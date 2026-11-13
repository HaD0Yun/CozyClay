#!/usr/bin/env node
// Browser contract for #663: a Follow shot keeps its subject in frame when the
// subject rides a routed object. The scene is seeded with a car on an 8 m
// route, Character 1 grouped under it (#655) and one Follow shot; the shot
// camera must end the take about its follow distance from the character's
// body, not parked behind the spot where the character was authored.
//
// Run: `COZYCLAY_LIVE_PORT=5890 npm run dev -- --port 5790`
// in one shell, then
// `QA_URL=http://127.0.0.1:5790/app/ CDP_PORT=9431 node tools/qa-browser.mjs -- node test/qa-camera-follow-carry-browser.mjs`
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { SCENES_STORAGE_KEY } from "../src/scenes.js";

const cdpPort = Number(process.env.CDP_PORT || 9431);
const out = process.env.QA_OUT || "/tmp/camera-follow-carry-qa";
const studioUrl = process.env.QA_URL ?? "http://127.0.0.1:5180/app/";
const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json();
const page = targets.find((target) => target.type === "page");
assert.ok(page, "no page target on the QA browser");

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
const evaluate = async (expression) => {
	const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
	if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || "browser evaluation failed");
	return result.result?.value;
};
const waitFor = async (label, probe, timeoutMs = 60000) => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const value = await probe().catch(() => null);
		if (value) return value;
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
	throw new Error(`Timed out waiting for ${label}`);
};

const FOLLOW_DISTANCE = 3;
const ROUTE = 8;
await send("Runtime.enable");
await send("Page.enable");
// Seed storage on a same-origin page that has no editor to autosave over it.
await send("Page.navigate", { url: `${new URL(studioUrl).origin}/favicon.ico` });
await evaluate(`(() => {
	const shot = {
		id: "follow-carry-qa", name: "Follow carry QA", startFrame: 0, endFrame: 359,
		cameraKeys: [{ frame: 0, framing: { pos: { x: 0, y: 1.6, z: -3 }, yaw: Math.PI, pitch: -0.1, fovDeg: 45 } }],
		camera: { mode: "follow", followCam: { distance: ${FOLLOW_DISTANCE}, height: 1.6, response: 0.7, lead: 0.25, maxDollySpeed: 4, pitchOffsetDeg: 0, orbitOffsetDeg: 0 } },
	};
	const scene = {
		version: 4, activeSceneId: "scene-follow-carry",
		scenes: [{
			id: "scene-follow-carry", name: "FOLLOW CARRY QA", objects: [],
			shotDocument: { version: 4, frameCount: 360, shots: [shot], waypoints: [] },
			stage: { characters: [{ id: "char-a", model: "y-bot-tpose", x: 0, y: 0.62, z: 0, rot: 0, hidden: false, pose: null, subject: "a driver" }], hasCharSheet: false, shotAspect: "16:9" },
		}],
	};
	localStorage.clear();
	localStorage.setItem("cozyclay.locale", "en");
	localStorage.setItem("cozyclay.project-session.v1", JSON.stringify({ name: "Follow carry QA", updatedAt: Date.now() }));
	localStorage.setItem(${JSON.stringify(SCENES_STORAGE_KEY)}, JSON.stringify(scene));
})()`);
await send("Page.navigate", { url: studioUrl });
await waitFor("studio QA hook", () => evaluate("Boolean(window.__cozyclay?.scrub && window.__cozyclay.rigA?.parent && window.__cozyclay.shotCam)"));

// The car is built the way the app builds one, routed, and the character is
// grouped under it by dragging its Outliner row onto the car's row (#655).
const car = await evaluate(`(() => {
	const api = window.__cozyclay.sceneObject;
	const id = api.place({ kind: "cube", name: "Vintage Car", x: 0, y: 0.4, z: 0 }).id;
	api.update({ id, scaleX: 1.3, scaleY: 0.22, scaleZ: 3.6, path: { points: [{ x: 0, y: 0.4, z: 0 }, { x: 0, y: 0.4, z: ${ROUTE} }] } });
	return id;
})()`);
await waitFor("car row", () => evaluate(`(() => {
	if (document.querySelector('[data-node-id="object:${car}"]')) return true;
	const fold = document.querySelector('[data-node-id="props"] .hierarchy-toggle');
	if (fold && fold.textContent.trim() === "▸") fold.click();
	return null;
})()`));
await evaluate(`(() => {
	const source = document.querySelector('[data-node-id="characterA"]');
	const target = document.querySelector('[data-node-id="object:${car}"]');
	const dataTransfer = new DataTransfer();
	const fire = (node, type) => node.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer }));
	fire(source, "dragstart"); fire(target, "dragenter"); fire(target, "dragover"); fire(target, "drop"); fire(source, "dragend");
})()`);
await waitFor("character grouped under the car", () => evaluate(`window.__cozyclay.charA.parent === ${JSON.stringify(car)} || null`));

const at = async (frame) => {
	await evaluate(`window.__cozyclay.scrub(${frame})`);
	await waitFor(`frame ${frame}`, () => evaluate(`window.__cozyclay.tlFrame === ${frame} || null`));
	// Let the frame loop place the carrier and the follow rig.
	await new Promise((resolve) => setTimeout(resolve, 400));
	return evaluate(`(() => {
		const body = window.__cozyclay.rigA.parent;
		body.updateWorldMatrix(true, false);
		const b = body.getWorldPosition(body.position.clone());
		const c = window.__cozyclay.shotCam.position;
		return { body: { x: b.x, y: b.y, z: b.z }, camera: { x: c.x, y: c.y, z: c.z }, planar: Math.hypot(c.x - b.x, c.z - b.z) };
	})()`);
};
await mkdir(out, { recursive: true });
const report = [];
for (const frame of [0, 180, 359]) {
	const sample = await at(frame);
	report.push({ frame, bodyZ: +sample.body.z.toFixed(3), cameraZ: +sample.camera.z.toFixed(3), planar: +sample.planar.toFixed(3) });
	const image = await send("Page.captureScreenshot", { format: "png" });
	await writeFile(`${out}/follow-${frame}.png`, Buffer.from(image.data, "base64"));
}
console.log(JSON.stringify(report));
const last = report.at(-1);
assert.ok(Math.abs(last.bodyZ - ROUTE) < 1e-3, `the character rides the car to z ${ROUTE}: ${JSON.stringify(last)}`);
// The follow grip lags by design (response, max dolly speed); it must still be
// on the subject, not ROUTE metres behind it at the authored spot.
for (const row of report) {
	assert.ok(row.planar < FOLLOW_DISTANCE + 1.5, `frame ${row.frame}: camera ${row.planar} m from the riding character; the follow lost its subject (${JSON.stringify(report)})`);
}
assert.ok(last.cameraZ - report[0].cameraZ > ROUTE - 1.5, `the camera travels with the car: ${JSON.stringify(report)}`);
console.log(`camera follow carry browser QA: the Follow shot keeps the riding character (screenshots in ${out})`);
ws.close();
