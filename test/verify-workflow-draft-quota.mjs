#!/usr/bin/env node
// The Workflow draft in localStorage stores each picture once (#1208). Before
// the fix a panel's data URL sat in the draft four times (fileUrl, image_url,
// outputs[0].value, thumbnail), so a 5 MiB storage held only six 150 KB panels.
// The graph in memory keeps every copy: only the stored text changes.
import assert from "node:assert/strict";
import { loadWorkflowGraph, normalizeWorkflowGraph, storeWorkflowGraph, WORKFLOW_STORAGE_KEY } from "../src/project.js";
import { sendPanelToWorkflow } from "../src/workflow-send.js";

const QUOTA = 5 * 1024 * 1024;

/** A localStorage stand-in that counts characters of keys plus values, like browsers do. */
function quotaStorage(seed = []) {
	const store = new Map(seed);
	const used = () => [...store].reduce((sum, [key, value]) => sum + key.length + value.length, 0);
	return {
		store,
		getItem: (key) => (store.has(key) ? store.get(key) : null),
		setItem(key, value) {
			const text = String(value);
			const next = used() - (store.has(key) ? key.length + store.get(key).length : 0) + key.length + text.length;
			if (next > QUOTA) {
				const error = new Error(`Setting the value of '${key}' exceeded the quota.`);
				error.name = "QuotaExceededError";
				throw error;
			}
			store.set(key, text);
		},
		removeItem: (key) => store.delete(key),
	};
}

/** A distinct base64 PNG data URL of `bytes` bytes, as a panel capture would be. */
function pngDataUrl(bytes, seed) {
	const view = new Uint8Array(bytes);
	let state = (seed * 2654435761) >>> 0 || 1;
	for (let i = 0; i < view.length; i += 1) {
		state = (state * 1664525 + 1013904223) >>> 0;
		view[i] = state >>> 24;
	}
	return `data:image/png;base64,${Buffer.from(view).toString("base64")}`;
}

const PROMPT = "SHOT: Panel\nCAMERA: 35mm\nCAPTION: She turns toward the door.";

// 1. Many 150 KB panels fit: main held six and threw on the seventh.
{
	const storage = quotaStorage();
	let sent = 0;
	let failure = null;
	for (let panel = 1; panel <= 30; panel += 1) {
		try {
			sendPanelToWorkflow({ dataUrl: pngDataUrl(150 * 1024, panel), fileName: `panel-${panel}.png`, prompt: PROMPT }, storage, 1000 + panel);
			sent += 1;
		} catch (error) {
			failure = error;
			break;
		}
	}
	if (failure) assert.equal(failure.name, "QuotaExceededError", "only the quota stops the sends");
	assert.ok(sent >= 24, `at least 24 panels of 150 KB fit in a 5 MiB draft, got ${sent}`);
	const graph = loadWorkflowGraph(storage);
	assert.equal(graph.nodes.filter((node) => node.type === "upload").length, sent, "every sent panel loads back");
	console.log(`PASS ${sent} panels of 150 KB fit in a 5 MiB draft`);
}

// 2. One panel costs about one copy of its picture in storage.
{
	const storage = quotaStorage();
	const dataUrl = pngDataUrl(400 * 1024, 7);
	const graph = sendPanelToWorkflow({ dataUrl, prompt: PROMPT }, storage, 2000);
	const stored = storage.getItem(WORKFLOW_STORAGE_KEY);
	assert.ok(stored.length < 1.2 * dataUrl.length, `stored draft is ${(stored.length / dataUrl.length).toFixed(2)}x the data URL, expected under 1.2x`);
	const upload = graph.nodes.find((node) => node.type === "upload");
	assert.equal(upload.data.fileUrl, dataUrl, "the returned graph keeps every copy in memory");
	assert.equal(upload.data.image_url, dataUrl);
	assert.equal(upload.data.thumbnail, dataUrl);
	assert.deepEqual(upload.data.outputs, [{ value: dataUrl }]);
	assert.deepEqual(loadWorkflowGraph(storage), graph, "the stored draft decodes to the graph that was sent");
	console.log("PASS one panel is stored at under 1.2x its data URL and loads back deep-equal");
}

// 3. storeWorkflowGraph (the Workflow canvas) stores a pasted picture once too, and round-trips.
{
	const storage = quotaStorage();
	const pasted = pngDataUrl(300 * 1024, 11);
	const other = pngDataUrl(2 * 1024, 12);
	const graph = normalizeWorkflowGraph({
		nodes: [
			{ id: "upload-1", type: "upload", position: { x: 0, y: 0 }, data: { fileUrl: pasted, image_url: pasted, outputs: [{ value: pasted }], outputHistory: [{ value: other }, { value: pasted }] } },
			{ id: "image-1", type: "image", position: { x: 300, y: 0 }, data: { prompt: "keep me", resultUrl: other, outputs: [{ value: other }], nested: [[pasted, { deep: other }]] } },
		],
		edges: [{ id: "e-1", source: "upload-1", target: "image-1", sourceHandle: "output", targetHandle: "input" }],
	});
	storeWorkflowGraph(graph, storage);
	const stored = storage.getItem(WORKFLOW_STORAGE_KEY);
	assert.ok(stored.length < 1.2 * (pasted.length + other.length), `stored canvas draft is ${(stored.length / pasted.length).toFixed(2)}x the pasted picture`);
	assert.deepEqual(loadWorkflowGraph(storage), graph, "storeWorkflowGraph then loadWorkflowGraph is deep-equal");
	assert.deepEqual(loadWorkflowGraph(storage, { strict: true }), graph, "strict load decodes the same graph");
	console.log("PASS storeWorkflowGraph stores each picture once and round-trips deep-equal");
}

// 4. A draft written by an older build (plain graph JSON) still loads unchanged,
//    and a send appends to it without touching the old nodes.
{
	const dataUrl = pngDataUrl(4 * 1024, 21);
	const old = normalizeWorkflowGraph({
		nodes: [{ id: "upload-old", type: "upload", position: { x: 80, y: 100 }, data: { fileUrl: dataUrl, image_url: dataUrl, outputs: [{ value: dataUrl }], thumbnail: dataUrl, note: "cozyclay:draft-blob:0" } }],
		edges: [],
	});
	const storage = quotaStorage([[WORKFLOW_STORAGE_KEY, JSON.stringify(old)]]);
	assert.deepEqual(loadWorkflowGraph(storage), old, "an unencoded draft loads unchanged");
	const next = sendPanelToWorkflow({ dataUrl: pngDataUrl(4 * 1024, 22), prompt: PROMPT }, storage, 3000);
	assert.deepEqual(next.nodes[0], old.nodes[0], "the old node is carried over untouched");
	assert.deepEqual(loadWorkflowGraph(storage), next, "the re-stored draft decodes deep-equal");
	console.log("PASS an older unencoded draft loads unchanged and keeps loading after a send");
}

// 5. Small drafts are still stored as plain graph JSON.
{
	const storage = quotaStorage();
	const tiny = "data:image/png;base64,iVBORw0KGgo=";
	const graph = sendPanelToWorkflow({ dataUrl: tiny, prompt: PROMPT }, storage, 4000);
	assert.deepEqual(JSON.parse(storage.getItem(WORKFLOW_STORAGE_KEY)), graph, "a draft without large pictures is plain graph JSON");
	console.log("PASS a draft without large pictures is stored as plain graph JSON");
}
