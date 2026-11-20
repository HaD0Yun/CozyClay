#!/usr/bin/env node
// The side a knee bends to (src/lowvis/engine-simple/knee.js), measured from the output by test/lowvis/knee-sweep.mjs's
// own arithmetic:
//  1. postures with no foot target (standing, every gait, kneel, sit, lie, tilted by pitch and roll about each pivot,
//     at three scales) and a figure lying on its back, tilted, with both feet on targets above its hips: no frame bends
//     a knee the wrong way
//  2. every foot target of the spec sweep (in front, high, above the hips, behind, across, to the side, low, out of
//     reach; four pitches; standing, kneeling, sitting, lying on the back and on the side; a target moving on): at most
//     the 4 frames measured when this was written bend the wrong way (a ratchet; a knee the measure cannot read counts
//     as wrong)
//  3. on direct solver inputs (pelvis turned every way, foot targets around and past the leg's reach, foot pitch, three
//     scales) the bones keep their lengths and the ankle lands (within 10 micrometres, the rounding the solver had before) where the hip-ankle line and the leg's reach put it,
//     whatever side the knee takes
import assert from "node:assert/strict";
import { buildClip } from "../../src/lowvis/engine-simple/engine.js";
import { solveSized } from "../../src/lowvis/engine-simple/size.js";
import { INDEX as J, OFFSET } from "../../src/lowvis/rig17.js";
import { LIMBS, directInputs, frameOf, limbSide, specInputs } from "./knee-sweep.mjs";

const KNEES = LIMBS.filter(l => l.leg), len = a => Math.hypot(a[0], a[1], a[2]), sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const PLAIN = /^(idle|walk|run|push|back|sidestep|lunge|turnwalk|kneel-stand|sit-stand|kneel-lie|\w+ hands|stand tilt .* about \S+|lie tilt .*) s[\d.]+$/;
let plain = 0, plainWrong = [], targeted = 0, targetedWrong = 0, worst = 0;
for (const inp of specInputs()) {
	const { clip } = buildClip({ demo: "sweep", ...inp.spec }, inp.def), c = clip.characters[0], isPlain = PLAIN.test(inp.tag);
	for (let f = 0; f < clip.frameCount; f++) {
		const pose = frameOf(c, f);
		for (const L of KNEES) {
			const tw = limbSide(pose.pos, pose.quat, L).twist;
			if (isPlain) { plain++; if (!(tw <= 90)) plainWrong.push(`${inp.tag} f${f} ${L.name} ${tw?.toFixed(1)}`); }
			else { targeted++; if (!(tw <= 90)) { targetedWrong++; worst = Math.max(worst, tw ?? 180); } }
		}
	}
}
assert.ok(plain > 40000, `plain postures measured: ${plain}`);
assert.deepEqual(plainWrong.slice(0, 5), [], `${plainWrong.length} wrong-way knees with no foot target or with the lying, tilted, feet-up figure`);
console.log(`1. no foot target, and lying tilted with the feet above the hips: 0 of ${plain} knee frames bend the wrong way`);
assert.ok(targetedWrong <= 4, `foot-target frames bending the wrong way: ${targetedWrong} of ${targeted} (largest twist ${worst.toFixed(1)} deg)`);
console.log(`2. foot targets: ${targetedWrong} of ${targeted} knee frames past 90 degrees of twist (largest ${worst.toFixed(1)})`);

const L1 = len(OFFSET[J.LeftLeg]), L2 = len(OFFSET[J.LeftFoot]);
let n = 0, worstBone = 0, worstAnkle = 0;
for (const inp of directInputs({ dirs: 48 })) {
	const r = solveSized(inp.B, {}, inp.s);
	for (const [i, L] of KNEES.entries()) {
		n++;
		worstBone = Math.max(worstBone, Math.abs(len(sub(r.pos[L.mid], r.pos[L.root])) - L1 * inp.s), Math.abs(len(sub(r.pos[L.end], r.pos[L.mid])) - L2 * inp.s));
		// the ankle: on the line from the hip to the foot target, at the target's distance held to the leg's reach
		const hip = r.pos[L.root], to = sub(inp.B.feet[i].a, hip), dist = Math.min(Math.max(len(to), Math.abs(L1 - L2) * inp.s + 1e-4 * inp.s), (L1 + L2) * 0.9995 * inp.s);
		const want = [0, 1, 2].map(k => hip[k] + to[k] / len(to) * dist);
		worstAnkle = Math.max(worstAnkle, len(sub(r.pos[L.end], want)));
	}
}
assert.ok(worstBone < 1e-5 && worstAnkle < 1e-5, `bone length off by ${worstBone}, ankle off by ${worstAnkle}`);
console.log(`3. ${n} legs solved directly: bone lengths within ${worstBone.toExponential(1)} m, ankles within ${worstAnkle.toExponential(1)} m of the hip-ankle line at reach`);
