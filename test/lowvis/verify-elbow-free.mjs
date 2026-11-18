#!/usr/bin/env node
// An elbow target of an arm whose wrist is free (pose elbowL / elbowR, no hand target) turns that arm only
// (src/lowvis/engine-simple/solve.js):
//  1. it never moves the body: hips, chest and head are where the same scene without the elbow key has them, on every
//     frame, for targets on the own body, on the upper arm's sphere and off it, in still and moving postures;
//  2. a target on the sphere of the upper arm about the shoulder (as the shoulder is in that scene) is reached within
//     10 mm, also where the body is lowered by its feet or walks;
//  3. the wrist keeps the hands' top speed (0.12 m a frame in the body frame) while the arm swings to the target and
//     back, also when the target is on the far side of the shoulder from where the elbow hangs.
// Every scene here is made up for this test.
import assert from "node:assert/strict";
import { INDEX as J, JOINT_COUNT, OFFSET } from "../../src/lowvis/rig17.js";
import { buildClip } from "../../src/lowvis/engine-simple/engine.js";

const len = a => Math.hypot(...a), sub = (a, b) => a.map((v, i) => v - b[i]), add = (a, b) => a.map((v, i) => v + b[i]), mul = (a, k) => a.map(v => v * k);
const UPPER = len(OFFSET[J.LeftForeArm]);
const at = (c, f, j) => { const i = (f * JOINT_COUNT + j) * 3; return [c.pos[i], c.pos[i + 1], c.pos[i + 2]]; };
const scene = (frames, s = 1) => ({ frames, characters: [{ id: "x", at: [0.3, -0.2], heading: 30, scale: s }], props: [] });
const build = (frames, list, s) => buildClip({ demo: "x", x: list }, scene(frames, s));
const unit = d => mul(d, 1 / len(d));
const DIRS = [[1, -0.3, 0.4], [-0.2, -0.6, 1], [0.1, 0.9, 0.2], [-1, 0.2, -0.3], [0.5, -0.8, -0.6], [0, 1, 0], [0, -1, 0.05]].map(unit);
const POSTURES = {
	standing: [], crouched: [[0, "pose", { hip: [0, -0.25, 0], over: 0 }]], seated: [[0, "sit", { height: 0.5, over: 0 }]],
	pushing: [[0, "push", { to: [0.3, 0.6] }]], walking: [[0, "walk", { to: [0.9, 0.7], steps: 2 }]], knelt: [[0, "kneel", { over: 0 }]],
};
const ELBOW = [["elbowL", J.LeftArm, J.LeftForeArm, J.LeftHand, 4], ["elbowR", J.RightArm, J.RightForeArm, J.RightHand, 5]];
const BODY = [J.Hips, J.Spine2, J.Head];

let n = 0, moved = 0, worst = { d: 0 };
for (const s of [1, 0.85]) for (const [name, base] of Object.entries(POSTURES)) {
	const F = 90, K = 30, ref = build(F, base, s).clip.characters[0];
	for (const [key, root, , , slot] of ELBOW) {
		const targets = [
			...DIRS.map(d => ({ on: true, to: { world: add(at(ref, 70, root), mul(d, UPPER * s)) } })),
			...DIRS.slice(0, 4).map((d, i) => ({ to: { world: add(at(ref, 70, root), mul(d, UPPER * s * [0.7, 1.04, 1.2, 1.5][i])) } })),
			{ to: { joint: "Spine2", at: [key === "elbowL" ? 0.25 : -0.25, -0.1, 0.15] } }, { to: { joint: key === "elbowL" ? "LeftUpLeg" : "RightUpLeg", at: [0, 0.1, 0.1] } },
			{ to: { joint: key === "elbowL" ? "LeftLeg" : "RightLeg", at: [0, 0.05, 0] } }, { to: { joint: "Head", at: [0, 0.1, 0.2] } },
		];
		for (const t of targets) {
			const { clip, aux } = build(F, [...base, [K, "pose", { [key]: t.to, over: 14 }]], s), c = clip.characters[0];
			n++;
			for (let f = 0; f < F; f++) for (const j of BODY) moved = Math.max(moved, len(sub(at(c, f, j), at(ref, f, j))));
			if (t.on) { const d = aux.reach.x[70][slot].d; if (d > worst.d) worst = { d, name, s, key }; }
		}
	}
}
assert.ok(moved < 1e-9, `an elbow target moves no part of the body (largest ${(moved * 1000).toFixed(3)} mm)`);
assert.ok(worst.d <= 0.01, `an elbow target on the upper arm's sphere is reached (worst ${(worst.d * 1000).toFixed(1)} mm, ${worst.name}, scale ${worst.s}, ${worst.key})`);
console.log(`ok body and sphere: ${n} elbow targets in ${Object.keys(POSTURES).length} postures at 2 sizes; hips, chest and head as without the key; on the sphere worst ${(worst.d * 1000).toFixed(1)} mm`);

// 3. the swing out and back keeps the wrist's top speed (still postures: the body frame is the world)
let fastest = 0, fastAt = "";
for (const [name, base] of Object.entries({ standing: POSTURES.standing, seated: POSTURES.seated })) {
	const ref = build(100, base).clip.characters[0];
	for (const [key, root, , hand] of ELBOW) for (const d of [...DIRS, [0, 1, 0], [0, 0, -1], [0.2, 0.3, -1]].map(unit)) for (const over of [8, 16]) {
		const c = build(100, [...base, [10, "pose", { [key]: { world: add(at(ref, 40, root), mul(d, UPPER)) }, over }], [50, "pose", { [key]: "rest", over }]]).clip.characters[0];
		for (let f = 1; f < 100; f++) { const v = len(sub(at(c, f, hand), at(c, f - 1, hand))); if (v > fastest) { fastest = v; fastAt = `${name} ${key} [${d.map(x => x.toFixed(2))}] over ${over} f${f}`; } }
	}
}
assert.ok(fastest <= 0.12 + 1e-6, `a free wrist moves at most 0.12 m a frame while its elbow target turns the arm (${(fastest * 1000).toFixed(1)} mm, ${fastAt})`);
console.log(`ok swing: the wrist moves at most ${(fastest * 1000).toFixed(1)} mm a frame turning to elbow targets all round the shoulder and back`);
console.log("PASS verify-elbow-free");
