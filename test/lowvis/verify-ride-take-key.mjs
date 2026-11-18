#!/usr/bin/env node
// A hand takes a riding prop off a moving carrier on a frame where a key of the prop also stands (a new ride key, a move
// key, a tip key): on that frame the prop still goes with the carrier, the same as when that key stands later, and the
// hands that carry it go on with it. A ride key written on the take frame begins at the let-go.
// Each case is built twice: as written, and with the key on the take frame moved 20 frames later (the control).
// Every scene here is made up for this test (the first case is a reviewer's).
import assert from "node:assert/strict";
import { buildClip } from "../../src/lowvis/engine-simple/engine.js";
import { serializeClip } from "../../src/lowvis/clip.js";
import { INDEX as J, JOINT_COUNT } from "../../src/lowvis/rig17.js";

const build = (spec, scene) => { const b = buildClip(structuredClone({ demo: "x", ...spec }), structuredClone(scene)); return { aux: b.aux, clip: JSON.parse(serializeClip(b.clip)) }; };
const jointAt = (clip, id, f, name) => { const c = clip.characters.find(ch => ch.id === id), i = (f * JOINT_COUNT + J[name]) * 3; return [c.pos[i], c.pos[i + 1], c.pos[i + 2]]; };
const propAt = (clip, id, f) => { const p = clip.props.find(q => q.id === id), i = p.pos.length === 3 ? 0 : f; return Array.from(p.pos.slice(i * 3, i * 3 + 3)); };
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const later = (keys, f) => keys.map(k => (k[0] === f ? [f + 20, k[1], k[2]] : k));

const hat = { id: "hat", size: [0.2, 0.08, 0.2], at: [0, 2, 0], moves: true }, pack = { id: "pack", size: [0.3, 0.3, 0.12], at: [0, 2, 0], moves: true };
const CASES = [ // [name, scene, spec, prop, take frame, carrier: [character id, joint] or a prop id, character whose wrists carry]
	["walk, hat off the Head by hold {at, over: 16}, next ride key on f26", { frames: 110, characters: [{ id: "t", at: [0, 0], heading: 0 }], props: [hat] },
		{ t: [[0, "walk", { to: [0, 6] }], [10, "hold", { prop: "hat", hand: "R", at: [-0.1, 0, 0], over: 16 }], [30, "pose", { R: { joint: "LeftArm", at: [-0.1, 0.1, 0] }, over: 20 }], [60, "release", { prop: "hat" }], [62, "pose", { R: "rest", over: 14 }]],
			hat: [[0, "ride", { joint: "Head", of: "t", at: [0, 0.17, 0] }], [26, "ride", { joint: "LeftArm", of: "t" }]] }, "hat", 26, ["t", "Head"]],
	["run at heading 60, scale 0.9, band off the RightArm by the left hand, next ride key with at on f22", { frames: 100, characters: [{ id: "t", at: [0, 0], heading: 60, scale: 0.9 }], props: [{ id: "band", size: [0.1, 0.06, 0.1], at: [0, 2, 0], moves: true }] },
		{ t: [[0, "run", { to: [5.2, 3] }], [10, "hold", { prop: "band", hand: "L", at: [0.05, 0, 0], over: 12 }], [70, "release", { prop: "band" }]],
			band: [[0, "ride", { joint: "RightArm", of: "t", at: [0.06, -0.1, 0] }], [22, "ride", { joint: "Spine2", of: "t", at: [0, 0, 0.15] }]] }, "band", 22, ["t", "RightArm"]],
	["walk back at heading 230, both hands take the pouch off the Hips, a tip key on f34", { frames: 110, characters: [{ id: "t", at: [0, 0], heading: 230, scale: 1.15 }], props: [{ id: "pouch", size: [0.26, 0.16, 0.1], at: [0, 2, 0], moves: true }] },
		{ t: [[0, "walk", { to: [1.5, 1.3], facing: 230 }], [8, "pose", { L: { on: "pouch", at: [0.13, 0, 0] }, R: { on: "pouch", at: [-0.13, 0, 0] }, over: 16 }], [34, "hold", { prop: "pouch", hand: "both" }], [80, "release", { prop: "pouch" }]],
			pouch: [[0, "ride", { joint: "Hips", of: "t", at: [0, 0, 0.16] }], [34, "tip", { pivot: [0, 0, 0], axis: [1, 0, 0], deg: 20, over: 10 }]] }, "pouch", 34, ["t", "Hips"], "t"],
	["walk at heading 300, carry off the back, a move key on f28", { frames: 100, characters: [{ id: "t", at: [0, 0], heading: 300 }], props: [pack] },
		{ t: [[0, "walk", { to: [-5, 2.9] }], [4, "pose", { L: { on: "pack", at: [0.18, 0, 0] }, R: { on: "pack", at: [-0.18, 0, 0] }, over: 12 }], [28, "carry", { prop: "pack" }], [72, "release", { prop: "pack" }]],
			pack: [[0, "ride", { joint: "Spine2", of: "t", at: [0, 0, 0.17] }], [28, "move", { to: [0, 0.15, 0], over: 8 }]] }, "pack", 28, ["t", "Spine2"], "t"],
	["another body walking beside takes the hat off the walker's Head, next ride key on its own Head on f30", { frames: 100, characters: [{ id: "t", at: [0, 0], heading: 0 }, { id: "v", at: [-0.55, 0], heading: 0 }], props: [hat] },
		{ t: [[0, "walk", { to: [0, 5] }]], v: [[0, "walk", { to: [-0.55, 5] }], [12, "hold", { prop: "hat", hand: "L", at: [0.1, 0, 0], over: 18 }], [70, "release", { prop: "hat" }]],
			hat: [[0, "ride", { joint: "Head", of: "t", at: [0, 0.17, 0] }], [30, "ride", { joint: "Head", of: "v", at: [0, 0.17, 0] }]] }, "hat", 30, ["t", "Head"]],
	["a jar off a cart a key moves, next ride key on f24", { frames: 90, characters: [{ id: "t", at: [0, 0], heading: 0 }], props: [{ id: "cart", size: [0.6, 0.1, 0.4], at: [0.4, 0.8, 0.5], moves: true }, { id: "jar", size: [0.1, 0.16, 0.1], at: [0.4, 0.93, 0.5], moves: true }] },
		{ t: [[6, "hold", { prop: "jar", hand: "R", at: [-0.05, 0, 0], over: 18 }], [60, "release", { prop: "jar" }]],
			cart: [[0, "move", { to: [-0.4, 0.8, 0.5], over: 50, ease: "linear" }]], jar: [[0, "ride", { on: "cart" }], [24, "ride", { on: "cart", at: [0.1, 0.13, 0] }]] }, "jar", 24, "cart"],
];
for (const [name, scene, spec, id, take, carrier, wristsOf] of CASES) {
	const r = build(spec, scene), ctl = build({ ...spec, [id]: later(spec[id], take) }, scene);
	assert.equal(r.aux.holders[id].findIndex(Boolean), take, `${name}: the hand takes hold at f${take}`);
	const car = f => (typeof carrier === "string" ? propAt(r.clip, carrier, f) : jointAt(r.clip, carrier[0], f, carrier[1]));
	const carStep = dist(car(take), car(take - 1)), step = dist(propAt(r.clip, id, take), propAt(r.clip, id, take - 1));
	assert.ok(carStep > 0.01, `${name}: the carrier moves on the take frame (${(carStep * 1000).toFixed(1)} mm)`);
	assert.ok(step > 0.75 * carStep, `${name}: the prop goes with the carrier on the take frame: ${(step * 1000).toFixed(1)} mm against ${(carStep * 1000).toFixed(1)}`);
	for (const f of [take - 1, take, take + 1]) assert.ok(dist(propAt(r.clip, id, f), propAt(ctl.clip, id, f)) < 1e-4, `${name}: f${f} the prop is where it is when the key stands later`);
	if (wristsOf) for (const w of ["LeftHand", "RightHand"]) assert.ok(dist(jointAt(r.clip, wristsOf, take, w), jointAt(ctl.clip, wristsOf, take, w)) < 1e-4, `${name}: ${w} on the take frame as in the control`);
	const rides = r.aux.rides.filter(x => x.prop === id), free = r.aux.holders[id].findIndex((h, f) => f > take && !h), keyed = rides.find(x => x.f === take);
	assert.equal(rides[0].began, 0, `${name}: the first ride began at f0`);
	if (keyed) assert.equal(keyed.began, free, `${name}: the ride written on the take frame begins at the let-go f${free}`);
	console.log(`ok ${name}: take f${take}: ${id} ${(step * 1000).toFixed(1)} mm / carrier ${(carStep * 1000).toFixed(1)} mm${keyed ? `; ride of f${take} began f${keyed.began}` : ""}`);
}
console.log("verify-ride-take-key: PASS");
