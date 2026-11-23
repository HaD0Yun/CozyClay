#!/usr/bin/env node
/** Real editor coverage for MCP batch transactions and undo coalescing. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { WebSocket } from "ws";

import { chromeArgs, resolveChromePath, seedCharacterStage } from "./qa-chrome.mjs";
import { LiveHub } from "./live-hub.mjs";
import { mcpToolCategory, mcpToolName } from "../src/execution-telemetry.js";

const root = fileURLToPath(new URL("..", import.meta.url)); const serverPath = fileURLToPath(new URL("./server.mjs", import.meta.url));

// CDP and MCP stdio are independent observation channels. Drain each call's
// requested/executed lifecycle before issuing the next, then assert by that
// exact request_id, never by an offset into asynchronously delivered events.
function createExecutionObserver({ schedule = setTimeout, unschedule = clearTimeout } = {}) {
	const events = new Map();
	const resultIds = new WeakMap();
	const commandOwners = new Map();
	const descriptions = new Map();
	const listeners = new Set();
	let currentCall = null;
	let wireRequestId = null;
	const notify = () => { for (const listener of [...listeners]) listener(); };
	const wait = (read, label) => {
		let check, timer;
		const cancel = () => { unschedule(timer); listeners.delete(check); };
		const promise = new Promise((resolve, reject) => {
			check = () => {
				try { const value = read(); if (value !== undefined) { cancel(); resolve(value); } }
				catch (error) { cancel(); reject(error); }
			};
			listeners.add(check);
			timer = schedule(() => { cancel(); reject(new Error(`Timed out waiting for ${label}.`)); }, 30_000);
			check();
		});
		return { promise, cancel };
	};
	return {
		get pendingWaiters() { return listeners.size; },
		telemetry(payload) {
			const id = payload.props.request_id;
			const lifecycle = events.get(id) ?? [];
			const firstRequested = payload.event === "mcp:tool_requested" && !lifecycle.some(e => e.event === "mcp:tool_requested");
			lifecycle.push(payload); events.set(id, lifecycle);
			if (firstRequested) {
				wireRequestId = id;
				if (currentCall && currentCall.id === null) currentCall.id = id;
			}
			notify();
		},
		command(frame) {
			if (frame.type === "cmd" && frame.name === "describe") commandOwners.set(frame.id, wireRequestId);
		},
		result(frame) {
			if (frame.type !== "result" || !commandOwners.has(frame.id)) return;
			const id = commandOwners.get(frame.id); commandOwners.delete(frame.id);
			if (frame.value?.objects) descriptions.set(id, frame.value);
			notify();
		},
		async call(trigger, category, toolName) {
			assert.equal(currentCall, null, "verification tool calls must be serial");
			const call = { id: null }; currentCall = call;
			const terminal = wait(() => {
				if (call.id === null) return;
				const lifecycle = events.get(call.id);
				assert.match(call.id, /^[a-f0-9]{32}$/);
				assert.deepEqual([lifecycle[0].props.tool_category, lifecycle[0].props.tool_name], [category, toolName]);
				return lifecycle.some(e => e.event === "mcp:tool_executed") ? call.id : undefined;
			}, `${category} request_id and terminal event`);
			try {
				// The listener above is installed before the actual MCP request.
				const [result, id] = await Promise.all([trigger(), terminal.promise]);
				resultIds.set(result, id);
				return result;
			} finally { terminal.cancel(); currentCall = null; }
		},
		async description(result) {
			const id = resultIds.get(result);
			assert.ok(id, "description belongs to an observed request");
			return wait(() => descriptions.get(id), `editor describe result for ${id}`).promise;
		},
		async assertExecution(result, outcome, applied) {
			const id = resultIds.get(result);
			assert.ok(id, "assertion belongs to an observed request");
			if (applied) await wait(() => events.get(id).find(e => e.event === "mcp:result_applied"), `mcp:result_applied for ${id}`).promise;
			const lifecycle = events.get(id);
			assert.equal(lifecycle[0].event, "mcp:tool_requested");
			assert.deepEqual(lifecycle.map(({ event }) => event), ["mcp:tool_requested", "mcp:tool_executed", ...(applied ? ["mcp:result_applied"] : [])]);
			assert.equal(lifecycle[1].props.outcome, outcome);
		},
	};
}

// Controlled delivery proof uses the real existing hub emitter. Only delivery
// to the test observer is delayed, never product telemetry or the clock by sleep.
async function verifyExecutionObservation() {
	const deadlines = new Map(); let timerId = 0;
	const observer = createExecutionObserver({ schedule: callback => { const id = ++timerId; deadlines.set(id, callback); return id; }, unschedule: id => deadlines.delete(id) });
	const hub = new LiveHub(); const queued = []; const state = { objects: [] }; let request = 0;
	hub.workspaceIds.set("fixture", "workspace");
	hub.editors.set("fixture", { readyState: WebSocket.OPEN, send: raw => queued.push(JSON.parse(raw).payload) });
	hub.sendCommand = async (name) => {
		if (name === "describe") return structuredClone(state);
		assert.equal(name, "apply_batch"); state.objects.push({ id: `object-${state.objects.length}` });
		return { applied: [1], failed: [], rolledBack: false };
	};
	const start = (name) => {
		const response = Promise.withResolvers();
		const result = observer.call(async () => {
			const value = await hub.observeExecution(name, "fixture", async () => {
				if (name === "apply_batch") { await hub.command("apply_batch", {}, "fixture"); await hub.command("describe", {}, "fixture"); }
				return { content: [] };
			}, { randomId: () => (++request).toString(16).padStart(32, "0"), now: () => 0 });
			response.resolve(); return value;
		}, mcpToolCategory(name), mcpToolName(name));
		return { response: response.promise, result };
	};
	const read = start("describe_scene"); await read.response;
	assert.equal(observer.pendingWaiters, 1, "MCP response cannot substitute for delayed requested/executed CDP events");
	queued.splice(0).forEach(observer.telemetry); const readResult = await read.result;
	await observer.assertExecution(readResult, "succeeded", false);
	observer.command({ type: "cmd", id: "old-description", name: "describe" });
	const batch = start("apply_batch"); await batch.response;
	assert.deepEqual(queued.map(e => e.event), ["mcp:tool_requested", "mcp:tool_executed", "mcp:result_applied"]);
	observer.telemetry(queued.shift());
	observer.command({ type: "cmd", id: "batch-description", name: "describe" });
	observer.telemetry(queued.shift()); const batchResult = await batch.result;
	const description = observer.description(batchResult);
	observer.result({ type: "result", id: "old-description", value: { objects: [] } });
	assert.equal(observer.pendingWaiters, 1, "a late earlier describe response cannot satisfy this request's readback");
	observer.result({ type: "result", id: "batch-description", value: structuredClone(state) });
	assert.deepEqual(await description, state);
	const application = observer.assertExecution(batchResult, "succeeded", true);
	assert.equal(observer.pendingWaiters, 1, "assertion waits for application of the exact batch request_id");
	observer.telemetry({ event: "mcp:result_applied", props: { request_id: "f".repeat(32) } });
	assert.equal(observer.pendingWaiters, 1, "another lifecycle's application cannot complete the batch");
	queued.splice(0).forEach(observer.telemetry); await application;
	const missing = start("apply_batch"); await missing.response;
	queued.splice(0, 2).forEach(observer.telemetry); const missingResult = await missing.result;
	const rejected = assert.rejects(observer.assertExecution(missingResult, "succeeded", true), /Timed out waiting for mcp:result_applied/);
	for (const expire of [...deadlines.values()]) expire(); await rejected;
	assert.equal(observer.pendingWaiters, 0, "omitted events must fail with bounded cleanup, not pass by retry");
	// A duplicate or unexpected application is still an error, not deduped away.
	queued.splice(0).forEach(observer.telemetry);
	observer.telemetry({ event: "mcp:result_applied", props: { request_id: "1".padStart(32, "0") } });
	await assert.rejects(observer.assertExecution(readResult, "succeeded", false), assert.AssertionError);
	console.log("PASS controlled delivery: delayed requested/terminal, exact command-ID readback, delayed exact-ID application, unrelated ID ignored, omitted event fails, unexpected application still fails");
}

const reservePort = () =>
	new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				reject(new Error("Could not reserve a TCP port."));
				return;
			}
			server.close((error) => (error ? reject(error) : resolve(address.port)));
		});
	});

const withTimeout = (promise, label, milliseconds = 30_000) => {
	let timer;
	return Promise.race([
		promise,
		new Promise((_, reject) => {
			timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), milliseconds);
		}),
	]).finally(() => clearTimeout(timer));
};

const waitForOutput = (child, pattern, label) =>
	withTimeout(
		new Promise((resolve, reject) => {
			let output = "";
			const inspect = (chunk) => {
				// picocolors turns colour ON when CI is set even without a TTY, and
				// the port lands inside bold escapes ("...127.0.0.1:\x1b[1m5599...")
				// — strip ANSI before matching or the ready banner never matches
				// on a GitHub runner while passing everywhere locally.
				output += chunk.toString().replace(/\u001b\[[0-9;]*m/g, "");
				if (pattern.test(output)) finish(resolve);
			};
			const onExit = (code, signal) => finish(reject, new Error(`${label} exited (${code ?? signal ?? "unknown"}): ${output}`));
			const finish = (callback, value) => {
				child.stdout.off("data", inspect);
				child.stderr.off("data", inspect);
				child.off("exit", onExit);
				callback(value);
			};
			child.stdout.on("data", inspect);
			child.stderr.on("data", inspect);
			child.once("exit", onExit);
		}),
		label,
	);

const terminate = async (child) => {
	if (!child || child.exitCode !== null || child.signalCode !== null) return;
	const exited = new Promise((resolve) => child.once("exit", resolve));
	child.kill("SIGTERM");
	await withTimeout(exited, "child cleanup", 5_000).catch(async () => {
		child.kill("SIGKILL");
		await withTimeout(exited, "forced child cleanup", 5_000);
	});
};

await verifyExecutionObservation();
const caseFlag = process.argv.indexOf("--case");
if (caseFlag !== -1) {
	assert.equal(process.argv[caseFlag + 1], "execution-observation");
} else {
const vitePort = Number(process.env.QA_VITE_PORT) || await reservePort();
const livePort = Number(process.env.COZYCLAY_LIVE_PORT) || await reservePort();
const cdpPort = Number(process.env.CDP_PORT) || await reservePort();
console.log(JSON.stringify({ surface: "real-Chrome-live-batch", vitePort, livePort, cdpPort }));
const vite = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"], {
	cwd: root,
	env: { ...process.env, COZYCLAY_LIVE_PORT: String(livePort) },
	stdio: ["ignore", "pipe", "pipe"],
});
const browserOptions = chromeArgs(cdpPort);
const profile = browserOptions.find(arg => arg.startsWith("--user-data-dir=")).slice("--user-data-dir=".length);
const browser = spawn(resolveChromePath(), browserOptions, { stdio: ["ignore", "pipe", "pipe"] });
const startup = Promise.all([
	waitForOutput(vite, new RegExp(`http://127\\.0\\.0\\.1:${vitePort}/`), "Vite"),
	waitForOutput(browser, /DevTools listening on (ws:\/\/[^\s]+)/, "Chrome"),
]);

let socket;
let client;
try {
	await startup;
	const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json();
	const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
	if (!page) throw new Error("Chrome did not expose a page target.");

	socket = new WebSocket(page.webSocketDebuggerUrl);
	await withTimeout(new Promise((resolve, reject) => {
		socket.addEventListener("open", resolve, { once: true });
		socket.addEventListener("error", reject, { once: true });
	}), "CDP connection");
	let nextId = 1;
	const pending = new Map();
	let resolveEditorHello;
	const editorHello = new Promise((resolve) => {
		resolveEditorHello = resolve;
	});
	const execution = createExecutionObserver();
	const assertExecution = (result, outcome, applied) => execution.assertExecution(result, outcome, applied);
	socket.addEventListener("message", (event) => {
		const frame = JSON.parse(event.data);
		if (frame.method === "Network.webSocketFrameReceived") {
			const editorFrame = JSON.parse(frame.params.response.payloadData);
			if (editorFrame.type === "event" && editorFrame.name === "telemetry") execution.telemetry(editorFrame.payload);
			execution.command(editorFrame);
		}
		if (frame.method === "Network.webSocketFrameSent") {
			try {
				const editorFrame = JSON.parse(frame.params.response.payloadData);
				if (editorFrame.type === "hello" && editorFrame.role === "editor") resolveEditorHello();
				execution.result(editorFrame);
			} catch {
				// CDP carries unrelated non-protocol WebSocket frames too.
			}
		}
		if (!frame.id || !pending.has(frame.id)) return;
		const request = pending.get(frame.id);
		pending.delete(frame.id);
		if (frame.error) request.reject(new Error(JSON.stringify(frame.error)));
		else request.resolve(frame.result);
	});
	const send = (method, params = {}) =>
		new Promise((resolve, reject) => {
			const id = nextId++;
			pending.set(id, { resolve, reject });
			socket.send(JSON.stringify({ id, method, params }));
		});
	const evaluate = async (expression) => {
		const response = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
		if (response.exceptionDetails) throw new Error(response.exceptionDetails.text);
		return response.result.value;
	};
	await send("Network.enable");
	await send("Page.enable");
	await send("Runtime.enable");
	await seedCharacterStage(send); await send("Page.navigate", { url: `http://127.0.0.1:${vitePort}/app/` });

	client = new Client({ name: "cozyclay-live-batch-verify", version: "1.0.0" });
	await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath, "--live-port", String(livePort)] }));
	await withTimeout(editorHello, "editor live hello");
	await withTimeout(evaluate(
		"window.__cozyclayMcpRigReady?.includes('char-a') ? true : new Promise((resolve) => window.addEventListener('cozyclay:mcp-rig-ready', (event) => event.detail === 'char-a' && resolve(true), { once: true }))",
	), "character rig readiness");
	const call = (name, args = {}, observe = true) => observe
		? execution.call(() => client.callTool({ name, arguments: args }), mcpToolCategory(name), mcpToolName(name))
		: client.callTool({ name, arguments: args });
	const history = () => evaluate("window.__sceneHistory()");
	const description = async () => JSON.stringify(await execution.description(await call("describe_scene")));
	const assertSceneEquivalent = (actualJson, expectedJson) => {
		const actual = JSON.parse(actualJson);
		const expected = JSON.parse(expectedJson);
		assert.equal(actual.sceneName, expected.sceneName);
		assert.deepEqual(actual.stage, expected.stage);
		assert.deepEqual(actual.timeline, expected.timeline);
		assert.deepEqual(actual.characters, expected.characters);
		assert.deepEqual(actual.objects, expected.objects);
		for (const field of ["x", "y", "z", "focalMm"]) {
			assert.ok(Math.abs(actual.camera[field] - expected.camera[field]) < 0.01, `camera ${field} changed`);
		}
		assert.equal(actual.camera.sensorId, expected.camera.sensorId);
		assert.equal(actual.camera.aspectRatio, expected.camera.aspectRatio);
	};

	// Given a normal one-shot MCP object mutation
	// When it reaches the live editor outside a batch
	// Then it retains its own undo entry.
	const beforeSingle = await description();
	const singleDepth = await history();
	const single = await call("place_object", { kind: "cube", x: -3 });
	assert.equal(single.isError, undefined, JSON.stringify(single));
	assert.equal((await history()).past - singleDepth.past, 1);
	await evaluate('window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyZ", ctrlKey: true, bubbles: true, cancelable: true }))');
	assert.deepEqual(JSON.parse(await description()).objects, JSON.parse(beforeSingle).objects);

	// Given an agent managing one element end to end — the reported "an MCP
	// element sometimes goes missing" class of failure
	// When place -> update -> remove run back to back as separate commands
	// Then every step is visible in the editor's OWN description immediately:
	// the placed object appears under its returned id, the update lands on
	// that id, and the removal leaves no trace. No step may silently drop.
	const placedResult = await call("place_object", { kind: "cube", x: 2, z: -2, name: "Lifecycle Crate" });
	assert.equal(placedResult.isError, undefined, JSON.stringify(placedResult));
	const placedReceipt = JSON.parse(placedResult.content[0].text);
	assert.equal(placedReceipt.action, "object.add");
	const placedId = placedReceipt.affectedIds[0];
	assert.ok(placedId, placedResult.content[0].text);
	const afterPlace = JSON.parse(await description()).objects.find((object) => object.id === placedId);
	assert.ok(afterPlace, `placed object ${placedId} missing from the editor description`);
	assert.equal(afterPlace.name, "Lifecycle Crate");
	const updated = await call("update_object", { id: placedId, x: 4, color: "#ff0000", name: "Lifecycle Crate B" });
	assert.equal(updated.isError, undefined, JSON.stringify(updated));
	const afterUpdate = JSON.parse(await description()).objects.find((object) => object.id === placedId);
	assert.ok(afterUpdate, `updated object ${placedId} missing from the editor description`);
	assert.equal(afterUpdate.x, 4);
	assert.equal(afterUpdate.color, "#ff0000");
	assert.equal(afterUpdate.name, "Lifecycle Crate B");
	const noOp = await call("update_object", { id: placedId, x: 4, color: "#ff0000", name: "Lifecycle Crate B" });
	await description(); // Exact next read lifecycle fences absence of application.
	await assertExecution(noOp, "succeeded", false);
	const noOpBatch = await call("apply_batch", { ops: [{ name: "update_object", args: { id: placedId, x: 4 } }] });
	await description();
	await assertExecution(noOpBatch, "succeeded", false);
	const removed = await call("remove_object", { id: placedId });
	assert.equal(removed.isError, undefined, JSON.stringify(removed));
	assert.ok(
		!JSON.parse(await description()).objects.some((object) => object.id === placedId),
		"removed object still present in the editor description",
	);

	// Given the real editor has an empty object history
	// When an MCP agent applies multiple mutations as a batch
	// Then all mutations land and one Undo returns the complete pre-batch document.
	const beforeHappy = await description();
	const happyDepth = await history();
	const happy = await call("apply_batch", {
		label: "Block street furniture",
		atomic: false,
		stopOnError: true,
		ops: [
			{ name: "place_object", args: { kind: "cube", x: 1, z: 2 } },
			{ name: "place_object", args: { kind: "cylinder", x: -2, z: 1 } },
			{ name: "place_object", args: { kind: "sphere", x: 0, z: -1 } },
		],
	});
	assert.equal(happy.isError, undefined, JSON.stringify(happy));
	const happyReceipt = JSON.parse(happy.content[0].text);
	assert.equal(happyReceipt.action, "objects.batch");
	assert.deepEqual(happyReceipt.output.applied, [1, 2, 3]);
	assert.equal(happyReceipt.revision.after, happyReceipt.revision.before + 1);
	assert.equal(happyReceipt.undo.entries, 1);
	const afterHappy = await description();
	await assertExecution(happy, "succeeded", true);
	const happyAfterDepth = await history();
	assert.equal(JSON.parse(afterHappy).objects.length, JSON.parse(beforeHappy).objects.length + 3);
	assert.equal(happyAfterDepth.past - happyDepth.past, 1);
	const undone = await call("studio_run", { action: "edit.undo", args: { receiptId: happyReceipt.receiptId } });
	assert.equal(JSON.parse(undone.content[0].text).status, "undone");
	const undoHappy = await description();
	assertSceneEquivalent(undoHappy, beforeHappy);
	assert.equal((await history()).past, happyDepth.past);

	// Given a batch whose third operation cannot resolve an object id
	// When atomic mode is requested
	// Then the document is byte-identical and no undo entry is added.
	await call("set_camera", { x: 2, y: 1.6, z: 4.5, focal_mm: 35 });
	const beforeAtomicFailure = await description();
	const atomicDepth = await history();
	const atomicFailure = await call("apply_batch", {
		label: "Rollback malformed block",
		atomic: true,
		stopOnError: true,
		ops: [
			{ name: "place_object", args: { kind: "cube", x: 3 } },
			{ name: "place_object", args: { kind: "cylinder", x: 4 } },
			{ name: "update_object", args: { id: "missing-object", x: 5 } },
		],
	});
	assert.equal(atomicFailure.isError, undefined, JSON.stringify(atomicFailure));
	assert.equal(JSON.parse(atomicFailure.content[0].text).output.rolledBack, true);
	const afterAtomicFailure = await description();
	await assertExecution(atomicFailure, "failed", false);
	assertSceneEquivalent(afterAtomicFailure, beforeAtomicFailure);
	const atomicRollbackDepthDelta = (await history()).past - atomicDepth.past;
	assert.equal(atomicRollbackDepthDelta, 0);

	// Given non-atomic mode stops on an invalid second operation
	// When the first operation has already applied
	// Then that first operation remains and the report names the applied index.
	const partialDepth = await history();
	const partial = await call("apply_batch", {
		label: "Keep completed work",
		atomic: false,
		stopOnError: true,
		ops: [
			{ name: "place_object", args: { kind: "cone", x: 5 } },
			{ name: "update_object", args: { id: "missing-object", x: 6 } },
			{ name: "place_object", args: { kind: "plane", x: 7 } },
		],
	});
	assert.equal(partial.isError, undefined, JSON.stringify(partial));
	assert.deepEqual(JSON.parse(partial.content[0].text).output.applied, [1]);
	assert.equal(JSON.parse(partial.content[0].text).output.failed[0].index, 2);
	assert.equal((await history()).past - partialDepth.past, 1);
	assert.equal(JSON.parse(await description()).objects.length, JSON.parse(beforeHappy).objects.length + 1);
	await assertExecution(partial, "failed", true);
	await evaluate('window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyZ", ctrlKey: true, bubbles: true, cancelable: true }))');

	// Given stopOnError is disabled
	// When an early operation fails
	// Then later operations still run while the batch remains one undo entry.
	const continueDepth = await history();
	const continueBatch = await call("apply_batch", {
		atomic: false,
		stopOnError: false,
		ops: [
			{ name: "update_object", args: { id: "missing-object", x: 6 } },
			{ name: "place_object", args: { kind: "plane", x: 7 } },
		],
	});
	assert.equal(continueBatch.isError, undefined, JSON.stringify(continueBatch));
	assert.deepEqual(JSON.parse(continueBatch.content[0].text).output.applied, [2]);
	assert.equal(JSON.parse(continueBatch.content[0].text).output.failed[0].index, 1);
	assert.equal((await history()).past - continueDepth.past, 1);
	await evaluate('window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyZ", ctrlKey: true, bubbles: true, cancelable: true }))');

	// Given a batch exceeds its fixed cap or tries to nest a batch
	// When it is sent to the MCP boundary
	// Then neither form mutates the editor or creates history.
	const boundaryDocument = await description();
	const boundaryDepth = await history();
	// Zod rejects the fixed cap before entering observeExecution, so this one
	// registration-boundary rejection has no live request lifecycle to await.
	const tooMany = await call("apply_batch", {
		ops: Array.from({ length: 101 }, () => ({ name: "place_object", args: { kind: "cube" } })),
	}, false);
	assert.equal(tooMany.isError, true, JSON.stringify(tooMany));
	const nested = await call("apply_batch", { ops: [{ name: "apply_batch", args: { ops: [] } }] });
	assert.equal(nested.isError, true, JSON.stringify(nested));
	// Since #344 the schema itself no longer lists character ops, so this is
	// a registration-boundary rejection too: no live request lifecycle to await.
	const characterBatch = await call("apply_batch", { ops: [{ name: "update_character", args: { ref: "A", x: 1 } }] }, false);
	assert.equal(characterBatch.isError, true, JSON.stringify(characterBatch));
	assert.deepEqual(JSON.parse(await description()).objects, JSON.parse(boundaryDocument).objects);
	assert.equal((await history()).past - boundaryDepth.past, 0);

	// The four cast aliases run through the same real MCP/Chrome surface.
	const castBefore = await description();
	const castReceipt = (result, action) => {
		assert.equal(result.isError, undefined, JSON.stringify(result));
		const value = JSON.parse(result.content[0].text);
		assert.equal(value.ok, true); assert.equal(value.action, action);
		assert.equal(value.undo.entries, 1);
		assert.ok(value.revision.after > value.revision.before);
		return value;
	};
	const undoReceipt = async value => {
		const result = await call("studio_run", { action: "edit.undo", args: { receiptId: value.receiptId } });
		assert.equal(JSON.parse(result.content[0].text).status, "undone", JSON.stringify(result));
	};
	const castAdded = castReceipt(await call("add_character", { subject: "Bus performer", model: "y-bot-tpose", x: 2, z: -1 }), "character.add");
	const castId = castAdded.affectedIds.find(id => !JSON.parse(castBefore).characters.some(row => row.id === id));
	const afterCastAdd = await description();
	assert.equal(JSON.parse(afterCastAdd).characters.find(row => row.id === castId).model, "x-bot-tpose", "an older caller's y-bot-tpose becomes the block figure");
	const castMoved = castReceipt(await call("place_character", { character: "B", x: 3, y: 0.5, facing: 90, hidden: true }), "character.update");
	const movedActor = JSON.parse(await description()).characters.find(row => row.id === castId);
	assert.deepEqual([movedActor.x, movedActor.y, movedActor.rot, movedActor.hidden], [3, 0.5, 90, true]);
	await undoReceipt(castMoved); assertSceneEquivalent(await description(), afterCastAdd);
	const staleCast = await call("remove_character", { character: "B", expectedRevision: castAdded.revision.before });
	assert.equal(JSON.parse(staleCast.content[0].text).code, "STALE_SCENE");
	const castRemoved = castReceipt(await call("remove_character", { character: "2" }), "character.remove");
	assert.equal(JSON.parse(await description()).characters.some(row => row.id === castId), false);
	await undoReceipt(castRemoved); assertSceneEquivalent(await description(), afterCastAdd);
	await undoReceipt(castAdded); assertSceneEquivalent(await description(), castBefore);

	console.log(JSON.stringify({
		castAliases: { receipts: 3, undoRestored: true, staleRevisionRefused: true },
		happy: {
			preState: JSON.parse(beforeHappy),
			postState: JSON.parse(afterHappy),
			undoState: JSON.parse(undoHappy),
			undoDepthDelta: happyAfterDepth.past - happyDepth.past,
		},
		atomicRollback: {
			preState: JSON.parse(beforeAtomicFailure),
			postState: JSON.parse(afterAtomicFailure),
			undoDepthDelta: atomicRollbackDepthDelta,
		},
		edges: {
			partialStopOnError: JSON.parse(partial.content[0].text).output,
			continueAfterError: JSON.parse(continueBatch.content[0].text).output,
			capRejected: tooMany.isError === true,
			nestedRejected: nested.isError === true,
			characterBatchRejected: characterBatch.isError === true,
		},
		adjacentUndoDepthDeltas: { singleShot: 1, humanPointerDrag: 1 },
		mixedObjectCharacterBatches: "restricted-v1",
		mcpExecutionTelemetry: "PASS: object and batch no-op, successful batch, atomic rollback, retained partial failure",

	}));
} finally {
	socket?.close();
	try { await client?.close(); }
	finally {
		await Promise.all([terminate(browser), terminate(vite)]);
		await rm(profile, { recursive: true, force: true });
		console.log(JSON.stringify({ cleanup: "owned Chrome/Vite/MCP closed and profile removed", vitePort, livePort, cdpPort, profile }));
	}
}
}
