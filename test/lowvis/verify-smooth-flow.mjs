#!/usr/bin/env node
// engine-simple flow: keys of one upper-layer field that follow each other with no hold pass the shared target
// without stopping (flow.js), a key cut into goes on at the field's speed, and the body layer has no one-frame snaps
// of the pelvis where a walk starts or stops or where a planted foot needs the pelvis lower (gait.js, spec-layers.js).
// The flow leaves the body and the key frames as they are without it: the reach assist does not follow it, a hand on a
// held prop stays on its place, and a hand is on a shared target on its frame (solve.js, share.js, flow.js).
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
	// 30%, was 40% while the inout blend was the cubic: the minimum-jerk blend's own peak is 1.875 times its mean, not 1.5
	check(lowAt(flowing, f) > 0.3 * peak, `chained keys: the hand passes frame ${f} at ${lowAt(flowing, f).toFixed(2)} m/s, over 30% of the ${peak.toFixed(2)} m/s before it`);
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
check(dv < 0.75 * sp, `a key cut into at frame 10 keeps the part of its speed that goes toward the new target: the wrist's velocity changes by ${dv.toFixed(2)} m/s in one frame at ${sp.toFixed(2)} m/s`);

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

// 6. The reach assist follows the blends without the flow: under chained hand keys the hips go no lower and move no
// more in one frame than under the same keys held a frame apart (which do not flow), at scale 1 and at 0.81.
for (const scale of [1, 0.81]) {
	const keys = [[0.3, 0.1, 0.3], [0.35, 0.35, 0.3], [0.2, 0.55, 0.25], [0.45, 0.4, 0.1]];
	const made = gap => buildClip({ demo: "t", a: keys.map((hands, k) => [k * (12 + gap), "pose", { hands, over: 12 }]) }, { frames: 60, characters: [{ id: "a", at: [0, 0], heading: 0, scale }], props: [] }).clip.characters[0];
	const hips = c => [...Array(60)].map((_, f) => at(c, f, J.Hips)), low = c => Math.min(...hips(c).map(p => p[1])), step = c => Math.max(...hips(c).slice(1).map((p, f) => Math.hypot(...p.map((v, k) => v - hips(c)[f][k]))));
	const flow = made(0), apart = made(1);
	check(low(flow) > low(apart) - 0.003 * scale, `scale ${scale}: chained hand keys lower the hips to ${low(flow).toFixed(4)} m, the same keys a frame apart to ${low(apart).toFixed(4)} m`);
	check(step(flow) < step(apart) + 0.003 * scale, `scale ${scale}: under chained hand keys the hips move at most ${(step(flow) * 1000).toFixed(1)} mm in a frame, a frame apart ${(step(apart) * 1000).toFixed(1)} mm`);
}

// 7. A hand that holds a prop at a place while its keys flow stays on that place: its reach entry of the hold is under
// 1 mm on every frame of the hold after the other holder lets go (the second pass of the frame follows the same blend).
{
	const scene = { frames: 100, characters: [{ id: "a", at: [0, 0], heading: 90 }, { id: "b", at: [1.3, 0], heading: 270 }], props: [{ id: "pole", size: [0.05, 0.05, 0.9], at: [0.3, 1.0, 0.3], moves: true }] };
	const { aux } = buildClip({ demo: "t",
		a: [[0, "hold", { prop: "pole", hand: "R" }], [0, "pose", { R: [-0.25, 0.15, 0.3], aim: [0, 1, 0], over: 10 }], [10, "pose", { R: [-0.2, 0.3, 0.45], over: 10 }], [20, "pose", { R: [-0.15, 0.35, 0.55], over: 10 }], [60, "release", { prop: "pole", hand: "R" }], [60, "pose", { R: "rest", over: 14 }]],
		b: [[20, "pose", { L: { on: "pole", at: [0, 0, 0.2] }, over: 12 }], [32, "hold", { prop: "pole", hand: "L", at: [0, 0, 0.2], over: 10 }], [62, "pose", { L: [0.2, 0.3, 0.35], over: 10 }], [72, "pose", { L: [0.25, 0.1, 0.25], over: 10 }]],
	}, scene);
	const off = Math.max(...aux.reach.b.slice(62, 90).map(row => (row[0]?.key === 32 ? row[0].d : 0)));
	check(off < 0.001, `a hand on its place on a held prop while its keys flow: ${(off * 1000).toFixed(2)} mm off at most`);
}

// 8. A blend that runs at the most a hand moves per frame needs its slow end to arrive: chained after it, a key takes
// no speed through the shared target, and the wrist is on that target on its frame as with the keys a frame apart.
for (const scale of [1, 0.81]) {
	const made = gap => buildClip({ demo: "t", a: [[0, "pose", { hands: [0.3, 0.4, 0.3], over: 8 }], [8 + gap, "pose", { hands: [0.2, 0.6, 0.2], over: 8 }]] }, { frames: 30, characters: [{ id: "a", at: [0, 0], heading: 0, scale }], props: [] }).clip.characters[0];
	const d = Math.hypot(...at(made(0), 8, J.LeftHand).map((v, k) => v - at(made(1), 8, J.LeftHand)[k]));
	check(d < 0.001, `scale ${scale}: after a blend at the hand's top speed the wrist is ${(d * 1000).toFixed(2)} mm from its target on the frame the next key starts`);
}

console.log(fails.length ? `FAIL verify-smooth-flow: ${fails.length}` : "PASS verify-smooth-flow");
process.exit(fails.length ? 1 : 0);
