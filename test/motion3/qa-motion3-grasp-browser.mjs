#!/usr/bin/env node
// Browser QA of holding, throwing and catching (#816): four scenes built in the Studio through its actions, each take
// compiled and installed there (motion.compile), screenshots from the front and the side at the frames that matter, and
// beside each a numeric twin read from the same compile path (compileSpec on the scene records the Studio holds): the
// numbers decide PASS, the PNGs are the evidence. Writes <QA_OUT>/checklist.md.
//
// QA_URL=http://127.0.0.1:5996/app/ CDP_PORT=9333 npm run qa:browser -- node test/motion3/qa-motion3-grasp-browser.mjs
import { mkdir, writeFile } from "node:fs/promises";
import { compileSpec } from "../../src/motion3/pipeline.js";
import { motionScene } from "../../src/motion3/scene.js";
import { skeletonFor } from "../../src/motion3/rigs/index.js";
import { objectPoseAt } from "../../src/motion3/object-pose.js";
import { graspChecks } from "../../src/motion3/qa/grasp-checks.js";
import { grabGap } from "../../src/motion3/qa/object-checks.js";
import { applyPatch } from "../../src/motion3/json-patch.js";
import { ballPickupSpec } from "./fixtures/ball-pickup.mjs";

const port = Number(process.env.CDP_PORT || 9222), out = process.env.QA_OUT || "/tmp/cozyclay3-grasp";
await mkdir(out, { recursive: true });
const page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t => t.type === "page" && t.webSocketDebuggerUrl);
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let nextId = 0;
const pending = new Map();
ws.onmessage = event => { const m = JSON.parse(event.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); if (m.error) p.reject(new Error(JSON.stringify(m.error))); else p.resolve(m.result); } };
const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++nextId; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async expression => { const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result?.value; };
const waitFor = async (expression, ms = 60_000) => { for (const t0 = Date.now(); Date.now() - t0 < ms;) { if (await evaluate(expression).catch(() => false)) return true; await new Promise(r => setTimeout(r, 250)); } return false; };
await send("Runtime.enable");
if (!(await waitFor("Boolean(window.__cozyclay?.rigA && window.__cozyclay.runStudioAction)"))) throw new Error("Studio never exposed a rig");

const act = (id, args) => evaluate(`(async () => { const r = await window.__cozyclay.runStudioAction(${JSON.stringify(id)}, ${JSON.stringify(args)}); return r && { ok: r.ok, affectedIds: r.affectedIds, output: r.output ?? null, error: r.error ?? null }; })()`);
const exported = async () => { let doc = await window_export(); while (typeof doc === "string") doc = JSON.parse(doc); return doc; };
const window_export = () => evaluate("window.__cozyclayProject.export()");
const findAll = (node, pred, acc = []) => { if (node && typeof node === "object") { if (pred(node)) acc.push(node); for (const v of Object.values(node)) findAll(v, pred, acc); } return acc; };
const character = findAll(await exported(), n => Array.isArray(n.characters) && n.characters[0]?.model)[0].characters[0];
const sk = skeletonFor(character.model), I = sk.index;
console.log(`character ${character.id} (${character.model}) at x ${character.x ?? 0}, z ${character.z ?? 0}`);

let made = [];
async function clear() { if (made.length) await act("object.remove", { ids: made }); made = []; }
async function addBox(name, [x, y, z], [sx, sy, sz]) {
	const a = await act("object.add", { kind: "cube", name, placement: { x, z } });
	if (!a?.ok) throw new Error(`object.add ${name}: ${JSON.stringify(a)}`);
	const id = a.affectedIds[0];
	await act("object.set", { id, set: { position: { x, y, z }, scale: { x: sx, y: sy, z: sz } } });
	made.push(id);
	return id;
}
async function addBall([x, y, z]) {
	const a = await act("object.createKit", { kit: "ball", position: { x, y, z } });
	if (!a?.ok) throw new Error(`createKit ball: ${JSON.stringify(a)}`);
	const root = a.output?.rootId ?? a.affectedIds[0];
	made.push(...a.affectedIds);
	return root;
}
/** The scene records the Studio holds for the ids made here (what a compile there reads). */
async function records() {
	const doc = await exported(), ids = new Set(made);
	const recs = findAll(doc, n => typeof n.id === "string" && ids.has(n.id) && typeof n.renderer === "string");
	return [...new Map(recs.map(r => [r.id, r])).values()];
}
async function shoot(name, f, look) {
	const shots = [];
	for (const [view, from] of [["front", [look[0], look[1] + 0.2, look[2] + 1.6]], ["side", [look[0] - 1.6, look[1] + 0.2, look[2]]]]) {
		// frameEditorCam sets the fly controls' look too (a bare lookAt is overwritten before the next paint)
		await evaluate(`window.__cozyclay.frameEditorCam({ x: ${from[0]}, y: ${from[1]}, z: ${from[2]} }, { x: ${look[0]}, y: ${look[1]}, z: ${look[2]} })`);
		// the viewport paints on change: setting the frame (from the one before) repaints it through the moved camera
		await evaluate(`window.__cozyclay.setFrame(${Math.max(0, f - 1)})`);
		await evaluate(`window.__cozyclay.setFrame(${f})`);
		await new Promise(r => setTimeout(r, 500));
		const shot = await send("Page.captureScreenshot", { format: "png" }), file = `${name}-f${String(f).padStart(3, "0")}-${view}.png`;
		await writeFile(`${out}/${file}`, Buffer.from(shot.data, "base64"));
		shots.push(file);
	}
	return shots;
}

const rows = [];
const row = (scene, frame, twin, pass, shots) => { rows.push({ scene, frame, twin, pass, shots }); console.log(`${pass ? "PASS" : "GAP "} ${scene} f${frame}: ${twin}`); };
const kinds = r => r.qa.groups.map(g => g.kind);
const issuesAt = (r, f) => graspChecks(sk, r.out).filter(i => i.frame === f);
const pad = (r, id, f) => { const s = r.out.frames[f].s, b = objectPoseAt(r.out, id, f).pos; return Math.min(...["Index", "Middle", "Ring", "Thumb"].map(n => Math.hypot(...s.P[I[`RightHand${n}4`]].map((v, i) => v - b[i])))); };

async function install(spec) {
	const c = await act("motion.compile", { characterId: character.id, spec, install: true });
	console.log(`  motion.compile: ok ${c?.ok}, installed ${c?.output?.installed}, qa ${c?.output?.qa?.total}`);
	return c;
}

// (a) the session's ball pickup: the ball kit on a table, picked up and lifted
{
	await clear();
	const table = await addBox("Table", [-0.2, 0, 0.7], [0.6, 0.75, 0.6]), ball = await addBall([-0.2, 0.79, 0.41]);
	const spec = JSON.parse(JSON.stringify(ballPickupSpec()).replaceAll('"empty"', JSON.stringify(ball)));
	spec.objects = { [ball]: Object.values(ballPickupSpec().objects)[0] };
	await install(spec);
	const recs = await records(), r = compileSpec(spec, { sk, scene: motionScene(recs) }), off = compileSpec({ ...spec, fix: { grasp: false } }, { sk, scene: motionScene(recs) });
	for (const f of [29, 32, 45, 84]) {
		const iss = issuesAt(r, f), shots = await shoot("a-pickup", f, [-0.2, 0.85, 0.41]);
		row("a ball pickup", f, `pad ${(pad(r, ball, f) * 100).toFixed(1)} cm, grasp issues ${iss.length}${f === 32 ? `, grab gap ${(grabGap(r.out, ball, 30) * 100).toFixed(1)} cm` : ""}`, iss.length === 0, shots);
	}
	const offGrasp = kinds(off).filter(k => /^FINGER_|^SUPPORT$/.test(k)).length;
	row("a ball pickup", "all", `default QA ${r.qa.total} (${kinds(r).join(", ") || "none"}); fix.grasp false grasp groups ${offGrasp}`, r.qa.total === 0 && offGrasp >= 1, []);
	void table;
}

// (b) a throw 5 m out: the ball in the right hand by its pinned grip, thrown at [0, 0, 5]
{
	await clear();
	const props = { ballGrip: { hand: "r", origin: ["RightHandIndex2", "RightHandMiddle2"], points: {} } };
	const throwSpec = id => ({ schema: "cozyclay.motion-spec.v1", fps: 24, frames: 80, props, use: [{ skill: "standIdle", args: { at: [0, 0], heading: 0 }, f0: 0 }, { skill: "throwObject", args: { object: id, to: [0, 0, 5] }, f0: 10 }],
		objects: { [id]: { prop: "ballGrip", at: [0, 0, -0.035], along: [0, 1, 0], grab: 4 } } });
	let ball = await addBall([2, 1, 2]);
	const held = objectPoseAt(compileSpec(throwSpec(ball), { sk, scene: motionScene(await records()) }).out, ball, 4).pos;
	await clear();
	ball = await addBall(held);
	const spec = throwSpec(ball);
	await install(spec);
	const r = compileSpec(spec, { sk, scene: motionScene(await records()) }), rest = objectPoseAt(r.out, ball, 79).pos, miss = Math.hypot(rest[0], rest[2] - 5);
	for (const f of [3, 6, 18, 31]) row("b throw", f, `ball at [${objectPoseAt(r.out, ball, f).pos.map(v => v.toFixed(2)).join(", ")}]`, true, await shoot("b-throw", f, f < 28 ? [0, 1.2, 0.2] : objectPoseAt(r.out, ball, f).pos));
	row("b throw", "all", `QA ${r.qa.total}, lands ${miss.toFixed(3)} m from the target`, r.qa.total === 0 && miss <= 0.25, await shoot("b-throw", 79, [rest[0], 0.3, rest[2]]));
}

// (c) a catch: a ball thrown at f12 from [0, 1.6, 6] at [0, 2.5, -9] m/s
{
	await clear();
	const ball = await addBall([0, 1.6, 6]);
	const spec = { schema: "cozyclay.motion-spec.v1", fps: 24, frames: 64, use: [{ skill: "standIdle", args: { at: [0, 0], heading: 0 }, f0: 0 }, { skill: "catchObject", args: { object: ball }, f0: 12 }],
		objects: { [ball]: { fall: { at: 12, v: [0, 2.5, -9] } } } };
	await install(spec);
	const r = compileSpec(spec, { sk, scene: motionScene(await records()) }), grab = r.out.ctx.spec.objects[ball].grab, P = f => objectPoseAt(r.out, ball, f).pos;
	const give = Math.hypot(...P(grab + 6).map((v, i) => v - P(grab)[i])), gap = grabGap(r.out, ball, grab);
	for (const f of [grab - 2, grab, grab + 3, grab + 8]) row("c catch", f, `ball at [${P(f).map(v => v.toFixed(2)).join(", ")}]`, true, await shoot("c-catch", f, [0, 1.25, 0.35]));
	row("c catch", grab, `QA ${r.qa.total}, grab gap ${(gap * 100).toFixed(1)} cm, give ${give.toFixed(3)} m`, r.qa.total === 0 && gap < 0.03 && give >= 0.08 && give <= 0.15, []);
}

// (d) a 12 kg box held out in front: LOAD, then its patch puts the left hand on it
{
	await clear();
	const GRAB = 20, OUT = [-0.08, 1.2, 0.35];
	const spec0 = id => ({ schema: "cozyclay.motion-spec.v1", fps: 24, frames: 60, props: { boxGrip: { hand: "r", origin: ["RightHandIndex2", "RightHandMiddle2"], points: {} } },
		use: [{ skill: "standIdle", args: { at: [0, 0], heading: 0 }, f0: 0 }], keys: [{ f: 0, set: { armw_r: 1, hand_r: OUT } }], objects: { [id]: { prop: "boxGrip", grab: GRAB, mass: 12 } } });
	const probe = compileSpec({ ...spec0("x"), objects: {}, props: {} }, { sk, scene: motionScene([]) }), Pp = probe.out.frames[GRAB].s.P;
	const palm = Pp[I.RightHandMiddle1].map((v, i) => (v + Pp[I.RightHand][i]) / 2);
	const box = await addBox("Box", [palm[0], palm[1] - 0.23, palm[2] + 0.18], [0.4, 0.4, 0.4]), recs = await records();
	const one = compileSpec(spec0(box), { sk, scene: motionScene(recs) }), load = one.qa.groups.find(g => g.kind === "LOAD");
	const spec = applyPatch(spec0(box), load?.patch ?? []);
	await install(spec);
	const r = compileSpec(spec, { sk, scene: motionScene(recs) });
	for (const f of [GRAB - 1, GRAB + 2, 40, 58]) row("d 12 kg two hands", f, `load ${r.observations.load?.hand_r?.maxNm ?? "-"} N m`, true, await shoot("d-box", f, [palm[0], palm[1] - 0.05, palm[2] + 0.18]));
	row("d 12 kg two hands", "all", `one hand: LOAD ${load?.worst ?? "-"} N m${load?.patch ? " with a patch" : ""}; patched: LOAD ${kinds(r).includes("LOAD") ? "yes" : "no"}, QA ${r.qa.total} (${[...new Set(kinds(r))].join(", ")})`, !!load?.patch && !kinds(r).includes("LOAD") && r.qa.total === 0, []);
}

await clear();
const md = ["# Grasp browser QA (#816)", "", "| scene | frame | numeric twin | result | screenshots |", "|---|---|---|---|---|",
	...rows.map(r => `| ${r.scene} | ${r.frame} | ${r.twin} | ${r.pass ? "PASS" : "GAP"} | ${r.shots.join(", ")} |`)];
await writeFile(`${out}/checklist.md`, md.join("\n") + "\n");
const shots = rows.reduce((n, r) => n + r.shots.length, 0), gaps = rows.filter(r => !r.pass);
console.log(`${shots} screenshots, ${rows.length} rows, ${gaps.length} gap(s): ${out}/checklist.md`);
ws.close();
if (shots < 16) process.exitCode = 1;
