#!/usr/bin/env node
// Issue #193: the camera inspector lost its duplicate Lens/Recenter controls,
// so the viewport camera bar is their only home — and that bar only shows in
// Camera mode. Selecting the camera
// must therefore ENTER Camera mode, from the hierarchy row and from a Shot
// block, or the controls would be selected-but-invisible.
//
// Run: `npm run dev:ui` in one shell, then
//   QA_URL=http://127.0.0.1:5180/app/ node tools/qa-browser.mjs -- \
//     node test/verify-camera-mode-browser.mjs

import { SCENES_STORAGE_KEY } from "../src/scenes.js";

const origin = new URL(process.env.QA_URL ?? "http://127.0.0.1:5180/app/").origin;
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
ws.onmessage = (event) => {
	const message = JSON.parse(event.data);
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
const waitFor = async (expression, timeoutMs = 30000) => {
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

const clickAt = async ({ x, y }) => {
	await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1, buttons: 1 });
	await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1, buttons: 0 });
};
const centreOf = async (expression) => {
	const centre = await evaluate(
		`(() => { const el = ${expression}; if (!el) return null; const r = el.getBoundingClientRect();` +
			" return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()",
	);
	if (!centre) throw new Error(`no element for ${expression}`);
	return centre;
};

// One authored Shot, seeded on a blank same-origin document so the studio
// reads it on its first paint (the same trick tools/qa-browser.mjs uses for
// the project session — a seed written into a live studio races its own save).
await send("Page.enable");
await send("Page.navigate", { url: `${origin}/favicon.ico` });
await sleep(500);
await evaluate(`(() => {
	const shot = { id: "camera-mode-shot", name: "Shot 1", startFrame: 0, endFrame: 47, camera: { mode: "keys" },
		cameraKeys: [{ frame: 0, framing: { pos: { x: 0, y: 1.6, z: 3 }, yaw: 0, pitch: -0.08, fovDeg: 45 } }] };
	const document = { version: 4, activeSceneId: "scene-camera-mode", scenes: [{
		id: "scene-camera-mode", name: "CAMERA MODE QA", objects: [],
		shotDocument: { version: 4, frameCount: 144, shots: [shot], waypoints: [] },
		stage: { characters: [{ id: "char-a", model: "y-bot-tpose", x: 0, z: 0, rot: 0, hidden: false, pose: null, subject: "a person" }], hasCharSheet: false, shotAspect: "16:9" },
	}] };
	localStorage.setItem("cozyclay.locale", "en");
	localStorage.setItem("cozyclay.project-session.v1", JSON.stringify({ name: "QA", updatedAt: Date.now() }));
	localStorage.setItem("${SCENES_STORAGE_KEY}", JSON.stringify(document));
})()`);
await send("Page.navigate", { url: `${origin}/app/` });
expect("the seeded studio becomes ready", await waitFor("!!window.__cozyclay?.editorCam"));
expect("the seeded Shot is on the timeline", await waitFor("!!document.querySelector('.tl-shot-block')"));

const mode = () => evaluate("document.querySelector('.app')?.dataset.workflowMode");
const fovVisible = () => evaluate(
	`(() => { const el = document.querySelector('.viewport-titlebar .viewport-fov-control input[type=range]'); if (!el) return false;` +
		" const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 2 && r.height > 2 && s.visibility !== 'hidden' && s.display !== 'none'; })()",
);
// Subscribe to the mode attribute BEFORE clicking, then await the change.
const armMode = (next) =>
	evaluate(`window.__modeChange = new Promise((resolve) => {
		const app = document.querySelector('.app');
		if (app.dataset.workflowMode === ${JSON.stringify(next)}) { resolve('already'); return; }
		const obs = new MutationObserver(() => {
			if (app.dataset.workflowMode === ${JSON.stringify(next)}) { obs.disconnect(); clearTimeout(t); resolve('changed'); }
		});
		obs.observe(app, { attributes: true, attributeFilter: ['data-workflow-mode'] });
		const t = setTimeout(() => { obs.disconnect(); resolve('timeout'); }, 5000);
	}), true`);
const modeSettled = () => evaluate("window.__modeChange");
const clickModeTab = async (label) => {
	await armMode(label.toLowerCase());
	const key = { Scene: "1", Pose: "2", Camera: "3", Motion: "4" }[label];
	await clickAt(await centreOf(`document.querySelector('[data-mode-key="${key}"]')`));
	return modeSettled();
};

/* ---------------------------------------- hierarchy row: Scene → Camera */
expect("the studio starts outside Camera mode", (await clickModeTab("Scene")) !== "timeout" && (await mode()) === "scene");
expect("Scene mode hides the camera bar's FOV control", (await fovVisible()) === false);

await armMode("camera");
await clickAt(await centreOf("[...document.querySelectorAll('.hierarchy-left [role=treeitem], .hierarchy-left button, .hierarchy-left li')].find((el) => el.textContent.trim() === 'Camera')"));
expect("clicking the Camera row enters Camera mode", (await modeSettled()) !== "timeout", String(await mode()));
// The FOV slider lives in the Camera mode lens popover of the G1 toolbar.
expect("Camera mode shows the lens value", await waitFor("!!document.querySelector('[data-testid=\"lens-value\"]')", 5000));
await clickAt(await centreOf("document.querySelector('[data-testid=\"lens-value\"]')"));
expect("the camera bar's FOV control is on screen", await waitFor(
	`(() => { const el = document.querySelector('.viewport-titlebar .viewport-fov-control input[type=range]'); if (!el) return false;` +
		" const r = el.getBoundingClientRect(); return r.width > 2 && r.height > 2; })()",
	5000,
));
// Recenter lives in the Perspective view list next to the framing presets.
await clickAt(await centreOf("document.querySelector('[data-testid=\"view-camera-trigger\"]')"));
await waitFor("!!document.querySelector('[aria-label=\"Recenter on subject\"]')", 5000);
expect("Recenter has exactly one visible home", (await evaluate(
	`[...document.querySelectorAll('[aria-label="Recenter on subject"], .btn')].filter((el) => {` +
		" const r = el.getBoundingClientRect();" +
		" return r.width > 2 && r.height > 2 && /Recenter/.test(el.getAttribute('aria-label') || el.textContent); }).length",
)) === 1);

/* ------------------------------------------ Shot block: Scene → Camera */
expect("Scene mode is reachable again", (await clickModeTab("Scene")) !== "timeout");
await armMode("camera");
await clickAt(await centreOf("document.querySelector('.tl-shot-block')"));
expect("clicking a Shot block enters Camera mode", (await modeSettled()) !== "timeout", String(await mode()));

ws.close();
if (failures) process.exit(1);
console.log("all camera-mode selection browser checks PASS — hierarchy row and Shot block both open the camera bar");
