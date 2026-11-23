#!/usr/bin/env node
// Browser contract for the Top-View while a camera rail is drawn: on a 200 m
// scene it opens framed on all of it, middle- and right-drag pan it, a rail
// drawn at the far end (with a pan in the middle of the stroke) lands where
// the pointer was on the floor, the wheel zooms about the pointer, Home over
// the view returns to the opening framing, and on a small scene a rail drawn
// without panning lands on the same points as before the pan existed. Also:
// Alt + left-drag pans (a touchpad's drag), Home in a text field stays the
// caret's, the Top-View opens framed for an object path too, a framing the
// view chose is shown in the tag but is not the zoom the next scene opens with,
// and the opening holds the whole travel of a body its take carries 300 m.
// Run: node tools/qa-browser.mjs -- node test/verify-plan-pan-browser.mjs
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterPageLoad } from "./bus/browser-navigation.mjs";
import { waitForFrameState } from "./bus/browser-frame-state.mjs";
import { SCENES_STORAGE_KEY } from "../src/scenes.js";
import { simplifyStroke } from "../src/camera-follow.js";
import { createSceneObject } from "../src/scene-objects.js";

const port = Number(process.env.CDP_PORT || 9222);
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
if (!page) throw new Error("no page target on the QA browser");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
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
const send = (method, params = {}) => afterPageLoad(ws, method, () => new Promise((resolve, reject) => {
	const id = nextId++;
	pending.set(id, { resolve, reject });
	ws.send(JSON.stringify({ id, method, params }));
}));
const evaluate = async (expression) => {
	const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
	if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || "evaluate failed");
	return result.result.value;
};
const waitFor = (expression, timeoutMs = 15000) => waitForFrameState(evaluate, expression, timeoutMs);
const frames = (count = 2) => evaluate(`new Promise((resolve) => { let n = ${count}; const step = () => (--n <= 0 ? resolve(true) : requestAnimationFrame(step)); requestAnimationFrame(step); })`);

let failures = 0;
const expect = (name, condition, detail = "") => {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
};
const shotDir = process.env.QA_SHOT_DIR;
const screenshot = async (name) => {
	if (!shotDir) return;
	await frames(3);
	const capture = await send("Page.captureScreenshot", { format: "png" });
	writeFileSync(join(shotDir, `${name}.png`), Buffer.from(capture.data, "base64"));
};

// Mouse input as the browser delivers it: CDP mouse events become pointer events.
const BUTTON_BITS = { none: 0, left: 1, right: 2, middle: 4 };
let held = 0;
const mouse = (type, x, y, button = "none", extra = {}) => {
	if (type === "mousePressed") held |= BUTTON_BITS[button];
	if (type === "mouseReleased") held &= ~BUTTON_BITS[button];
	return send("Input.dispatchMouseEvent", { type, x, y, button, buttons: held, clickCount: type === "mouseMoved" ? 0 : 1, ...extra });
};
const ALT = { modifiers: 1 };
const drag = async (button, from, to, steps = 8, extra = {}) => {
	await mouse("mouseMoved", from.x, from.y, "none", extra);
	await mouse("mousePressed", from.x, from.y, button, extra);
	for (let i = 1; i <= steps; i += 1) await mouse("mouseMoved", from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps, button, extra);
	await mouse("mouseReleased", to.x, to.y, button, extra);
	await frames();
};
const wheel = async (x, y, deltaY) => {
	await mouse("mouseMoved", x, y);
	await send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY });
	await frames();
};
const key = async (code, keyName, vk) => {
	for (const type of ["keyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, code, key: keyName, windowsVirtualKeyCode: vk });
	await frames();
};

// The plan camera as the board sees it, and the floor point under a page point.
const planState = () => evaluate(`(() => {
	const cam = window.__cozyclay.planCam, pane = document.querySelector('.vp-inset.plan').getBoundingClientRect();
	if (!cam) throw new Error("no plan camera on window.__cozyclay");
	return { x: cam.position.x, z: cam.position.z, left: cam.left, right: cam.right, top: cam.top, bottom: cam.bottom,
		pane: { left: pane.left, top: pane.top, width: pane.width, height: pane.height },
		keptZoom: JSON.parse(localStorage.getItem("cozyclay.workspace-layout.v1") || "{}").planZoom ?? 1,
		readout: document.querySelector('.vp-inset-zoom')?.textContent ?? null,
		editor: window.__cozyclay.editorCam ? window.__cozyclay.editorCam.position.toArray() : null };
})()`);
const floorAt = (state, px, py) => {
	const u = ((px - state.pane.left) / state.pane.width) * 2 - 1;
	const v = ((py - state.pane.top) / state.pane.height) * 2 - 1;
	return { x: state.x + u * state.right, z: state.z + v * state.top };
};

// The inset rises into place when it appears: measure it once it stands still.
const settlePane = async () => {
	await evaluate("Promise.all(document.querySelector('.vp-inset.plan').getAnimations({ subtree: true }).map((animation) => animation.finished)).then(() => true)");
	await frames(3);
};
const seed = async ({ objects, characters, keepLayout = false }) => {
	await send("Page.navigate", { url: `${new URL(studioUrl).origin}/favicon.ico` });
	const shot = {
		id: "pan-qa", name: "Pan QA", startFrame: 0, endFrame: 239,
		cameraKeys: [{ frame: 0, framing: { pos: { x: 0, y: 1.6, z: 3 }, yaw: 0, pitch: -0.1, fovDeg: 45 } }],
		camera: { mode: "follow", followCam: { distance: 3, height: 1.6, response: 0.7, lead: 0.25, railStartMode: "head", maxDollySpeed: 4, pitchOffsetDeg: 0, orbitOffsetDeg: 180 }, cameraRail: null, railFollow: null },
	};
	const scene = { version: 4, activeSceneId: "scene-pan-qa", scenes: [{ id: "scene-pan-qa", name: "PAN QA", objects,
		shotDocument: { version: 4, frameCount: 240, shots: [shot], waypoints: [] },
		stage: { characters, hasCharSheet: false, shotAspect: "16:9" } }] };
	await evaluate(`(() => {
		const layout = ${keepLayout} ? localStorage.getItem("cozyclay.workspace-layout.v1") : null;
		localStorage.clear();
		if (layout) localStorage.setItem("cozyclay.workspace-layout.v1", layout);
		localStorage.setItem("cozyclay.locale", "en");
		localStorage.setItem("cozyclay.project-session.v1", JSON.stringify({ name: "Pan QA", updatedAt: Date.now() }));
		localStorage.setItem(${JSON.stringify(SCENES_STORAGE_KEY)}, ${JSON.stringify(JSON.stringify(scene))});
	})()`);
	await send("Page.navigate", { url: studioUrl });
	expect("studio renders", await waitFor("!!window.__cozyclay?.planCam && !!window.__cozyclay?.shotCam && !!document.querySelector('.tl-shot-block')", 60000));
	await evaluate("document.querySelector('.tl-shot-block')?.click()");
	expect("Draw rail is offered", await waitFor("!!document.querySelector('[data-testid=sequencer-draw-rail]')"));
	await openRail();
};
const openRail = async () => {
	await evaluate("document.querySelector('[data-testid=sequencer-draw-rail]').click()");
	expect("the Top-View opens for the rail", await waitFor("document.querySelector('.app')?.dataset.railDraw === '1' && document.querySelector('.vp-inset.plan')?.getBoundingClientRect().width > 100"));
	await settlePane();
};
const storedRail = () => evaluate(`(() => {
	const body = JSON.parse(localStorage.getItem(${JSON.stringify(SCENES_STORAGE_KEY)}));
	return body.scenes[0].shotDocument.shots[0].camera.cameraRail;
})()`);

await send("Runtime.enable");
await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1438, height: 979, deviceScaleFactor: 1, mobile: false });
const studioUrl = process.env.QA_URL ?? "http://127.0.0.1:5180/app/";

// ---- 1. a 200 m scene: a long floor along +x, a post at each end
// QA_NO_PAN_ONLY=1 runs only part 2, so it can run on the branch point's sources too.
const longScene = async () => {
	const LONG = 200;
	await seed({
		objects: [
			{ ...createSceneObject("cube"), id: "runway", name: "Runway", x: LONG / 2, scaleX: LONG, scaleY: 0.05, scaleZ: 4 },
			{ ...createSceneObject("cube"), id: "post-end", name: "End", x: LONG },
		],
		characters: [{ id: "char-a", model: "y-bot-tpose", x: 0, z: 0, rot: 0, hidden: false, pose: null, subject: "a person" }],
	});
	const opened = await planState();
	expect("the opening framing holds the whole 200 m", opened.x + opened.left <= 0 && opened.x + opened.right >= LONG, JSON.stringify(opened));
	// The framing the view chose is what the tag shows; the layout keeps the zoom the wheel set (none yet).
	expect("the opening framing is shown in the tag and is not the kept zoom", opened.keptZoom === 1 && opened.readout === `${Number((12.4 / opened.top).toFixed(2))}×`, JSON.stringify({ kept: opened.keptZoom, readout: opened.readout, top: opened.top }));
	await screenshot("1-opened");

	// Zoom in at the pane centre, then pan toward the far end: middle-drag, then right-drag.
	const centre = { x: opened.pane.left + opened.pane.width / 2, y: opened.pane.top + opened.pane.height / 2 };
	const centreWorld = floorAt(opened, centre.x, centre.y);
	for (let i = 0; i < 6; i += 1) await wheel(centre.x, centre.y, -200);
	const zoomedIn = await planState();
	const centreAfter = floorAt(zoomedIn, centre.x, centre.y);
	expect("the wheel zooms in", zoomedIn.top < opened.top / 4, `${opened.top} -> ${zoomedIn.top}`);
	expect("the wheel zoom keeps the floor point under the pointer", Math.abs(centreAfter.x - centreWorld.x) < 0.05 && Math.abs(centreAfter.z - centreWorld.z) < 0.05, JSON.stringify({ centreWorld, centreAfter }));
	const span = opened.pane.width * 0.8;
	let before = zoomedIn;
	// Alt + left-drag is the pan a touchpad has: it moves the view and starts no stroke.
	for (const button of ["middle", "right", "alt-left", "middle", "right", "alt-left"]) {
		const alt = button === "alt-left";
		await drag(alt ? "left" : button, { x: centre.x + span / 2, y: centre.y }, { x: centre.x - span / 2, y: centre.y + 10 }, 8, alt ? ALT : {});
		const now = await planState();
		const moved = now.x - before.x;
		const expected = (span / opened.pane.width) * 2 * now.right;
		expect(`${button}-drag pans the view (the floor follows the pointer)`, Math.abs(moved - expected) < 0.05 && now.z < before.z, JSON.stringify({ moved, expected }));
		expect(`${button}-drag leaves the rail drawing open`, await evaluate("document.querySelector('.app')?.dataset.railDraw === '1'"));
		before = now;
		if (now.x + now.right > LONG + 5) break;
	}
	expect("the pans left the editor camera alone", JSON.stringify(before.editor) === JSON.stringify(opened.editor));
	// The editor camera's own right-drag (fly) and middle-drag (pan) over the main view are not the Top-View's.
	const mainView = await evaluate("(() => { const r = document.querySelector('.vp-main').getBoundingClientRect(); return { x: r.left + r.width * 0.7, y: r.top + r.height * 0.6 }; })()");
	for (const button of ["right", "middle"]) {
		const editorBefore = JSON.stringify((await planState()).editor);
		const editorLook = await evaluate("JSON.stringify(window.__cozyclay.editorCam.quaternion.toArray())");
		await drag(button, mainView, { x: mainView.x - 90, y: mainView.y + 36 });
		const now = await planState();
		const editorMoved = JSON.stringify(now.editor) !== editorBefore || (await evaluate("JSON.stringify(window.__cozyclay.editorCam.quaternion.toArray())")) !== editorLook;
		expect(`a ${button}-drag over the main view moves the editor camera and leaves the Top-View`, editorMoved && now.x === before.x && now.z === before.z && now.top === before.top, JSON.stringify({ editorMoved, moved: [now.x - before.x, now.z - before.z] }));
	}
	expect("no rail was drawn by the pan gestures", (await storedRail()) === null || (await storedRail()) === undefined);
	const panned = await planState();
	expect("the view reaches the far end", panned.x + panned.right >= LONG && panned.x - panned.right > LONG / 2, JSON.stringify(panned));
	await screenshot("2-panned");

	// A stroke at the far end, with a middle-button chord pan in its middle.
	const p0 = { x: panned.pane.left + panned.pane.width * 0.2, y: panned.pane.top + panned.pane.height * 0.3 };
	const p1 = { x: panned.pane.left + panned.pane.width * 0.8, y: panned.pane.top + panned.pane.height * 0.3 };
	const w0 = floorAt(panned, p0.x, p0.y), w1 = floorAt(panned, p1.x, p1.y);
	await mouse("mouseMoved", p0.x, p0.y);
	await mouse("mousePressed", p0.x, p0.y, "left");
	for (let i = 1; i <= 10; i += 1) await mouse("mouseMoved", p0.x + ((p1.x - p0.x) * i) / 10, p0.y, "left");
	await frames();
	// chord: middle down while the left is held, drag the view right (floor under the pointer follows)
	await mouse("mousePressed", p1.x, p1.y, "middle");
	for (let i = 1; i <= 6; i += 1) await mouse("mouseMoved", p1.x - (panned.pane.width * 0.5 * i) / 6, p1.y + (panned.pane.height * 0.4 * i) / 6, "middle");
	const pc = { x: p1.x - panned.pane.width * 0.5, y: p1.y + panned.pane.height * 0.4 };
	await mouse("mouseReleased", pc.x, pc.y, "middle");
	await frames();
	const mid = await planState();
	const wc = floorAt(mid, pc.x, pc.y);
	expect("the chord pan moved the view, not the stroke", Math.abs(wc.x - w1.x) < 0.1 && Math.abs(wc.z - w1.z) < 0.1 && mid.x > panned.x, JSON.stringify({ w1, wc }));
	const p2 = { x: pc.x, y: pc.y + panned.pane.height * 0.3 };
	for (let i = 1; i <= 8; i += 1) await mouse("mouseMoved", pc.x, pc.y + ((p2.y - pc.y) * i) / 8, "left");
	await mouse("mouseReleased", p2.x, p2.y, "left");
	const w2 = floorAt(mid, p2.x, p2.y);
	expect("the rail stroke is saved", await waitFor(`(() => { const body = JSON.parse(localStorage.getItem(${JSON.stringify(SCENES_STORAGE_KEY)})); return Array.isArray(body.scenes[0].shotDocument.shots[0].camera.cameraRail); })()`));
	const rail = await storedRail();
	const first = rail?.[0], last = rail?.[rail.length - 1];
	const corner = rail?.reduce((best, point) => (Math.hypot(point.x - w1.x, point.z - w1.z) < Math.hypot(best.x - w1.x, best.z - w1.z) ? point : best), rail[0]);
	expect("the rail starts where the press was on the floor", first && Math.abs(first.x - w0.x) < 0.05 && Math.abs(first.z - w0.z) < 0.05, JSON.stringify({ first, w0 }));
	expect("the point placed before the chord pan stays where it was in the world", corner && Math.hypot(corner.x - w1.x, corner.z - w1.z) < 0.15, JSON.stringify({ corner, w1 }));
	expect("the rail ends where the release was, after the pan", last && Math.abs(last.x - w2.x) < 0.05 && Math.abs(last.z - w2.z) < 0.05, JSON.stringify({ last, w2 }));
	expect("the whole rail lies at the far end", rail.every((point) => point.x > LONG / 2), JSON.stringify(rail));
	console.log(`rail world points: ${JSON.stringify(rail.map((point) => [Number(point.x.toFixed(2)), Number(point.z.toFixed(2))]))}`);

	// Zoom out about a pointer near a corner, then Home over the view.
	await evaluate("document.querySelector('[data-testid=sequencer-draw-rail]').click()");
	expect("the rail drawing reopens", await waitFor("document.querySelector('.app')?.dataset.railDraw === '1'"));
	await settlePane();
	const reopened = await planState();
	const corner2 = { x: reopened.pane.left + reopened.pane.width * 0.85, y: reopened.pane.top + reopened.pane.height * 0.2 };
	const cornerWorld = floorAt(reopened, corner2.x, corner2.y);
	await wheel(corner2.x, corner2.y, -300);
	await wheel(corner2.x, corner2.y, -300);
	const zoomed = await planState();
	const cornerAfter = floorAt(zoomed, corner2.x, corner2.y);
	expect("the wheel zooms about the pointer", zoomed.top < reopened.top && Math.abs(cornerAfter.x - cornerWorld.x) < 0.05 && Math.abs(cornerAfter.z - cornerWorld.z) < 0.05, JSON.stringify({ cornerWorld, cornerAfter }));
	await screenshot("3-zoomed");
	await key("Home", "Home", 36);
	const homed = await planState();
	expect("Home over the Top-View returns to the opening framing", Math.abs(homed.x - reopened.x) < 1e-6 && Math.abs(homed.z - reopened.z) < 1e-6 && Math.abs(homed.top - reopened.top) < 1e-6, JSON.stringify({ homed, reopened }));
	expect("Home over the Top-View leaves the editor camera alone", JSON.stringify(homed.editor) === JSON.stringify(zoomed.editor));

	// Home in a text field is the caret's, also while the pointer rests over the Top-View.
	await wheel(corner2.x, corner2.y, -300);
	const beforeTyping = await planState();
	const field = await evaluate("(() => { const r = document.querySelector('.v2-outliner-search').getBoundingClientRect(); return { x: r.left + 20, y: r.top + r.height / 2 }; })()");
	await mouse("mouseMoved", field.x, field.y);
	await mouse("mousePressed", field.x, field.y, "left");
	await mouse("mouseReleased", field.x, field.y, "left");
	await send("Input.insertText", { text: "abcdef" });
	await mouse("mouseMoved", corner2.x, corner2.y);
	await key("Home", "Home", 36);
	const typed = await evaluate("({ field: document.activeElement.className, caret: document.activeElement.selectionStart, value: document.activeElement.value })");
	const afterTyping = await planState();
	expect("Home in a text field moves the caret, not the Top-View", typed.value === "abcdef" && typed.caret === 0 && afterTyping.x === beforeTyping.x && afterTyping.z === beforeTyping.z && afterTyping.top === beforeTyping.top, JSON.stringify({ typed, beforeTyping, afterTyping }));
	// Empty the search again through the input's own setter, so the Outliner lists every row.
	await evaluate("(() => { const field = document.activeElement; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field, ''); field.dispatchEvent(new Event('input', { bubbles: true })); field.blur(); })()");
	await mouse("mouseMoved", 20, 400);
	await key("Escape", "Escape", 27);
	if (await evaluate("document.querySelector('.app')?.dataset.railDraw === '1'")) await evaluate("document.querySelector('[data-testid=sequencer-draw-rail]').click()");
	expect("the rail drawing closes", await waitFor("document.querySelector('.app')?.dataset.railDraw !== '1'"));

	// The Top-View opens framed for an object path too, not on the corner the rail drawing was left at.
	await evaluate(`(() => { const fold = document.querySelector('[data-node-id="props"] .hierarchy-toggle'); if (fold && fold.textContent.trim() === "▸") fold.click(); })()`);
	expect("the prop is listed", await waitFor(`!!document.querySelector('[data-node-id="object:post-end"] .hierarchy-row')`));
	await evaluate(`document.querySelector('[data-node-id="object:post-end"] .hierarchy-row').click()`);
	expect("Draw path is offered", await waitFor("!!document.querySelector('.objmo-tools .tl-camera-tool')"));
	await evaluate("document.querySelector('.objmo-tools .tl-camera-tool').click()");
	expect("the Top-View opens for the path", await waitFor("!!document.querySelector('.objmo-tools .tl-camera-tool.active') && document.querySelector('.vp-inset.plan')?.getBoundingClientRect().width > 100"));
	await settlePane();
	const forPath = await planState();
	expect("the path drawing opens on the whole 200 m", forPath.x + forPath.left <= 0 && forPath.x + forPath.right >= LONG, JSON.stringify(forPath));
	await evaluate("document.querySelector('.objmo-tools .tl-camera-tool.active')?.click()");
};
if (!process.env.QA_NO_PAN_ONLY) await longScene();

// ---- 2. a small scene, no pan: the rail lands on the branch point's points
await seed({
	objects: [{ ...createSceneObject("cube"), id: "box", name: "Box", x: 2, z: -3 }],
	characters: [{ id: "char-a", model: "y-bot-tpose", x: 0, z: 0, rot: 0, hidden: false, pose: null, subject: "a person" }],
});
const small = await planState();
const aspect = small.pane.width / small.pane.height;
// The renderer sets the camera's width from the pane's rect each frame, and that rect carries float noise
// while the pane rises into place (measured 9e-7 m): the width is held to 10 micrometres.
expect("a small scene opens on the old view: the stage centre at the stored zoom", small.x === 0 && small.z === 0 && Math.abs(small.top - 12.4) < 1e-9 && Math.abs(small.right - 12.4 * aspect) < 1e-5, JSON.stringify(small));
// The old mapping: an orthographic camera over the stage centre, 12.4 m half height.
const oldFloor = (px, py) => ({ x: (((px - small.pane.left) / small.pane.width) * 2 - 1) * 12.4 * aspect, z: (((py - small.pane.top) / small.pane.height) * 2 - 1) * 12.4 });
const path = [];
for (let i = 0; i <= 16; i += 1) {
	const t = i / 16;
	path.push({ x: small.pane.left + small.pane.width * (0.25 + 0.5 * t), y: small.pane.top + small.pane.height * (0.7 - 0.4 * Math.sin(Math.PI * t)) });
}
await mouse("mouseMoved", path[0].x, path[0].y);
await mouse("mousePressed", path[0].x, path[0].y, "left");
for (const point of path.slice(1)) await mouse("mouseMoved", point.x, point.y, "left");
await mouse("mouseReleased", path.at(-1).x, path.at(-1).y, "left");
expect("the small rail is saved", await waitFor(`(() => { const body = JSON.parse(localStorage.getItem(${JSON.stringify(SCENES_STORAGE_KEY)})); return Array.isArray(body.scenes[0].shotDocument.shots[0].camera.cameraRail); })()`));
// The board's own sampling (a new point once 6 cm from the last), then the app's simplification.
const stroke = [oldFloor(path[0].x, path[0].y)];
for (const point of path.slice(1)) {
	const floor = oldFloor(point.x, point.y), tail = stroke.at(-1);
	if (Math.hypot(floor.x - tail.x, floor.z - tail.z) > 0.06) stroke.push(floor);
}
const expected = simplifyStroke(stroke, 0.12);
const smallRail = await storedRail();
const equal = smallRail.length === expected.length && smallRail.every((point, i) => Math.abs(point.x - expected[i].x) < 1e-3 && Math.abs(point.z - expected[i].z) < 1e-3);
expect("a rail drawn without panning has the branch point's points", equal, JSON.stringify({ smallRail, expected }));
console.log(`no-pan rail: ${JSON.stringify(smallRail.map((point) => [Number(point.x.toFixed(3)), Number(point.z.toFixed(3))]))}`);

// ---- 3. a long scene's framing is not the zoom the next scene opens with
if (!process.env.QA_NO_PAN_ONLY) {
	await seed({
		objects: [{ ...createSceneObject("cube"), id: "runway", name: "Runway", x: 100, scaleX: 200, scaleY: 0.05, scaleZ: 4 }],
		characters: [{ id: "char-a", model: "y-bot-tpose", x: 0, z: 0, rot: 0, hidden: false, pose: null, subject: "a person" }],
	});
	const long = await planState();
	expect("the long scene opens framed whole, the wheel untouched", long.x + long.right >= 200 && long.keptZoom === 1, JSON.stringify(long));
	await seed({
		objects: [{ ...createSceneObject("cube"), id: "box", name: "Box", x: 2, z: -3 }],
		characters: [{ id: "char-a", model: "y-bot-tpose", x: 0, z: 0, rot: 0, hidden: false, pose: null, subject: "a person" }],
		keepLayout: true,
	});
	const next = await planState();
	expect("the small scene opened next has the old view, not the long scene's framing", next.x === 0 && next.z === 0 && Math.abs(next.top - 12.4) < 1e-9 && next.readout === null, JSON.stringify(next));

	// ---- 4. a body whose take carries it 300 m: the opening holds its whole travel, not only where it stands now
	await evaluate("document.querySelector('[data-testid=sequencer-draw-rail]').click()");
	expect("the rail drawing closes before the take", await waitFor("document.querySelector('.app')?.dataset.railDraw !== '1'"));
	expect("the rig is up", await waitFor("!!window.__cozyclay.rigs?.['char-a']", 30000));
	const rest = await evaluate(`(() => { const rig = window.__cozyclay.rigs["char-a"], out = {}; rig.updateMatrixWorld(true); rig.traverse((n) => { if (n.isBone && /Hips$/.test(n.name) && out.hips == null) out.hips = n.getWorldPosition(n.position.clone()).y; if (n.isBone && /LeftFoot$/.test(n.name) && out.ankle == null) out.ankle = n.getWorldPosition(n.position.clone()).y; }); return out; })()`);
	const stand = (x) => ({ root: [x, rest.hips - 0.01, 0], yaw: 0, foot_l: [x + 0.09, rest.ankle, -0.03], foot_r: [x - 0.09, rest.ankle, 0.03], fyaw_l: 0, fyaw_r: 0 });
	const spec = { schema: "cozyclay.motion-spec.v1", fps: 24, frames: 240, keys: [{ f: 0, set: stand(-150) }, { f: 239, set: stand(150) }] };
	const compiled = await evaluate(`(async () => { const receipt = await window.__cozyclay.runStudioAction("motion.compile", ${JSON.stringify({ characterId: "char-a", spec, install: true })}); return { ok: receipt?.ok, message: receipt?.message ?? null }; })()`);
	expect("a take that travels 300 m installs", compiled.ok && await waitFor("window.__cozyclay.motion?.schema === 'cozyclay.take.v3'", 20000), JSON.stringify(compiled));
	await evaluate("document.querySelector('.tl-shot-block')?.click()");
	expect("Draw rail is offered beside the take", await waitFor("!!document.querySelector('[data-testid=sequencer-draw-rail]')"));
	await openRail();
	const travel = await planState();
	expect("the opening holds the body's whole 300 m travel", travel.x + travel.left <= -150 && travel.x + travel.right >= 150, JSON.stringify(travel));
}

ws.close();
if (failures) process.exit(1);
console.log("all Top-View pan browser checks PASS");
