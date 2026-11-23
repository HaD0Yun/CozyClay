#!/usr/bin/env node
// The counted walk (gait.js, pace.js) and the ride on a joint (ride.js) together: props ride on joints of bodies that
// walk a written number of steps forward and then backward (facing kept), one of them with steps too long for a walk
// so the engine fits the count.
//  1. On every frame each prop is within 1 mm and 0.5 deg of its place in the joint's frame (with at: at, its axes along
//     the joint's or turned deg about axis; without at: the place it has on frame 0).
//  2. The walk comes out as it does without the props: the same bodies (every joint, every frame), the same contacts
//     and the same told walk lines.
//  3. The walks go where they are written: forward, then backward with the body still facing the way it faced.
// Every scene here is made up for this test.
import assert from "node:assert/strict";
import { buildClip } from "../../src/lowvis/engine-simple/engine.js";
import { serializeClip } from "../../src/lowvis/clip.js";
import { INDEX as J, JOINT_COUNT, qAxisAngle, qMul, qRotate } from "../../src/lowvis/rig17.js";

const build = (spec, scene) => { const b = buildClip(structuredClone({ demo: "x", ...spec }), structuredClone(scene)); return { ...b, parsed: JSON.parse(serializeClip(b.clip)) }; };
const jointAt = (clip, id, f, j) => { const c = clip.characters.find(ch => ch.id === id), i = (f * JOINT_COUNT + j) * 3, k = (f * JOINT_COUNT + j) * 4; return { c: [c.pos[i], c.pos[i + 1], c.pos[i + 2]], q: [c.quat[k], c.quat[k + 1], c.quat[k + 2], c.quat[k + 3]] }; };
const prop = (clip, id, f) => { const p = clip.props.find(q => q.id === id), i = p.pos.length === 3 ? 0 : f; return { c: Array.from(p.pos.slice(i * 3, i * 3 + 3)), q: Array.from(p.quat.slice(i * 4, i * 4 + 4)) }; };
const conj = q => [-q[0], -q[1], -q[2], q[3]];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const angle = (a, b) => { const d = qMul(conj(a), b); return 2 * Math.asin(Math.min(1, Math.hypot(d[0], d[1], d[2]))) * 180 / Math.PI; };
const rel = (car, p) => ({ c: qRotate(conj(car.q), [p.c[0] - car.c[0], p.c[1] - car.c[1], p.c[2] - car.c[2]]), q: qMul(conj(car.q), p.q) });

const F = 230;
const SCENE = {
	frames: F,
	characters: [{ id: "a", at: [0, 0], heading: 0 }, { id: "b", at: [2, 0.4], heading: 90, scale: 0.85 }],
	props: [
		{ id: "cap", size: [0.2, 0.08, 0.24], at: [0, 2, 0], moves: true }, { id: "pack", size: [0.3, 0.4, 0.15], at: [0, 1.2, -0.4], moves: true },
		{ id: "pouch", size: [0.12, 0.1, 0.06], at: [0.3, 1, 0], moves: true }, { id: "shin", size: [0.08, 0.14, 0.08], at: [0, 0.3, 0.3], moves: true },
		{ id: "watch", size: [0.05, 0.02, 0.05], at: [2, 1, 0.4], moves: true }, { id: "badge", size: [0.06, 0.06, 0.02], at: [2.1, 1.3, 0.5], moves: true },
	],
};
// a: 5 plants forward over 3 m, then 4 plants back over 2.2 m facing ahead. b: 3 plants over 2.6 m (each step too long for a
// walk, so the count is fitted), then 3 plants back over 1.2 m facing its heading, with a slower step.
const BODIES = {
	a: [[0, "walk", { to: [0, 3], steps: 5 }], [100, "walk", { to: [0, 0.8], facing: 0, steps: 4 }]],
	b: [[10, "walk", { to: [4.6, 0.4], steps: 3 }], [120, "walk", { to: [3.4, 0.4], facing: 90, steps: 3, stepFrames: 16 }]],
};
const RIDES = {
	cap: { joint: "Head", of: "a", at: [0, 0.14, 0.02] },
	pack: { joint: "Spine2", of: "a", at: [0, 0, -0.2], axis: [0, 1, 0], deg: 15 },
	pouch: { joint: "Hips", of: "a" }, // no at: the place it has on frame 0
	shin: { joint: "LeftLeg", of: "a", at: [0, -0.1, 0.06] },
	watch: { joint: "LeftForeArm", of: "b", at: [0, -0.12, 0], axis: [1, 0, 0], deg: 90 },
	badge: { joint: "RightUpLeg", of: "b", at: [0.08, -0.1, 0.07] },
};
const spec = { ...BODIES, ...Object.fromEntries(Object.entries(RIDES).map(([id, r]) => [id, [[0, "ride", r]]])) };
const withProps = build(spec, SCENE), bare = build(BODIES, { ...SCENE, props: [] });

// --- 1. on its place on every frame ---
let worstD = 0, worstT = 0;
for (const [id, r] of Object.entries(RIDES)) {
	const car = f => jointAt(withProps.parsed, r.of, f, J[r.joint]);
	const place = r.at ? { c: r.at, q: r.deg ? qAxisAngle(r.axis, r.deg * Math.PI / 180) : [0, 0, 0, 1] } : rel(car(0), prop(withProps.parsed, id, 0));
	for (let f = 0; f < F; f++) {
		const c = car(f), p = prop(withProps.parsed, id, f), o = qRotate(c.q, place.c);
		const d = dist(p.c, [c.c[0] + o[0], c.c[1] + o[1], c.c[2] + o[2]]), t = angle(p.q, qMul(c.q, place.q));
		worstD = Math.max(worstD, d); worstT = Math.max(worstT, t);
		assert.ok(d <= 0.001, `${id} on ${r.of}'s ${r.joint}, f${f}: ${(d * 1000).toFixed(2)} mm off its place`);
		assert.ok(t <= 0.5, `${id} on ${r.of}'s ${r.joint}, f${f}: ${t.toFixed(2)} deg off its turn`);
	}
}
console.log(`ok 1 six props on six joints of two walking bodies: worst ${(worstD * 1000).toFixed(3)} mm, ${worstT.toFixed(3)} deg over ${F} frames`);

// --- 2. the walk as without the props ---
for (const id of ["a", "b"]) {
	const x = withProps.parsed.characters.find(c => c.id === id), y = bare.parsed.characters.find(c => c.id === id);
	for (const key of ["pos", "quat"]) {
		assert.equal(x[key].length, y[key].length, `${id}.${key}: the same length`);
		let d = 0; for (let i = 0; i < x[key].length; i++) d = Math.max(d, Math.abs(x[key][i] - y[key][i]));
		assert.equal(d, 0, `${id}.${key}: the body with props riding on it differs by ${d} from the body without`);
	}
	assert.deepEqual(withProps.aux.contacts[id], bare.aux.contacts[id], `${id}: the same contacts`);
}
assert.deepEqual(withProps.aux.walks, bare.aux.walks, "the same told walk lines");
console.log("ok 2 both bodies, every joint and frame, contacts and told walk lines: the same as without the props");

// --- 3. forward, then backward ---
const hips = (id, f) => jointAt(withProps.parsed, id, f, J.Hips).c;
const fwd = (id, f) => { const q = jointAt(withProps.parsed, id, f, J.Hips).q, z = qRotate(q, [0, 0, 1]); return Math.atan2(z[0], z[2]) * 180 / Math.PI; };
assert.ok(Math.abs(hips("a", 95)[2] - 3) < 0.05 && Math.abs(hips("a", F - 1)[2] - 0.8) < 0.05, `a goes to z 3 and back to 0.8: ${hips("a", 95)[2].toFixed(3)}, ${hips("a", F - 1)[2].toFixed(3)}`);
assert.ok(Math.abs(hips("b", 115)[0] - 4.6) < 0.05 && Math.abs(hips("b", F - 1)[0] - 3.4) < 0.05, `b goes to x 4.6 and back to 3.4: ${hips("b", 115)[0].toFixed(3)}, ${hips("b", F - 1)[0].toFixed(3)}`);
for (const [id, a, b, h] of [["a", 100, F - 1, 0], ["b", 120, F - 1, 90]]) for (let f = a; f <= b; f++) {
	const d = ((fwd(id, f) - h + 540) % 360) - 180;
	assert.ok(Math.abs(d) < 15, `${id} f${f}: the back walk keeps facing ${h} (hips face ${fwd(id, f).toFixed(1)})`);
}
const told = withProps.aux.walks.filter(w => w.who === "b" && w.f === 10 && w.steps[0] === 3 && w.steps[1] > 3);
assert.equal(told.length, 1,`b's 3 plants over 2.6 m are told as fitted: ${JSON.stringify(withProps.aux.walks.filter(w => w.who === "b"))}`);
console.log(`ok 3 a: z 0 -> ${hips("a", 95)[2].toFixed(2)} -> ${hips("a", F - 1)[2].toFixed(2)}; b: x 2 -> ${hips("b", 115)[0].toFixed(2)} -> ${hips("b", F - 1)[0].toFixed(2)}, facing kept while backing; b's count fitted and told`);
console.log("PASS verify-ride-counted-walk");
