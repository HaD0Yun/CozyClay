/**
 * Send a storyboard panel to the Workflow canvas: one Upload node holding the
 * panel PNG, wired into a fresh Video generation node whose prompt is the
 * shot prompt plus the panel caption. The helper only appends to the draft
 * (`cozyclay.workflow.v1`); it never runs the workflow and never touches an
 * existing node or edge. Kept free of React so Node tests can drive it.
 */

import { loadWorkflowGraph, normalizeWorkflowGraph, WORKFLOW_STORAGE_KEY, WORKFLOW_VERSION } from "./project.js";
import { encodeWorkflowDraft } from "./workflow-draft-codec.js";
import { pastedImageNodeData } from "./workflow/clipboard-image.js";
import { DEFAULT_NODE_SCHEMAS, defaultFormValues, schemaProperties } from "./workflow/node-schema.js";
import { buildShotPrompt } from "./shot-prompt.js";

const COLUMN_GAP = 380;
const ROW_GAP = 280;
const FIRST_POSITION = { x: 80, y: 100 };
const VIDEO_MODEL = { id: "video-generation", name: "Video generation" };

/** The video prompt for a panel: the labelled shot block, then its caption. */
export function panelVideoPrompt(meta, caption = "") {
	const prompt = buildShotPrompt(meta, { target: "video" });
	const note = typeof caption === "string" ? caption.trim() : "";
	return note ? `${prompt}\nCAPTION: ${note}` : prompt;
}

function nodeBase(label) {
	return { label, cost: 0, outputHistory: [], outputs: [], resultUrl: null, isLoading: false, errorMsg: null };
}

function freshId(type, taken, stamp) {
	let id = `${type}-${stamp}`;
	for (let n = 2; taken.has(id); n += 1) id = `${type}-${stamp}-${n}`;
	taken.add(id);
	return id;
}

/** Pure: the draft with the panel's two nodes and one edge appended. Every
 * pre-existing node and edge is carried over untouched. */
export function appendPanelToWorkflowGraph(draft, { dataUrl, mimeType = "image/png", fileName = "panel.png", prompt = "", now = Date.now() } = {}) {
	if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/")) throw new Error("A panel image is required");
	const graph = normalizeWorkflowGraph(draft);
	const taken = new Set(graph.nodes.map((node) => node.id));
	const uploadId = freshId("upload", taken, now);
	const videoId = freshId("video", taken, now);
	// Below everything already on the canvas, left-aligned with it.
	const x = graph.nodes.length ? Math.min(...graph.nodes.map((node) => node.position.x)) : FIRST_POSITION.x;
	const y = graph.nodes.length ? Math.max(...graph.nodes.map((node) => node.position.y)) + ROW_GAP : FIRST_POSITION.y;
	const upload = {
		id: uploadId,
		type: "upload",
		position: { x, y },
		data: { ...nodeBase("Upload"), ...pastedImageNodeData({ name: fileName, type: mimeType }, dataUrl), uploadName: fileName, thumbnail: dataUrl },
	};
	const formValues = { ...defaultFormValues(schemaProperties(DEFAULT_NODE_SCHEMAS, "video", VIDEO_MODEL.id)), prompt };
	const video = {
		id: videoId,
		type: "video",
		position: { x: x + COLUMN_GAP, y },
		data: { ...nodeBase("Video"), prompt, model: VIDEO_MODEL.id, selectedModel: { ...VIDEO_MODEL }, formValues },
	};
	const edge = { id: `e-${uploadId}-${videoId}`, source: uploadId, target: videoId, sourceHandle: "output", targetHandle: "input" };
	return normalizeWorkflowGraph({
		version: WORKFLOW_VERSION,
		nodes: [...graph.nodes, upload, video],
		edges: [...graph.edges, edge],
	});
}

/** Write the panel into the stored draft. Unlike storeWorkflowGraph this lets a
 * storage failure (quota, private mode) surface, so the caller can say so. */
export function sendPanelToWorkflow(panel, storage = globalThis.localStorage, now = Date.now()) {
	if (!storage) throw new Error("Browser storage is unavailable");
	// A corrupt stored draft throws here, before anything is written.
	const draft = loadWorkflowGraph(storage, { strict: true });
	const graph = appendPanelToWorkflowGraph(draft, { ...panel, now });
	storage.setItem(WORKFLOW_STORAGE_KEY, encodeWorkflowDraft(graph));
	try { globalThis.dispatchEvent?.(new CustomEvent("cozyclay:workflow-change")); } catch { /* non-browser runtime */ }
	return graph;
}

/** A Blob's bytes as a data URL, for a stylized panel read from the asset store. */
export function bytesToDataUrl(bytes, type = "image/png") {
	const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	let binary = "";
	for (let i = 0; i < view.length; i += 0x8000) binary += String.fromCharCode.apply(null, view.subarray(i, i + 0x8000));
	return `data:${type};base64,${btoa(binary)}`;
}
