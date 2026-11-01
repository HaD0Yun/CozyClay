#!/usr/bin/env node
// Lane Q1: the same request ("야구 배트를 휘두르는 모습을 만들어줘") gave QA 0 in session 6262a69c and QA 17 in
// session 4db5d447 (fixtures/bat-robust.mjs). The QA-17 run's issues, by cause:
//   1. SLIDE Right heel f10-19: fyaw_r keyed 0 at f0 and 30 at f37 turned the back foot 9 deg while it was flat on
//      the floor. A flat foot under the body's weight cannot turn without a heel or ball sliding: fix.slide now
//      keeps its heading until the heel lifts, then the foot turns on its ball (fix/turn.js).
//   2. POP and FLIP RightForeArm f44-45: the holding elbow's planned pole jumped across a ridge of its swivel
//      landscape (22 cm in one frame). The plan now never jumps (hold-plan.js steadyPath).
//   3. BODY hand_l into torso_lo f35: the second hand's roll priced the hand in the torso at 1 per cm^2, so it
//      took 0.9 cm of torso to save 1 of strain. Past QA's allowance it now costs DEEP (second-hand.js), and so
//      does the second hand going into the holding hand past the SELF allowance.
//   4. SELF hands overlap: real. The left hand is anchored by its wrist (no fit) at `low` plus a world offset,
//      so its palm is 10-24 cm off the bat; at f29 and f41 the anchor is 7-11 cm from the right palm.
// QA also excuses a second hand whose palm is inside the object it grips (the QA-0 run's allow is not needed).
import { takeHash as hashOf } from "../motion3/fixtures/take-hash.mjs";
import { compileSpec } from "../motion3/fixtures/legacy-compile.mjs";
import { motionScene } from "../../src/motion3/scene.js";
import { skeletonFor } from "../../src/motion3/rigs/index.js";
import { bakeTake } from "../../src/motion3/take.js";
import { specIdOf } from "../../src/motion3/spec-store.js";
import { buildKit } from "../../src/kits/index.js";
import { smoothPath, steadyPath } from "../../src/motion3/hold-plan.js";
import { objectBoxesAt } from "../../src/motion3/object-pose.js";
import { add, sub, scale, dist, len, dot } from "../../src/motion3/compiler/math.js";
import { SCENE_OBJECTS as CAR, EXITCAR_SPEC } from "../motion3/fixtures/exitcar-scene.mjs";
import * as J2 from "../motion3/fixtures/bat-swing.mjs";
import * as K8 from "../motion3/fixtures/bat-aim-swing.mjs";
import * as N1 from "../motion3/fixtures/bat-stance.mjs";
import * as G from "../motion3/fixtures/ground-sessions.mjs";
import * as Q from "../motion3/fixtures/bat-robust.mjs";
import { FOLD_SPEC, FOLD_KIT_AT } from "../motion3/fixtures/bat-fold.mjs";
import { SCENE_OBJECTS as CUP_SCENE } from "../motion3/fixtures/cup-scene.mjs";
import { RUN3_SPEC } from "../motion3/fixtures/cup-run3-spec.mjs";

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
}
const sk = skeletonFor("y-bot-tpose"), I = sk.index, wrap = d => Math.atan2(Math.sin(d), Math.cos(d));
const bat = ([x, y, z]) => motionScene(buildKit("bat", [], { position: { x, y, z } }).records);
const kinds = r => r.qa.groups.map(g => `${g.kind} ${g.subject} n${g.count} f${g.first}-${g.last}`);

// ---- 0. the fixtures are the specs the sessions installed --------------------------------------------
expect("the fixtures compile to the specIds the sessions installed (spec-72eaf5116c0a at QA 0, spec-f77f28d4b845 at QA 17)",
	specIdOf(Q.CLEAN_SPEC) === Q.CLEAN_SPEC_ID && specIdOf(Q.SEVENTEEN_SPEC) === Q.SEVENTEEN_SPEC_ID);

// ---- 1. the QA-17 run: what is left is real ------------------------------------------------------------
const seventeen = compileSpec(Q.SEVENTEEN_SPEC, { sk, scene: bat(Q.SEVENTEEN_KIT_AT) }), out = seventeen.out;
console.log(`  4db5d447: QA ${seventeen.qa.total} (was 17: SLIDE Right heel n10, SELF hands overlap n3, POP RightForeArm n2, BODY hand_l n1, FLIP RightForeArm n1): ${kinds(seventeen).join(" | ")}`);
console.log(`  fixed.slide ${JSON.stringify(seventeen.fixed.slide)}`);
expect("4db5d447: no SLIDE, POP, FLIP or BODY; only SELF hands overlap is left, at most 2 frames", seventeen.qa.groups.length === 1
	&& seventeen.qa.groups[0].kind === "SELF" && seventeen.qa.groups[0].count <= 2 && seventeen.qa.goals.every(g => g.ok), kinds(seventeen).join(" | "));
expect("4db5d447: the flat back foot waited for its heel (fixed.slide.turns: 8-12 deg held)", seventeen.fixed.slide?.turns?.max > 8 && seventeen.fixed.slide.turns.max < 12, JSON.stringify(seventeen.fixed.slide));
// the elbow over the follow-through: it moved 22 cm at f43-44
const elbowStep = Math.max(...Array.from({ length: 12 }, (_, i) => dist(out.frames[38 + i].s.P[I.RightForeArm], out.frames[39 + i].s.P[I.RightForeArm])));
expect("4db5d447: the right elbow goes over to the follow-through in steps of at most 12 cm a frame (it jumped 22 cm at f43-44)", elbowStep < 0.12, elbowStep);
// the SELF left is the spec's: the left wrist sits on its anchor, low plus a world offset, right next to the right palm
const self = seventeen.qa.groups[0], anchorAt = f => add(out.frames[f].diag.props.batGrip.low, Q.SEVENTEEN_SPEC.anchors.batLow.offset);
const near = [...new Set([self.first, self.worstFrame, self.last])].map(f => [f, dist(out.frames[f].s.P[I.LeftHand], anchorAt(f)), dist(anchorAt(f), out.frames[f].diag.props.batGrip.origin)]);
const palmOff = Math.max(...Array.from({ length: 72 }, (_, f) => {
	const P = out.frames[f].s.P, b = objectBoxesAt(out, "empty", f)[0], ax = [b.R[0][1], b.R[1][1], b.R[2][1]], v = sub(scale(add(P[I.LeftHandIndex2], P[I.LeftHandMiddle2]), 0.5), b.pos);
	return len(sub(v, scale(ax, dot(v, ax))));
}));
console.log(`  SELF frames [f, wrist to anchor m, anchor to right palm m]: ${JSON.stringify(near.map(([f, a, b]) => [f, +a.toFixed(4), +b.toFixed(3)]))}; left palm up to ${(palmOff * 100).toFixed(1)} cm off the bat axis`);
expect("4db5d447: the SELF left is the spec's: the left wrist is on its anchor (low plus a world offset) and the anchor is 7-11 cm from the right palm there", near.every(([, a, b]) => a < 0.002 && b < 0.11), JSON.stringify(near));

// ---- 2. the QA-0 run stays clean, and needs no allow ------------------------------------------------------
const clean = compileSpec(Q.CLEAN_SPEC, { sk, scene: bat(Q.CLEAN_KIT_AT) }), bare = structuredClone(Q.CLEAN_SPEC);
delete bare.checks.allow;
const unallowed = compileSpec(bare, { sk, scene: bat(Q.CLEAN_KIT_AT) });
// WRIST (qa/wrist-checks.js): the follow-through's keys ask the right forearm 1 deg past its 85 deg twist for a frame or two
const onlyTwist = r => r.qa.groups.every(g => g.kind === "WRIST" && /^hand_r twist/.test(g.subject) && g.count <= 2);
expect("6262a69c: QA 0 but a frame or two of WRIST hand_r twist past 85 deg, and the same take, bit for bit", onlyTwist(clean) && hashOf(bakeTake(sk, clean.out)) === "8396660b457d69cc", kinds(clean).join(" | "));
expect("6262a69c without its checks.allow (hand_l x empty 5 cm) is QA 0 too (but that WRIST): the left palm is on the handle at f37-40 while the grip fades (weight 0.3-0.6)",
	onlyTwist(unallowed), kinds(unallowed).join(" | "));

// ---- 3. the plan of a path never jumps ------------------------------------------------------------------
// two valleys that swap at frame 12, a high ridge behind them (as the elbow's swivel limit): smoothPath jumps across the ridge
const valley = (t, c) => 10 * (1 - Math.cos(t - c)), ridge = t => 300 * Math.max(0, Math.abs(wrap(t)) - 2.2) ** 2;
const cost = (i, t) => Math.min(valley(t, -1.8) + (i < 12 ? 0 : 30), valley(t, 1.8) + (i < 12 ? 30 : 0)) + ridge(t);
const point = (i, t) => [0.15 * Math.cos(t), 0.15 * Math.sin(t), 0.02 * i], dir = (i, t) => [Math.cos(t), Math.sin(t), 0];
const x0 = Array.from({ length: 24 }, (_, i) => (i < 12 ? -1.8 : 1.8)), turn = x => Math.max(...x.slice(1).map((t, i) => Math.abs(wrap(t - x[i])) * 180 / Math.PI));
const jumped = smoothPath(cost, point, x0), steady = steadyPath(cost, point, x0, dir);
console.log(`  two valleys: smoothPath turns up to ${turn(jumped).toFixed(1)} deg a frame, steadyPath ${turn(steady).toFixed(1)}`);
expect("steadyPath: where smoothPath jumps 90 deg across a ridge, the path goes round in turns of 45 deg or less", turn(jumped) > 80 && turn(steady) <= 45);
const easy = (i, t) => 5 * (1 - Math.cos(t - 0.02 * i)), x1 = Array.from({ length: 24 }, (_, i) => 0.02 * i);
expect("steadyPath: a path that does not jump is smoothPath's, bit for bit", smoothPath(easy, point, x1).every((v, i) => Object.is(v, steadyPath(easy, point, x1, dir)[i])));

// ---- 4. a flat planted foot keeps its heading until its heel lifts ------------------------------------
const flatTurn = fix => compileSpec({ schema: "cozyclay.motion-spec.v1", fps: 24, frames: 48, ...(fix ? { fix } : {}), keys: [
	{ f: 0, set: { root: [0, 0.98, 0], yaw: 0, foot_l: [0.15, 0.105, 0], foot_r: [-0.15, 0.105, 0], fyaw_l: 0, fyaw_r: 0, fpitch_r: 0 } },
	{ f: 20, set: { fpitch_r: 0 } }, { f: 32, set: { fpitch_r: 30 } }, { f: 36, set: { fyaw_r: 40 } }] }, { sk, scene: { objects: {} } });
const heading = (r, f) => { const P = r.out.frames[f].s.P; return Math.atan2(P[I.RightToeBase][0] - P[I.RightFoot][0], P[I.RightToeBase][2] - P[I.RightFoot][2]) * 180 / Math.PI; };
const held = flatTurn(null), slid = flatTurn({ slide: false });
console.log(`  fyaw_r 0 -> 40 over f0-f36, heel up from f20: heading f19 ${heading(held, 19).toFixed(1)}, f47 ${heading(held, 47).toFixed(1)} deg; ${JSON.stringify(held.fixed.slide)}; fix.slide off: ${kinds(slid).filter(k => k.startsWith("SLIDE")).join(" | ")}`);
expect("a flat foot keyed to turn while flat: no SLIDE; it keeps its heading while flat (f0-f19) and reaches the keyed one once the heel is up",
	held.qa.ok && Math.abs(heading(held, 19) - heading(held, 0)) < 0.1 && Math.abs(heading(held, 47) - heading(slid, 47)) < 0.1 && held.fixed.slide?.turns?.frames > 0, kinds(held).join(" | "));
expect("with fix.slide off the same turn is a SLIDE (the foot turns flat)", slid.qa.groups.some(g => g.kind === "SLIDE" && g.subject.startsWith("Right")), kinds(slid).join(" | "));

// Flow (compiler/channels.js: the free spine, head and arms carry through keys and trail) re-baked the takes whose arms swing
// free (exitcar, walk, cup run3, the standing smokes, df6acdcc, 6262a69c); their QA did not change.
// ---- 5. take hashes: what lane Q1 changed and why -----------------------------------------------------------
const spec0 = { schema: "cozyclay.motion-spec.v1", fps: 24 }, STAND = [{ skill: "standIdle", f0: 0, args: { at: [0, 0], heading: 0 } }];
const j2keyed = structuredClone(J2.SWING_SPEC);
j2keyed.objects[J2.BAT].keys = J2.SWING_KEYS;
// [name, rig, spec, scene, hash before (v3@4087806b), hash after (null: the same), why]
// exitcar and walk also bake the idle layer of their holds (compiler/idle.js: a held pose breathes and shifts its weight).
// The walking takes (exitcar, walk, cup run3) re-baked with the narrower default foot width (walk.js halfWidth 0.08), the
// flat-ish heel strike (STRIKE_DF 4, no slant term) and less stride-time noise (gait-rhythm.js TIME.noise 0.02); their QA
// did not change (0 before and after).
const TAKES = [
// re-pinned when standIdle and walks began keying arm_hang (compiler/pose.js: a free forearm hangs plumb); QA unchanged
// re-pinned when the walk scaled its knees, swing kick, heel strike and hips at the strike with its pace and the swing foot
// began following the shank (walk.js, walk-pelvis.js); QA 0 before and after
// re-pinned when the walk's upper body began following its pace and leading the legs (walk.js, head-steady.js); QA 0 before and after
// re-pinned when the head began leading the walk's turns (head-lead.js); QA 0 before and after
	["exitcar", "x-bot-tpose", { fps: 24, ...EXITCAR_SPEC }, motionScene(CAR), "9e35eb6aa9a2c9f8", "6dfc89e506976346", "the walk's natural rhythm (compiler/gait-rhythm.js) and foot rockers and arms (compiler/walk.js), and the left hand's grip turn on the door handle (compiler/grip.js) and hips (compiler/walk-pelvis.js); then the smaller heel strike and the stride length term (walk.js, gait-rhythm.js); then the hips-first walk (walk-pelvis.js, walk.js); then the walk by pace (walk.js, walk-pelvis.js)"],
	["smoke squat cea7fa46", "y-bot-tpose", G.SQUAT_SPEC, motionScene(G.smokeScene()), "4b988f4b26056859", null],
	["walk", "y-bot-tpose", { ...spec0, frames: 160, use: [...STAND, { skill: "walkTo", f0: 1, args: { to: [0, 2.4], steps: 6, heading: 0 } }] }, { objects: {} }, "6a6295472b4a4781", "c71db8a3d52dc4d9", "the walk's natural rhythm (compiler/gait-rhythm.js) and foot rockers and arms (compiler/walk.js) and hips (compiler/walk-pelvis.js); then the smaller heel strike and the stride length term (walk.js, gait-rhythm.js); then the hips-first walk (walk-pelvis.js, walk.js); then the walk by pace (walk.js, walk-pelvis.js)"],
	["cup run3", "y-bot-tpose", RUN3_SPEC, motionScene(CUP_SCENE), "b2e90da88e394432", "95ba80251e30a32e", "the walk's natural rhythm (compiler/gait-rhythm.js) and foot rockers and arms (compiler/walk.js) and hips (compiler/walk-pelvis.js); then the smaller heel strike and the stride length term (walk.js, gait-rhythm.js); then the hips-first walk (walk-pelvis.js, walk.js); then the walk by pace (walk.js, walk-pelvis.js)"],
	["K8 6912547c", "y-bot-tpose", K8.EARLIER_SPEC, motionScene(K8.batKit(K8.EARLIER_KIT_AT)), "fc6f95586f8b1622", null],
	["N1 f0f2be59", "y-bot-tpose", N1.CLEAN_SPEC, motionScene(K8.batKit(N1.CLEAN_KIT_AT)), "e874f6556578614d", null],
	["J2 bat, no keys", "y-bot-tpose", J2.SWING_SPEC, motionScene(J2.SCENE_OBJECTS), "681b862de6399b43", "7e49b1630982dfc8", "the flat back foot turned 7.2 deg (turn.js)"],
	["J2 bat, keys", "y-bot-tpose", j2keyed, motionScene(J2.SCENE_OBJECTS), "c21fc53ff579e90f", "248dc5649b0c7499", "the same foot (turn.js)"],
	["K8 16d12ba9", "y-bot-tpose", K8.SWING_SPEC, motionScene(K8.batKit(K8.SWING_KIT_AT)), "35a73f309c9fe95f", "496cb796f592d8e8", "the left hand's roll priced past SELF on the right hand"],
	["N1 d5c110a7", "y-bot-tpose", N1.STANCE_SPEC, motionScene(K8.batKit(N1.STANCE_KIT_AT)), "38d773bb8b474f7a", "24f0828dfbfa9eb0", "the left hand's roll priced past BODY in the torso; then fix.retime on by default (QA 60 -> 56)"],
	["L2 9dcf19c5", "y-bot-tpose", G.SWING_SPEC, motionScene(G.batScene()), "ad773fd24b96b59b", "6c6926016a279376", "the flat front foot turned 18.5 deg (turn.js)"],
	["P2 df6acdcc", "y-bot-tpose", FOLD_SPEC, bat(FOLD_KIT_AT), "f3d9e1c7e86e7d08", "f912e5753d15fa42", "the left hand's roll priced past BODY"],
	["Q1 4db5d447", "y-bot-tpose", Q.SEVENTEEN_SPEC, bat(Q.SEVENTEEN_KIT_AT), "9521e2c61c85f8b1", "e1ad064ef842f30d", "all four"],
];
const wrong = [];
for (const [name, rig, spec, scene, h0, h1, why] of TAKES) {
	const isk = skeletonFor(rig), r = compileSpec(spec, { sk: isk, scene }), hash = hashOf(bakeTake(isk, r.out));
	console.log(`  ${name}: QA ${r.qa.total}, ${hash}${h1 ? ` (was ${h0}: ${why})` : ""}`);
	if (hash !== (h1 ?? h0)) wrong.push([name, hash]);
}
expect("the takes lane Q1 does not touch bake bit for bit as before; the others bake as listed", wrong.length === 0, JSON.stringify(wrong));

if (failures) { console.error(`${failures} motion3 bat-robust check(s) failed`); process.exit(1); }
console.log("motion3 bat robustness: all checks passed");
