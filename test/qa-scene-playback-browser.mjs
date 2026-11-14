#!/usr/bin/env node
// Browser contract for Play on the Workflow Scene node (#218). The reported
// bug is that a Scene node which has already been rendered shows a still frame
// and a ticking counter while nothing on screen moves, so the assertions here
// are pixels, not state: the node preview has to change between two captures
// while it is playing, and has to be byte-identical between two captures once
// it is paused — before a Run and, the part that regressed, after one. The run
// finishes on the hand-off the previs exists for: the Scene node's "→ Video"
// control has to add a Video node and wire the render output into it.
//
// Run: `CCLAY_KIMODO_HOST= COZYCLAY_LIVE_PORT=5399 npm run dev -- --port 5398`
// in one shell, then
// `QA_URL=http://127.0.0.1:5398/workflow/ CDP_PORT=9418 node tools/qa-browser.mjs -- node test/qa-scene-playback-browser.mjs`
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { SCENES_STORAGE_KEY } from "../src/scenes.js";

const cdpPort = Number(process.env.CDP_PORT || 9418);
const out = process.env.QA_OUT || "/tmp/scene-playback-qa";
const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json();
const page = targets.find((target) => target.type === "page" && target.url.includes("/workflow/")) || targets.find((target) => target.type === "page");
assert.ok(page, "workflow page is not open");

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let seq = 0;
const pending = new Map();
ws.onmessage = (event) => {
	const message = JSON.parse(event.data);
	if (!message.id || !pending.has(message.id)) return;
	const item = pending.get(message.id);
	pending.delete(message.id);
	if (message.error) item.reject(new Error(JSON.stringify(message.error)));
	else item.resolve(message.result);
};
const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expression, timeoutMs = 180000) => {
	const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, timeout: timeoutMs });
	if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || "browser evaluation failed");
	return result.result?.value;
};
const waitFor = async (label, probe, timeoutMs = 90000) => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = await probe().catch(() => null);
		if (value) return value;
		await new Promise((resolve) => setTimeout(resolve, 120));
	}
	throw new Error(`Timed out waiting for ${label}`);
};
const rectOf = (selector) => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; })()`);
const clickSelector = async (selector) => {
	const rect = await rectOf(selector);
	assert.ok(rect && rect.width > 0, `no element matches ${selector}`);
	const x = Math.round(rect.x + rect.width / 2);
	const y = Math.round(rect.y + rect.height / 2);
	for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1, buttons: type === "mousePressed" ? 1 : 0 });
};
// The preview element, not the whole page: a full-page capture also carries the
// frame readout and the toast layer, both of which change while playing and
// would make "the picture moved" pass without a single moving pixel.
const capturePreview = async () => {
	const rect = await rectOf(".cozy-scene-node .cozy-scene-preview");
	assert.ok(rect && rect.width > 0, "the Scene node has no preview element");
	const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false, clip: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: 1 } });
	return Buffer.from(shot.data, "base64");
};
// The studio's QA hook is rebuilt on tlFrame, so the playhead it reports is
// live; its `playing` flag is a snapshot from an older render and is not. Both
// waits below therefore read motion off the playhead itself.
const embedState = () => evaluate(`(() => {
	const frame = document.querySelector('.cozy-scene-node iframe');
	const live = frame && frame.contentWindow && frame.contentWindow.__cozyclay;
	return live ? { frame: live.tlFrame, frameCount: live.frameCount } : null;
})()`);
const playhead = async () => (await embedState())?.frame ?? null;
const rolling = async (label) => {
	const start = await playhead();
	return waitFor(label, async () => {
		const frame = await playhead();
		return frame !== null && frame !== start ? frame : null;
	}, 20000);
};
const settled = async () => {
	// Pause is asserted on identical bytes, so the capture pair must start after
	// everything in the frame has stopped: the same playhead twice in a row, the
	// node's own transport reporting paused, and no studio toast still on screen
	// (those come and go on their own and are not the preview moving).
	let previous = null;
	return waitFor("the embedded Studio to settle on a paused frame", async () => {
		const quiet = await evaluate(`(() => {
			const button = document.querySelector('.cozy-scene-node .cozy-scene-button');
			const embedded = document.querySelector('.cozy-scene-node iframe');
			const inner = embedded && embedded.contentDocument;
			return !!inner && button.getAttribute('aria-pressed') === 'false' && !inner.querySelector('.toast');
		})()`);
		const frame = await playhead();
		if (!quiet || frame === null) { previous = null; return null; }
		const stable = previous !== null && previous === frame;
		previous = frame;
		return stable ? { frame } : null;
	});
};
const after = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

await mkdir(out, { recursive: true });

// A four-second camera move: the previs has to have something to show, and the
// take is deliberately not 120 frames, so the node's frame readout can only be
// right if it follows the embed instead of the old placeholder length.
const sceneDocument = {
	version: 4,
	activeSceneId: "scene-playback-qa",
	scenes: [{
		id: "scene-playback-qa",
		name: "PLAYBACK QA",
		objects: [],
		shotDocument: {
			version: 4,
			frameCount: 96,
			shots: [{
				id: "playback-qa-shot",
				name: "Playback QA orbit",
				startFrame: 0,
				endFrame: 95,
				camera: { mode: "keys" },
				cameraKeys: [
					{ id: "playback-qa-key-a", frame: 0, framing: { pos: { x: -2.4, y: 1.7, z: 4.2 }, yaw: 0.5, pitch: -0.08, fovDeg: 45 } },
					{ id: "playback-qa-key-b", frame: 95, framing: { pos: { x: 2.4, y: 1.4, z: 2.1 }, yaw: -0.6, pitch: -0.16, fovDeg: 32 } },
				],
			}],
			waypoints: [],
		},
		stage: {
			characters: [{ id: "char-a", model: "y-bot-tpose", x: 0, z: 0, rot: 0, hidden: false, pose: null, subject: "a person" }],
			hasCharSheet: false,
			shotAspect: "16:9",
		},
	}],
};
const graph = {
	version: 1,
	nodes: [{ id: "scene-qa", type: "scene", position: { x: 120, y: 120 }, data: { label: "CozyClay Scene", sceneName: "CozyClay Scene", status: "idle", preview: "scene" } }],
	edges: [],
};

await evaluate(`(() => {
	localStorage.setItem("cozyclay.locale", "en");
	localStorage.setItem("cozyclay.project-session.v1", JSON.stringify({ name: "QA", updatedAt: Date.now() }));
	localStorage.setItem("${SCENES_STORAGE_KEY}", ${JSON.stringify(JSON.stringify(sceneDocument))});
	localStorage.setItem("cozyclay.workflow.v1", ${JSON.stringify(JSON.stringify(graph))});
})(), true`);
// Reload on the seeded storage, and wait for the document the assertions run
// against rather than racing the navigation with a poll.
await send("Page.enable");
const reloaded = new Promise((resolve) => {
	const onMessage = (event) => {
		if (JSON.parse(event.data).method !== "Page.loadEventFired") return;
		ws.removeEventListener("message", onMessage);
		resolve();
	};
	ws.addEventListener("message", onMessage);
});
await send("Page.reload", { ignoreCache: true });
await reloaded;

await waitFor("the workflow canvas", () => evaluate("!!document.querySelector('.react-flow__node')"));
const hasScene = await waitFor("the canvas to settle", () => evaluate("document.querySelector('.cozy-scene-node') ? 'scene' : 'none'"), 20000);
if (hasScene === "none") {
	await clickSelector(".workflow-canvas-panel button");
	await waitFor("a Scene node on the canvas", () => evaluate("!!document.querySelector('.cozy-scene-node')"));
	console.log("PASS the canvas had no Scene node, so one was added");
}
await waitFor("the node's embedded Studio", () => evaluate(`(() => {
	const frame = document.querySelector('.cozy-scene-node iframe');
	const live = frame && frame.contentWindow && frame.contentWindow.__cozyclay;
	return !!(live && live.rigA);
})()`));
console.log(`PASS the Scene node came up with its embedded Studio (${JSON.stringify(await embedState())})`);

// The take is the embed's, not a guess: the seeded shot is 96 frames and the
// studio stretches it to fit the cast's motion, so the only length the node can
// report correctly is the one the embed announces.
const timeline = await waitFor("the frame readout to follow the embedded take", async () => {
	const state = await embedState();
	const text = await evaluate("document.querySelector('.cozy-scene-node .cozy-scene-frame-control output').textContent");
	return state && text === `0/${state.frameCount - 1}` ? { text, frameCount: state.frameCount } : null;
}, 30000);
assert.notEqual(timeline.frameCount, 120, "the embedded take must differ from the node's placeholder length for this to prove anything");
console.log(`PASS the frame readout matches the embedded take: ${timeline.text}`);

// 1. Play before a Run: the un-rendered node has always shown the live embed,
// so this is the reference behaviour the rendered node has to match.
await clickSelector(".cozy-scene-node .cozy-scene-button");
await rolling("the embed to start playing");
const beforeA = await capturePreview();
await after(400);
const beforeB = await capturePreview();
await writeFile(`${out}/before-run-playing-a.png`, beforeA);
await writeFile(`${out}/before-run-playing-b.png`, beforeB);
assert.ok(!beforeA.equals(beforeB), "the preview has to move while playing before a Run");
console.log(`PASS Play animates the preview before a Run (${beforeA.length} vs ${beforeB.length} bytes)`);
await clickSelector(".cozy-scene-node .cozy-scene-button");
await settled();

// 2. Run: the node captures a framing PNG and reports it as its render.
await clickSelector(".cozy-scene-node .cozy-scene-run");
const status = await waitFor("the render to complete", async () => {
	const text = await evaluate("document.querySelector('.cozy-scene-node .cozy-scene-node-status').textContent");
	return text === "Render complete" ? text : null;
});
console.log(`PASS Run reports: ${JSON.stringify(status)}`);
assert.ok(await evaluate("!!document.querySelector('.cozy-scene-node iframe')"), "the live previs stays mounted after a Run");
assert.ok(await evaluate("!!document.querySelector('.cozy-scene-node .cozy-scene-render-thumb')"), "the captured frame is shown next to the live previs");
console.log("PASS after a Run the node keeps the live previs and shows the captured frame beside it");

// 3. Play after a Run: this is #218 — same pixels moving, same node.
await clickSelector(".cozy-scene-node .cozy-scene-button");
await rolling("the embed to start playing again");
const playingA = await capturePreview();
await after(400);
const playingB = await capturePreview();
await writeFile(`${out}/playing-a.png`, playingA);
await writeFile(`${out}/playing-b.png`, playingB);
assert.ok(!playingA.equals(playingB), "the rendered node's preview has to move while playing (#218)");
console.log(`PASS Play animates the preview after a Run (${playingA.length} vs ${playingB.length} bytes)`);

// 4. Pause: the same two captures have to come back identical.
await clickSelector(".cozy-scene-node .cozy-scene-button");
const paused = await settled();
const pausedA = await capturePreview();
await after(400);
const pausedB = await capturePreview();
await writeFile(`${out}/paused.png`, pausedA);
assert.ok(pausedA.equals(pausedB), "a paused preview must not move");
console.log(`PASS Pause stops the preview at frame ${paused.frame} (${pausedA.length} identical bytes)`);

// 5. The hand-off the previs exists for.
const before = await evaluate("({ nodes: document.querySelectorAll('.react-flow__node').length, edges: document.querySelectorAll('.react-flow__edge').length })");
await clickSelector(".cozy-scene-node .cozy-scene-video");
const linked = await waitFor("the new Video node and its edge", async () => {
	const now = await evaluate("({ nodes: document.querySelectorAll('.react-flow__node').length, edges: document.querySelectorAll('.react-flow__edge').length, video: document.querySelectorAll('.workflow-node-video').length })");
	return now.nodes === before.nodes + 1 && now.edges === before.edges + 1 ? now : null;
});
assert.ok(linked.video >= 1, "the added node is a Video node");
// The drawn edge is only half the claim: the saved graph has to carry the
// render -> input wiring a later Run reads.
const saved = await waitFor("the wired graph to be saved", async () => {
	const graphJson = await evaluate("localStorage.getItem('cozyclay.workflow.v1')");
	const parsed = JSON.parse(graphJson || "{}");
	const edge = (parsed.edges || [])[0];
	return edge ? { edge, video: (parsed.nodes || []).find((node) => node.id === edge.target) } : null;
}, 15000);
assert.equal(saved.edge.sourceHandle, "render", "the edge leaves the Scene node's render output");
assert.equal(saved.edge.targetHandle, "input", "the edge enters the Video node's input");
assert.equal(saved.video?.type, "video", "the connected node is a Video node");
console.log(`PASS → Video added a Video node and connected it (${JSON.stringify({ ...linked, edge: `${saved.edge.source}:${saved.edge.sourceHandle} -> ${saved.edge.target}:${saved.edge.targetHandle}` })})`);
await writeFile(`${out}/video-node.png`, Buffer.from((await send("Page.captureScreenshot", { format: "png" })).data, "base64"));

console.log(`PASS qa-scene-playback-browser: ${out}/{before-run-playing-a,before-run-playing-b,playing-a,playing-b,paused,video-node}.png`);
ws.close();
