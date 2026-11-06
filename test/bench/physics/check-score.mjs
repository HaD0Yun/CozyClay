#!/usr/bin/env node
// PR 3 check (docs/qa/physics-bench.md): the scorer passes a correct synthetic motion and fails a broken one.
//   node test/bench/physics/check-score.mjs
// Each case moves the rest-pose Y Bot as one rigid body (no tool involved), so the expected answer is known:
//   jump      a ballistic hop (g = 9.81)               -> the airborne span passes the gravity check
//   hover     a rise at constant speed, then a hold    -> the gravity check fails (hovering)
//   slide     a planted foot dragged 5 cm on the floor -> foot slide over 2 cm
//   still     the same stand without the drag          -> no slide
//   bar-in    set 1's bar (made short) at the left palm -> penetration, and "hands never 1 cm inside the bar" fails
//   bar-under the same bar 7 cm above the palm           -> neither
import { measure, shared } from "./checks.mjs";
import { loadSets } from "./sets.mjs";
import { RIG, landmarksAt, mat4 } from "./take.mjs";
import { TASKS } from "./tasks.mjs";
import { skeletonFor } from "../../../src/motion3/rigs/index.js";

const sk = skeletonFor("y-bot-tpose"), sets = loadSets();
const set = n => sets.find(s => s.task === n);
/** A take of the rest pose moved by offset(f) (a rigid translation), with the set's objects still. */
function rigid(s, frames, offset) {
	const bones = Array.from({ length: frames }, (_, f) => { const o = offset(f); return sk.restWorldPos.map((p, b) => mat4(sk.restWorldRot[b], [p[0] + o[0], p[1] + o[1], p[2] + o[2]])); });
	const objects = Object.fromEntries(s.objects.map(o => [o.id, { shape: o.shape, size: o.size ?? null, fixed: Boolean(o.fixed), mass: o.mass ?? null, parent: o.parent ?? null, matrix: [mat4([[1, 0, 0], [0, 1, 0], [0, 0, 1]], o.center)] }]));
	return { version: 0, fps: 24, frames, rig: RIG, characters: { "char-a": { bones } }, objects, source: { tool: "synthetic" } };
}
const g = 9.81, dt = 1 / 24, v0 = 2.2, air = Math.round(((2 * v0) / g) / dt);
// a short bar (0.3 m) at the standing T-pose's left palm, so only the hand can reach it (in a T-pose the shoulders are
// at hand height, and a long bar would cross the torso)
const palm = landmarksAt(rigid(set(2), 1, () => [0, 0, 0]), "char-a", 0).palm_l;
const shortBar = dy => ({ ...set(1), objects: [{ ...set(1).objects[0], center: [palm[0], palm[1] + dy, palm[2]], size: [0.3, 0.04, 0.04] }] });
const CASES = [
	["jump", set(2), rigid(set(2), 50, f => [0, f >= 10 && f <= 10 + air ? v0 * (f - 10) * dt - 0.5 * g * ((f - 10) * dt) ** 2 + 0.0001 : 0, 0]), m => shared(m).hovering.length === 0],
	["hover", set(2), rigid(set(2), 50, f => [0, Math.min(Math.max(f - 10, 0), 15) * 0.03, 0]), m => shared(m).hovering.length > 0],
	["slide", set(2), rigid(set(2), 30, f => [0, 0, Math.min(Math.max(f - 10, 0), 10) * 0.005]), m => shared(m).footSlide.slide > 0.02],
	["still", set(2), rigid(set(2), 30, () => [0, 0, 0]), m => shared(m).footSlide.slide <= 0.02],
	["bar-in", shortBar(0), rigid(shortBar(0), 5, () => [0, 0, 0]), m => shared(m).penetration.depth > 0.02 && !TASKS[1](m).find(x => /1 cm inside/.test(x.name)).pass],
	["bar-under", shortBar(0.07), rigid(shortBar(0.07), 5, () => [0, 0, 0]), m => shared(m).penetration.depth <= 0.02 && TASKS[1](m).find(x => /1 cm inside/.test(x.name)).pass],
];
let failed = 0;
for (const [name, s, take, expect] of CASES) {
	const m = measure(take, s), ok = expect(m), sh = shared(m);
	if (!ok) failed++;
	console.log(`${ok ? "OK  " : "FAIL"} ${name.padEnd(10)} hovering ${sh.hovering.length} ${sh.hovering.map(h => `(error ${h.error.toFixed(3)} m)`).join(" ")}, foot slide ${(sh.footSlide.slide * 100).toFixed(1)} cm, penetration ${(sh.penetration.depth * 100).toFixed(1)} cm ${sh.penetration.part ?? ""}`);
}
console.log(failed ? `${failed} of ${CASES.length} cases wrong: FAIL` : `${CASES.length} cases: PASS`);
process.exit(failed ? 1 : 0);
