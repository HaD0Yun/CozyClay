#!/usr/bin/env node
// A visual tour of the Auto Pose tool for the feature report: drives the real UI with pointer and key events in a
// headed-equivalent window (no metrics override), saves one screenshot per step and the measured numbers.
//   npx vite --host 127.0.0.1 --port 5197 --strictPort &
//   QA_WINDOW=1500,1000 QA_CHROME_FLAGS=--force-device-scale-factor=2 QA_URL=http://127.0.0.1:5197/app/ CDP_PORT=9338 \
//     QA_OUT=<dir> node tools/qa-browser.mjs -- node tools/qa-poser-tour.mjs
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const port = Number(process.env.CDP_PORT || 9222), url = process.env.QA_URL || "http://127.0.0.1:5180/app/";
const out = process.env.QA_OUT || join(process.cwd(), ".omo/evidence/poser-tour");
await mkdir(join(out, "shots"), { recursive: true });
const page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === "page" && t.webSocketDebuggerUrl);
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let nextId = 1, blocked = [];
const pending = new Map();
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const id = nextId++; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
ws.onmessage = (event) => {
	const m = JSON.parse(event.data);
	if (m.method === "Target.attachedToTarget" && m.params.targetInfo.type === "worker") {
		const sid = m.params.sessionId;
		send("Network.enable", {}, sid).then(() => send("Network.setBlockedURLs", { urls: blocked }, sid)).catch(() => {}).finally(() => send("Runtime.runIfWaitingForDebugger", {}, sid).catch(() => {}));
	}
	if (!m.id || !pending.has(m.id)) return;
	const p = pending.get(m.id);
	pending.delete(m.id);
	if (m.error) p.reject(new Error(JSON.stringify(m.error))); else p.resolve(m.result);
};
const evaluate = async (expression) => { const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "evaluate failed"); return r.result.value; };
const poll = (c, t = 15000) => evaluate(`new Promise((resolve) => { const end = Date.now() + ${t}; const tick = () => { let ok = false; try { ok = Boolean(${c}); } catch {} if (ok) resolve(true); else if (Date.now() > end) resolve(false); else setTimeout(tick, 50); }; tick(); })`);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const click = (s) => evaluate(`(() => { const n = document.querySelector(${JSON.stringify(s)}); if (!n || n.disabled) return false; n.click(); return true; })()`);
const mouse = (type, x, y, buttons = 0, modifiers = 0) => send("Input.dispatchMouseEvent", { type, x, y, modifiers, button: type === "mouseMoved" && !buttons ? "none" : "left", buttons, clickCount: type === "mouseMoved" ? 0 : 1 });
const key = async (code, k, modifiers = 0) => { await send("Input.dispatchKeyEvent", { type: "keyDown", code, key: k, ...(modifiers ? {} : { text: k }), modifiers, windowsVirtualKeyCode: k.toUpperCase().charCodeAt(0) }); await send("Input.dispatchKeyEvent", { type: "keyUp", code, key: k, modifiers }); };
const P = "window.__cozyclayPoser", J = { hips: 0, head: 6, leftHand: 13, rightHand: 19, rightElbow: 18, leftFoot: 24, rightFoot: 28 };
const idle = () => poll(`!${P}.controller.dragging && !${P}.controller.busy`, 6000);
const joint = (j) => evaluate(`${P}.controller.bridge.jointPoser(${j})`);
const cm = (a, b) => +(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) * 100).toFixed(2);
const steps = [];
let index = 0;
async function shot(key, data = {}, ok = true) {
	await pause(450);
	index += 1;
	const file = `shots/${String(index).padStart(2, "0")}-${key}.jpg`;
	const r = await send("Page.captureScreenshot", { format: "jpeg", quality: 82 });
	await writeFile(join(out, file), Buffer.from(r.data, "base64"));
	const hint = await evaluate(`document.querySelector('[data-testid=poser-hint]')?.textContent ?? ""`).catch(() => "");
	steps.push({ key, file, ok, data, hint });
	console.log(`${ok ? "OK  " : "FAIL"} ${key} ${JSON.stringify(data)}`);
}
// Drag handle `id` to a poser-frame point, along a straight screen path, with real pointer events.
async function dragTo(id, target, { n = 36, mid = null } = {}) {
	const from = await evaluate(`${P}.screenOf(${JSON.stringify(id)})`);
	if (!from?.[3]) throw new Error(`${id} is not reachable on screen: ${JSON.stringify(from)}`);
	const to = await evaluate(`(() => { const w = ${P}.controller.bridge.toWorld(${JSON.stringify(target)}); return ${P}.project(w.x, w.y, w.z); })()`);
	await mouse("mouseMoved", from[0], from[1]); await mouse("mousePressed", from[0], from[1], 1);
	for (let i = 1; i <= n; i += 1) { await mouse("mouseMoved", from[0] + ((to[0] - from[0]) * i) / n, from[1] + ((to[1] - from[1]) * i) / n, 1); await pause(18); if (mid && i === Math.round(n / 2)) await mid(); }
	await mouse("mouseReleased", to[0], to[1]);
	await idle(); await pause(250);
}
async function selectDot(id) {
	const at = await evaluate(`${P}.screenOf(${JSON.stringify(id)})`);
	await mouse("mouseMoved", at[0], at[1]); await mouse("mousePressed", at[0], at[1], 1); await mouse("mouseReleased", at[0], at[1]);
	await idle();
	return poll(`${P}.state().selected === ${JSON.stringify(id)}`, 2000);
}
const undo = async () => { await key("KeyZ", "z", process.platform === "darwin" ? 4 : 2); await pause(600); };
const reset = async () => { await click("[data-testid=poser-reset]"); await idle(); await pause(300); };
const add = (p, d) => p.map((v, i) => v + d[i]);
const heading = async () => evaluate(`(() => { const G = ${P}.controller.bridge.turnAt(6); return Math.atan2(G[2], G[8]) * 180 / Math.PI; })()`);

async function openStudio(name) {
	await evaluate(`(() => { for (const k of Object.keys(localStorage)) if (/project-session|scenes|left-collapsed|first-success/i.test(k)) localStorage.removeItem(k); })()`);
	await send("Page.navigate", { url });
	await poll("document.readyState === 'complete' && !!document.querySelector('[data-testid=start-create]')", 30000);
	await evaluate(`(() => { const i = document.querySelector('[data-testid="start-project-name"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(i, ${JSON.stringify(name)}); i.dispatchEvent(new Event("input", { bubbles: true })); })()`);
	await click("[data-testid=start-create]");
	await poll("!document.querySelector('.v2-start-screen') && !!document.querySelector('.timeline')", 20000);
	await evaluate("document.querySelector('.v2-first-success-guide-close')?.click()");
	await click("[data-testid=viewport-add]");
	await poll("!!document.querySelector('.add-object-menu [data-add=character]')");
	await click(".add-object-menu [data-add=character]");
	await poll("!!window.__cozyclay?.characters?.length && !!window.__cozyclay.rigs?.[window.__cozyclay.characters[0].id]", 30000);
	// reopen the project (a first character added this session is not keyed until then: reported separately)
	await pause(2500); await send("Page.reload", {}); await pause(1000);
	await poll("!!window.__cozyclay?.characters?.length && !!window.__cozyclay.rigs?.[window.__cozyclay.characters[0].id]", 30000);
	await evaluate("document.querySelector('.v2-first-success-guide-close')?.click()");
	await click(".vp-mode-key[data-mode=pose]");
	await poll("!!document.querySelector('.vp-tool-key[data-tool=poser]')", 20000);
	await pause(800);
	await key("KeyE", "e");
}

await send("Page.enable");
await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
await send("Page.navigate", { url });
await poll("document.readyState === 'complete'", 30000);
await evaluate(`(() => { for (const k of Object.keys(localStorage)) if (/project-session|scenes|left-collapsed|first-success/i.test(k)) localStorage.removeItem(k); })()`);
await openStudio("poser_tour");
const ready = await poll("document.querySelector('[data-testid=poser-model]')?.dataset.status === 'ready' && !!window.__cozyclayPoser?.controller", 60000);
const view = await evaluate("({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio })");
await reset();
await shot("ready", { model: await evaluate(`${P}.state().model.info`), window: view }, ready);

// live drag of the right hand
const hand0 = await joint(J.rightHand), feet0 = [await joint(J.leftFoot), await joint(J.rightFoot)];
await dragTo("rightHand", add(hand0, [0.35, -0.3, 0.25]), { mid: () => shot("drag-mid") });
const hand1 = await joint(J.rightHand), place1 = await evaluate(`${P}.controller.handles.rightHand.place`), feet1 = [await joint(J.leftFoot), await joint(J.rightFoot)];
await shot("drag-after", { handToDot_cm: cm(hand1, place1), handMoved_cm: cm(hand1, hand0), feetDrift_cm: feet1.map((p, i) => cm(p, feet0[i])), keys: await evaluate("window.__cozyclay.ik.keys.size") }, cm(hand1, place1) < 2 && feet1.every((p, i) => cm(p, feet0[i]) < 1));

// hips down: knees bend, feet stay
const hips0 = await joint(J.hips);
await dragTo("hips", add(hips0, [0, -0.25, 0]));
const hips1 = await joint(J.hips), feet2 = [await joint(J.leftFoot), await joint(J.rightFoot)];
const lowest = await evaluate(`(() => { const b = ${P}.controller.bridge; return Math.min(...b.facts.written.map((on, j) => (on ? b.jointPoser(j)[1] : 9))); })()`);
await shot("hips-down", { hipsLowered_cm: +((hips0[1] - hips1[1]) * 100).toFixed(1), feetDrift_cm: feet2.map((p, i) => cm(p, feet1[i])), lowestJoint_cm: +(lowest * 100).toFixed(2) }, hips0[1] - hips1[1] > 0.1 && feet2.every((p, i) => cm(p, feet1[i]) < 3) && lowest > -0.001);

// select a dot: rings and the panel row
const selected = await selectDot("leftHand");
await shot("select-rings", { selected: await evaluate(`${P}.state().selected`), ringsShown: await evaluate(`${P}.ringAxis !== undefined`) }, selected);

// ring turn about the vertical axis
const turn0 = await evaluate(`${P}.controller.bridge.turnAt(13)`), centre = await evaluate(`${P}.markAt("leftHand")`);
const ringPoint = (deg) => evaluate(`${P}.project(${centre[0]} + 0.16 * Math.cos(${(deg * Math.PI) / 180}), ${centre[1]}, ${centre[2]} + 0.16 * Math.sin(${(deg * Math.PI) / 180}))`);
let start = 90;
for (const deg of [90, 45, 135, 0, 180, 225, 270, 315]) { const q = await ringPoint(deg); await mouse("mouseMoved", q[0], q[1]); if ((await evaluate(`${P}.ringAxis()`)) === "y") { start = deg; break; } }
const r0 = await ringPoint(start);
await mouse("mouseMoved", r0[0], r0[1]); await mouse("mousePressed", r0[0], r0[1], 1);
for (let d = 3; d <= 45; d += 3) { const q = await ringPoint(start + d); await mouse("mouseMoved", q[0], q[1], 1); await pause(25); }
const r1 = await ringPoint(start + 45); await mouse("mouseReleased", r1[0], r1[1]); await idle();
const turn1 = await evaluate(`${P}.controller.bridge.turnAt(13)`);
const turned = (Math.acos(Math.min(1, Math.max(-1, (turn0.reduce((s, v, i) => s + v * turn1[i], 0) - 1) / 2))) * 180) / Math.PI;
await shot("ring-turn", { ringDrag_deg: 45, handTurned_deg: +turned.toFixed(1), holdsRotation: await evaluate(`${P}.controller.handles.leftHand.holdsRotation`) }, turned > 30 && turned < 60);

// hold on / off: the same hips drag with the left hand held, then not held
await reset();
await selectDot("leftHand");
await click("[data-testid=poser-held]"); await pause(200);
const heldOn = await evaluate(`${P}.controller.handles.leftHand.held`);
let lh0 = await joint(J.leftHand), h0 = await joint(J.hips);
await dragTo("hips", add(h0, [0.2, -0.15, 0]));
const heldDrift = cm(await joint(J.leftHand), lh0);
await shot("hold-on", { leftHandHeld: heldOn, leftHandMoved_cm: heldDrift, hipsMoved_cm: cm(await joint(J.hips), h0) }, heldOn && heldDrift < 3);
await undo();
await selectDot("leftHand");
await click("[data-testid=poser-held]"); await pause(200);
lh0 = await joint(J.leftHand); h0 = await joint(J.hips);
await dragTo("hips", add(h0, [0.2, -0.15, 0]));
const freeDrift = cm(await joint(J.leftHand), lh0);
await shot("hold-off", { leftHandHeld: await evaluate(`${P}.controller.handles.leftHand.held`), leftHandMoved_cm: freeDrift }, freeDrift > heldDrift + 5);

// an optional guide: the right elbow switched on and dragged
await reset();
await click("[data-testid=poser-handle-rightElbow]"); await pause(200);
await click("[data-testid=poser-enabled]"); await pause(200);
const elbow0 = await joint(J.rightElbow), elbowTarget = add(elbow0, [0.05, -0.2, 0.15]);
await dragTo("rightElbow", elbowTarget);
await shot("elbow-guide", { elbowOn: await evaluate(`${P}.controller.handles.rightElbow.enabled`), elbowToDot_cm: cm(await joint(J.rightElbow), await evaluate(`${P}.controller.handles.rightElbow.place`)), elbowMoved_cm: cm(await joint(J.rightElbow), elbow0) });

// look-at point dragged to the character's left: the head turns toward it
await reset();
const head0 = await heading(), lookFrom = await evaluate(`(() => { const m = ${P}.markAt("lookAt"); return ${P}.controller.bridge.toPoser(new ${P}.controller.bridge.rig.position.constructor(...m)); })()`);
await dragTo("lookAt", add(lookFrom, [0.5, 0, -0.2]));
const head1 = await heading();
await shot("look-at", { headTurned_deg: +(head1 - head0).toFixed(1), lookAtPlaced: await evaluate(`${P}.controller.handles.lookAt.placed`) }, Math.abs(head1 - head0) > 10);

// tolerance: the same sideways hips drag with the left foot tight, then with 50 cm tolerance
await reset();
let f0 = await joint(J.leftFoot); h0 = await joint(J.hips);
await dragTo("hips", add(h0, [0.3, -0.05, 0]));
const tight = cm(await joint(J.leftFoot), f0);
await undo();
await click("[data-testid=poser-handle-leftFoot]"); await pause(200);
await evaluate(`(() => { const i = document.querySelector('[data-testid=poser-tolerance]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(i, "1000"); i.dispatchEvent(new Event("input", { bubbles: true })); })()`);
await pause(200);
const tolerance = await evaluate(`${P}.controller.handles.leftFoot.tolerance`);
f0 = await joint(J.leftFoot); h0 = await joint(J.hips);
await dragTo("hips", add(h0, [0.3, -0.05, 0]));
const loose = cm(await joint(J.leftFoot), f0);
await shot("tolerance", { leftFootTolerance_cm: tolerance * 100, footMovedTight_cm: tight, footMovedLoose_cm: loose }, loose > tight);

// flip: left and right swap across the body's own plane
await reset();
await dragTo("rightHand", add(await joint(J.rightHand), [0.35, -0.3, 0.25]));
const before = await evaluate(`(() => { const b = ${P}.controller.bridge, pose = b.readPose(); return { G0: Array.from(pose.G.slice(0, 9)), hips: b.jointPoser(0), lh: b.jointPoser(13), rh: b.jointPoser(19) }; })()`);
await click("[data-testid=poser-flip]"); await idle(); await pause(300);
const n = [before.G0[0], before.G0[3], before.G0[6]], refl = (p) => { const d = n.reduce((s, v, k) => s + v * (p[k] - before.hips[k]), 0); return p.map((v, k) => v - 2 * d * n[k]); };
const flipErr = Math.max(cm(await joint(J.leftHand), refl(before.rh)), cm(await joint(J.rightHand), refl(before.lh)));
await shot("flip", { handsVsReflected_cm: flipErr }, flipErr < 2);

// copy, reset, paste, paste reversed (relative to the hips: paste keeps the character where it stands)
await click("[data-testid=poser-copy]"); await pause(200);
const rel = (p, h) => p.map((v, k) => v - h[k]);
const copied = { lh: rel(await joint(J.leftHand), await joint(J.hips)), rh: rel(await joint(J.rightHand), await joint(J.hips)) };
await reset();
await shot("reset", { upright: await evaluate(`(() => { const b = ${P}.controller.bridge, h = b.jointPoser(0), t = b.jointPoser(6); return +((t[1] - h[1]) / Math.hypot(t[0] - h[0], t[1] - h[1], t[2] - h[2])).toFixed(4); })()`), feetHeight_cm: [(await joint(J.leftFoot))[1] * 100, (await joint(J.rightFoot))[1] * 100].map((v) => +v.toFixed(1)) });
await click("[data-testid=poser-paste]"); await idle(); await pause(300);
const pasteErr = Math.max(cm(rel(await joint(J.leftHand), await joint(J.hips)), copied.lh), cm(rel(await joint(J.rightHand), await joint(J.hips)), copied.rh));
await shot("paste", { handsVsCopied_cm: pasteErr }, pasteErr < 2);
const pastedHand = await joint(J.rightHand);
await click("[data-testid=poser-paste-reversed]"); await idle(); await pause(300);
const pasted = await evaluate(`(() => { const b = ${P}.controller.bridge, pose = b.readPose(); return { G0: Array.from(pose.G.slice(0, 9)), hips: b.jointPoser(0) }; })()`);
const n2 = [pasted.G0[0], pasted.G0[3], pasted.G0[6]], flipOf = (v) => { const d = n2.reduce((s, x, k) => s + x * v[k], 0); return v.map((x, k) => x - 2 * d * n2[k]); };
const reverseErr = Math.max(cm(rel(await joint(J.rightHand), pasted.hips), flipOf(copied.lh)), cm(rel(await joint(J.leftHand), pasted.hips), flipOf(copied.rh)));
await shot("paste-reversed", { handsVsFlippedCopy_cm: reverseErr }, reverseErr < 3);

// undo: the last step (paste reversed) goes back
const beforeUndo = await joint(J.rightHand);
await undo();
const afterUndo = await joint(J.rightHand);
await shot("undo", { handBackToPaste_cm: cm(afterUndo, pastedHand), handChanged_cm: cm(afterUndo, beforeUndo) }, cm(afterUndo, pastedHand) < 0.5 && cm(afterUndo, beforeUndo) > 5);

// solve and frame timings over the whole tour so far (worker network, single thread)
const perf = await evaluate(`(() => { const q = (a, p) => (a.length ? +a[Math.min(a.length - 1, Math.floor(p * a.length))].toFixed(1) : null);
	const s = ${P}.controller.stats.solves.map((x) => x.totalMs).sort((a, b) => a - b), f = [...${P}.perf.frames].sort((a, b) => a - b);
	return { solves: s.length, solveMedianMs: q(s, 0.5), solveP95Ms: q(s, 0.95), refused: ${P}.controller.stats.refused, lastDragFrames: f.length, frameMedianMs: q(f, 0.5), frameP95Ms: q(f, 0.95) }; })()`);
console.log(`PERF ${JSON.stringify(perf)}`);

// model missing: a new project with the model URL blocked
blocked = ["*cozy-poser-v1.onnx*"];
await send("Network.setBlockedURLs", { urls: blocked });
await evaluate(`caches.delete("cozy-poser-v1")`);
await openStudio("poser_tour_missing");
const failed = await poll("document.querySelector('[data-testid=poser-model]')?.dataset.status === 'failed'", 20000);
await key("KeyW", "w");
const wWorks = await poll("document.querySelector('.vp-tool-key[data-tool=ik]')?.classList.contains('active')", 3000);
await key("KeyE", "e"); await pause(400);
await shot("model-missing", { status: await evaluate("document.querySelector('[data-testid=poser-model]')?.dataset.status"), retryShown: await evaluate("!!document.querySelector('[data-testid=poser-retry]')"), wToolStillWorks: wWorks }, failed && wWorks);
blocked = [];
await send("Network.setBlockedURLs", { urls: [] });

await writeFile(join(out, "tour.json"), JSON.stringify({ when: new Date().toISOString(), view, steps, perf }, null, 1));
console.log(steps.every((s) => s.ok) ? "ALL OK" : `${steps.filter((s) => !s.ok).length} NOT OK`);
ws.close();
process.exit(0);
