#!/usr/bin/env node
// Lane P4 (docs/motion-api-v3.1.md C13): a knee folds no further than a leg can. The leg IK had no stop: hips
// keyed below what the legs fold put the shin into the thigh (175 deg), and QA only measured the bend as style.
// Active knee flexion ends near 135-140 deg; a deep squat with the heels down folds 150-160 deg as the thigh
// rests on the calf, and passive flexion stops near 160. The leg IK follows its ankle target to 150 deg, eases
// onto a stop at 160 deg and leaves the rest as a REACH residual (the ankle under the hip, so GROUND too), with
// a hint to bring the root up. QA calls a knee past the stop a hard KNEE issue; the opt-in style KNEE stays.
// Takes whose knees stay within 150 deg bake bit for bit as before.
import { takeHash as hashOf } from "../motion3/fixtures/take-hash.mjs";
import { compileSpec } from "../motion3/fixtures/legacy-compile.mjs";
import { generalChecks } from "../../src/motion3/qa/checks.js";
import { runMotionQa } from "../../src/motion3/qa/index.js";
import { motionScene } from "../../src/motion3/scene.js";
import { skeletonFor } from "../../src/motion3/rigs/index.js";
import { bakeTake } from "../../src/motion3/take.js";
import { refPoint } from "../../src/motion3/refs.js";
import { applyPatch } from "../../src/motion3/json-patch.js";
import { buildKit } from "../../src/kits/index.js";
import { pose } from "../../src/motion3/compiler/pose.js";
import { rotateSubtree } from "../../src/motion3/compiler/skeleton.js";
import { KNEE_FOLD, KNEE_STOP, flexionAt, reachAt, armReach, foldPoint } from "../../src/motion3/compiler/limbs.js";
import { add, sub, dist, angle, axisRot, cross } from "../../src/motion3/compiler/math.js";
import { SCENE_OBJECTS as CAR, EXITCAR_SPEC } from "../motion3/fixtures/exitcar-scene.mjs";
import * as G from "../motion3/fixtures/ground-sessions.mjs";

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
}
const yb = skeletonFor("y-bot-tpose"), xb = skeletonFor("x-bot-tpose"), I = yb.index, rest = pose(yb, {}).s;
const A = dist(rest.P[I.LeftUpLeg], rest.P[I.LeftLeg]), B = dist(rest.P[I.LeftLeg], rest.P[I.LeftFoot]);
const kneeOf = (sk, s, S) => angle(sub(s.P[sk.index[`${S}Leg`]], s.P[sk.index[`${S}UpLeg`]]), sub(s.P[sk.index[`${S}Foot`]], s.P[sk.index[`${S}Leg`]]));
const maxKnee = (out, sk) => Math.max(...out.frames.flatMap(({ s }) => [kneeOf(sk, s, "Left"), kneeOf(sk, s, "Right")]));
const kinds = r => r.qa.groups.map(g => `${g.kind} ${g.subject} n${g.count} f${g.first}-${g.last}`);

// ---- 1. the limit, measured as QA measures it (UpLeg->Leg against Leg->Foot) ---------------------------
expect("the knee bends freely to 150 deg and stops at 160 deg (passive flexion: the thigh on the calf)", KNEE_FOLD === 150 && KNEE_STOP === 160);
const k = reachAt(A, B, KNEE_FOLD), stop = reachAt(A, B, KNEE_STOP), w = k - stop, h = 1e-6, ease = d => armReach(A, B, d, KNEE_FOLD, KNEE_STOP);
const ds = Array.from({ length: 400 }, (_, i) => (i / 399) * (k + 0.05));
expect("the hip-ankle distance: the target's own up to 150 deg (bit for bit), C1 where the stop engages, never nearer than 160 deg, on it 2w inside",
	ds.filter(d => d >= k).every(d => ease(d) === d) && Math.abs((ease(k) - ease(k - h)) / h - 1) < 1e-3 && Math.abs(flexionAt(A, B, stop) - KNEE_STOP) < 1e-9
	&& ds.every((d, i) => ease(d) >= stop - 1e-12 && (i === 0 || ease(d) >= ease(ds[i - 1]))) && ease(k - 2 * w) === stop && ease(0) === stop);
// the fold centre sits above the hip (the pelvis's up): a target under the hip goes on down, one at the free fold stays
const H = rest.P[I.LeftUpLeg], under = add(H, [0, -0.15, 0.02]), P = foldPoint(H, under, A, B, [0, 1, 0], KNEE_FOLD, KNEE_STOP), edge = add(H, [0, -k, 0]);
expect("foldPoint for a knee: a target 15 cm under the hip goes straight on down to the eased distance; one at the free fold is itself",
	P[1] < under[1] && Math.abs(dist(P, H) - ease(dist(under, H))) < 1e-12 && Math.abs(P[0] - under[0]) < 1e-12 && foldPoint(H, edge, A, B, [0, 1, 0], KNEE_FOLD, KNEE_STOP) === edge);

// ---- 2. the hips driven down past what the legs fold ---------------------------------------------------
const spec0 = { schema: "cozyclay.motion-spec.v1", fps: 24 };
const squatDown = (to, { fz = -0.1, fx = 0.1, pitch = 0, limits } = {}) => ({ ...spec0, frames: 57, ...(limits ? { checks: { limits } } : {}), keys: [
	{ f: 0, set: { root: [0, 0.6, -0.12], yaw: 0, pitch, spine_pitch: 10, foot_l: [fx, 0.101, fz], foot_r: [-fx, 0.101, fz], fyaw_l: 15, fyaw_r: -15, knee_l: [0.45, 0, 1], knee_r: [-0.45, 0, 1] } },
	{ f: 48, set: { root: [0, to, -0.12] } }] });
for (const sk of [yb, xb]) {
	const name = sk === yb ? "Y Bot" : "X Bot", spec = squatDown(0.2), r = compileSpec(spec, { sk, scene: { objects: {} } });
	const bends = r.out.frames.map(({ s }) => kneeOf(sk, s, "Left")), d2 = Math.max(...bends.slice(2).map((b, i) => Math.abs(b - 2 * bends[i + 1] + bends[i])));
	const reach = r.qa.groups.find(g => g.kind === "REACH" && g.subject === "leg_miss_l"), ground = r.qa.groups.find(g => g.kind === "GROUND" && /^Left/.test(g.subject));
	console.log(`  ${name} hips 0.6 -> 0.2 m over 48 frames: knee up to ${maxKnee(r.out, sk).toFixed(2)} deg (asked ${r.out.frames[48].diag.leg_fold_l.toFixed(1)}), knee angle 2nd difference <= ${d2.toFixed(3)} deg/f^2; ${kinds(r).join(" | ")}`);
	console.log(`    REACH hint: ${reach?.hint}\n    GROUND hint: ${ground?.hint}`);
	expect(`${name}: hips keyed below what the legs fold: the knee eases onto 160 deg with no kink (2nd difference < 0.3 deg/f^2), no POP, FLIP or KNEE; REACH and GROUND name the stop and raise the root`,
		maxKnee(r.out, sk) <= KNEE_STOP + 1e-6 && maxKnee(r.out, sk) > KNEE_STOP - 1e-3 && d2 < 0.3 && r.qa.groups.every(g => g.kind === "REACH" || g.kind === "GROUND")
		&& /^root: raise [\d.]+ m at f\d+ \(the ankle target is [\d.]+ m inside the shin's reach: the knee would fold 17\ddeg; it bends to 150deg and stops at 160deg\), or key foot_l farther from the hip/.test(reach?.hint)
		&& /^root: raise [\d.]+ m at f\d+ \(the sole is in the floor because the knee is on its stop: the knee would fold 17\ddeg/.test(ground?.hint) && reach.patch?.[0]?.path === "/keys/1/set/root",
		kinds(r).join(" | "));
	// the patch the hint carries puts the hips where the knee folds 150 deg: the take is clean
	const fixed = compileSpec(applyPatch(spec, reach.patch), { sk, scene: { objects: {} } });
	console.log(`    patched (${JSON.stringify(reach.patch[0].value)}): knee up to ${maxKnee(fixed.out, sk).toFixed(2)} deg, QA ${fixed.qa.total}`);
	expect(`${name}: the REACH patch (the root up) gives a clean squat with the knee within 150 deg`, fixed.qa.ok && maxKnee(fixed.out, sk) <= KNEE_FOLD + 0.01, kinds(fixed).join(" | "));
}
// a deep squat with the feet forward asks 154 deg: it bends to within millimetres and QA stays clean; the opt-in style KNEE still reads it
const deep = compileSpec(squatDown(0.22, { fz: 0.02, fx: 0.16, pitch: 22 }), { sk: yb, scene: { objects: {} } }), deepMax = maxKnee(deep.out, yb);
const capped = compileSpec(squatDown(0.22, { fz: 0.02, fx: 0.16, pitch: 22, limits: { knee: 150 } }), { sk: yb, scene: { objects: {} } });
console.log(`  deep squat (feet forward, pitch 22): knee ${deepMax.toFixed(2)} deg, asked ${deep.out.frames[48].diag.leg_fold_l.toFixed(2)}, ankle ${(deep.out.frames[48].diag.leg_miss_l * 1000).toFixed(1)} mm short; QA ${deep.qa.total}; with checks.limits.knee 150: ${kinds(capped).join(" | ")}`);
// the arms are not keyed and hang: at hips 0.22 m the fingertips touch the floor, 1.1 cm in on 3 frames, which QA measures since
// #1113 (qa/floor.js); the knees are what this checks
const hanging = g => g.kind === "GROUND" && /^fingers_[lr] below floor$/.test(g.subject) && g.worst < 0.015;
expect("a deep squat asking 154 deg folds within 1 deg of it with no QA issue (the hanging fingertips aside); checks.limits.knee 150 still makes it a style KNEE (bent), never a stop (folds)",
	deep.qa.groups.every(hanging) && deepMax > KNEE_FOLD && deepMax < KNEE_STOP && deep.out.frames[48].diag.leg_fold_l - deepMax < 1
	&& capped.qa.groups.some(g => g.kind === "KNEE" && / knee bent 15\ddeg$/.test(g.subject)) && !capped.qa.groups.some(g => / folds /.test(g.subject)), kinds(capped).join(" | "));

// ---- 3. QA: a knee past its stop is a hard KNEE issue ----------------------------------------------------
const stand = compileSpec(squatDown(0.6), { sk: yb, scene: { objects: {} } }), F = 10;
const folded = { ...stand.out, frames: stand.out.frames.map((fr, f) => {
	if (f !== F) return fr;
	const s = { P: fr.s.P.slice(), R: fr.s.R.slice() }, up = sub(s.P[I.LeftLeg], s.P[I.LeftUpLeg]), down = sub(s.P[I.LeftFoot], s.P[I.LeftLeg]);
	rotateSubtree(yb, s, I.LeftLeg, s.P[I.LeftLeg].slice(), axisRot(cross(up, down), 170 - angle(up, down)));
	return { ...fr, s };
}) };
const knee = generalChecks(yb, folded, {}).filter(i => i.kind === "KNEE"), qa = runMotionQa(yb, folded, stand.spec), g = qa.groups.find(x => x.kind === "KNEE");
console.log(`  injected fold: ${JSON.stringify(knee)}; hint: ${g?.hint}`);
expect("a knee folded to 170 deg is a hard KNEE issue at that frame (limit 160), with a hint to bring the hips up off the foot",
	knee.length === 1 && knee[0].msg === "Left knee folds 170deg" && knee[0].frame === F && knee[0].limit === KNEE_STOP && !qa.ok && g?.worstFrame === F
	&& /\(the knee folds 170deg, past its 160deg stop; it bends freely to 150deg\)/.test(g.hint) && !generalChecks(yb, stand.out, {}).some(i => i.kind === "KNEE"), JSON.stringify([knee, g]));

// ---- 4. the squat fixtures: knees within 150 deg, so they bake bit for bit; the filter stays on the lips ---
const STAND = [{ skill: "standIdle", f0: 0, args: { at: [0, 0], heading: 0 } }];
const cig = buildKit("cigarette", [], { position: { x: 0.6, z: 0.5 } }), lit = buildKit("lighter", cig.records, { position: { x: 0.75, z: 0.5 } });
const kitScene = motionScene([...cig.records, ...lit.records, { id: "puff", name: "Exhale", renderer: "effect", x: 0, y: 1.5, z: 0.1, rot: 0, footprint: { width: 0, depth: 0 }, height: 0 }]);
const SQUAT = { root: [0, 0.45, -0.12], yaw: 0, pitch: 22, spine_pitch: 10, head_pitch: -12, foot_l: [0.16, 0.101, 0.02], foot_r: [-0.16, 0.101, 0.02], fyaw_l: 15, fyaw_r: -15, knee_l: [0.45, 0, 1], knee_r: [-0.45, 0, 1] };
const smoke = (frames, start, kit) => ({ ...spec0, frames, ...start, use: [...(start.use ?? []), { skill: "smokeCigarette", f0: 1, args: kit ? { kit: { cig: cig.rootId, lighter: lit.rootId, exhale: "puff" } } : {} }] });
const lifted = [{ x: 0.25, y: 0.3, z: 0.1 }, { x: -0.25, y: 0.3, z: 0.1 }];
// [name, rig, spec, scene, max knee flexion (v3@f51e47e8, deg), take hash, filter-to-lips (mm, null: no cigarette)]; the exit-car and
// the walk as the walk's natural rhythm (compiler/gait-rhythm.js), foot rockers and arm swing (compiler/walk.js) and hips (compiler/walk-pelvis.js) bake them (the walk's knee 56.45 deg in the even walk)
// Flow (compiler/channels.js: the free spine, head and arms carry through keys and trail) re-baked the takes whose arms swing
// free (exitcar, walk, cup run3, the standing smokes, df6acdcc, 6262a69c); their QA did not change.
// exitcar and walk also bake the idle layer of their holds (compiler/idle.js: a held pose breathes and shifts its weight).
// The walking takes (exitcar, walk, cup run3) re-baked with the smaller heel-strike toe-up (walk.js SHIN 0.12) and the
// stride length term (gait-rhythm.js LENGTH.stride); their QA did not change (0 before and after);
// the walk's knee peak moved 58.61 -> 59.09 deg with it.
// The walking takes (exitcar, walk, cup run3) re-baked with the hips-first walk (walk-pelvis.js, walk.js: the hips as high as
// near-straight stance knees allow, the heel rising as the leg needs, each swing on one spline); their QA did not change
// (0 before and after); the walk's knee peak moved 59.09 -> 85.29 deg (its swing knee folds right after toe-off).
// The walking takes (exitcar, walk, cup run3) re-baked with the narrower default foot width (walk.js halfWidth 0.08), the
// flat-ish heel strike (STRIKE_DF 4, no slant term) and less stride-time noise (gait-rhythm.js TIME.noise 0.02); their QA
// did not change (0 before and after); the walk's knee peak moved 85.29 -> 85.62 deg, then 85.62 -> 72.735 deg with the walk by pace,
// then 72.735 -> 72.77 deg with its upper body by pace.
const TAKES = [
// re-pinned when standIdle and walks began keying arm_hang (compiler/pose.js: a free forearm hangs plumb); QA unchanged
// re-pinned when the walk scaled its knees, swing kick, heel strike and hips at the strike with its pace and the swing foot
// began following the shank (walk.js, walk-pelvis.js); QA 0 before and after
// re-pinned when the walk's upper body began following its pace and leading the legs (walk.js, head-steady.js); QA 0 before and after
// re-pinned when the head began leading the walk's turns (head-lead.js); QA 0 before and after, knee peaks unchanged
	["exitcar", xb, { fps: 24, ...EXITCAR_SPEC }, motionScene(CAR), 129.71, "6dfc89e506976346", null],
	["walk", yb, { ...spec0, frames: 160, use: [...STAND, { skill: "walkTo", f0: 1, args: { to: [0, 2.4], steps: 6, heading: 0 } }] }, { objects: {} }, 72.77, "c71db8a3d52dc4d9", null],
	["smoke squat (Y Bot)", yb, smoke(240, { keys: [{ f: 0, set: SQUAT }] }, false), { objects: {} }, 133.46, "c57884d0ea3d1603", 2.081],
	["smoke squat (X Bot)", xb, smoke(240, { keys: [{ f: 0, set: SQUAT }] }, false), { objects: {} }, 134.67, "9c3b79ba1922488f", 0.29],
	["smoke squat, kits (Y Bot)", yb, smoke(240, { keys: [{ f: 0, set: SQUAT }] }, true), kitScene, 133.46, "29bedcfc6c9154e6", 2.081],
	["smoke squat, kits (X Bot)", xb, smoke(240, { keys: [{ f: 0, set: SQUAT }] }, true), kitScene, 134.67, "a6da7196e4bd1665", 0.29],
	["squat smoke cea7fa46", yb, G.SQUAT_SPEC, motionScene(G.smokeScene()), 127.13, "4b988f4b26056859", 2.045],
	["squat smoke 375e8ea5 (first)", yb, G.FIRST_SPEC, motionScene(G.smokeScene(...lifted)), 137.45, "693cfb2af67aa001", 2.036],
	["squat smoke 375e8ea5 (raised)", yb, G.RAISED_SPEC, motionScene(G.smokeScene(...lifted)), 135.25, "f34605759ebbcc2f", 2.036],
];
const wrong = [];
for (const [name, sk, spec, scene, before, h0, lips0] of TAKES) {
	const r = compileSpec(spec, { sk, scene }), most = maxKnee(r.out, sk), hash = hashOf(bakeTake(sk, r.out)), wm = r.out.baked.w_mouth_r;
	const lips = lips0 === null ? null : +(Math.max(...r.out.frames.map((fr, f) => (wm[f] >= 0.999 ? dist(fr.diag.props.cig.filter, refPoint(r.out, f, "landmark:mouth")) : 0))) * 1000).toFixed(3);
	console.log(`  ${name}: knee ${before} -> ${most.toFixed(2)} deg, QA ${r.qa.total}, ${hash}${lips === null ? "" : `, filter to lips ${lips} mm`}`);
	if (Math.abs(most - before) > 0.005 || most > KNEE_FOLD || hash !== h0 || lips !== lips0 || !r.qa.ok || r.qa.groups.some(x => x.kind === "KNEE")) wrong.push([name, most, hash, lips, kinds(r)]);
}
expect("every squat, the exit-car and the walk keep their knees within 150 deg and bake bit for bit as before (filter to lips unchanged, QA clean)", wrong.length === 0, JSON.stringify(wrong));

if (failures) { console.error(`${failures} motion3 knee check(s) failed`); process.exit(1); }
console.log("motion3 knee fold limit: all checks passed");
