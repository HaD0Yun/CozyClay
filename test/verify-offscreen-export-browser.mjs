#!/usr/bin/env node
// End-to-end determinism contract: the same six-second authored project is
// exported twice through the production WebGL + WebCodecs path. The encoded
// frame count is exact and every pre-encode RGBA hash must match by address.

import { SCENES_STORAGE_KEY } from "../src/scenes.js";

const port = Number(process.env.CDP_PORT || 9222);
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
if (!page) throw new Error("no page target on the QA browser");

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
	ws.onopen = resolve;
	ws.onerror = reject;
});

let nextId = 1;
const pending = new Map();
const pageErrors = [];
ws.onmessage = (event) => {
	const message = JSON.parse(event.data);
	if (message.method === "Runtime.exceptionThrown") {
		pageErrors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
		return;
	}
	if (!message.id || !pending.has(message.id)) return;
	const { resolve, reject } = pending.get(message.id);
	pending.delete(message.id);
	if (message.error) reject(new Error(JSON.stringify(message.error)));
	else resolve(message.result);
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
	const id = nextId++;
	pending.set(id, { resolve, reject });
	ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
	const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
	if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || "evaluate failed");
	return result.result.value;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (expression, timeoutMs = 15_000) => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await evaluate(expression).catch(() => false)) return true;
		await sleep(100);
	}
	return false;
};

let failures = 0;
const expect = (name, condition, detail = "") => {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
};

await send("Runtime.enable");
await send("Page.enable");
await send("Page.navigate", { url: process.env.QA_URL ?? "http://127.0.0.1:5180/app/" });
await waitFor("location.href.startsWith('http')");
await evaluate(`(() => {
	const shot = {
		id: "export-qa-shot",
		name: "Six second move",
		startFrame: 0,
		endFrame: 143,
		cameraKeys: [
			{ frame: 0, framing: { pos: { x: 0, y: 1.6, z: 3 }, yaw: 0, pitch: -0.08, fovDeg: 45 } },
			{ frame: 143, framing: { pos: { x: 1.4, y: 1.8, z: 2.5 }, yaw: -0.38, pitch: -0.12, fovDeg: 38 } },
		],
		camera: { mode: "keys" },
	};
	const document = {
		version: 4,
		activeSceneId: "scene-export-qa",
		scenes: [{
			id: "scene-export-qa",
			name: "EXPORT QA",
			objects: [],
			shotDocument: { version: 4, frameCount: 144, shots: [shot], waypoints: [] },
			stage: {
				characters: [{ id: "char-a", model: "y-bot-tpose", x: 0, z: 0, rot: 0, hidden: false, pose: null, subject: "a person" }],
				hasCharSheet: false,
				shotAspect: "16:9",
			},
		}],
	};
	localStorage.clear(); localStorage.setItem('cozyclay.shell.agent-pane.v1','folded');
	localStorage.setItem("cozyclay.locale", "en");
	localStorage.setItem("${SCENES_STORAGE_KEY}", JSON.stringify(document));
})()`);
await send("Page.reload");
expect("six-second project and offscreen exporter become ready", await waitFor("!!window.__cozyclay?.rigA && !!window.__exportOffscreen && !!window.__captureFrame", 20_000));

const beforeFrame = await evaluate("window.__cozyclay.tlFrame");
const first = await evaluate("window.__exportOffscreen({ startFrame: 0, endFrame: 143 })");
const second = await evaluate("window.__exportOffscreen({ startFrame: 0, endFrame: 143, probeMetadata: true })");
const afterFrame = await evaluate("window.__cozyclay.tlFrame");

expect("first export addresses exactly 144 frames", first.frameCount === 144 && first.hashes?.length === 144, JSON.stringify({ frameCount: first.frameCount, hashes: first.hashes?.length }));
expect("WebCodecs emits exactly 144 encoded frames", first.encodedFrameCount === 144 && second.encodedFrameCount === 144, JSON.stringify({ first: first.encodedFrameCount, second: second.encodedFrameCount }));
const mismatchedHashes = first.hashes.flatMap((hash, index) => hash === second.hashes[index] ? [] : [index]);
expect("second export has the same 144 pixel hashes", mismatchedHashes.length === 0, `mismatches=${mismatchedHashes.slice(0, 20).join(",")} total=${mismatchedHashes.length}`);
expect("authored camera move produces more than one distinct frame", new Set(first.hashes).size > 1, `unique=${new Set(first.hashes).size}`);
expect("offline export does not advance the playback head", beforeFrame === afterFrame, JSON.stringify({ beforeFrame, afterFrame }));
expect("both exports produce non-empty MP4 files", first.mimeType === "video/mp4" && first.blobSize > 0 && second.blobSize > 0, JSON.stringify({ first: first.blobSize, second: second.blobSize }));
expect("browser reads exact six-second MP4 metadata", Math.abs(second.metadata?.duration - 6) < 0.001 && second.metadata?.width === 1920 && second.metadata?.height === 1080, JSON.stringify(second.metadata));
expect("browser run has no uncaught page errors", pageErrors.length === 0, pageErrors.join(" | "));

ws.close();
if (failures) process.exit(1);
console.log(`all offscreen export browser checks PASS — 6 seconds, ${first.frameCount} frames, two-run hashes identical`);
