#!/usr/bin/env node
// Browser QA for Pose mode's keyed poses (PoseKeyBar.jsx, motion/pose-key-door.js,
// pose-key-ghosts.jsx): key pose A at f0 with the Key button and pose B at f60 by a
// press on the Body lane (raw CDP mouse events); scrubbing to f30 shows an in-between
// rotation; the lane shows one dot per key; a dot drags to retime and right-click
// removes it, each one undo step; every key off the playhead draws one faded ghost,
// none when Ghosts is off or when looking through the shot camera.
// Run through tools/qa-browser.mjs with QA_URL pointing at `/app/`.

// Run through tools/qa-browser.mjs with QA_URL pointing at `/app/`.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const port = Number(process.env.CDP_PORT || 9222);
const out = process.env.QA_OUT || join(process.cwd(), ".omo/evidence/pose-keys");
await mkdir(out, { recursive: true });
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
const send = (method, params = {}) => new Promise((resolve, reject) => {
	const id = nextId++;
	pending.set(id, { resolve, reject });
	ws.send(JSON.stringify({ id, method, params }));
});
const waitForPageLoad = (timeoutMs = 30000) => new Promise((resolve, reject) => {
	let settled = false;
	const finish = (error) => {
		if (settled) return;
		settled = true;
		ws.removeEventListener("message", onMessage);
		clearTimeout(timer);
		if (error) reject(error);
		else resolve();
	};
	const onMessage = (event) => {
		if (JSON.parse(event.data).method === "Page.loadEventFired") finish();
	};
	const timer = setTimeout(() => finish(new Error("timed out waiting for the QA page to load")), timeoutMs);
	ws.addEventListener("message", onMessage);
});
const evaluate = async (expression) => {
	const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
	if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || "evaluate failed");
	return result.result.value;
};
const waitFor = (condition, timeoutMs = 15000) => evaluate(`new Promise((resolve) => {
	let settled = false;
	const finish = (value) => {
		if (settled) return;
		settled = true;
		observer.disconnect();
		clearTimeout(timer);
		resolve(value);
	};
	const check = () => {
		let value = false;
		try { value = Boolean(${condition}); } catch {}
		if (value) finish(true);
	};
	const observer = new MutationObserver(check);
	observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
	const timer = setTimeout(() => finish(false), ${timeoutMs});
	check();
})`);
const screenshot = async (name) => {
	const result = await send("Page.captureScreenshot", { format: "png" });
	const path = join(out, name);
	await writeFile(path, Buffer.from(result.data, "base64"));
	console.log(`SCREENSHOT ${path}`);
	return path;
};
const setInput = (selector, value) => evaluate(`(() => {
	const input = document.querySelector(${JSON.stringify(selector)});
	if (!input) return false;
	const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
	setter.call(input, ${JSON.stringify(value)});
	input.dispatchEvent(new Event("input", { bubbles: true }));
	return true;
})()`);
const click = (selector) => evaluate(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!node) return false; node.click(); return true; })()`);
const mouse = (type, x, y, buttons = 0) => send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" && !buttons ? "none" : "left", buttons, clickCount: type === "mouseMoved" ? 0 : 1 });
const press = async (code, keyName, modifiers = 0) => {
	const text = !modifiers && keyName.length === 1 ? { text: keyName } : {};
	await send("Input.dispatchKeyEvent", { type: "keyDown", code, key: keyName, ...text, modifiers, windowsVirtualKeyCode: keyName === "Escape" ? 27 : keyName.toUpperCase().charCodeAt(0) });
	await send("Input.dispatchKeyEvent", { type: "keyUp", code, key: keyName, modifiers });
};
// The left upper arm's local rotation, read off the live rig.
const armQuat = () => evaluate(`(() => { const rig = window.__cozyclay.rigs[window.__cozyclay.characters[0].id]; let arm = null; rig.traverse((n) => { if (!arm && n.isBone && /LeftArm$/.test(n.name)) arm = n; }); const q = arm.quaternion; return [q.x, q.y, q.z, q.w]; })()`);
// Turn the left upper arm by `angle` about its local Z, the way a pose drag leaves it on screen.
const turnArm = (angle) => evaluate(`(() => { const rig = window.__cozyclay.rigs[window.__cozyclay.characters[0].id]; let arm = null; rig.traverse((n) => { if (!arm && n.isBone && /LeftArm$/.test(n.name)) arm = n; }); arm.rotateZ(${angle}); arm.updateMatrixWorld(true); return true; })()`);
const angleBetween = (a, b) => 2 * Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3])));
const keyFrames = () => evaluate("[...document.querySelectorAll('.tl-track[data-track-id=\"Full-Body\"] .tl-marker.ik')].map((node) => Number(/at frame (\\d+)/.exec(node.title)?.[1])).sort((a, b) => a - b)");
const laneAt = (frame, row = 1) => evaluate(`(() => { const lane = document.querySelector('.tl-track[data-track-id="Full-Body"] .tl-lane').getBoundingClientRect(); return { x: lane.left + ${frame} / Math.max(1, window.__cozyclay.frameCount - 1) * lane.width, y: lane.top + lane.height * (${row} + 0.5) / 2 }; })()`);
const marker = (frame) => evaluate(`(() => { const node = [...document.querySelectorAll('.tl-track[data-track-id="Full-Body"] .tl-marker.ik')].find((n) => /at frame ${frame}\\b/.test(n.title)); if (!node) return null; const r = node.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
// A condition on page state that no DOM change announces (the ghost count): polled, not observed.
const poll = (condition, timeoutMs = 8000) => evaluate(`new Promise((resolve) => { const end = Date.now() + ${timeoutMs}; const tick = () => { let ok = false; try { ok = Boolean(${condition}); } catch {} if (ok) resolve(true); else if (Date.now() > end) resolve(false); else setTimeout(tick, 50); }; tick(); })`);
const ghosts = () => evaluate("window.__cozyclayPoseGhosts?.count ?? 0");
const scrub = async (frame) => { await evaluate(`window.__cozyclay.scrub(${frame})`); await poll(`window.__cozyclay.tlFrame === ${frame}`); await waitFor("false", 300); };

await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1438, height: 979, deviceScaleFactor: 1, mobile: false });
let failures = 0;
const expect = (name, condition, detail = "") => {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
};

await evaluate(`(() => { for (const key of Object.keys(localStorage)) if (/project-session|scenes|left-collapsed|first-success/i.test(key)) localStorage.removeItem(key); })()`);
{ const loaded = waitForPageLoad(); await send("Page.navigate", { url: process.env.QA_URL || "http://127.0.0.1:5180/app/" }); await loaded; }
expect("the start screen renders", await waitFor("!!document.querySelector('.v2-start-screen.startup [data-testid=start-create]')"));
await setInput('[data-testid="start-project-name"]', "qa_pose_keys");
await click("[data-testid=start-create]");
expect("Create opens the editor", await waitFor("!document.querySelector('.v2-start-screen') && !!document.querySelector('.timeline')"));
await evaluate("document.querySelector('.v2-first-success-guide-close')?.click()");
await click("[data-testid=viewport-add]");
await waitFor("!!document.querySelector('.add-object-menu [data-add=character]')");
await click(".add-object-menu [data-add=character]");
await waitFor("!!window.__cozyclay?.characters?.length && !!window.__cozyclay.rigs?.[window.__cozyclay.characters[0].id]", 20000);
await click(".vp-mode-key[data-mode=pose]");
expect("Pose mode shows the key bar", await waitFor("!!document.querySelector('.pose-key-bar.posing [data-fid=pose_key]')", 20000));
await waitFor("false", 800);

// --- 1. Key pose A at f0 (Key button) and pose B at f60 (a press on the Body lane) ------------
await scrub(0);
await turnArm(-0.8);
const poseA = await armQuat();
await click("[data-fid=pose_key]");
expect("Key keys pose A at f0: one dot", await waitFor("document.querySelectorAll('.tl-track[data-track-id=\"Full-Body\"] .tl-marker.ik').length === 1"), JSON.stringify(await keyFrames()));
await turnArm(1.4);
const poseB = await armQuat();
const at60 = await laneAt(60);
await mouse("mouseMoved", at60.x, at60.y);
await mouse("mousePressed", at60.x, at60.y, 1);
await mouse("mouseReleased", at60.x, at60.y);
expect("a press on the Body lane at f60 keys the pose on screen there: dots at 0 and 60", await waitFor("document.querySelectorAll('.tl-track[data-track-id=\"Full-Body\"] .tl-marker.ik').length === 2") && JSON.stringify(await keyFrames()) === "[0,60]", JSON.stringify(await keyFrames()));
expect("the playhead follows to the new key", await poll("window.__cozyclay.tlFrame === 60"));
expect("keying B did not disturb key A", angleBetween(await (async () => { await scrub(0); return armQuat(); })(), poseA) < 0.02);
await scrub(60);
const keyedB = await armQuat();
expect("f60 holds pose B", angleBetween(keyedB, poseB) < 0.02, JSON.stringify({ keyedB, poseB }));

// The Body group: two rows (Body, IK keys), no Pins row; the IK keys row takes clicks with a crosshair, like Root path.
const rows = await evaluate(`(() => { const track = document.querySelector('.tl-track[data-track-id="Full-Body"]'), lane = track.querySelector('.tl-lane'), dot = track.querySelector('.tl-marker.ik'); const t = track.getBoundingClientRect(), d = dot.getBoundingClientRect(); return { labels: [...track.querySelectorAll('[data-lane-label]')].map((n) => n.dataset.laneLabel), height: Math.round(t.height), row: parseFloat(getComputedStyle(document.querySelector('.v2-sequencer')).getPropertyValue('--tl-track-row-height')), dotRow: Math.floor((d.top + d.height / 2 - t.top) / (t.height / 2)), cursor: getComputedStyle(lane).cursor }; })()`);
expect("the Body group has two rows, Body and IK keys (no Pins)", JSON.stringify(rows.labels) === '["Body","IK keys"]' && Math.abs(rows.height - rows.row * 2) <= 1, JSON.stringify(rows));
expect("the key dots sit on the IK keys row (row 2)", rows.dotRow === 1, JSON.stringify(rows));
expect("the IK keys lane shows a crosshair, like Root path", rows.cursor === "crosshair", rows.cursor);

// --- 2. In between, the pose interpolates; outside, the edge keys hold ------------------------------
await scrub(30);
const mid = await armQuat(), span = angleBetween(poseA, poseB), toA = angleBetween(mid, poseA), toB = angleBetween(mid, poseB);
expect("f30 is an in-between rotation (about halfway from A to B)", Math.abs(toA - span / 2) < 0.08 && Math.abs(toB - span / 2) < 0.08, JSON.stringify({ span, toA, toB }));
await scrub(120);
expect("after the last key the pose holds B", angleBetween(await armQuat(), poseB) < 0.02);

// --- 3. Ghosts: every key off the playhead ------------------------------------------------------------
await scrub(30);
expect("at f30 both keys show as ghosts", await poll("(window.__cozyclayPoseGhosts?.count ?? 0) === 2"), JSON.stringify(await evaluate("window.__cozyclayPoseGhosts")));
await screenshot("01-ghosts-f30.png");
await scrub(0);
expect("on key f0 only the other key is a ghost", await poll("(window.__cozyclayPoseGhosts?.count ?? 0) === 1"), String(await ghosts()));
expect("the playhead keeps its own pose after the ghosts are read", angleBetween(await armQuat(), poseA) < 0.02);
await click("[data-testid=pose-ghosts]");
expect("Ghosts off: none", await poll("(window.__cozyclayPoseGhosts?.count ?? 0) === 0"));
await click("[data-testid=pose-ghosts]");
await poll("(window.__cozyclayPoseGhosts?.count ?? 0) === 1");
// The shot camera never draws them: ghosts live on the editor-only layer the shot capture leaves out.
const layers = await evaluate(`(() => {
	const group = window.__cozyclayGhosts?.scene?.getObjectByName?.("pose-key-ghosts") ?? null, masks = new Set();
	group?.traverse((node) => { if (node.isMesh) masks.add(node.layers.mask); });
	const shot = window.__captureFrame?.();
	return { masks: [...masks], shotMask: shot?.layersMask ?? null };
})()`);
expect("ghosts sit only on the editor layer the shot camera's capture leaves out", layers.masks.length === 1 && layers.masks[0] === 1 << 5 && layers.shotMask !== null && (layers.shotMask & (1 << 5)) === 0, JSON.stringify(layers));
await evaluate("window.__cozyclay.setLookThrough(true)");
await poll("window.__cozyclay.lookThroughShot === true", 3000);
if (await evaluate("window.__cozyclay.lookThroughShot === true")) {
	expect("looking through the shot camera: none", await poll("(window.__cozyclayPoseGhosts?.count ?? 0) === 0"));
	await evaluate("window.__cozyclay.setLookThrough(false)");
	expect("back in the editor view they return", await poll("(window.__cozyclayPoseGhosts?.count ?? 0) === 1"));
} else console.log("NOTE Pose mode keeps its own camera: look-through is not available here");

// --- 4. Retime by drag, remove by right-click; one undo step each ---------------------------------------
const dot = await marker(60), to = await laneAt(72, 1);
await mouse("mouseMoved", dot.x, dot.y);
await mouse("mousePressed", dot.x, dot.y, 1);
for (let t = 1; t <= 8; t += 1) await mouse("mouseMoved", dot.x + (to.x - dot.x) * t / 8, dot.y, 1);
await mouse("mouseReleased", to.x, dot.y);
const moved = await keyFrames();
expect("dragging the f60 dot retimes it", moved.length === 2 && moved[0] === 0 && Math.abs(moved[1] - 72) <= 2, JSON.stringify(moved));
await evaluate("document.activeElement?.blur?.()");
await press("KeyZ", "z", 2);
expect("one undo puts it back at f60", await waitFor("[...document.querySelectorAll('.tl-track[data-track-id=\"Full-Body\"] .tl-marker.ik')].some((n) => /at frame 60\\b/.test(n.title))"), JSON.stringify(await keyFrames()));
const back = await marker(60);
await send("Input.dispatchMouseEvent", { type: "mousePressed", x: back.x, y: back.y, button: "right", buttons: 2, clickCount: 1 });
await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: back.x, y: back.y, button: "right", buttons: 0, clickCount: 1 });
expect("right-click removes the key", await waitFor("document.querySelectorAll('.tl-track[data-track-id=\"Full-Body\"] .tl-marker.ik').length === 1"), JSON.stringify(await keyFrames()));
await press("KeyZ", "z", 2);
expect("one undo brings it back", await waitFor("document.querySelectorAll('.tl-track[data-track-id=\"Full-Body\"] .tl-marker.ik').length === 2"), JSON.stringify(await keyFrames()));
await scrub(30);
await screenshot("02-keys-lane.png");

ws.close();
if (failures > 0) {
	console.error(`\n${failures} pose key check(s) failed`);
	process.exit(1);
}
console.log("\nAll pose key checks passed");
