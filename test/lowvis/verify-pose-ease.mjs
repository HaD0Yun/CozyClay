#!/usr/bin/env node
// A pose key's inout blend (engine-simple/math.js poseEase, flow.js): from rest to rest it is the minimum-jerk curve, so
// its fastest frame is nearer twice its mean than the cubic's 1.5 times; a hand takes that curve only as far as the most
// a hand moves per frame allows, so it is no later on its target than with the cubic; the whole figure's tilt keeps the
// cubic; and a flight reads a hip key as the engine blends it (air.js lowerOf). Every scene here is made up for this test.
import { buildClip } from "../../src/lowvis/engine-simple/engine.js";
import { lowerOf } from "../../src/lowvis/engine-simple/spec-layers.js";
import { INDEX as J, JOINT_COUNT } from "../../src/lowvis/rig17.js";

const one = (frames, scale = 1) => ({ frames, characters: [{ id: "a", at: [0, 0], heading: 0, scale }], props: [] });
const build = (scene, a) => buildClip({ demo: "t", a }, scene).clip.characters[0];
const at = (c, f, j) => Array.from(c.pos.slice((f * JOINT_COUNT + j) * 3, (f * JOINT_COUNT + j) * 3 + 3));
const local = (c, f, j) => at(c, f, j).map((v, k) => v - at(c, f, J.Hips)[k]); // heading 0, standing: body frame = world axes
const dist = (p, q) => Math.hypot(...p.map((v, k) => v - q[k]));
const fails = [];
const check = (ok, what) => { if (!ok) fails.push(what); console.log(`${ok ? "ok" : "FAIL"} ${what}`); };

// 1. One hand key from rest to rest: the wrist's fastest frame against its mean over the key's frames (the cubic: 1.72).
{
	const to = [-0.3, 0.35, 0.4], c = build(one(72), [[6, "pose", { R: to, over: 12 }]]);
	const steps = [...Array(12)].map((_, k) => dist(local(c, 7 + k, J.RightHand), local(c, 6 + k, J.RightHand)));
	const ratio = Math.max(...steps) / (steps.reduce((s, v) => s + v, 0) / steps.length);
	check(ratio > 2 && ratio < 2.25, `one hand key over 12 frames: its fastest frame is ${ratio.toFixed(2)} times its mean (over 2)`);
	check(dist(local(c, 18, J.RightHand), to) < 0.001, `and the wrist is on its target on the key's end frame (${(dist(local(c, 18, J.RightHand), to) * 1000).toFixed(2)} mm off)`);
	check(dist(at(c, 6, J.RightHand), at(c, 5, J.RightHand)) < 1e-6, "and it has not moved on the key's first frame");
}
// 2. A hand's blend to rest at the most a hand moves per frame: no later at rest than the cubic brings it (a blend of
//    the full curve's faster middle would lose more to that limit: 84 mm from rest here on the key's end frame).
{
	const hang = local(build(one(2), [[0, "idle", {}]]), 0, J.RightHand), far = hang.map((v, k) => v + [0.1, 0.5, 0.85][k] * 0.48 / Math.hypot(0.1, 0.5, 0.85));
	const c = build(one(60), [[0, "pose", { R: far, over: 14 }], [20, "pose", { R: "rest", over: 4 }]]), off = dist(local(c, 24, J.RightHand), hang) * 1000;
	check(off < 63, `a blend to rest of 120 mm a frame over 4 frames is ${off.toFixed(1)} mm from rest on its end frame (under 63)`);
}
// 3. The whole figure's tilt keeps the cubic: a quarter of the way through its frames it has 15.6% of its turn.
{
	const c = build(one(40), [[4, "pose", { tilt: [40, 0], over: 16 }]]);
	const pitch = f => { const d = at(c, f, J.Head).map((v, k) => v - at(c, f, J.Hips)[k]); return Math.atan2(d[2], d[1]); };
	const share = (pitch(8) - pitch(4)) / (pitch(20) - pitch(4));
	check(Math.abs(share - 0.15625) < 0.002, `a tilt key has ${(share * 100).toFixed(1)}% of its turn a quarter of the way through (the cubic: 15.6%)`);
}
// 4. A flight reads a hip key as the engine blends it: on a standing body the hips are as much lower as lowerOf says.
{
	const keys = [[4, "pose", { hip: [0, -0.2, 0], over: 10 }], [14, "pose", { hip: [0, -0.3, 0], over: 8 }], [30, "pose", { hip: [0, 0, 0], over: 12 }]];
	const c = build(one(50), keys), lower = lowerOf(keys.map(([f, , o]) => ({ f, over: o.over, ease: "inout", to: o.hip }))), h0 = at(c, 0, J.Hips)[1];
	let worst = 0; for (let f = 0; f < 50; f++) worst = Math.max(worst, Math.abs(h0 - at(c, f, J.Hips)[1] - lower(f)));
	check(worst < 1e-5, `hip keys lower the hips as a flight reads them (${(worst * 1000).toFixed(4)} mm apart at most)`);
}
console.log(fails.length ? `FAIL verify-pose-ease: ${fails.length}` : "PASS verify-pose-ease");
process.exit(fails.length ? 1 : 0);
