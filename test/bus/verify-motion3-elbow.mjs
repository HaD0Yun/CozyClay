#!/usr/bin/env node
// Lane P3 (docs/motion-api-v3.1.md C13, C14): an elbow folds no further than an arm can. Session df6acdcc
// (fixtures/bat-fold.mjs) folded the right elbow to 171 deg at f34: the forearm in the upper arm, and no QA
// check said so. Active flexion ends near 145 deg (AMA 140, Kendall 145, AAOS 150); the arm IK follows its
// target to 145 deg, eases onto a stop at 150 deg and leaves the rest as a REACH residual with a hint. QA
// calls an elbow past the stop a hard ELBOW issue. Takes whose elbows stay within 145 deg bake as before.
import { takeHash as hashOf } from "../motion3/fixtures/take-hash.mjs";
import { compileSpec } from "../motion3/fixtures/legacy-compile.mjs";
import { generalChecks } from "../../src/motion3/qa/checks.js";
import { runMotionQa } from "../../src/motion3/qa/index.js";
import { motionScene } from "../../src/motion3/scene.js";
import { skeletonFor } from "../../src/motion3/rigs/index.js";
import { bakeTake } from "../../src/motion3/take.js";
import { refPoint } from "../../src/motion3/refs.js";
import { buildKit } from "../../src/kits/index.js";
import { pose } from "../../src/motion3/compiler/pose.js";
import { rotateSubtree } from "../../src/motion3/compiler/skeleton.js";
import { ELBOW_FOLD, ELBOW_STOP, flexionAt, reachAt, armReach, foldPoint, elbowFold } from "../../src/motion3/compiler/limbs.js";
import { add, sub, dot, dist, angle, axisRot, norm, cross } from "../../src/motion3/compiler/math.js";
import { SCENE_OBJECTS as CAR, EXITCAR_SPEC } from "../motion3/fixtures/exitcar-scene.mjs";
import * as J2 from "../motion3/fixtures/bat-swing.mjs";
import * as K8 from "../motion3/fixtures/bat-aim-swing.mjs";
import * as N1 from "../motion3/fixtures/bat-stance.mjs";
import * as G from "../motion3/fixtures/ground-sessions.mjs";
import { FOLD_SPEC, FOLD_KIT_AT } from "../motion3/fixtures/bat-fold.mjs";
import { SCENE_OBJECTS as CUP_SCENE } from "../motion3/fixtures/cup-scene.mjs";
import { RUN3_SPEC } from "../motion3/fixtures/cup-run3-spec.mjs";

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
}
const sk = skeletonFor("y-bot-tpose"), I = sk.index, rest = pose(sk, {}).s;
const A = dist(rest.P[I.RightArm], rest.P[I.RightForeArm]), B = dist(rest.P[I.RightForeArm], rest.P[I.RightHand]);
const bend = (s, S) => angle(sub(s.P[I[`${S}ForeArm`]], s.P[I[`${S}Arm`]]), sub(s.P[I[`${S}Hand`]], s.P[I[`${S}ForeArm`]]));
const maxBend = (out, S, isk = sk) => Math.max(...out.frames.map(({ s }) => angle(sub(s.P[isk.index[`${S}ForeArm`]], s.P[isk.index[`${S}Arm`]]), sub(s.P[isk.index[`${S}Hand`]], s.P[isk.index[`${S}ForeArm`]]))));
const kinds = r => r.qa.groups.map(g => `${g.kind} ${g.subject} n${g.count} f${g.first}-${g.last}`);

// ---- 1. the limit, measured as QA measures it --------------------------------------------------------
expect("the elbow bends freely to 145 deg (active flexion) and stops at 150 deg", ELBOW_FOLD === 145 && ELBOW_STOP === 150);
expect("flexionAt and reachAt invert each other: the IK's shoulder-wrist distance is QA's joint angle", [10, 30, 90, 145, 150, 170].every(d => Math.abs(flexionAt(A, B, reachAt(A, B, d)) - d) < 1e-6));
const k = reachAt(A, B, ELBOW_FOLD), stop = reachAt(A, B, ELBOW_STOP), w = k - stop, h = 1e-6;
const ds = Array.from({ length: 400 }, (_, i) => (i / 399) * (k + 0.05));
expect("armReach: the target itself up to 145 deg (bit for bit), C1 where it engages, never nearer than the stop, on it 2w inside",
	ds.filter(d => d >= k).every(d => armReach(A, B, d) === d) && Math.abs((armReach(A, B, k) - armReach(A, B, k - h)) / h - 1) < 1e-3
	&& ds.every((d, i) => armReach(A, B, d) >= stop - 1e-12 && (i === 0 || armReach(A, B, d) >= armReach(A, B, ds[i - 1]))) && armReach(A, B, k - 2 * w) === stop && armReach(A, B, 0) === stop);
expect("elbowFold: an asked fold to 145 deg is kept, a deeper one eases onto 150 deg", Math.abs(elbowFold(A, B, 120) - 120) < 1e-6 && elbowFold(A, B, 147) > 146 && elbowFold(A, B, 147) < 147 && Math.abs(elbowFold(A, B, 180) - 150) < 1e-6);
// a target passing straight through the shoulder joint: the nearest point (rays from the shoulder) jumps across the stop
const S = rest.P[I.RightArm], path = Array.from({ length: 16 }, (_, i) => add(S, [-0.25 + (i + 0.5) / 32, 0, 0]));
const jump = back => Math.max(...path.slice(1).map((T, i) => dist(foldPoint(S, T, A, B, back), foldPoint(S, path[i], A, B, back))));
console.log(`  a target through the shoulder joint, 1.6 cm a step: the wrist steps up to ${(jump([0, 0, -1]) * 100).toFixed(1)} cm (rays from behind), ${(jump([0, 0, 0]) * 100).toFixed(1)} cm (from the shoulder)`);
expect("foldPoint glides past the shoulder (rays from behind it): the wrist steps at most 4x the target's step where the nearest point jumps across the stop", jump([0, 0, -1]) < 4 / 32 && jump([0, 0, 0]) > 2 * stop * 0.95);

// ---- 2. a hand target driven into the shoulder ---------------------------------------------------------
const STAND = [{ skill: "standIdle", f0: 0, args: { at: [0, 0], heading: 0 } }], spec0 = { schema: "cozyclay.motion-spec.v1", fps: 24 };
const S0 = compileSpec({ ...spec0, frames: 2, use: STAND }, { sk, scene: { objects: {} } }).out.frames[0].s.P[I.RightArm];
const drive = (n, from, to) => compileSpec({ ...spec0, frames: n + 9, use: STAND, keys: [{ f: 0, set: { armw_r: 1, hand_r: add(S0, from) } }, { f: n, set: { hand_r: add(S0, to) } }] }, { sk, scene: { objects: {} } });
const right = r => r.qa.groups.filter(g => /^(Right|arm_miss_r)/.test(g.subject));
for (const [label, n] of [["over 48 frames", 48], ["at 3 cm a frame", 12]]) {
	const r = drive(n, [0, -0.05, 0.4], [0, 0, 0.02]), reach = r.qa.groups.find(g => g.kind === "REACH" && g.subject === "arm_miss_r"), fr = reach && r.out.frames[reach.worstFrame - (r.out.f0 ?? 0)];
	const out = fr && norm(sub(fr.s.P[I.RightHand], fr.s.P[I.RightArm]));
	console.log(`  hand into the shoulder ${label}: elbow up to ${maxBend(r.out, "Right").toFixed(2)} deg; ${kinds(r).join(" | ")}`);
	expect(`a hand target driven into the shoulder ${label}: the elbow stops at 150 deg with no POP, FLIP or ELBOW, and REACH says how far inside (12 cm) and to move it out (the patch moves hand_r away from the shoulder)`,
		maxBend(r.out, "Right") <= ELBOW_STOP + 1e-6 && right(r).every(g => g.kind === "REACH") && Math.abs(reach?.worst - 0.122) < 0.002
		&& /inside the forearm's reach: the elbow would fold 176deg; it bends to 145deg and stops at 150deg/.test(reach?.hint) && /back from it$/.test(reach.hint) && dot(reach.fix?.delta ?? [0, 0, 0], out) > 0.1, `${right(r).map(g => `${g.kind} ${g.subject} ${g.hint}`).join(" | ")}`);
}
const through = drive(16, [-0.25, 0, 0], [0.25, 0, 0]);
expect("a hand target passing through the shoulder joint: the elbow stops at 150 deg and its bend plane does not flip", maxBend(through.out, "Right") <= ELBOW_STOP + 1e-6
	&& !through.qa.groups.some(g => g.kind === "FLIP" || g.kind === "ELBOW"), kinds(through).join(" | "));

// ---- 3. an FK bend stops there too ---------------------------------------------------------------------
const fk = bd => bend(pose(sk, { arm_rest: 90, abend_r: bd }).s, "Right");
console.log(`  FK abend_r with arm_rest 90: 100 -> ${fk(100).toFixed(2)}, 147 -> ${fk(147).toFixed(2)}, 175 -> ${fk(175).toFixed(2)} deg`);
expect("an FK abend past 145 deg eases onto the stop like the IK; one within it is left as it is", fk(175) <= ELBOW_STOP + 1e-6 && fk(175) > 149.5 && Math.abs(fk(147) - elbowFold(A, B, 147)) < 0.05 && Math.abs(fk(100) - 100) < 1);

// ---- 4. QA: an elbow past its stop is a hard ELBOW issue ------------------------------------------------
const idle = drive(12, [0, -0.05, 0.4], [0, -0.05, 0.3]), F = 10;
const folded = { ...idle.out, frames: idle.out.frames.map((fr, f) => {
	if (f !== F) return fr;
	const s = { P: fr.s.P.slice(), R: fr.s.R.slice() }, up = sub(s.P[I.RightForeArm], s.P[I.RightArm]), down = sub(s.P[I.RightHand], s.P[I.RightForeArm]);
	rotateSubtree(sk, s, I.RightForeArm, s.P[I.RightForeArm].slice(), axisRot(cross(up, down), 170 - angle(up, down)));
	return { ...fr, s };
}) };
const elbow = generalChecks(sk, folded, {}).filter(i => i.kind === "ELBOW"), qa = runMotionQa(sk, folded, idle.spec), g = qa.groups.find(x => x.kind === "ELBOW");
console.log(`  injected fold: ${JSON.stringify(elbow)}; hint: ${g?.hint}`);
expect("an elbow folded to 170 deg is an ELBOW issue at that frame (limit 150), hard: qa.ok false, a group with a hint to move the hand out",
	elbow.length === 1 && elbow[0].msg === "Right elbow folds 170deg" && elbow[0].frame === F && elbow[0].limit === ELBOW_STOP && !qa.ok && g?.worstFrame === F
	&& /past its 150deg stop; it bends freely to 145deg\)$/.test(g.hint) && !generalChecks(sk, idle.out, {}).some(i => i.kind === "ELBOW"), JSON.stringify([elbow, g]));

// ---- 5. the fixtures: no elbow past the stop; takes within 145 deg bake as before -------------------------
const cig = buildKit("cigarette", [], { position: { x: 0.6, z: 0.5 } }), lit = buildKit("lighter", cig.records, { position: { x: 0.75, z: 0.5 } });
const kitScene = motionScene([...cig.records, ...lit.records, { id: "puff", name: "Exhale", renderer: "effect", x: 0, y: 1.5, z: 0.1, rot: 0, footprint: { width: 0, depth: 0 }, height: 0 }]);
const SQUAT = { root: [0, 0.45, -0.12], yaw: 0, pitch: 22, spine_pitch: 10, head_pitch: -12, foot_l: [0.16, 0.101, 0.02], foot_r: [-0.16, 0.101, 0.02], fyaw_l: 15, fyaw_r: -15, knee_l: [0.45, 0, 1], knee_r: [-0.45, 0, 1] };
const smoke = (frames, start, kit) => ({ ...spec0, frames, ...start, use: [...(start.use ?? []), { skill: "smokeCigarette", f0: 1, args: kit ? { kit: { cig: cig.rootId, lighter: lit.rootId, exhale: "puff" } } : {} }] });
const j2keyed = structuredClone(J2.SWING_SPEC);
j2keyed.objects[J2.BAT].keys = J2.SWING_KEYS;
const foldScene = motionScene(buildKit("bat", [], { position: { x: FOLD_KIT_AT[0], y: FOLD_KIT_AT[1], z: FOLD_KIT_AT[2] } }).records);
// [name, rig, spec, scene, max elbow flexion before (v3@95716ab7, deg), take hash before, take hash after (null: the same)]
// Lane Q1 changed six of them after P3, and their hashes here are Q1's: J2 both (a flat foot keeps its heading until it lifts,
// fix/turn.js), K8 16d12ba9 (the second hand's roll priced past the SELF allowance on the holding hand), N1 d5c110a7 and
// P2 df6acdcc (the same price past the BODY allowance in the torso), L2 9dcf19c5 (its flat front foot, fix/turn.js).
// The walking takes (exitcar, walk, cup run3) carry the hashes of the walk's natural rhythm (compiler/gait-rhythm.js)
// its foot rockers and arms (compiler/walk.js: heel strike, push-off over the ball, elbows bending with the swing) and hips (compiler/walk-pelvis.js); exitcar also the left hand's grip turn
// on the door handle (compiler/grip.js).
// Flow (compiler/channels.js: the free spine, head and arms carry through keys and trail) re-baked the takes whose arms swing
// free (exitcar, walk, cup run3, the standing smokes, df6acdcc, 6262a69c); their QA did not change.
// exitcar and walk also bake the idle layer of their holds (compiler/idle.js: a held pose breathes and shifts its weight).
// The walking takes (exitcar, walk, cup run3) re-baked with the smaller heel-strike toe-up (walk.js SHIN 0.12) and the
// stride length term (gait-rhythm.js LENGTH.stride); their QA did not change (0 before and after).
// The walking takes (exitcar, walk, cup run3) re-baked with the hips-first walk (walk-pelvis.js, walk.js); their QA did not
// change (0 before and after).
// The walking takes (exitcar, walk, cup run3) re-baked with the narrower default foot width (walk.js halfWidth 0.08), the
// flat-ish heel strike (STRIKE_DF 4, no slant term) and less stride-time noise (gait-rhythm.js TIME.noise 0.02); their QA
// did not change (0 before and after).
const TAKES = [
// re-pinned when standIdle and walks began keying arm_hang (compiler/pose.js: a free forearm hangs plumb); QA unchanged
// re-pinned when the walk scaled its knees, swing kick, heel strike and hips at the strike with its pace and the swing foot
// began following the shank (walk.js, walk-pelvis.js); QA 0 before and after
// re-pinned when the walk's upper body began following its pace and leading the legs (walk.js, head-steady.js); QA 0 before and after
// re-pinned when the head began leading the walk's turns (head-lead.js); QA 0 before and after
	["exitcar", "x-bot-tpose", { fps: 24, ...EXITCAR_SPEC }, motionScene(CAR), 137.07, "6dfc89e506976346", null],
	["smoke stand (Y Bot)", "y-bot-tpose", smoke(266, { use: STAND }, false), { objects: {} }, 134.57, "23c7c29a978ffeb1", null],
	["smoke stand (X Bot)", "x-bot-tpose", smoke(266, { use: STAND }, false), { objects: {} }, 137.07, "35bbaaf6f2607e62", null],
	["smoke squat, kits (Y Bot)", "y-bot-tpose", smoke(240, { keys: [{ f: 0, set: SQUAT }] }, true), kitScene, 132.24, "29bedcfc6c9154e6", null],
	["smoke squat, kits (X Bot)", "x-bot-tpose", smoke(240, { keys: [{ f: 0, set: SQUAT }] }, true), kitScene, 134.53, "a6da7196e4bd1665", null],
	["squat smoke cea7fa46", "y-bot-tpose", G.SQUAT_SPEC, motionScene(G.smokeScene()), 131.75, "4b988f4b26056859", null],
	["walk", "y-bot-tpose", { ...spec0, frames: 160, use: [...STAND, { skill: "walkTo", f0: 1, args: { to: [0, 2.4], steps: 6, heading: 0 } }] }, { objects: {} }, 9.51, "c71db8a3d52dc4d9", null],
	["cup run3", "y-bot-tpose", RUN3_SPEC, motionScene(CUP_SCENE), 133.27, "95ba80251e30a32e", null],
	["J2 bat, no keys", "y-bot-tpose", J2.SWING_SPEC, motionScene(J2.SCENE_OBJECTS), 141.52, "7e49b1630982dfc8", null],
	["J2 bat, keys", "y-bot-tpose", j2keyed, motionScene(J2.SCENE_OBJECTS), 140.96, "248dc5649b0c7499", null],
	["K8 16d12ba9", "y-bot-tpose", K8.SWING_SPEC, motionScene(K8.batKit(K8.SWING_KIT_AT)), 143.57, "496cb796f592d8e8", null],
	["K8 6912547c", "y-bot-tpose", K8.EARLIER_SPEC, motionScene(K8.batKit(K8.EARLIER_KIT_AT)), 150.89, "2228cc5001daba8e", "fc6f95586f8b1622"],
	// N1 d5c110a7 re-pinned when fix.retime went on by default (3 windows stretched, QA 60 -> 56; 5528ad309521dd71 with retime: false)
	["N1 d5c110a7", "y-bot-tpose", N1.STANCE_SPEC, motionScene(K8.batKit(N1.STANCE_KIT_AT)), 154.06, "fa22fc331b91e0aa", "24f0828dfbfa9eb0"],
	["N1 f0f2be59", "y-bot-tpose", N1.CLEAN_SPEC, motionScene(K8.batKit(N1.CLEAN_KIT_AT)), 152.2, "3d73c4b9e175a657", "e874f6556578614d"],
	["L2 9dcf19c5", "y-bot-tpose", G.SWING_SPEC, motionScene(G.batScene()), 150.87, "a7ffbc022b463875", "6c6926016a279376"],
	["P2 df6acdcc", "y-bot-tpose", FOLD_SPEC, foldScene, 170.87, "cba7efc1642eee3a", "f912e5753d15fa42"],
];
const runs = {}, wrong = [];
for (const [name, rig, spec, scene, before, h0, h1] of TAKES) {
	const isk = skeletonFor(rig), r = compileSpec(spec, { sk: isk, scene }), most = Math.max(maxBend(r.out, "Left", isk), maxBend(r.out, "Right", isk)), hash = hashOf(bakeTake(isk, r.out));
	runs[name] = r;
	console.log(`  ${name}: elbow ${before} -> ${most.toFixed(2)} deg, QA ${r.qa.total}, ${hash}${h1 ? ` (was ${h0})` : ""}`);
	if (most > ELBOW_STOP + 1e-6 || (before <= ELBOW_FOLD) !== !h1 || hash !== (h1 ?? h0) || r.qa.groups.some(x => x.kind === "ELBOW")) wrong.push([name, most, hash]);
}
expect("no fixture take folds an elbow past 150 deg or has an ELBOW issue; those within 145 deg bake bit for bit as before, the five past it change", wrong.length === 0, JSON.stringify(wrong));
// the smoking hand at the mouth stays within the fold, so the filter stays on the lips
const lips = name => {
	const { out } = runs[name], wm = out.baked.w_mouth_r;
	return Math.max(...out.frames.map((fr, f) => (wm[f] >= 0.999 ? dist(fr.diag.props.cig.filter, refPoint(out, f, "landmark:mouth")) : 0)));
};
const onLips = ["smoke stand (Y Bot)", "smoke squat, kits (Y Bot)", "smoke squat, kits (X Bot)", "squat smoke cea7fa46"].map(n => [n, +(lips(n) * 1000).toFixed(1)]);
console.log(`  filter on the lips (mm, while w_mouth_r is 1): ${JSON.stringify(onLips)}`);
expect("the smoking hand brings the filter to the lips within 3.5 mm, its elbow under 145 deg", onLips.every(([, mm]) => mm < 3.5));
const fold = runs["P2 df6acdcc"], reach = fold.qa.groups.find(x => x.kind === "REACH"), at34 = fold.out.frames[34].diag.hold_r;
expect("df6acdcc: the keys that drive the wrist into the shoulder are a REACH residual whose hint names the fold, and the right elbow plane no longer flips",
	/^empty at f34: the grip is 10\.9 cm inside the forearm's reach \(the elbow would fold 171deg; it bends to 145deg and stops at 150deg\)/.test(reach?.hint) && /key a pose farther from the shoulder/.test(reach.hint)
	&& at34.fold > 170 && !fold.qa.groups.some(x => x.kind === "FLIP" && /^RightForeArm/.test(x.subject)), JSON.stringify([reach, at34]));

if (failures) { console.error(`${failures} motion3 elbow check(s) failed`); process.exit(1); }
console.log("motion3 elbow fold limit: all checks passed");
