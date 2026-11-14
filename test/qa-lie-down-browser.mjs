#!/usr/bin/env node
// Browser QA for lying down in Pose mode (posestudio.jsx rotateTrack; motion/ik.js ikPlantFeet, solveHipsTranslateToFloor):
// the Root/Hips control shows rotation rings beside its move arrows; a ring drag turns the whole body level, feet with it
// (the Z ring onto the side, the X ring onto the back); the Y arrow then lowers it to the floor with Foot snap and Body
// contact on: the feet come down instead of folding the legs, and the body rests on the floor (on its side, the shoulder).
// Measured on the rig (hips, head, ankles, knees, skinned-mesh lowest point) after release, each case in a new project.
// Run through tools/qa-browser.mjs with QA_URL pointing at `/app/` (QA_STARTUP_CHOOSER=1).
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const port = Number(process.env.CDP_PORT || 9222);
const out = process.env.QA_OUT || join(process.cwd(), ".omo/evidence/fix-islands");
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
const waitFor = (condition, timeoutMs = 15000) => evaluate(`new Promise((resolve, reject) => {
	let settled = false;
	const finish = (value) => {
		if (settled) return;
		settled = true;
		observer.disconnect();
		clearTimeout(timer);
		window.removeEventListener("qa:pose-state", check);
		if (value) resolve(true);
		else reject(new Error("QA prerequisite missing: " + ${JSON.stringify(condition)}));
	};
	const check = () => {
		let value = false;
		try { value = Boolean(${condition}); } catch {}
		if (value) finish(true);
	};
	const observer = new MutationObserver(check);
	observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
	window.addEventListener("qa:pose-state", check);
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
const settle = () => evaluate("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
const rigExpr = "window.__cozyclay.rigs[window.__cozyclay.characters[0].id]";
await send("Page.enable"); await send("Runtime.enable"); const pageErrors = []; ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.method === "Runtime.exceptionThrown") pageErrors.push(m.params.exceptionDetails?.exception?.description?.slice(0, 400)); if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") pageErrors.push(m.params.args.map((a) => a.value ?? a.description).join(" ").slice(0, 400)); });
await send("Emulation.setDeviceMetricsOverride", { width: 1438, height: 979, deviceScaleFactor: 1, mobile: false });
// App publishes this state after its React commit; observe it together with
// DOM commits so a late-loading rig cannot be mistaken for a missing control.
await send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
	let state;
	Object.defineProperty(window, "__cozyclay", {
		configurable: true, get: () => state,
		set: value => { state = value; window.dispatchEvent(new Event("qa:pose-state")); },
	});
})()` });
let failures = 0;
const expect = (name, condition, detail = "") => {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
};

const appUrl = new URL(process.env.QA_URL || "http://127.0.0.1:5180/app/");
appUrl.searchParams.set("agent", "mock");
appUrl.searchParams.set("state", "ready");
// A new project with one character, in Pose mode, with Root/Hips focused (its rings and arrows drawn).
const freshProject = async () => {
	await evaluate(`(() => { for (const key of Object.keys(localStorage)) if (/project-session|scenes|left-collapsed|first-success|mock\\.agent/i.test(key)) localStorage.removeItem(key); })()`);
	{ const loaded = waitForPageLoad(); await send("Page.navigate", { url: appUrl.href }); await loaded; }
	expect("the start screen renders", await waitFor("!!document.querySelector('.v2-start-screen.startup [data-testid=start-create]')"));
	await setInput('[data-testid="start-project-name"]', "qa_lie_down");
	await click("[data-testid=start-create]");
	expect("Create opens the editor", await waitFor("!document.querySelector('.v2-start-screen') && !!document.querySelector('.timeline')"));
	await evaluate("document.querySelector('.v2-first-success-guide-close')?.click()");
	await click("[data-testid=viewport-add]");
	await waitFor("!!document.querySelector('.add-object-menu [data-add=character]')");
	await click(".add-object-menu [data-add=character]");
	await waitFor(`!!window.__cozyclay?.characters?.length && !!${rigExpr}`, 20000);
	// Subscribe before switching modes. A failed prerequisite rejects here,
	// before any pointer event can dereference a missing screen point.
	const ready = waitFor("window.__cozyclay?.ikMode === true && !!window.__ikControlScreenPositions?.().hips", 15000);
	await click(".vp-mode-key[data-mode=pose]");
	expect("Pose mode shows the Root/Hips control", await ready);
	await settle();
	const at = await evaluate("window.__ikControlScreenPositions().hips");
	assert.ok(at && Number.isFinite(at.x) && Number.isFinite(at.y), "QA prerequisite missing: Root/Hips control has no finite screen point");
	await mouse("mouseMoved", at.x, at.y); await mouse("mousePressed", at.x, at.y, 1); await mouse("mouseReleased", at.x, at.y); await settle(); await settle();
};



// World points of the rig, a ring's screen path, and the skinned mesh's lowest point.
const joints = () => evaluate(`(() => { const rig = ${rigExpr}, out = {}; rig.updateMatrixWorld(true); rig.traverse((n) => { const m = n.isBone && n.name.match(/(Hips|Head|LeftUpLeg|LeftLeg|LeftFoot|RightUpLeg|RightLeg|RightFoot)$/); if (m && !out[m[1]]) out[m[1]] = n.getWorldPosition(n.position.clone()).toArray(); }); return out; })()`);
// The skinned mesh's lowest point, for the body and for the hands apart (a vertex goes by its heaviest bone): hand
// contact holds the wrist above the floor, not the palm's edge, so the hands are measured, not held to the body's bar.
const meshMinY = () => evaluate(`(() => { const rig = ${rigExpr}; rig.updateMatrixWorld(true); const out = { body: Infinity, hands: Infinity }; rig.traverse((mesh) => { if (!mesh.isSkinnedMesh) return; const p = mesh.geometry.attributes.position, si = mesh.geometry.attributes.skinIndex, sw = mesh.geometry.attributes.skinWeight, t = mesh.position.clone(); for (let i = 0; i < p.count; i += 3) { let top = 0; for (let k = 1; k < 4; k++) if (sw.getComponent(i, k) > sw.getComponent(i, top)) top = k; const hand = /Hand/.test(mesh.skeleton.bones[si.getComponent(i, top)]?.name ?? ""); t.fromBufferAttribute(p, i); mesh.applyBoneTransform(i, t); t.applyMatrix4(mesh.matrixWorld); const key = hand ? "hands" : "body"; if (t.y < out[key]) out[key] = t.y; } }); return out; })()`);
const dragPath = async (points) => {
	await mouse("mouseMoved", points[0].x, points[0].y); await mouse("mousePressed", points[0].x, points[0].y, 1);
	for (const p of points.slice(1)) { await mouse("mouseMoved", p.x, p.y, 1); await settle(); }
	const last = points.at(-1); await mouse("mouseReleased", last.x, last.y); await settle(); await settle();
};
const tiltDeg = (a, b) => Math.asin(Math.min(1, Math.abs(b[1] - a[1]) / Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]))) * 180 / Math.PI;
const kneeDeg = (hip, knee, ankle) => { const u = hip.map((v, i) => v - knee[i]), w = ankle.map((v, i) => v - knee[i]); return Math.acos(u.reduce((s, v, i) => s + v * w[i], 0) / Math.hypot(...u) / Math.hypot(...w)) * 180 / Math.PI; };

// --- 1. Root/Hips shows rotation rings beside its move arrows -------------------------------------------------------
await freshProject();
const standing = await joints();
const picks = await evaluate("window.__ikPickScreenPositions().filter((p) => p.trackId === 'hips')");
const rings = picks.filter((p) => p.kind === "fk" && p.part === "ring").map((p) => p.axis).sort();
expect("Root/Hips shows X, Y and Z rotation rings", JSON.stringify(rings) === '["x","y","z"]', JSON.stringify(rings));
expect("and keeps its move arrows", ["x", "y", "z"].every((axis) => picks.some((p) => p.kind === "body" && p.part === "tip" && p.axis === axis)));

// --- 2-3. Lie down twice, on the side and on the back: a ring drag turns the whole body level (feet with it), then the
// Y arrow lowers it onto the floor with Foot snap and Body contact on. "Reset to default pose" stands it up between.
const snapOn = await evaluate("[...document.querySelectorAll('button')].some((b) => /Snap on/.test(b.textContent))");
const contactOn = await evaluate("[...document.querySelectorAll('button')].find((b) => b.textContent.includes('Body contact'))?.getAttribute('aria-pressed') !== 'false'");
expect("Foot snap and Body contact are on (the default)", snapOn && contactOn, JSON.stringify({ snapOn, contactOn }));
// A press point on one ring that is far, on screen, from the other two (their pick tubes overlap where rings cross, and
// the nearest ring takes the press). The rings are world-aligned circles round the hips (posestudio.jsx); the radius is
// solved from the ring's published pick point (its 45 degree point).
const ringPress = (axis, picks) => evaluate(`(() => {
	const picks = ${JSON.stringify(picks)}, rig = ${rigExpr}; rig.updateMatrixWorld(true); let hips = null; rig.traverse((n) => { if (!hips && n.isBone && /Hips$/.test(n.name)) hips = n; });
	const c = hips.getWorldPosition(hips.position.clone()), V = c.constructor, Q = hips.quaternion.constructor;
	const quat = (a) => new Q().setFromUnitVectors(new V(0, 0, 1), { x: new V(1, 0, 0), y: new V(0, 1, 0), z: new V(0, 0, 1) }[a]);
	const at = (a, r, t) => window.__ikProject(new V(r * Math.cos(t), r * Math.sin(t), 0).applyQuaternion(quat(a)).add(c));
	const pick = picks.find((p) => p.kind === "fk" && p.part === "ring" && p.axis === ${JSON.stringify(axis)});
	let r = 0.2, best = Infinity; for (let k = 0.05; k <= 0.8; k += 0.0025) { const s = at(${JSON.stringify(axis)}, k, Math.PI / 4), d = Math.hypot(s.x - pick.x, s.y - pick.y); if (d < best) { best = d; r = k; } }
	const others = ["x", "y", "z"].filter((a) => a !== ${JSON.stringify(axis)}).flatMap((a) => Array.from({ length: 96 }, (_, i) => at(a, r, i * Math.PI / 48)));
	let press = null; for (let i = 0; i < 96; i++) { const s = at(${JSON.stringify(axis)}, r, i * Math.PI / 48), clear = Math.min(...others.map((o) => Math.hypot(o.x - s.x, o.y - s.y))); if (!press || clear > press.clear) press = { x: s.x, y: s.y, clear }; }
	return { ...press, fit: best };
})()`);
const hipsPicks = () => evaluate("window.__ikPickScreenPositions().filter((p) => p.trackId === 'hips')");
const lieDown = async (axis, label, shot) => {
	// Press on the ring's own hit point, then walk the pointer round the hips on screen until hips-to-head is level: the
	// ring's angle comes from ray hits on its plane, so the pointer path needs no knowledge of the view.
	const now = await hipsPicks(), centre = now.find((p) => p.kind === "body" && p.part === null), ring = await ringPress(axis, now);
	expect(`${label}: a clear press point on the ${axis.toUpperCase()} ring (fit under 3 px, 12 px or more from the other rings)`, ring.fit < 3 && ring.clear >= 12, JSON.stringify(ring));
	const radius = Math.hypot(ring.x - centre.x, ring.y - centre.y), start = Math.atan2(ring.y - centre.y, ring.x - centre.x);
	const tiltNow = async () => { const j = await joints(); return tiltDeg(j.Hips, j.Head); };
	await mouse("mouseMoved", ring.x, ring.y); await mouse("mousePressed", ring.x, ring.y, 1);
	let sign = 1, step = 0, tilt = await tiltNow();
	for (let k = 1; k <= 72 && tilt > 4; k++) {
		step += sign;
		const a = start + step * Math.PI / 36;
		await mouse("mouseMoved", centre.x + radius * Math.cos(a), centre.y + radius * Math.sin(a), 1); await settle();
		tilt = await tiltNow();
		if (k === 6 && tilt > 85) { sign = -1; step = 0; } // the first way round did not tip the body: go the other way
	}
	const end = start + step * Math.PI / 36;
	await mouse("mouseReleased", centre.x + radius * Math.cos(end), centre.y + radius * Math.sin(end)); await settle(); await settle();
	const turned = await joints();
	expect(`${label}: the ${axis.toUpperCase()} ring turns the body level (hips to head within 15 degrees)`, tiltDeg(turned.Hips, turned.Head) < 15, String(tiltDeg(turned.Hips, turned.Head)));
	expect(`${label}: the feet come along, legs straight (each leg within 20 degrees of level, knees over 160)`, ["Left", "Right"].every((s) => tiltDeg(turned[`${s}UpLeg`], turned[`${s}Foot`]) < 20 && kneeDeg(turned[`${s}UpLeg`], turned[`${s}Leg`], turned[`${s}Foot`]) > 160), JSON.stringify(turned));
	const yTip = (await hipsPicks()).find((p) => p.kind === "body" && p.part === "tip" && p.axis === "y");
	await dragPath(Array.from({ length: 13 }, (_, i) => ({ x: yTip.x, y: yTip.y + i * 40 })));
	await settle();
	const lying = await joints(), mins = await meshMinY(), floor = mins.body, low = Math.min(lying.LeftFoot[1], lying.RightFoot[1]);
	expect(`${label}: lowered onto the floor (hips and head under 0.3 m, the lower ankle under 0.2 m)`, lying.Hips[1] < 0.3 && lying.Head[1] < 0.3 && low < 0.2, JSON.stringify(lying));
	expect(`${label}: still level, legs not folded (tilt under 15 degrees, knees over 150)`, tiltDeg(lying.Hips, lying.Head) < 15 && ["Left", "Right"].every((s) => kneeDeg(lying[`${s}UpLeg`], lying[`${s}Leg`], lying[`${s}Foot`]) > 150));
	expect(`${label}: the body rests on the floor, not through it or above it (lowest point but the hands -2..+4 cm)`, floor > -0.02 && floor < 0.04, String(floor));
	await screenshot(shot);
	await settle();
	const kept = await joints();
	expect(`${label}: the pose stays after the drags end (hips within 1 cm)`, Math.abs(kept.Hips[1] - lying.Hips[1]) < 0.01, `${lying.Hips[1]} -> ${kept.Hips[1]}`);
	console.log(`MEASURE ${label}: ring ${axis} ${step * 5} deg on screen | hips ${lying.Hips[1].toFixed(3)} head ${lying.Head[1].toFixed(3)} ankles ${lying.LeftFoot[1].toFixed(3)}/${lying.RightFoot[1].toFixed(3)} | tilt ${tiltDeg(lying.Hips, lying.Head).toFixed(1)} deg | knees ${kneeDeg(lying.LeftUpLeg, lying.LeftLeg, lying.LeftFoot).toFixed(0)}/${kneeDeg(lying.RightUpLeg, lying.RightLeg, lying.RightFoot).toFixed(0)} | body min ${floor.toFixed(3)} hands min ${mins.hands.toFixed(3)}`);
	return lying;
};
const side = await lieDown("z", "on the side", "01-lying-side.png");
expect("the hips came down from standing", standing.Hips[1] - side.Hips[1] > 0.6, `${standing.Hips[1]} -> ${side.Hips[1]}`);
// A new project stands a new character up; it lies on its back with the other ring.
await freshProject();
const back = await lieDown("x", "on the back", "02-lying-back.png");
expect("on the back: both ankles at one height (within 6 cm), not stacked as on the side", Math.abs(back.LeftFoot[1] - back.RightFoot[1]) < 0.06, `${back.LeftFoot[1]} ${back.RightFoot[1]}`);
expect("on the side: the legs are stacked (ankles 10 cm or more apart in height)", Math.abs(side.LeftFoot[1] - side.RightFoot[1]) >= 0.1, `${side.LeftFoot[1]} ${side.RightFoot[1]}`);
expect("no page errors", pageErrors.length === 0, pageErrors.join(" | ").slice(0, 400));
ws.close();
if (failures) { console.error(`${failures} lie-down check(s) failed`); process.exit(1); }
console.log("PASS lying down in Pose mode");

