#!/usr/bin/env node
// engine-simple flow: keys of one upper-layer field that follow each other with no hold pass the shared target
// without stopping (flow.js), a key cut into goes on at the field's speed, and the body layer has no one-frame snaps
// of the pelvis where a walk starts or stops or where a planted foot needs the pelvis lower (gait.js, spec-layers.js).
// Every number is measured here from the clip's joint positions.
import assert from "node:assert/strict";
import { buildClip } from "../../src/lowvis/engine-simple/engine.js";
import { INDEX as J, JOINT_COUNT } from "../../src/lowvis/rig17.js";

const one = (frames, props = []) => ({ frames, characters: [{ id: "a", at: [0, 0], heading: 0 }], props });
const build = (scene, a) => buildClip({ demo: "t", a }, scene).clip.characters[0];
const at = (c, f, j) => Array.from(c.pos.slice((f * JOINT_COUNT + j) * 3, (f * JOINT_COUNT + j) * 3 + 3));
const local = (c, f, j) => { const p = at(c, f, j), h = at(c, f, J.Hips); return [p[0] - h[0], p[1] - h[1], p[2] - h[2]]; }; // heading 0, standing: body frame = world axes
const speed = (c, f, j, get = local) => Math.hypot(...get(c, f + 1, j).map((v, k) => v - get(c, f, j)[k])) * 24; // m/s from frame f to f + 1
const fails = [];
const check = (ok, what) => { if (!ok) fails.push(what); console.log(`${ok ? "ok" : "FAIL"} ${what}`); };

// 1. A chain of hand keys that goes on the same way: no stop at the shared targets; with one frame between, a stop.
const up = [[-0.25, 0.1, 0.3], [-0.25, 0.3, 0.35], [-0.25, 0.5, 0.4], [-0.25, 0.7, 0.4]];
const chain = gap => build(one(72), up.map((R, k) => [k * (12 + gap), "pose", { R, over: 12 }]));
const flowing = chain(0), held = chain(1);
const lowAt = (c, f) => Math.min(speed(c, f - 1, J.RightHand), speed(c, f, J.RightHand));
for (const f of [12, 24]) {
	const peak = Math.max(...[...Array(10)].map((_, k) => speed(flowing, f - 10 + k, J.RightHand)));
	check(lowAt(flowing, f) > 0.4 * peak, `chained keys: the hand passes frame ${f} at ${lowAt(flowing, f).toFixed(2)} m/s, over 40% of the ${peak.toFixed(2)} m/s before it`);
	check(lowAt(held, f + f / 12) < 0.1, `with a frame between the keys the hand stops at frame ${f + f / 12} (${lowAt(held, f + f / 12).toFixed(3)} m/s)`);
}
// the field is on each target on the frame its key ends, as without the flow (the wrist on the asked place, within 1 mm)
const hips0 = at(flowing, 0, J.Hips);
for (const [k, f] of [[1, 12], [2, 24], [3, 36]]) {
	const w = at(held, f + k - 1, J.RightHand), w2 = at(flowing, f, J.RightHand), d = Math.hypot(...w.map((v, i) => v - w2[i]));
	check(d < 0.001, `the wrist on frame ${f} (key ${k} ends) is where it is with the keys held apart, ${(d * 1000).toFixed(2)} mm`);
}
assert.ok(hips0);

// 2. A chain that turns back in every coordinate stops at the turn (no speed is made up there).
const zig = build(one(48), [[0, "pose", { R: [-0.2, 0.2, 0.3], over: 12 }], [12, "pose", { R: [-0.3, 0.4, 0.2], over: 12 }], [24, "pose", { R: [-0.2, 0.2, 0.3], over: 12 }]]);
check(lowAt(zig, 24) < 0.15, `a key that sends the hand back the way it came stops at frame 24 (${lowAt(zig, 24).toFixed(3)} m/s)`);

// 3. A key cut into goes on at the hand's speed: the change of the wrist's velocity in one frame at the cut stays
// under a third of its speed (base: it fell to rest at once).
const cut = build(one(60), [[0, "pose", { R: [-0.3, 0.5, 0.2], over: 24 }], [10, "pose", { R: [-0.3, 0.2, 0.45], over: 20 }]]);
const vel = (c, f) => local(c, f + 1, J.RightHand).map((v, k) => (v - local(c, f, J.RightHand)[k]) * 24);
const dv = Math.hypot(...vel(cut, 10).map((v, k) => v - vel(cut, 9)[k])), sp = Math.hypot(...vel(cut, 9));
check(dv < sp / 3, `a key cut into at frame 10: the wrist's velocity changes by ${dv.toFixed(2)} m/s in one frame at ${sp.toFixed(2)} m/s`);

// 4. The same for a scalar field: lean 0 -> 15 -> 30 deg in two chained keys passes 15 deg moving.
const lean = build(one(48), [[0, "pose", { lean: 15, over: 12 }], [12, "pose", { lean: 30, over: 12 }]]);
const chest = (c, f) => local(c, f, J.Head);
check(Math.min(speed(lean, 11, J.Head, chest), speed(lean, 12, J.Head, chest)) > 0.4 * speed(lean, 6, J.Head, chest), "chained lean keys: the head moves on through frame 12");

// 5. The body layer: no one-frame snap of the pelvis (speed over 0.3 m/s and over 3 times both frames beside it) where
// a walk starts after a stand, stops, or plants a foot out of the leg's reach at the pelvis' height.
const snaps = c => { const n = []; for (let f = 1; f < c.pos.length / JOINT_COUNT / 3 - 2; f++) { const v = g => speed(c, f + g, J.Hips, (cc, ff, j) => at(cc, ff, j)); if (v(0) > 0.3 && v(0) > 3 * v(-1) && v(0) > 3 * v(1)) n.push(f); } return n; };
const walks = build(one(200, [{ id: "seat", size: [0.6, 0.45, 0.45], at: [0, 0.225, 3.2] }]), [[0, "idle"], [10, "walk", { to: [0, 2] }], [70, "idle"], [84, "walk", { to: [0, 2.65], heading: 180 }], [130, "sit", { on: "seat", over: 30 }], [170, "stand", { over: 24 }]]);
check(snaps(walks).length === 0, `walk, stand, walk, sit, stand: pelvis snaps at frames [${snaps(walks).join(", ")}]`);
const stands = [...Array(10)].map((_, f) => at(walks, f, J.Hips));
check(stands.every(p => Math.hypot(p[0] - stands[0][0], p[2] - stands[0][2]) < 1e-6), "a body that stands before its walk keeps its pelvis still");

console.log(fails.length ? `FAIL verify-smooth-flow: ${fails.length}` : "PASS verify-smooth-flow");
process.exit(fails.length ? 1 : 0);
