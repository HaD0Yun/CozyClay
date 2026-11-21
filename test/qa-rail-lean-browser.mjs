#!/usr/bin/env node
// Browser contract for lean marks on a travel route, against a real scene: the
// "Vintage Car" (an Empty > Chassis that owns a ~76 m route > Parts > 67 parts
// with four wheels). Seeds test/fixtures/vintage-car-scene.json the way a
// returning author's saved project arrives (SEED_DOC overrides the file).
//   1. Turning the Empty leaves every descendant's route alone, and turning back
//      restores every part exactly (a parent's turn turns bodies, not roads).
//   2. A bank mark on the chassis route lifts one wheel mid-route and is level
//      at the ends; every non-routed part keeps its pose relative to the chassis.
//   3. "Add dot at playhead" drops a dot where the prop is on that frame.
//   4. The Bank field edits the selected dot; the ends stay level (disabled).
//
// Run: `CCLAY_KIMODO_HOST= COZYCLAY_LIVE_PORT=5932 npm run dev -- --port 5832` in
// one shell, then
// `QA_URL=http://127.0.0.1:5832/app/ CDP_PORT=9832 node tools/qa-browser.mjs -- node test/qa-rail-lean-browser.mjs`
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Matrix4, Quaternion, Vector3 } from "three";

const doc = readFileSync(process.env.SEED_DOC || new URL("./fixtures/vintage-car-scene.json", import.meta.url), "utf8");
const cdpPort = Number(process.env.CDP_PORT || 9832);
const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json();
const page = targets.find((t) => t.type === "page" && t.url.includes("/app/")) || targets.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let seq = 0; const pending = new Map();
ws.onmessage = (event) => { const m = JSON.parse(event.data); if (!m.id || !pending.has(m.id)) return; const it = pending.get(m.id); pending.delete(m.id); m.error ? it.reject(new Error(JSON.stringify(m.error))) : it.resolve(m.result); };
const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "eval failed"); return r.result?.value; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (label, probe, timeoutMs = 60000) => { const deadline = Date.now() + timeoutMs; while (Date.now() < deadline) { const v = await probe().catch(() => null); if (v) return v; await sleep(150); } throw new Error(`timeout: ${label}`); };
const navigate = async (url) => { await send("Page.enable"); const loaded = new Promise((resolve) => { const on = (e) => { if (JSON.parse(e.data).method === "Page.loadEventFired") { ws.removeEventListener("message", on); resolve(); } }; ws.addEventListener("message", on); }); await send("Page.navigate", { url }); await loaded; };
const mouse = (type, x, y) => send("Input.dispatchMouseEvent", { type, x: Math.round(x), y: Math.round(y), button: "left", clickCount: 1, buttons: type === "mouseReleased" ? 0 : 1 });
const click = async (x, y) => { await mouse("mousePressed", x, y); await mouse("mouseReleased", x, y); };
const center = (selector) => evaluate(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
const shot = async (name) => {
	if (!process.env.QA_OUT) return;
	const fs = await import("node:fs");
	const s = await send("Page.captureScreenshot", { format: "png" });
	fs.writeFileSync(`${process.env.QA_OUT}/${name}.png`, Buffer.from(s.data, "base64"));
};

const base = new URL(page.url);
await navigate(`${base.origin}/favicon.ico`);
await evaluate(`(() => { localStorage.clear(); localStorage.setItem('cozyclay.locale','en'); localStorage.setItem('cozyclay.project-session.v1', JSON.stringify({ name: 'Rail Lean QA', updatedAt: Date.now() })); localStorage.setItem('cozyclay.scenes.v4', ${JSON.stringify(doc)}); return true; })()`);
await navigate(`${base.origin}/app/`);
await waitFor("hook", () => evaluate("Boolean(window.__cozyclay?.sceneObject) && (window.__cozyclay.objects||[]).length > 100"));
await waitFor("stage", () => evaluate("Boolean(window.__cclayPropWorld?.['cube'] && window.__cclayPropWorld?.['cylinder'])"));
await sleep(800);

const frameCount = await evaluate("window.__cozyclay.frameCount");
const take = { frameCount, fps: 24 };
const objects = () => evaluate("JSON.parse(JSON.stringify(window.__cozyclay.objects))");
const object = async (id) => (await objects()).find((o) => o.id === id);
const update = async (id, patch) => { await evaluate(`window.__cozyclay.sceneObject.update({ id: ${JSON.stringify(id)}, ...${JSON.stringify(patch)} }); true`); await sleep(500); };
const seek = async (frame) => { await evaluate(`window.__cozyclay.scrub(${frame}); true`); await sleep(450); };
// The page's own pure functions, so the QA asks the same math the studio does.
const pagePath = (expression) => evaluate(`(async () => { const m = await import('/src/object-path.js'); const o = window.__cozyclay.objects.find((e) => e.id === 'cube'); const take = ${JSON.stringify(take)}; return JSON.parse(JSON.stringify((${expression})(m, o.path, take))); })()`);
const frameAtProgress = (target) => pagePath(`(m, path, take) => { let best = 0, bestError = 9; for (let f = 0; f < take.frameCount; f += 1) { const e = Math.abs(m.pathProgressAt(path, f, take) - ${target}); if (e < bestError) { best = f; bestError = e; } } return best; }`);
const progressAt = (frame) => pagePath(`(m, path, take) => m.pathProgressAt(path, ${frame}, take)`);
const leanAt = (frame) => pagePath(`(m, path, take) => m.pathLeanAt(path, m.pathProgressAt(path, ${frame}, take))`);

/* ---------------------------------------------------------------- 1. */
const start = await objects();
const byId = (rows) => new Map(rows.map((o) => [o.id, o]));
assert.ok(start.length > 100, "the real scene is loaded");
const chassisStart = byId(start).get("cube");
assert.ok(chassisStart.path?.points.length === 9, "the chassis owns the 9-point route");
const POSE = ["x", "y", "z", "rot", "rotX", "rotZ"];
await update("empty", { rotZ: 15 });
const rolled = byId(await objects());
for (const o of start) assert.deepEqual(rolled.get(o.id).path ?? null, o.path ?? null, `rolling the Empty leaves ${o.id}'s route alone`);
assert.notEqual(rolled.get("cylinder").rotZ, byId(start).get("cylinder").rotZ, "the bodies did turn with the Empty");
await update("empty", { rotZ: 0 });
const back = byId(await objects());
let worstRestore = 0;
for (const o of start) for (const key of POSE) worstRestore = Math.max(worstRestore, Math.abs((back.get(o.id)[key] ?? 0) - (o[key] ?? 0)));
assert.ok(worstRestore < 5e-9, `rolling back restores every record (worst ${worstRestore})`);
for (const o of start) assert.deepEqual(back.get(o.id).path ?? null, o.path ?? null, `${o.id}: route restored`);
console.log(`1. empty rotZ 15 and back: ${start.length} records, routes untouched, worst pose restore error ${worstRestore.toExponential(2)}`);

/* ---------------------------------------------------------------- 2. */
const routePath = chassisStart.path;
await update("cube", { path: { ...routePath, marks: [{ t: 0.4, bank: 12, pitch: 0 }, { t: 0.6, bank: 0, pitch: 0 }] } });
const subtree = (rows, root) => { const out = new Set(); const grow = (id) => { for (const o of rows) if (o.parent === id && !out.has(o.id)) { out.add(o.id); grow(o.id); } }; grow(root); return out; };
const rows = await objects();
const riders = [...subtree(rows, "cube")].filter((id) => !rows.find((o) => o.id === id).path && !rows.find((o) => o.id === id).hidden);
const worldOf = () => evaluate(`(() => { const w = window.__cclayPropWorld; return Object.fromEntries(${JSON.stringify(["cube", ...riders])}.map((id) => [id, w[id] ? { ...w[id], quat: { ...w[id].quat } } : null])); })()`);
const M = (r) => new Matrix4().compose(new Vector3(r.x, r.y, r.z), new Quaternion(r.quat.x, r.quat.y, r.quat.z, r.quat.w), new Vector3(1, 1, 1));
const relativeTo = (world) => { const inv = M(world.cube).invert(); return Object.fromEntries(riders.filter((id) => world[id]).map((id) => [id, new Matrix4().multiplyMatrices(inv, M(world[id]))])); };
const lastFrame = frameCount - 1;
const midFrame = await frameAtProgress(0.4);
const samples = [0, Math.round(midFrame / 2), midFrame, Math.round((midFrame + lastFrame) / 2), lastFrame];
const heights = {}; const relatives = {}; let drift = 0; let driftWho = "";
for (const frame of samples) {
	await seek(frame);
	const world = await worldOf();
	heights[frame] = { fl: world.cylinder.y, fr: world["cylinder-2"].y };
	relatives[frame] = relativeTo(world);
}
for (const frame of samples.slice(1)) {
	for (const id of Object.keys(relatives[0])) {
		const a = new Vector3().setFromMatrixPosition(relatives[0][id]); const b = new Vector3().setFromMatrixPosition(relatives[frame][id]);
		const q = new Quaternion().setFromRotationMatrix(relatives[0][id]).angleTo(new Quaternion().setFromRotationMatrix(relatives[frame][id]));
		const d = Math.max(a.distanceTo(b), q * 0.1);
		if (d > drift) { drift = d; driftWho = `${id}@${frame}`; }
	}
}
const gap = (frame) => heights[frame].fl - heights[frame].fr;
console.log(`2. wheel FL-FR height gap (m), bank 12 at t=0.4 returning to 0 at t=0.6; ${frameCount} frames, mid-route = frame ${midFrame}:`);
for (const frame of samples) console.log(`   frame ${String(frame).padStart(3)}  progress ${(await progressAt(frame)).toFixed(3)}  FL ${heights[frame].fl.toFixed(4)}  FR ${heights[frame].fr.toFixed(4)}  gap ${gap(frame).toFixed(4)}`);
console.log(`   ${riders.length} non-routed riders, worst drift against the chassis ${drift.toExponential(2)} (${driftWho})`);
assert.ok(Math.abs(gap(0)) < 1e-3, `level at frame 0 (${gap(0)})`);
assert.ok(Math.abs(gap(lastFrame)) < 1e-3, `level at the last frame (${gap(lastFrame)})`);
assert.ok(Math.abs(gap(midFrame)) > 0.02, `one wheel lifts mid-route (${gap(midFrame)})`);
const midLean = await leanAt(midFrame);
const track = Math.abs((await object("cylinder")).x - (await object("cylinder-2")).x);
assert.ok(Math.abs(Math.abs(gap(midFrame)) - track * Math.sin(midLean.bank * Math.PI / 180)) < 2e-3, `the gap is track x sin(bank): ${gap(midFrame)} vs ${track * Math.sin(midLean.bank * Math.PI / 180)}`);
assert.ok(drift < 1e-3, `every non-routed part rides the chassis rigidly (drift ${drift})`);
await seek(0);
await shot("rail-lean-frame-0");
await seek(midFrame);
await shot("rail-lean-mid");

/* ---------------------------------------------------------------- 3 + 4. */
await update("cube", { path: { ...routePath, marks: [] } });
const row = await waitFor("chassis row", () => center('[data-node-id="object:cube"]'));
await click(row.x, row.y);
await waitFor("route strip", () => center('[data-testid="route-add-dot"]'));
const hint = await waitFor("route hint toast", () => evaluate(`(document.querySelector('.toast')?.textContent ?? '').includes('Double-click the line to add a dot') || null`).catch(() => null), 4000).catch(() => null);
console.log(`3. first route selection toast shown: ${Boolean(hint)}`);
assert.ok(hint, "selecting a route shows the one-time hint");
const addFrame = await frameAtProgress(0.25);
await seek(addFrame);
const expectedT = await progressAt(addFrame);
const addButton = await center('[data-testid="route-add-dot"]');
assert.equal(await evaluate("document.querySelector('[data-testid=\"route-add-dot\"]').disabled"), false, "Add dot is available mid-route");
await click(addButton.x, addButton.y);
await sleep(500);
const added = (await object("cube")).path.marks;
assert.equal(added.length, 1, `Add dot adds one mark: ${JSON.stringify(added)}`);
assert.ok(Math.abs(added[0].t - expectedT) < 1e-6, `at the playhead: t ${added[0].t} vs progress ${expectedT}`);
assert.equal(await evaluate("window.__cozyclay.pathPointIndex"), 1, "the new dot is selected");
assert.equal(await evaluate("document.querySelector('[data-testid=\"route-add-dot\"]').disabled"), true, "no second dot on top of the first");
console.log(`   Add dot at frame ${addFrame}: mark t=${added[0].t.toFixed(4)} (progress ${expectedT.toFixed(4)}), selected`);

const field = await waitFor("bank field", () => center('[data-testid="route-lean-fields"] .number-field:nth-child(1) input'));
assert.equal(await evaluate("document.querySelector('[data-testid=\"route-lean-fields\"] input').disabled"), false, "the lean fields are live on an interior dot");
await click(field.x, field.y);
await sleep(150);
await send("Input.insertText", { text: "9" });
await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
await sleep(500);
const edited = (await object("cube")).path.marks;
assert.equal(edited.length, 1);
assert.equal(edited[0].bank, 9, `the Bank field edits the selected dot: ${JSON.stringify(edited)}`);
assert.ok(Math.abs(edited[0].t - added[0].t) < 1e-12 && edited[0].pitch === 0, "its place and pitch are untouched");
console.log(`4. Bank field: typed 9 -> ${JSON.stringify(edited[0])}`);
await shot("rail-lean-dot-selected");
// The dot that carries a lean wears a tilt bar: look at it.
const leanDot = await pagePath(`(m, path) => m.pathPointAtFraction(path, ${edited[0].t})`);
await evaluate(`window.__cozyclay.frameEditorCam({ x: ${leanDot.x + 2.5}, y: ${leanDot.y + 2.2}, z: ${leanDot.z + 2.5} }, { x: ${leanDot.x}, y: ${leanDot.y}, z: ${leanDot.z} })`);
await seek(addFrame + 1); // a repaint: the stage renders on demand
await sleep(300);
await shot("rail-lean-dot-tilt-bar");

// The ends are level, always: pressing the route's start dot selects it, and the
// lean fields turn off with a hint.
const startPoint = (await object("cube")).path.points[0];
await evaluate(`window.__cozyclay.frameEditorCam({ x: ${startPoint.x}, y: 9, z: ${startPoint.z + 7} }, { x: ${startPoint.x}, y: 0.4, z: ${startPoint.z} })`);
await seek(0);
await sleep(400);
const dot = await evaluate(`(() => { const cam = window.__cozyclay.editorCam; cam.updateMatrixWorld(); const c = document.querySelector('.vp-main').getBoundingClientRect(); const v = new cam.position.constructor(${startPoint.x}, ${startPoint.y}, ${startPoint.z}).project(cam); return { x: c.left + (v.x + 1) / 2 * c.width, y: c.top + (1 - v.y) / 2 * c.height }; })()`);
await click(dot.x, dot.y);
await sleep(500);
assert.equal(await evaluate("window.__cozyclay.pathPointIndex"), 0, "the start dot is selected");
const atEnd = await evaluate("[...document.querySelectorAll('[data-testid=\"route-lean-fields\"] input')].map((i) => [i.disabled, i.value])");
console.log(`   start dot selected: lean fields ${JSON.stringify(atEnd)}`);
assert.deepEqual(atEnd, [[true, "0"], [true, "0"]], "an end shows its lean fields off, at 0");
const endHint = await evaluate("document.querySelector('[data-testid=\"route-lean-fields\"]').parentElement.querySelector('.tl-path-hint').textContent");
assert.match(endHint, /level/i, `the hint says the ends are level: ${endHint}`);
await shot("rail-lean-end-selected");

console.log("rail lean browser QA: route turns leave roads alone, a bank mark lifts one wheel, Add dot and Bank field work");
ws.close();
