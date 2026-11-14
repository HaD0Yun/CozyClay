#!/usr/bin/env node
// Browser contract for "Send to AI" on the Workflow Scene node (#168). The
// button has to reach the node's own embedded Studio, get a real keyframe pack
// back across the frame boundary, hand the bytes to the browser as a download
// and report the export. Nothing here is stubbed on the app side: the pack is
// built by the embedded Studio from a seeded shot, the only interception is
// HTMLAnchorElement.prototype.click, so the run does not open a file dialog.
//
// Run: `COZYCLAY_LIVE_PORT=5344 npm run dev -- --port 5340` in one shell, then
// `QA_URL=http://127.0.0.1:5340/workflow/ CDP_PORT=9468 node tools/qa-browser.mjs -- node test/qa-send-to-ai-browser.mjs`
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { SCENES_STORAGE_KEY } from "../src/scenes.js";

const cdpPort = Number(process.env.CDP_PORT || 9468);
const out = process.env.QA_OUT || "/tmp/send-to-ai-qa";
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
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
	throw new Error(`Timed out waiting for ${label}`);
};
const clickSelector = async (selector) => {
	const box = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
	assert.ok(box, `no element matches ${selector}`);
	for (const type of ["mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1, buttons: type === "mousePressed" ? 1 : 0 });
};

await mkdir(out, { recursive: true });

// A one-second authored shot with a camera move: the embedded Studio has to
// have something to pack, and both endpoint frames have to be renderable.
const sceneDocument = {
	version: 4,
	activeSceneId: "scene-send-qa",
	scenes: [{
		id: "scene-send-qa",
		name: "SEND QA",
		objects: [],
		shotDocument: {
			version: 4,
			frameCount: 24,
			shots: [{
				id: "send-qa-shot",
				name: "Send QA push in",
				startFrame: 0,
				endFrame: 23,
				camera: { mode: "keys" },
				cameraKeys: [
					{ id: "send-qa-key-a", frame: 0, framing: { pos: { x: 0, y: 1.6, z: 4 }, yaw: 0, pitch: -0.08, fovDeg: 45 } },
					{ id: "send-qa-key-b", frame: 23, framing: { pos: { x: 1.2, y: 1.5, z: 2.2 }, yaw: -0.35, pitch: -0.12, fovDeg: 34 } },
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
await send("Page.reload", { ignoreCache: true });

await waitFor("the Scene node", () => evaluate("!!document.querySelector('.cozy-scene-node .cozy-scene-send')"));
const idleStatus = await evaluate("document.querySelector('.cozy-scene-node .cozy-scene-node-status').textContent");
console.log(`PASS the Scene node renders a Send to AI button (status: ${JSON.stringify(idleStatus)})`);

// The embedded Studio is same-origin, so readiness is its own QA hook plus the
// seeded shot: exactly what the pack build reads. Waiting on this instead of a
// timer is what keeps the run from failing on a slow first WebGL context.
await waitFor("the embedded Studio to finish loading its shot", () => evaluate(`(() => {
	const frame = document.querySelector('.cozy-scene-node iframe');
	const live = frame && frame.contentWindow && frame.contentWindow.__cozyclay;
	return !!(live && live.rigA && typeof live.exportKeyframePack === "function");
})()`));
console.log("PASS the node's embedded Studio came up with the seeded shot");

// Intercept the download instead of letting Chrome write a zip to the QA
// profile: the assertion is about what the app hands the browser.
await evaluate(`(() => {
	window.__qaAnchors = [];
	const original = HTMLAnchorElement.prototype.click;
	HTMLAnchorElement.prototype.click = function () {
		if (this.download) { window.__qaAnchors.push({ download: this.download, href: this.href }); return; }
		return original.apply(this, arguments);
	};
	delete window.__cozyclayWorkflow;
})(), true`);

await clickSelector(".cozy-scene-node .cozy-scene-send");
const packing = await evaluate("(() => { const b = document.querySelector('.cozy-scene-node .cozy-scene-send'); return { label: b.textContent, disabled: b.disabled }; })()");
assert.equal(packing.label, "Packing…", "the button reports the pending export");
assert.equal(packing.disabled, true, "the button is disabled while the pack is being built");
console.log("PASS clicking Send to AI puts the button into its Packing… state");

const status = await waitFor("the pack result on the node", async () => {
	const text = await evaluate("document.querySelector('.cozy-scene-node .cozy-scene-node-status').textContent");
	return text && text !== "Ready when connected" && text !== "Rendering…" ? text : null;
});
assert.match(status, /^Pack ready: cozyclay-shot-\d+-[a-z0-9-]+\.zip \(\d+ files\)$/, `the node should show the pack name and file count, got: ${status}`);
console.log(`PASS the node reports the finished pack: ${JSON.stringify(status)}`);

const anchors = await evaluate("window.__qaAnchors");
assert.equal(anchors.length, 1, `exactly one download should have been triggered, got ${anchors.length}`);
assert.ok(anchors[0].download.startsWith("cozyclay-shot-"), `the download is named for the shot, got: ${anchors[0].download}`);
assert.ok(anchors[0].download.endsWith(".zip"), `the download is a zip, got: ${anchors[0].download}`);
assert.ok(anchors[0].href.startsWith("blob:"), `the download points at in-memory bytes, got: ${anchors[0].href}`);
assert.ok(status.includes(anchors[0].download), "the node names the same pack the browser was handed");
console.log(`PASS the pack reaches the browser as a download: ${anchors[0].download} -> ${anchors[0].href.slice(0, 24)}...`);

// track() is a no-op outside production builds, so the export report is
// asserted through the hook the click handler sets right after it.
const tracked = await evaluate("window.__cozyclayWorkflow && window.__cozyclayWorkflow.lastTrack");
assert.ok(tracked, "the click handler records the analytics event on its QA hook");
assert.equal(tracked.event, "export:keyframe_pack");
assert.equal(tracked.source, "workflow");
assert.ok(Number.isInteger(tracked.entries) && tracked.entries > 0, `the event carries the entry count, got: ${JSON.stringify(tracked)}`);
assert.ok(status.includes(`(${tracked.entries} files)`), "the reported entry count matches the line on the node");
console.log(`PASS the export is reported to analytics: ${JSON.stringify(tracked)}`);

const button = await evaluate("(() => { const b = document.querySelector('.cozy-scene-node .cozy-scene-send'); return { label: b.textContent, disabled: b.disabled }; })()");
assert.equal(button.label, "Send to AI", "the button returns to its idle label");
assert.equal(button.disabled, false, "the button is clickable again for the next export");
console.log("PASS the button returns to Send to AI when the export finishes");

await writeFile(`${out}/after.png`, Buffer.from((await send("Page.captureScreenshot", { format: "png" })).data, "base64"));
console.log(`PASS qa-send-to-ai-browser: ${out}/after.png`);
ws.close();
