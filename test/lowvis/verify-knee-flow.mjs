#!/usr/bin/env node
// The knee goes on from the frame before (src/lowvis/engine-simple/knee.js, solve.js, engine.js), measured from the
// output with arithmetic of this file and knee-sweep.mjs:
//  1. foot targets that move slowly through and around the two leg directions where the side has no direction
//     (knee-flow-inputs.mjs; upright, lying, tilted; both legs; alone and with a second figure; the first figure at
//     scale 1): at most FLOW_JUMPS one-frame jumps (a knee that moves over 30 mm x its scale while its hip and its ankle
//     each move under 10 mm x its scale; 1166 on the solver of one frame alone, 81baeae5), and at most FLOW_WRONG knee
//     frames on the wrong side by every reading of knee-sweep.mjs, or unread (886 there)
//  2. the same spec gives the same bytes built twice, built again after another spec, and, with two figures, built with
//     the characters listed in the other order
//  3. a knee given as the frame before's the side its own frame chooses is solved to the last bit as with none given;
//     with any frame before, bones keep their lengths and the ankle lands where the hip-ankle line and the leg's reach put it
//  4. a foot swung to places given in the body frame and held there (knee-flow-inputs.mjs swingInputs, scales 0.5, 1,
//     2): at most SWING_JUMPS one-frame jumps (9 on the solver of one frame alone, 81baeae5, the largest 196 mm at scale 1)
import assert from "node:assert/strict";
import { buildClip } from "../../src/lowvis/engine-simple/engine.js";
import { solveSized } from "../../src/lowvis/engine-simple/size.js";
import { INDEX as J, OFFSET } from "../../src/lowvis/rig17.js";
import { LIMBS, directInputs, directPaths, frameOf, limbSide } from "./knee-sweep.mjs";
import { nearInputs, swingInputs } from "./knee-flow-inputs.mjs";

// ratchets measured when this was written (the specs of scale 1; knee-flow-compare.mjs runs all three)
const FLOW_JUMPS = 388, FLOW_WRONG = 780, SWING_JUMPS = 0;
const KNEES = LIMBS.filter(l => l.leg), len = a => Math.hypot(a[0], a[1], a[2]), sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const same = (a, b) => a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
/** Over a list of inputs: knee frames, one-frame jumps (the first one's tag) and frames on the wrong side or unread. */
function measure(list) {
	const n = { frames: 0, jumps: 0, wrong: 0, worst: "" };
	for (const inp of list) {
		const { clip } = buildClip(structuredClone({ demo: "near", ...inp.spec }), inp.def);
		for (const c of clip.characters) {
			const s = inp.def.characters.find(x => x.id === c.id).scale ?? 1;
			let prev = null;
			for (let f = 0; f < clip.frameCount; f++) {
				const P = frameOf(c, f);
				for (const L of KNEES) {
					n.frames++;
					const t = limbSide(P.pos, P.quat, L).twist;
					if (t === null || t > 90) n.wrong++;
					if (!prev) continue;
					const dk = len(sub(P.pos[L.mid], prev.pos[L.mid])), dh = len(sub(P.pos[L.root], prev.pos[L.root])), da = len(sub(P.pos[L.end], prev.pos[L.end]));
					if (dh < 0.01 * s && da < 0.01 * s && dk > 0.03 * s) { n.jumps++; n.worst ||= `${inp.tag} ${c.id} f${f} ${L.name} ${(dk * 1000).toFixed(0)} mm`; }
				}
				prev = P;
			}
		}
	}
	return n;
}
const inputs = nearInputs().filter(i => i.s === 1), { frames, jumps, wrong, worst } = measure(inputs);
assert.ok(frames > 60000, `knee frames measured: ${frames}`);
assert.ok(jumps <= FLOW_JUMPS, `one-frame knee jumps near the two directions: ${jumps} (first ${worst})`);
assert.ok(wrong <= FLOW_WRONG, `knee frames on the wrong side by every reading near the two directions: ${wrong}`);
console.log(`1. ${inputs.length} specs near the two directions: ${jumps} one-frame knee jumps, ${wrong} of ${frames} knee frames on the wrong side by every reading`);

const bytes = (inp, def = inp.def) => Object.fromEntries(buildClip(structuredClone({ demo: "near", ...inp.spec }), def).clip.characters.map(c => [c.id, [...c.pos, ...c.quat]]));
const probe = nearInputs().filter((_, i) => i % 53 === 0);
let turned = 0;
for (const [i, inp] of probe.entries()) {
	const a = bytes(inp), b = bytes(inp);
	bytes(probe[(i + 1) % probe.length]);
	const c = bytes(inp);
	assert.ok(Object.keys(a).every(id => same(a[id], b[id]) && same(a[id], c[id])), `${inp.tag}: the same bytes every time`);
	if (!inp.two) continue;
	const r = bytes(inp, { ...inp.def, characters: [...inp.def.characters].reverse() });
	assert.ok(Object.keys(a).every(id => same(a[id], r[id])), `${inp.tag}: the same bytes with the characters in the other order`);
	turned++;
}
assert.ok(turned > 3, `two-figure specs built in the other order: ${turned}`);
console.log(`2. ${probe.length} specs built twice and again after another, ${turned} of them with two figures also in the other order: the same bytes`);

const L1 = len(OFFSET[J.LeftLeg]), L2 = len(OFFSET[J.LeftFoot]);
let n = 0, bone = 0, ankle = 0;
for (const inp of directInputs({ dirs: 24 })) {
	const r = solveSized(inp.B, {}, inp.s), again = solveSized(inp.B, { knee: r.knee }, inp.s);
	assert.ok(same(r.pos.flat(), again.pos.flat()) && same(r.quat.flat(), again.quat.flat()), `${inp.tag}: a knee already on its side is solved as with none given`);
	n++;
}
const check = (r, B, s) => KNEES.forEach((L, i) => {
	bone = Math.max(bone, Math.abs(len(sub(r.pos[L.mid], r.pos[L.root])) - L1 * s), Math.abs(len(sub(r.pos[L.end], r.pos[L.mid])) - L2 * s));
	const hip = r.pos[L.root], to = sub(B.feet[i].a, hip), dist = Math.min(Math.max(len(to), Math.abs(L1 - L2) * s + 1e-4 * s), (L1 + L2) * 0.9995 * s);
	ankle = Math.max(ankle, len(sub(r.pos[L.end], [0, 1, 2].map(k => hip[k] + to[k] / len(to) * dist))));
});
let steps = 0;
for (const path of directPaths()) {
	let prev = null;
	for (let k = 0; k <= 120; k++) { const st = path.at(k / 120), r = solveSized(st.B, prev ? { knee: prev.knee } : {}, st.s); check(r, st.B, st.s); prev = r; steps++; }
}
assert.ok(bone < 1e-5 && ankle < 1e-5, `bone length off by ${bone}, ankle off by ${ankle}`);
console.log(`3. ${n} direct inputs given their own knee: the same to the last bit; ${steps} path steps given the step before's knee: bones within ${bone.toExponential(1)} m, ankles within ${ankle.toExponential(1)} m`);

const swings = swingInputs(), sw = measure(swings);
assert.ok(sw.frames > 3000, `knee frames of the swings measured: ${sw.frames}`);
assert.ok(sw.jumps <= SWING_JUMPS, `one-frame knee jumps while a foot swings to a place and holds: ${sw.jumps} (first ${sw.worst})`);
assert.equal(sw.wrong, 0, "knee frames on the wrong side by every reading while a foot swings to a place and holds");
console.log(`4. ${swings.length} foot swings: ${sw.jumps} one-frame knee jumps, ${sw.wrong} of ${sw.frames} knee frames on the wrong side by every reading`);
console.log("PASS verify-knee-flow");
