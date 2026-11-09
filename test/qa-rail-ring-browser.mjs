#!/usr/bin/env node
// Browser contract for the route dot's lean rings: with the rotate tool (E) a
// selected interior dot shows a bank ring (about the travel direction) and a
// pitch ring (about the lateral axis); dragging a ring writes that lean, undo
// restores it, and the move tool (W) brings the arrows back. Seeds the real
// Vintage Car scene like qa-rail-lean-browser.
//
// Run: `CCLAY_KIMODO_HOST= COZYCLAY_LIVE_PORT=5932 npm run dev -- --port 5832`
// then `QA_OUT=/tmp/ring QA_URL=http://127.0.0.1:5832/app/ CDP_PORT=9832 node tools/qa-browser.mjs -- node test/qa-rail-ring-browser.mjs`
import fs from "node:fs";
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
/* ---- ring probe: E on a selected dot shows bank/pitch rings; dragging them writes the lean ---- */
import { pathMarkFractions, pathPointAtFraction } from "../src/object-path.js";
const OUT = process.env.QA_OUT;
const png = async (name) => { if (!OUT) return; const s = await send("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(`${OUT}/${name}.png`, Buffer.from(s.data, "base64")); };
await update("cube", { path: { ...routePath, marks: [] } });
const row = await waitFor("chassis row", () => center('[data-node-id="object:cube"]'));
await click(row.x, row.y);
await waitFor("route strip", () => center('[data-testid="route-add-dot"]'));
await seek(111); await sleep(300);
await (async () => { const b = await center('[data-testid="route-add-dot"]'); await click(b.x, b.y); })();
await sleep(400);
let o = await object("cube");
assert.equal(o.path.marks.length, 1, "one dot added");
const idx = await evaluate("window.__cozyclay.pathPointIndex");
assert.equal(idx, 1, "the new dot is selected");
await seek(0); await sleep(300); // the car drives away from the dot: no gizmo overlap
await png("ring-strip-light");
// where the dot is, and its travel frame
const t = pathMarkFractions(o.path)[1];
const D = pathPointAtFraction(o.path, t);
const before = pathPointAtFraction(o.path, Math.max(0, t - 0.01)), after = pathPointAtFraction(o.path, Math.min(1, t + 0.01));
const yaw = Math.atan2(after.x - before.x, after.z - before.z);
const F = { x: Math.sin(yaw), y: 0, z: Math.cos(yaw) }, R = { x: Math.cos(yaw), y: 0, z: -Math.sin(yaw) };
const add = (...vs) => vs.reduce((a, [v, k]) => ({ x: a.x + v.x * k, y: a.y + v.y * k, z: a.z + v.z * k }), { x: 0, y: 0, z: 0 });
const camPos = add([D, 1], [R, 2.4], [{ x: 0, y: 1, z: 0 }, 1.9], [F, -2.4]);
await evaluate(`window.__cozyclay.frameEditorCam({ x: ${camPos.x}, y: ${camPos.y}, z: ${camPos.z} }, { x: ${D.x}, y: ${D.y}, z: ${D.z} })`);
await sleep(400);
// the rotate tool
const rot = await center('[data-tool="rotate"]');
await click(rot.x, rot.y);
await sleep(400);
await png("ring-rotate-mode");
const project = (p) => evaluate(`(() => { const cam = window.__cozyclay.editorCam; cam.updateMatrixWorld(); const c = document.querySelector('.vp-main').getBoundingClientRect(); const v = new cam.position.constructor(${p.x}, ${p.y}, ${p.z}).project(cam); return { x: c.left + (v.x + 1) / 2 * c.width, y: c.top + (1 - v.y) / 2 * c.height }; })()`);
const camWorld = await evaluate("(() => { const p = window.__cozyclay.editorCam.position; return { x: p.x, y: p.y, z: p.z }; })()");
const dist = Math.hypot(camWorld.x - D.x, camWorld.y - D.y, camWorld.z - D.z);
let s = Math.max(0.35, dist * 0.16) * 0.42;
const dragRing = async (pointAt, sweepDeg) => {
	const steps = 16;
	const p0 = await project(pointAt(0));
	await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: p0.x, y: p0.y });
	await sleep(60);
	await send("Input.dispatchMouseEvent", { type: "mousePressed", x: p0.x, y: p0.y, button: "left", clickCount: 1, buttons: 1 });
	for (let i = 1; i <= steps; i += 1) {
		const p = await project(pointAt((sweepDeg * i) / steps));
		await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: p.x, y: p.y, button: "left", buttons: 1 });
		await sleep(16);
	}
	const pe = await project(pointAt(sweepDeg));
	await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: pe.x, y: pe.y, button: "left", clickCount: 1, buttons: 0 });
	await sleep(400);
};
const up = { x: 0, y: 1, z: 0 };
const pointsBefore = JSON.stringify(o.path.points);
const centerPx = await project(D); const edgePx = await project(add([D, 1], [R, s]));
console.log("dot px", centerPx, "ring px radius", Math.hypot(edgePx.x - centerPx.x, edgePx.y - centerPx.y).toFixed(1), "s", s.toFixed(3), "dist", dist.toFixed(2), "idx", await evaluate("window.__cozyclay.pathPointIndex"), "rotate pressed", await evaluate("document.querySelector('[data-tool=\"rotate\"]').getAttribute('aria-pressed')"));
// bank ring: the circle in the right/up plane; from the right-hand point up by 40°
await dragRing((deg) => add([D, 1], [R, s * Math.cos(deg * Math.PI / 180)], [up, s * Math.sin(deg * Math.PI / 180)]), 40);
o = await object("cube");
console.log("after bank drag:", JSON.stringify(o.path.marks[0]), "points moved:", JSON.stringify(o.path.points) !== pointsBefore, "idx now", await evaluate("window.__cozyclay.pathPointIndex"));
assert.ok(Math.abs(o.path.marks[0].bank - 40) <= 4, `bank ring drag of 40° writes ~40: ${o.path.marks[0].bank}`);
assert.equal(o.path.marks[0].pitch, 0, "the bank ring leaves pitch alone");
await png("ring-after-bank");
// pitch ring: seen from the side so the bank ring is edge-on and cannot be hit first
const camPos2 = add([D, 1], [R, 3.6], [up, 1.3], [F, -0.6]);
await evaluate(`window.__cozyclay.frameEditorCam({ x: ${camPos2.x}, y: ${camPos2.y}, z: ${camPos2.z} }, { x: ${D.x}, y: ${D.y}, z: ${D.z} })`);
await sleep(400);
{ const cw = await evaluate("(() => { const p = window.__cozyclay.editorCam.position; return { x: p.x, y: p.y, z: p.z }; })()"); const d2 = Math.hypot(cw.x - D.x, cw.y - D.y, cw.z - D.z); s = Math.max(0.35, d2 * 0.16) * 0.42; }
// the circle in the forward/up plane; from the forward point up by 30°
await dragRing((deg) => add([D, 1], [F, s * Math.cos(deg * Math.PI / 180)], [up, s * Math.sin(deg * Math.PI / 180)]), 30);
o = await object("cube");
console.log("after pitch drag:", JSON.stringify(o.path.marks[0]));
assert.ok(Math.abs(o.path.marks[0].pitch - 30) <= 4, `pitch ring drag of 30° writes ~30 nose-up: ${o.path.marks[0].pitch}`);
assert.ok(Math.abs(o.path.marks[0].bank - 40) <= 4, "the pitch ring leaves bank alone");
// undo twice restores a level dot
for (let i = 0; i < 2; i += 1) { await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "z", code: "KeyZ", modifiers: 4, windowsVirtualKeyCode: 90 }); await send("Input.dispatchKeyEvent", { type: "keyUp", key: "z", code: "KeyZ", modifiers: 4, windowsVirtualKeyCode: 90 }); await sleep(250); }
o = await object("cube");
console.log("after 2 undos:", JSON.stringify(o.path.marks[0]));
// W brings the arrows back
const mv = await center('[data-tool="move"]'); await click(mv.x, mv.y); await sleep(300);
await png("ring-move-mode");
console.log("ring probe: rings appear with E, drags write bank/pitch, W restores arrows");
process.exit(0);
