#!/usr/bin/env node
// motion3 compiler + QA core: exact kinematics, keyed channels, a clean walk, and QA that
// catches deliberately broken takes.
import fs from "node:fs";
import { createSkeleton, restState, toLocal, fk } from "../../src/motion3/compiler/skeleton.js";
import { pose } from "../../src/motion3/compiler/pose.js";
import { bakeChannels, flowOptions } from "../../src/motion3/compiler/channels.js";
import { validateSpec } from "../../src/motion3/compiler/validate.js";
import { compileMotion } from "../../src/motion3/compiler/compile.js";
import { runMotionQa } from "../../src/motion3/qa/index.js";
import { solePoints } from "../../src/motion3/qa/geometry.js";
import { bakeTake, takeHips } from "../../src/motion3/take.js";
import { dist, I3, angle, sub, dot } from "../../src/motion3/compiler/math.js";
import { palmAxes } from "../../src/motion3/compiler/limbs.js";
/** Local quaternion [x,y,z,w] of bone b at frame f of a take (nearest frame, clamped). */
const takeQuat = (take, f, b) => { const i = (Math.max(0, Math.min(take.frameCount - 1, Math.round(f))) * take.bones.length + b) * 4; return [take.rot[i], take.rot[i + 1], take.rot[i + 2], take.rot[i + 3]]; };

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
}
const rig = name => createSkeleton(JSON.parse(fs.readFileSync(new URL(`../../src/motion3/rigs/${name}.json`, import.meta.url))));

for (const model of ["x-bot-tpose", "y-bot-tpose"]) {
	const sk = rig(model), I = sk.index;
	expect(`${model}: 65 control bones with fingers`, sk.names.length === 65 && I.RightHandIndex3 !== undefined, sk.names.length);
	const s = restState(sk), L = toLocal(sk, s), back = fk(sk, L.quats, L.hips);
	expect(`${model}: rest FK round trip`, Math.max(...s.P.map((p, j) => dist(p, back.P[j]))) < 1e-9);
	const c = { root: [0.2, 0.95, 0.1], yaw: 40, spine_pitch: 15, foot_l: [0.35, 0.3, 0.45], foot_r: [0.1, 0.09, 0], knee_l: [0.1, 0.2, 1],
		armw_r: 1, elbow_r: [-0.5, -1, -0.2], wtwist_r: -30, wflex_r: 20, fingers_r: { grip: 1 } };
	const target = [-0.05, 1.45, 0.45];
	const { s: p } = pose(sk, c, { handTarget: () => target });
	expect(`${model}: leg IK lands on target`, dist(p.P[I.LeftFoot], c.foot_l) < 1e-6);
	expect(`${model}: arm IK lands on target`, dist(p.P[I.RightHand], target) < 1e-6);
	const drift = Math.max(...p.P.map((q, j) => sk.parent[j] < 0 ? 0 : Math.abs(dist(q, p.P[sk.parent[j]]) - dist(sk.restWorldPos[j], sk.restWorldPos[sk.parent[j]]))));
	expect(`${model}: bone lengths unchanged by posing`, drift < 1e-9, drift);
	const L2 = toLocal(sk, p), back2 = fk(sk, L2.quats, L2.hips);
	expect(`${model}: posed state survives local quaternions`, Math.max(...p.P.map((q, j) => dist(q, back2.P[j]))) < 1e-9);
}

// A fist's or a grip's thumb closes over the index and middle fingers. The old thumb curls turned about the knuckle line
// and swung the thumb out to the side, so a fist read as a thumbs-up: its tip sat 8.4 cm (Y Bot) from the index finger.
for (const model of ["x-bot-tpose", "y-bot-tpose"]) {
	const sk = rig(model), I = sk.index;
	for (const preset of ["fist", "grip"]) {
		const tip = {};
		for (const [k, side] of [["r", "Right"], ["l", "Left"]]) {
			const { s: p } = pose(sk, { [`fingers_${k}`]: { [preset]: 1 } }), P = j => p.P[I[`${side}Hand${j}`]];
			const hand = dist(P("Middle1"), p.P[I[`${side}Hand`]]), { d, l, n } = palmAxes(sk, p, side), t = sub(P("Thumb4"), p.P[I[`${side}Hand`]]);
			const near = Math.min(...["Index", "Middle"].map(f => { const a = P(`${f}2`), ab = sub(P(`${f}3`), a), u = Math.max(0, Math.min(1, dot(sub(P("Thumb4"), a), ab) / dot(ab, ab))); return dist(P("Thumb4"), a.map((v, i) => v + ab[i] * u)); }));
			tip[k] = [dot(t, d), dot(t, l), dot(t, n)];
			expect(`${model} ${side} ${preset}: the thumb tip rests on the index or middle finger's middle phalanx`, near < 0.25 * hand, `${(near * 100).toFixed(1)} cm, hand ${(hand * 100).toFixed(1)} cm`);
			expect(`${model} ${side} ${preset}: the thumb is not raised out to the side (no thumbs-up)`, tip[k][1] < 0.3 * hand, `${(tip[k][1] * 100).toFixed(1)} cm toward the thumb side`);
		}
		// the rigs themselves differ left to right by up to 0.1 mm
		expect(`${model} ${preset}: the two hands mirror`, Math.abs(tip.r[0] - tip.l[0]) < 0.002 && Math.abs(tip.r[1] - tip.l[1]) < 0.002 && Math.abs(tip.r[2] + tip.l[2]) < 0.002, JSON.stringify(tip));
	}
}

const ch = bakeChannels([{ f: 0, set: { a: 0 } }, { f: 10, set: { a: 1 } }, { f: 20, set: { a: 1 } }, { f: 30, set: { a: 0, v: 1 }, step: ["v"] }, { f: 5, set: { v: 0 } }], 40);
expect("PCHIP never overshoots a held value", Math.max(...ch.a) <= 1 + 1e-12 && ch.a.slice(10, 21).every(v => Math.abs(v - 1) < 1e-12));
expect("step keys switch on their frame", ch.v[29] === 0 && ch.v[30] === 1);
// Flow (channels.js): the body's own swing carries through keys and trails; contacts and held values stay exact.
{
	const keys = [{ f: 0, set: { head_yaw: 0, aswing_r: 0, foot_l: [0, 0, 0] } }, { f: 10, set: { head_yaw: 20, aswing_r: 20, foot_l: [1, 0, 0] } },
		{ f: 20, set: { head_yaw: 50, aswing_r: 50 } }, { f: 30, set: { head_yaw: 50, aswing_r: 50 } }, { f: 40, set: { head_yaw: 0, aswing_r: 0 } }];
	// the constant trail and the hold, without overlap (verify-motion3-overlap.mjs: each link's own delay on top of it)
	const on = bakeChannels(keys, 46, flowOptions({ overlap: false })), off = bakeChannels(keys, 46, flowOptions(false)), plainHead = bakeChannels(keys.map(k => ({ ...k, set: { ...k.set } })), 46, flowOptions({ lag: false, overlap: false }));
	expect("flow: the head trails 2 frames and the arm 3; a foot is on time", Math.abs(on.head_yaw[12] - plainHead.head_yaw[10]) < 1e-9 && Math.abs(on.aswing_r[13] - plainHead.aswing_r[10]) < 1e-9 && on.foot_l[10][0] === 1);
	expect("flow: a hold stays flat and the last value is reached", on.head_yaw.slice(22, 33).every(v => Math.abs(v - 50) < 1e-9) && on.head_yaw[45] === 0);
	expect("flow: the speed through a key is kept (not the monotone cubic's)", Math.abs(plainHead.head_yaw[11] - plainHead.head_yaw[9]) > Math.abs(off.head_yaw[11] - off.head_yaw[9]));
	expect("flow: false is the monotone cubic everywhere", JSON.stringify(off.head_yaw) === JSON.stringify(bakeChannels(keys.map(k => ({ ...k, set: { head_yaw: k.set.head_yaw } })), 46, flowOptions(false)).head_yaw));
	const ik = bakeChannels([{ f: 0, set: { armw_r: 1, aswing_r: 0 } }, { f: 10, set: { aswing_r: 30 } }, { f: 20, set: { aswing_r: 60 } }], 30, flowOptions({ overlap: false }));
	const ikOff = bakeChannels([{ f: 0, set: { armw_r: 1, aswing_r: 0 } }, { f: 10, set: { aswing_r: 30 } }, { f: 20, set: { aswing_r: 60 } }], 30, flowOptions(false));
	expect("flow: an arm on its IK keeps its keys on time", ik.aswing_r.every((v, f) => Math.abs(v - ikOff.aswing_r[f]) < 1e-9));
	let refused = "";
	try { validateSpec({ schema: "cozyclay.motion-spec.v1", frames: 10, flow: { lag: { neck: 2 }, smooth: 1 } }, { sk: rig("x-bot-tpose") }); } catch (e) { refused = e.message; }
	expect("flow: a bad spec.flow is refused with its fields", refused.includes('spec.flow.lag has unknown field "neck"') && refused.includes("spec.flow.smooth must be true or false"), refused);
}

const sk = rig("x-bot-tpose"), I = sk.index, P = sk.restWorldPos, ank = P[I.LeftFoot][1];
const walkSpec = { schema: "cozyclay.motion-spec.v1", fps: 30, frames: 220,
	keys: [{ f: 0, set: { root: [0, P[I.Hips][1] - 0.01, 0], yaw: 0, foot_l: [0.09, ank, -0.03], foot_r: [-0.09, ank, 0.03], fyaw_l: 0, fyaw_r: 0, knee_l: [0.05, 0, 1], knee_r: [-0.05, 0, 1] } }],
	generators: [{ type: "walk", f0: 10, steps: 8, heading: [0, 40] }] };
const walk = compileMotion(walkSpec, { sk, scene: { objects: {} } });
const walkQa = runMotionQa(sk, walk, walkSpec);
expect("an 8-step curving walk passes QA with 0 issues", walkQa.ok, JSON.stringify(walkQa.groups.slice(0, 3)));
// The feet roll heel first (compiler/walk.js): the heel touches with the ball still up, stays put while the foot rolls
// down onto it; the ball stays put while the heel comes up; the foot leaves the floor pitched well over.
for (const side of ["Left", "Right"]) {
	const sole = walk.frames.map(fr => solePoints(sk, fr.s, side)), k = side[0].toLowerCase(), down = 0.0065;
	const moved = (key, a, b) => Math.hypot(sole[b][key][0] - sole[a][key][0], sole[b][key][2] - sole[a][key][2]);
	const strikes = sole.map((p, f) => f > 0 && p.heel[1] < down && sole[f - 1].heel[1] >= down ? f : -1).filter(f => f > 0);
	const heelFirst = strikes.filter(f => sole[f].ball[1] > 0.01 && moved("heel", f, f + 3) < 5e-4);
	const lifts = sole.map((p, f) => f > 0 && p.ball[1] >= 0.001 && sole[f - 1].ball[1] < 0.001 ? f : -1).filter(f => f > 0);
	const rolled = lifts.filter(f => moved("ball", f - 6, f - 1) < 5e-4 && sole[f - 6].heel[1] < sole[f - 1].heel[1] - 0.03);
	const push = Math.max(...walk.frames.map(fr => fr.c[`fpitch_${k}`] ?? 0));
	expect(`${side}: the heel strikes before the ball and holds while the foot rolls down; the heel rises on a still ball before lift-off`,
		strikes.length >= 3 && heelFirst.length >= strikes.length - 1 && lifts.length >= 3 && rolled.length === lifts.length && push >= 35,
		JSON.stringify({ strikes, heelFirst, lifts, rolled, push }));
}
// The arms swing with bending elbows (compiler/walk.js): the elbow's bend changes through the walk, and at each landing the
// forward arm's elbow is the more bent. The head takes back part of a trunk sway (compiler/head-steady.js), unless the spec keys it.
{
	const bend = (fr, S) => angle(sub(fr.s.P[I[`${S}ForeArm`]], fr.s.P[I[`${S}Arm`]]), sub(fr.s.P[I[`${S}Hand`]], fr.s.P[I[`${S}ForeArm`]]));
	const lb = walk.frames.map(fr => bend(fr, "Left")), mid = walk.frames.slice(60, 160);
	const fwdMore = mid.filter(fr => Math.abs((fr.c.aswing_l ?? 0) - (fr.c.aswing_r ?? 0)) > 15).every(fr => ((fr.c.aswing_l > fr.c.aswing_r) === (bend(fr, "Left") > bend(fr, "Right"))));
	expect("the elbows bend with the arm swing, the forward arm's the more", Math.max(...lb) - Math.min(...lb) > 18 && fwdMore, JSON.stringify([Math.min(...lb), Math.max(...lb), fwdMore]));
	const sway = Array.from({ length: 14 }, (_, i) => ({ f: 30 + i * 10, set: { spine_roll: i % 2 ? 5 : -5 } }));
	const roll = (fr, a, b) => { const v = sub(fr.s.P[b], fr.s.P[a]); return Math.atan2(v[0], v[1]) * 180 / Math.PI; };
	const spanOf = (out, a, b) => { const xs = out.frames.slice(60, 160).map(fr => roll(fr, a, b)); return Math.max(...xs) - Math.min(...xs); };
	const swayed = compileMotion({ ...walkSpec, keys: [...walkSpec.keys, ...sway] }, { sk, scene: { objects: {} } });
	const looked = compileMotion({ ...walkSpec, keys: [...walkSpec.keys, ...sway, { f: 100, set: { head_roll: 0 } }] }, { sk, scene: { objects: {} } });
	const chest = spanOf(swayed, I.Spine2, I.Neck), head = spanOf(swayed, I.Neck, I.HeadTop_End), keyed = spanOf(looked, I.Neck, I.HeadTop_End);
	// (the walk sways the trunk itself, once a stride (walk.js LIST, SWAY, SIDE), about the head's averaging window, so a little more
	// of that slow sway stays in the head: 0.59 of the chest here)
	// a keyed head is not steadied: it sways with the trunk (a little more, the neck on top; 13.09 vs 12.34 deg)
	expect("a walking head sways less than the trunk under it, and a keyed head is left alone", head < 0.65 * chest && keyed > chest - 0.5, JSON.stringify({ chest, head, keyed }));
}
const take = bakeTake(sk, walk, { position: [0, 0, 0], yaw: 0 });
const f = 120, q = Array.from({ length: 65 }, (_, b) => takeQuat(take, f, b)), back = fk(sk, q, takeHips(take, f));
expect("take v3 replays the compiled frame", Math.max(...walk.frames[f].s.P.map((p, j) => dist(p, back.P[j]))) < 1e-4);

// Broken takes must be caught.
const box = { pos: [0, 0, 0.6], R: I3(), half: [0.4, 0.5, 0.1] };
const into = compileMotion({ ...walkSpec, frames: 60, generators: [{ type: "walk", f0: 5, steps: 2, heading: [0, 0] }] }, { sk, scene: { objects: { Wall: box } } });
const kinds = new Set(runMotionQa(sk, into, walkSpec).groups.map(g => g.kind));
expect("QA catches walking into an object", kinds.has("COLLIDE"), [...kinds]);
const slideSpec = { ...walkSpec, frames: 30, generators: [], keys: [walkSpec.keys[0], { f: 29, set: { foot_l: [0.2, ank, -0.03], root: [0.05, P[I.Hips][1] - 0.01, 0] } }] };
const slideQa = runMotionQa(sk, compileMotion(slideSpec, { sk, scene: { objects: {} } }), slideSpec);
expect("QA catches a planted foot sliding", slideQa.groups.some(g => g.kind === "SLIDE"), JSON.stringify(slideQa.groups.map(g => g.kind)));
const reachSpec = { ...walkSpec, frames: 2, generators: [], fix: { reach: false }, keys: [{ f: 0, set: { ...walkSpec.keys[0].set, foot_l: [0.09, ank - 0.4, 0.5] } }] };
const reachQa = runMotionQa(sk, compileMotion(reachSpec, { sk, scene: { objects: {} } }), reachSpec);
expect("QA catches an unreachable foot target (reach fix off)", reachQa.groups.some(g => g.kind === "REACH"));

// Contact checks ported from the car-exit QA, the knee check on a lifted knee, prop anchor offsets.
const one = (set, extra = {}) => ({ ...walkSpec, frames: 1, generators: [], keys: [{ f: 0, set: { ...walkSpec.keys[0].set, ...set } }], ...extra });
const groupsOf = (spec, objects = {}) => runMotionQa(sk, compileMotion(spec, { sk, scene: { objects } }), spec).groups;
const intoChest = groupsOf(one({ armw_r: 1, hand_r: [0, P[I.Spine2][1] - 0.04, 0.04] }, { fix: { self: false } }));
expect("QA catches a hand inside the torso (fix.self off)", intoChest.some(g => g.kind === "BODY" && /hand_r into torso/.test(g.subject)), JSON.stringify(intoChest.map(g => g.subject)));
const keptOut = groupsOf(one({ armw_r: 1, hand_r: [0, P[I.Spine2][1] - 0.04, 0.04] }));
expect("with fix.self (default) the same target goes onto the skin: no BODY", !keptOut.some(g => g.kind === "BODY"), JSON.stringify(keptOut.map(g => g.subject)));
const clasped = groupsOf(one({ armw_r: 1, armw_l: 1, hand_r: [0, 1.15, 0.4], hand_l: [0, 1.15, 0.4] }));
expect("QA catches the two hands overlapping", clasped.some(g => g.kind === "SELF" && g.subject === "hands overlap"), JSON.stringify(clasped.map(g => g.subject)));
const hinge = { schema: "cozyclay.motion-spec.v1", frames: 2, keys: [{ f: 0, set: { ...walkSpec.keys[0].set, door: 0 } }, { f: 1, set: { door: -90 } }],
	objects: { Door: { pivot: [0.6, 0, 1], axis: [0, 1, 0], channel: "door" } } };
const doorGroups = groupsOf(hinge, { Door: { pos: [1, 0, 1], R: I3(), half: [0.4, 0.5, 0.05] }, Post: { pos: [0.6, -0.1, 1.6], R: I3(), half: [0.2, 0.6, 0.3] } });
const doorHit = doorGroups.find(g => g.kind === "OBJECT");
expect("QA catches a hinged door swinging into another object (and not before)", doorHit?.subject === "Door into Post" && doorHit.first === 1, JSON.stringify(doorGroups));
const lifted = groupsOf(one({ foot_l: [0.09, 0.78, 0.33], knee_l: [0, 0.8, 1] }));
const liftedKnee = compileMotion(one({ foot_l: [0.09, 0.78, 0.33], knee_l: [0, 0.8, 1] }), { sk, scene: { objects: {} } }).frames[0].s.P[I.LeftLeg];
expect("a knee lifted above the hip is not called backward", liftedKnee[1] > P[I.LeftUpLeg][1] && !lifted.some(g => g.kind === "KNEE"), JSON.stringify(lifted.map(g => g.subject)));
const backward = groupsOf(one({ foot_l: [0.09, 0.25, 0.02], knee_l: [0, 0, -1] }));
expect("QA catches a knee bending backward", backward.some(g => g.kind === "KNEE" && /backward/.test(g.subject)), JSON.stringify(backward.map(g => g.subject)));
const lit = compileMotion(one({ armw_r: 1, armw_l: 1, hand_r: [0, 1.25, 0.3], w_under_l: 1 }, {
	props: { cig: { hand: "r", origin: ["RightHandIndex2", "RightHandMiddle2"], points: { tip: [0, 0, 0.058] } },
		lighter: { hand: "l", origin: ["LeftHand", "LeftHandMiddle1"], points: { flame: [0.01, 0.036, 0] } } },
	anchors: { under: { kind: "prop", prop: "cig", point: "tip", offset: [0, -0.02, 0] } },
	fits: [{ side: "l", anchor: "under", effector: { prop: "lighter", point: "flame" } }] }), { sk, scene: { objects: {} } }).frames[0].diag.props;
expect("a prop anchor offset puts the flame 2 cm under the tip", dist(lit.lighter.flame, [lit.cig.tip[0], lit.cig.tip[1] - 0.02, lit.cig.tip[2]]) < 1e-3, dist(lit.lighter.flame, lit.cig.tip));

// arm_hang (pose.js): a free FK forearm hangs plumb from the elbow where standIdle and walks key it, as far as the rig's
// thigh allows (the narrower X Bot keeps some slant), and arm_hang 0 keeps the forearm on the upper arm's slant
{
	const { skeletonFor } = await import("../../src/motion3/rigs/index.js");
	const slant = (sk, c) => { const { s } = pose(sk, c), I = sk.index, v = sub(s.P[I.LeftHand], s.P[I.LeftForeArm]); return Math.abs(Math.atan2(v[0], -v[1]) * 180 / Math.PI); };
	const y = skeletonFor("y-bot-tpose"), x = skeletonFor("x-bot-tpose");
	const got = { yHang: slant(y, { arm_hang: 1 }), yOld: slant(y, {}), xHang: slant(x, { arm_hang: 1 }), xOld: slant(x, {}) };
	expect("arm_hang 1 hangs the Y Bot's free forearm plumb, the X Bot's as far as its thigh allows; arm_hang 0 keeps the slant",
		got.yHang < 1 && got.yOld > 15 && got.xHang > 4 && got.xHang < got.xOld - 6, JSON.stringify(got));
}
if (failures) { console.error(`${failures} motion3 core check(s) failed`); process.exit(1); }
console.log("motion3 core: all checks passed");
