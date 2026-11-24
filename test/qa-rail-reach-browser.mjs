#!/usr/bin/env node
// Browser contract: the rail follows the group. In the vintage-car scene the
// route belongs to the Chassis (cube) under the Empty "Vintage Car" — and the
// Empty is what an author selects. Selecting it must show the Chassis's rail
// and dots (double-click the line adds a dot to the CHASSIS's route), and
// during playback the Empty rides the car instead of staying at its authored
// place, so the Empty's marker and gizmo stay on the car.
//
// Seeds the author's real scene (test/fixtures/vintage-car-scenes.json, or
// SEED_DOC) into localStorage the way a returning author has it.
//
// Run: `CCLAY_KIMODO_HOST= COZYCLAY_LIVE_PORT=5934 npm run dev -- --port 5834`
// in one shell, then
// `QA_URL=http://127.0.0.1:5834/app/ CDP_PORT=9834 node tools/qa-browser.mjs -- node test/qa-rail-reach-browser.mjs`
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Euler, Matrix4, Quaternion, Vector3 } from "three";
import { objectTransformAt } from "../src/object-path.js";

const seedPath = process.env.SEED_DOC || fileURLToPath(new URL("./fixtures/vintage-car-scenes.json", import.meta.url));
const doc = readFileSync(seedPath, "utf8");
const cdpPort = Number(process.env.CDP_PORT || 9834);
const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json();
const page = targets.find((target) => target.type === "page" && target.url.includes("/app/")) || targets.find((target) => target.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let seq = 0; const pending = new Map();
ws.onmessage = (event) => { const m = JSON.parse(event.data); if (!m.id || !pending.has(m.id)) return; const it = pending.get(m.id); pending.delete(m.id); if (m.error) it.reject(new Error(JSON.stringify(m.error))); else it.resolve(m.result); };
const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expression) => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "eval failed"); return r.result?.value; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (label, probe, timeoutMs = 60000) => { const d = Date.now() + timeoutMs; while (Date.now() < d) { const v = await probe().catch(() => null); if (v) return v; await sleep(150); } throw new Error(`Timed out waiting for ${label}`); };
const mouse = (type, x, y, clickCount = 1) => send("Input.dispatchMouseEvent", { type, x: Math.round(x), y: Math.round(y), button: "left", clickCount, buttons: type === "mouseReleased" ? 0 : 1 });
const click = async (x, y) => { await mouse("mousePressed", x, y); await mouse("mouseReleased", x, y); };
const dblclick = async (x, y) => {
	await click(x, y);
	await mouse("mousePressed", x, y, 2);
	await mouse("mouseReleased", x, y, 2);
	await sleep(500);
};
const navigate = async (url) => {
	await send("Page.enable");
	const loaded = new Promise((resolve) => { const on = (e) => { if (JSON.parse(e.data).method === "Page.loadEventFired") { ws.removeEventListener("message", on); resolve(); } }; ws.addEventListener("message", on); });
	await send("Page.navigate", { url });
	await loaded;
};

await send("Runtime.enable");
const base = new URL(page.url);
await navigate(`${base.origin}/favicon.ico`);
await evaluate(`(() => { localStorage.clear(); localStorage.setItem('cozyclay.shell.agent-pane.v1','folded'); localStorage.setItem('cozyclay.locale','en'); localStorage.setItem('cozyclay.project-session.v1', JSON.stringify({ name: 'Rail reach QA', updatedAt: Date.now() })); localStorage.setItem('cozyclay.scenes.v4', ${JSON.stringify(doc)}); return true; })()`);
await navigate(`${base.origin}/app/`);
await waitFor("hooks", () => evaluate("Boolean(window.__cozyclay?.sceneObject) && (window.__cozyclay.objects || []).length > 100"));
await waitFor("stage", () => evaluate("Boolean(window.__cclayPropWorld?.['empty'] && window.__cclayPropWorld?.['cube'])"));
await sleep(800);

const authored = await evaluate(`(() => { const o = Object.fromEntries(window.__cozyclay.objects.map((e) => [e.id, e])); return { empty: o.empty, cube: o.cube, frameCount: window.__cozyclay.frameCount }; })()`);
assert.equal(authored.empty.renderer, "empty", "the scene's Vintage Car is an Empty");
assert.equal(authored.empty.path, null, "the Empty owns no route");
assert.ok(authored.cube.path?.points?.length > 2 && authored.cube.parent === "empty", "the Chassis owns the route under the Empty");
const take = { frameCount: authored.frameCount, fps: 24 };

const world = (id) => evaluate(`window.__cclayPropWorld[${JSON.stringify(id)}]`);
const seek = async (frame) => { await evaluate(`window.__cozyclay.scrub(${frame})`); await sleep(600); };
const hooks = () => evaluate(`(() => { const h = window.__cozyclay; return { enabled: h.pathHandlesEnabled, ownerId: h.objectPathOwnerId, marks: h.objectPath?.marks ?? null, pointCount: h.objectPath?.points?.length ?? 0, markIndex: h.pathPointIndex }; })()`);
const selectedRow = () => evaluate(`document.querySelector('[data-node-id][aria-selected="true"]')?.getAttribute('data-node-id') ?? null`);

/* ---- before selecting anything: no rail ---- */
await seek(0);
assert.equal((await hooks()).enabled, false, "nothing selected: no rail");
const cubeBefore150 = await (async () => { await seek(150); return world("cube"); })();
await seek(0);

/* ---- select the Empty through the real hierarchy row ---- */
await waitFor("Vintage Car row", () => evaluate(`(() => { if (document.querySelector('[data-node-id="object:empty"]')) return true; const f = document.querySelector('[data-node-id="props"] .hierarchy-toggle'); if (f && f.textContent.trim() === "▸") f.click(); return null; })()`));
const row = await evaluate(`(() => { const r = document.querySelector('[data-node-id="object:empty"]').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
await click(row.x, row.y);
await sleep(700);
assert.equal(await selectedRow(), "object:empty", "the selection is the Empty, not the Chassis");
const selected = await hooks();
assert.equal(selected.enabled, true, "the rail is on for the selected Empty");
assert.equal(selected.ownerId, "cube", "and it is the Chassis's route");
assert.equal(selected.pointCount, authored.cube.path.points.length, "the handles carry the Chassis's whole route");
assert.deepEqual(selected.marks, authored.cube.path.marks ?? [], "no dots yet");

/* ---- frame the route and double-click it: a dot lands on the Chassis ---- */
const pts = authored.cube.path.points;
const near = pts[4];
await evaluate(`window.__cozyclay.frameEditorCam({ x: ${near.x}, y: 14, z: ${near.z + 9} }, { x: ${near.x}, y: ${near.y}, z: ${near.z} })`);
await sleep(700);
const proj3 = (p) => evaluate(`(() => { const cam = window.__cozyclay.editorCam; cam.updateMatrixWorld(); const c = document.querySelector('.vp-main').getBoundingClientRect(); const v = new cam.position.constructor(${p.x}, ${p.y}, ${p.z}).project(cam); return { x: Math.round(c.left + (v.x + 1) / 2 * c.width), y: Math.round(c.top + (1 - v.y) / 2 * c.height) }; })()`);
const spot = await proj3(near);
console.log("route point on screen", JSON.stringify(spot));
await dblclick(spot.x, spot.y);
const added = await hooks();
assert.equal(await selectedRow(), "object:empty", "double-clicking the line keeps the Empty selected");
assert.equal(added.enabled, true, "the rail is still on");
assert.ok(added.markIndex >= 1, `the new dot is rendered and selected (mark index ${added.markIndex})`);
assert.equal(added.marks.length, (authored.cube.path.marks ?? []).length + 1, `a dot was added: ${JSON.stringify(added)}`);
const after = await evaluate(`(() => { const o = Object.fromEntries(window.__cozyclay.objects.map((e) => [e.id, e])); return { cubePath: o.cube.path, emptyPath: o.empty.path, cubePose: [o.cube.x, o.cube.y, o.cube.z, o.cube.rot], emptyPose: [o.empty.x, o.empty.y, o.empty.z, o.empty.rot] }; })()`);
assert.equal(after.cubePath.marks.length, added.marks.length, "the dot is stored on cube.path.marks");
assert.deepEqual(after.cubePath.points, authored.cube.path.points, "adding a dot never reshapes the route");
assert.equal(after.emptyPath, null, "the Empty still owns no route");
assert.deepEqual(after.cubePose, [authored.cube.x, authored.cube.y, authored.cube.z, authored.cube.rot], "the Chassis's authored pose is untouched");
assert.deepEqual(after.emptyPose, [authored.empty.x, authored.empty.y, authored.empty.z, authored.empty.rot], "and so is the Empty's");

/* ---- playback: the Empty rides the car ---- */
const matrix = (r) => new Matrix4().compose(new Vector3(r.x, r.y, r.z), new Quaternion(r.quat.x, r.quat.y, r.quat.z, r.quat.w), new Vector3(1, 1, 1));
const authoredMatrix = (o) => new Matrix4().compose(new Vector3(o.x, o.y ?? 0, o.z), new Quaternion().setFromEuler(new Euler((o.rotX ?? 0) * Math.PI / 180, (o.rot ?? 0) * Math.PI / 180, (o.rotZ ?? 0) * Math.PI / 180)), new Vector3(1, 1, 1));
const numbers = {};
for (const frame of [0, 60, 150]) {
	await seek(frame);
	const [empty, cube] = [await world("empty"), await world("cube")];
	const motion = new Matrix4().multiplyMatrices(matrix(cube), authoredMatrix(authored.cube).invert());
	const expected = new Vector3().setFromMatrixPosition(new Matrix4().multiplyMatrices(motion, authoredMatrix(authored.empty)));
	const err = expected.distanceTo(new Vector3(empty.x, empty.y, empty.z));
	const away = Math.hypot(empty.x - authored.empty.x, empty.z - authored.empty.z);
	numbers[frame] = { errMm: +(err * 1000).toFixed(4), awayM: +away.toFixed(2) };
	assert.ok(err < 0.001, `frame ${frame}: the Empty is ${(err * 1000).toFixed(3)} mm from the chassis motion applied to its authored pose`);
	if (frame === 150) {
		assert.ok(away > 5, `frame 150: the car has driven off (${away.toFixed(1)} m) and the Empty went with it`);
		// the Chassis itself is exactly its own route sample, as before the feature
		const own = objectTransformAt(authored.cube, 150, take);
		assert.ok(Math.hypot(cube.x - own.x, cube.y - own.y, cube.z - own.z) < 0.001, `the Chassis sits on its route sample: ${JSON.stringify([cube.x, cube.y, cube.z])} vs ${JSON.stringify([own.x, own.y, own.z])}`);
		assert.ok(Math.hypot(cube.x - cubeBefore150.x, cube.y - cubeBefore150.y, cube.z - cubeBefore150.z) < 0.001, "and the Chassis is where it was before the Empty was selected");
	}
}

/* ---- the gizmo sits on the drawn Empty, not on its authored numbers ---- */
{
	const empty = await world("empty");
	await evaluate(`window.__cozyclay.frameEditorCam({ x: ${empty.x}, y: 14, z: ${empty.z + 9} }, { x: ${empty.x}, y: ${empty.y}, z: ${empty.z} })`);
	await sleep(800);
	// the move gizmo's vertical arm rises from its origin: it shares the origin's screen x, and the origin sits between the arm and the depth arm
	const handles = await evaluate("window.__gizmoHandles()");
	const up = handles.find((handle) => handle.axis === "y");
	const depth = handles.find((handle) => handle.axis === "z");
	assert.ok(up && depth, "the selected Empty has a transform gizmo");
	const there = await proj3(empty);
	const gap = Math.abs(up.x - there.x);
	numbers.gizmoGapPx = +gap.toFixed(1);
	assert.ok(gap < 40 && there.y > up.y - 60 && there.y < depth.y + 60, `the gizmo is on the Empty's drawn position (${JSON.stringify({ up, depth, there })}); it used to stay ${Math.hypot(empty.x - authored.empty.x, empty.z - authored.empty.z).toFixed(1)} m away at its authored place`);
}

/* ---- dragging the gizmo of the carried Empty at frame 150 ---- */
// A world-space drag is delta-based on authored numbers: the group (Empty,
// Chassis, route) moves by the dragged amount, and the Empty, drawn by the
// car's carry, moves by exactly that amount on screen too — no jump.
{
	const before = { drawn: await world("empty"), cube: await world("cube"), authored: await evaluate(`(() => { const o = Object.fromEntries(window.__cozyclay.objects.map((e) => [e.id, e])); return { empty: [o.empty.x, o.empty.y, o.empty.z], cube: [o.cube.x, o.cube.y, o.cube.z], route0: o.cube.path.points[0] }; })()`) };
	const arm = (await evaluate("window.__gizmoHandles()")).find((handle) => handle.axis === "x");
	await mouse("mousePressed", arm.x, arm.y);
	for (let i = 1; i <= 8; i += 1) { await mouse("mouseMoved", arm.x + (40 * i) / 8, arm.y); await sleep(20); }
	await mouse("mouseReleased", arm.x + 40, arm.y);
	await sleep(700);
	const now = { drawn: await world("empty"), cube: await world("cube"), authored: await evaluate(`(() => { const o = Object.fromEntries(window.__cozyclay.objects.map((e) => [e.id, e])); return { empty: [o.empty.x, o.empty.y, o.empty.z], cube: [o.cube.x, o.cube.y, o.cube.z], route0: o.cube.path.points[0] }; })()`) };
	const dx = now.authored.empty[0] - before.authored.empty[0];
	assert.ok(Math.abs(dx) > 0.05, `the drag moved the Empty's authored x by ${dx.toFixed(3)}`);
	assert.ok(Math.abs(now.authored.empty[2] - before.authored.empty[2]) < 1e-6 && Math.abs(now.authored.empty[1] - before.authored.empty[1]) < 1e-6, "and only x");
	assert.ok(Math.abs(now.authored.cube[0] - before.authored.cube[0] - dx) < 1e-6, "the Chassis, grouped under it, moved the same amount");
	assert.ok(Math.abs(now.authored.route0.x - before.authored.route0.x - dx) < 1e-6, "and carried its route along");
	const drawnMove = [now.drawn.x - before.drawn.x, now.drawn.y - before.drawn.y, now.drawn.z - before.drawn.z];
	assert.ok(Math.hypot(drawnMove[0] - dx, drawnMove[1], drawnMove[2]) < 1e-3, `the drawn Empty moved by the dragged amount, with no jump: ${JSON.stringify(drawnMove)} vs dx ${dx}`);
	numbers.dragDx = +dx.toFixed(3);
}
console.log(JSON.stringify(numbers));
console.log("rail reach browser QA: the Empty shows the Chassis's rail, a dot lands on the Chassis, and the Empty rides the car");
ws.close();
