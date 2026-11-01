#!/usr/bin/env node
// The agent loop helpers: every QA group carries a cause and a hint, applying a hint removes the
// issue, the auto-fixes (reach, slide, penetration, retime) report what they changed and leave
// QA clean, and the strict validator answers exact messages.
import { EXITCAR_SPEC, SCENE_OBJECTS } from "./fixtures/exitcar-scene.mjs";
import { compileSpec } from "../../src/motion3/pipeline.js";
import { motionScene } from "../../src/motion3/scene.js";
import { skeletonFor } from "../../src/motion3/rigs/index.js";
import { I3 } from "../../src/motion3/compiler/math.js";
import { createStudioAppActions } from "../../src/commands/index.js";
import { SCENE_OBJECTS as CUP_OBJECTS, CHARACTER as CUP_CHARACTER } from "./fixtures/cup-scene.mjs";
import { isPop } from "../../src/motion3/qa/style.js";
import { groundY } from "../../src/motion3/qa/ground.js";
import { repairSpec } from "../../src/motion3/repair.js";
import { fitOutput } from "../../src/motion3/report.js";

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
}
const sk = skeletonFor("x-bot-tpose"), I = sk.index, car = motionScene(SCENE_OBJECTS), empty = { objects: {} };
const compile = (spec, scene = car) => compileSpec(spec, { sk, scene });
const show = (label, r) => {
	console.log(`  ${label}: ${r.qa.total} issues, fixed ${JSON.stringify(r.fixed)}, ${JSON.stringify(r.ms)}`);
	for (const g of r.qa.groups.slice(0, 3)) console.log(`    [${g.count}] ${g.kind} ${g.subject} f${g.first}-${g.last}\n      cause: ${g.cause}\n      hint:  ${g.hint}`);
};
const broken = edit => { const s = structuredClone(EXITCAR_SPEC); edit(s); return s; };

// 1. Hints: a seat set 7 cm too low; the hint names keys[0] and says how far to raise the root.
const low = broken(s => { s.keys[0].set.root = [0.48, 0.85, -0.052]; });
let r = compile(low);
show("hips sunk into the seat", r);
const hit = r.qa.groups.find(g => g.kind === "COLLIDE" && g.subject === "hips x Car_Seat_Driver");
expect("every group has a cause and a hint", r.qa.groups.every(g => typeof g.cause === "string" && typeof g.hint === "string"), JSON.stringify(r.qa.groups.map(g => [g.kind, g.cause])));
expect("the seat hit is caused by keys[0] f0 root", hit?.cause === "keys[0] f0 root", hit?.cause);
const move = /^root: move \[([^\]]+)\] m at f(\d+)/.exec(hit?.hint ?? "");
expect("the hint is a world move of the root, upward", move && Number(move[1].split(",")[1]) > 0.02, hit?.hint);
const fixedLow = broken(s => { s.keys[0].set.root = [0.48, 0.85, -0.052].map((v, i) => v + Number(move[1].split(",")[i])); });
r = compile(fixedLow);
expect("applying the hint clears the seat collision", !r.qa.groups.some(g => g.kind === "COLLIDE" && /hips x Car_Seat_Driver/.test(g.subject)), JSON.stringify(r.qa.groups.map(g => g.subject)));

// 2. Hints: the cigarette appears 14 frames early, away from the pocket; the hint names the frame.
const early = broken(s => { const k = s.keys.find(kk => kk.step?.includes("cig_vis")), was = k.f; k.f -= 14; s.keys.find(kk => kk.set.cig_vis === 0 && kk.f === was - 1).f = k.f - 1; });
r = compile(early);
show("cigarette appears early", r);
const appear = r.qa.groups.find(g => g.kind === "APPEAR"), to = /move the step from f(\d+) to f(\d+)/.exec(appear?.hint ?? "");
expect("the APPEAR hint moves the step to a frame where the hand is at the pocket", Boolean(to), appear?.hint);
const moved = broken(s => { const k = s.keys.find(kk => kk.step?.includes("cig_vis")), was = k.f; k.f = Number(to[2]); s.keys.find(kk => kk.set.cig_vis === 0 && kk.f === was - 1).f = k.f - 1; });
expect("applying it clears the APPEAR issue", !compile(moved).qa.groups.some(g => g.kind === "APPEAR"));

// 3. Hints: elbow pole flipped up while smoking -> the chicken-wing check proposes a pole; a pole
//    interpolated through zero is named as such.
const wing = broken(s => { for (const k of s.keys) if (JSON.stringify(k.set.elbow_r) === "[0.4,-1,0.6]") k.set.elbow_r = [0.4, 1, 0.6]; });
r = compile(wing);
show("elbow pole up", r);
const below = r.qa.groups.find(g => g.kind === "BELOW"), flip = r.qa.groups.find(g => g.kind === "FLIP");
expect("BELOW: the hint keys an elbow_r pole pointing down", /^elbow_r: key \[[^\]]*-1[^\]]*\] \(body frame/.test(below?.hint ?? ""), below?.hint);
expect("FLIP: the pole passing through zero is the named cause", /passes near zero/.test(flip?.hint ?? ""), flip?.hint);

// 4. Hints: walk-generated keys point at the walk (change heading/turnDistance), not a key.
r = compile(broken(s => { s.generators[0].heading = [125, 80]; }));
const walkHit = r.qa.groups.find(g => g.kind === "COLLIDE" && /Car_Door_L/.test(g.subject));
expect("a walk into the open door names the walk step and suggests changing the walk", /generators\[0\] walk step \d/.test(walkHit?.cause ?? "") && /^walk path: /.test(walkHit?.hint ?? ""), `${walkHit?.cause} | ${walkHit?.hint}`);

// 5. Auto-fixes.
const stand = (extra = {}) => ({ schema: "cozyclay.motion-spec.v1", fps: 24, frames: 60, use: [{ skill: "standIdle", f0: 0, args: { at: [0, 0] } }], ...extra });
// reach: the hips keyed 4 cm up with the feet planted -> the legs miss; the fix lowers the hips, eased
const P = sk.restWorldPos, ank = P[I.LeftFoot][1], hipY = P[I.Hips][1] - 0.01;
const deep = fix => stand({ fix, keys: [{ f: 20, set: { root: [0, hipY, 0] } }, { f: 30, set: { root: [0, hipY + 0.04, 0] } }, { f: 40, set: { root: [0, hipY, 0] } }] });
const reachOff = compile(deep({ reach: false }), empty), reachOn = compile(deep(undefined), empty);
show("hips 4 cm too high, fix off", reachOff);
show("hips 4 cm too high, fix on", reachOn);
expect("reach fix off: QA reports REACH", reachOff.qa.groups.some(g => g.kind === "REACH"));
expect("reach fix on (default): hips lowered, reported, QA has no REACH", reachOn.fixed.reachLegs?.frames > 0 && !reachOn.qa.groups.some(g => g.kind === "REACH"), JSON.stringify(reachOn.fixed));
// slide: a planted foot creeping 6 mm -> locked
const creep = fix => stand({ fix, frames: 40, keys: [{ f: 5, set: { foot_l: [0.09, ank, -0.03] } }, { f: 35, set: { foot_l: [0.096, ank, -0.03] } }] });
const slideOff = compile(creep({ slide: false }), empty), slideOn = compile(creep(undefined), empty);
const drift = rr => Math.abs(rr.out.frames[35].s.P[I.LeftToeBase][0] - rr.out.frames[5].s.P[I.LeftToeBase][0]);
console.log(`  creeping foot: ball drifts ${(drift(slideOff) * 1000).toFixed(1)} mm without the lock, ${(drift(slideOn) * 1000).toFixed(2)} mm with it; fixed ${JSON.stringify(slideOn.fixed)}`);
expect("slide fix (default): the planted ball stays within 0.5 mm and the lock is reported", drift(slideOff) > 0.005 && drift(slideOn) < 5e-4 && slideOn.fixed.slide?.plants >= 1, JSON.stringify(slideOn.fixed));
// penetration: a held IK hand 1.5 cm into a board
const held = fix => stand({ fix, keys: [{ f: 0, set: { armw_r: 1, hand_r: [-0.22, 1.1, 0.32], elbow_r: [-0.5, -1, -0.3] } }, { f: 30, set: { hand_r: [-0.22, 1.1, 0.36] } }, { f: 59, set: { hand_r: [-0.22, 1.1, 0.32] } }] });
const free = compile(held(undefined), empty).out.frames[30].s.P, front = Math.max(free[I.RightHand][2], free[I.RightHandMiddle3][2]) + 0.022;
const board = { objects: { Board: { pos: [-0.2, 0, front - 0.015 + 0.05], R: I3(), half: [0.3, 0.8, 0.05] } } };
const penOff = compile(held(undefined), board), penOn = compile(held({ penetration: 0.02 }), board);
show("hand 1.5 cm into a board, fix off", penOff);
show("hand 1.5 cm into a board, penetration 0.02", penOn);
expect("penetration fix: the board hit is gone, pushes reported", penOff.qa.groups.some(g => g.kind === "COLLIDE") && penOn.qa.ok && penOn.fixed.penetration?.frames > 0, JSON.stringify(penOn.fixed));
// retime: a hand thrown 0.5 m in 4 frames. Smooth and fast is style (C13): retime stretches only
// what QA reports, here the speed and acceleration limits the spec opts into.
// the throw's hand is in front of the chest: its arm goes into it (BODY), the rest is retime's
const onlyBody = r => r.qa.groups.every(g => g.kind === "BODY");
// the throw tests retime alone: fix.self (elbows turned out of the body) would add its own motion to the arm
const throwHand = (fix, limits) => ({ ...stand({ fix: { ...fix, self: false }, frames: 120, ...(limits ? { checks: { limits } } : {}) }), keys: [{ f: 30, set: { armw_r: 0 } }, { f: 36, set: { armw_r: 1, hand_r: [-0.25, 1.1, 0.25] } }, { f: 50, set: { hand_r: [-0.25, 1.1, 0.25] } }, { f: 54, set: { hand_r: [0.1, 1.45, 0.3] } }, { f: 90, set: { hand_r: [0.1, 1.45, 0.3] } }] });
const everyday = { speedLimb: 0.16, accLimb: 0.05 };
// retime is on by default (deep research 4); the baseline opts out
const fastOff = compile(throwHand({ retime: false }, everyday), empty), fastOn = compile(throwHand(undefined, everyday), empty);
show("hand thrown, everyday limits, no retime", fastOff);
show("hand thrown, everyday limits, retime", fastOn);
expect("retime (default on): speed/acc issues gone, stretch reported; fix: { retime: false } keeps them", fastOff.qa.groups.some(g => g.kind === "ACC" || g.kind === "SPEED") && onlyBody(fastOn) && fastOn.fixed.retime?.maxStretch > 1, JSON.stringify(fastOn.fixed));
const fastFree = compile(throwHand({ retime: true }), empty);
expect("retime: without the opt-in a smooth fast throw is clean (but its arm in the chest, BODY) and keeps its speed", onlyBody(fastFree) && !fastFree.fixed.retime && fastFree.observations.peaks.RightHand.speed[0] > 3.8, JSON.stringify(fastFree.observations.peaks));
// the exitcar fixture itself stays clean with the default fixes on
r = compile(EXITCAR_SPEC);
expect("exitcar: QA 0 with the default fixes, and the fixes report their counts", r.qa.ok && typeof r.fixed === "object", JSON.stringify(r.qa.groups.slice(0, 2)));
console.log(`  exitcar default fixes: ${JSON.stringify(r.fixed)}; ${JSON.stringify(r.ms)}`);

// 5b. Style is measured, not judged (C13). A bat-like swing moves the wrist at ~9 m/s, smoothly.
const swing = ({ end, ...extra } = {}) => stand({ frames: 48, ...extra, keys: [{ f: 0, set: { aswing_r: -50, abend_r: 10 } }, { f: 20, set: { aswing_r: -50 } },
	{ f: end ?? 27, set: { aswing_r: 150 } }, { f: 47, set: { aswing_r: 150 } }] });
const fastSwing = compile(swing(), empty), wrist = fastSwing.observations?.peaks?.RightHand;
console.log(`  swing: ${fastSwing.qa.total} issues; observations ${JSON.stringify(fastSwing.observations)}`);
expect("fast smooth swing: qa.ok, observations show the wrist peak (~9 m/s) and its frame", fastSwing.qa.ok && wrist?.speed[0] > 8.5 && wrist.speed[0] < 10.5 && wrist.speed[1] >= 21 && wrist.speed[1] <= 31
	&& wrist.accel[0] > 50 && Number.isInteger(wrist.accel[1]), JSON.stringify(fastSwing.qa.groups.slice(0, 2)));
expect("observations: still joints are left out, knees and elbows report their deepest bend, balance its minimum",
	!("LeftFoot" in fastSwing.observations.peaks) && fastSwing.observations.bend.elbow_r.length === 2 && fastSwing.observations.balance.min[0] > 0, JSON.stringify(fastSwing.observations));
const optSpeed = compile(swing({ checks: { limits: { speedLimb: 0.16 } } }), empty);
expect("checks.limits.speedLimb opts back in: SPEED is an error again (and only SPEED)", !optSpeed.qa.ok && optSpeed.qa.groups.some(g => g.kind === "SPEED" && /RightHand/.test(g.subject))
	&& optSpeed.qa.groups.every(g => g.kind === "SPEED"), JSON.stringify(optSpeed.qa.groups.map(g => `${g.kind} ${g.subject}`)));
const stepped = compile(stand({ keys: [{ f: 0, set: { armw_r: 1, hand_r: [-0.25, 1.1, 0.25] } }, { f: 30, set: { hand_r: [-0.25, 1.1, 0.25] } }, { f: 31, step: ["hand_r"], set: { hand_r: [-0.2, 1.15, 0.3] } }] }), empty);
expect("an isolated pop (a hand that jumps 8.7 cm in one frame) is still an error", !stepped.qa.ok && stepped.qa.groups.some(g => g.kind === "POP" && /RightHand .* in one frame/.test(g.subject)), JSON.stringify(stepped.qa.groups.map(g => g.subject)));
// the detector: a spike (kink, step, glitch, jitter) against the frames around it, not a short hard burst
// (signed accelerations along x, m/frame^2: a step pushes then pulls back, a glitch pulls back on both sides)
const at = (list, f) => isPop({ a: Float64Array.from(list, Math.abs), A: list.map(x => [x, 0, 0]) }, f, 0.05);
expect("isPop: a kink, a step key (f and f+1), a one-frame glitch (f-1..f+1) and a jitter pop",
	at([0, 0, 0, 0, 0, 0.2, 0, 0, 0, 0], 5) && at([0, 0, 0, 0, 0, 0.2, -0.2, 0, 0, 0], 5) && at([0, 0, 0, 0, 0.1, -0.2, 0.1, 0, 0, 0], 5)
	&& at([0, 0, 0, 0.02, 0.09, -0.2, -0.12, 0.02, 0, 0], 5));
expect("isPop: a 4-frame smooth move, steady hard acceleration and anything under the floor do not",
	!at([0, 0, 0, 0.078, 0.094, 0, -0.094, -0.078, 0, 0], 4) && !at([0, 0, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1], 5) && !at([0, 0, 0, 0, 0, 0.04, 0, 0, 0, 0], 5));
expect("isPop: a 2- or 3-frame burst that pushes one way (a swing's launch, the hips turning round) does not, however hard",
	!at([0, 0, 0, 0, 0.3, 0.25, 0, 0, 0, 0], 4) && !at([0, 0, 0, 0, 0.12, 0.3, 0.2, 0, 0, 0], 5) && !at([0, 0, 0.03, 0.007, 0.044, 0.079, 0.041, 0.013, 0.013, 0], 5));
// search and repair cost only qa.groups: the fast end of a searched swing is not penalised, repair has nothing to do
const searched = compile(swing({ end: { range: [24, 30] } }), empty);
expect("search ignores observations: the midpoint swing is clean at once (cost 0, 1 eval)", searched.qa.ok && searched.search?.cost === 0 && searched.search.evals === 1, JSON.stringify(searched.search));
const repaired = repairSpec(swing(), { rounds: 4 }, s => compile(s, empty));
expect("repair ignores observations: a clean fast swing compiles once and is kept as sent", repaired.repair.rounds === 0 && repaired.repair.compiles === 1 && JSON.stringify(repaired.spec) === JSON.stringify(swing()), JSON.stringify(repaired.repair));
// a float: the root keyed 4 cm past the legs' reach lifts both feet for 7 frames, the hips do not fall
const float = compile(stand({ fix: { reach: false }, keys: [{ f: 20, set: { root: [0, sk.restWorldPos[I.Hips][1] - 0.01, 0] } }, { f: 30, set: { root: [0, sk.restWorldPos[I.Hips][1] + 0.03, 0] } }, { f: 40, set: { root: [0, sk.restWorldPos[I.Hips][1] - 0.01, 0] } }] }), empty);
expect("FLOAT: off the ground without falling is a hard error; the airborne frames are observed", float.qa.groups.some(g => g.kind === "FLOAT" && g.count >= 4 && g.hint) && float.observations.balance.air?.length >= 1
	&& !float.qa.groups.some(g => g.kind === "BALANCE"), JSON.stringify(float.qa.groups.map(g => `${g.kind} ${g.subject}`)));
// the ground is the floor or an object's top under the sole (qa/ground.js); session 68d305dc read a foot on a cube as FLOAT
const boxRec = (o = {}) => ({ id: "box", name: "Box", renderer: "cube", x: 0, y: 0, z: 0, rot: 0, rotX: 0, rotZ: 0, scaleX: 1.2, scaleY: 0.3, scaleZ: 1.2, footprint: { width: 1.2, depth: 1.2 }, height: 1, ...o });
const onBox = motionScene([boxRec()]), up = 0.3;
const feetAt = (dy, dl = [0, 0]) => ({ root: [0, hipY + dy, 0], foot_l: [P[I.LeftFoot][0] + dl[0], ank + dy, P[I.LeftFoot][2] + dl[1]], foot_r: [P[I.RightFoot][0], ank + dy, P[I.RightFoot][2]] });
const keyed = (keys, extra = {}) => ({ schema: "cozyclay.motion-spec.v1", fps: 24, frames: 60, keys, ...extra });
const standBox = compile(keyed([{ f: 0, set: feetAt(up) }, { f: 59, set: feetAt(up) }]), onBox);
expect("ground: feet on a 0.3 m box top stand on the ground (no FLOAT, no air), balance is measured on them, both feet planted",
	standBox.qa.ok && !standBox.observations.balance.air && standBox.observations.balance.min?.[0] > 0 && JSON.stringify(standBox.timeline[0].planted) === JSON.stringify({ l: [[0, 59]], r: [[0, 59]] }),
	JSON.stringify({ groups: standBox.qa.groups.map(g => g.subject), balance: standBox.observations.balance, planted: standBox.timeline[0].planted }));
const slideBox = compile(keyed([{ f: 0, set: feetAt(up) }, { f: 20, set: feetAt(up) }, { f: 40, set: feetAt(up, [0.04, 0]) }, { f: 59, set: feetAt(up, [0.04, 0]) }], { fix: { slide: false } }), onBox);
expect("ground: a planted foot sliding 4 cm on the box top is SLIDE", slideBox.qa.groups.some(g => g.kind === "SLIDE" && /^Left /.test(g.subject)) && !slideBox.qa.groups.some(g => g.kind === "FLOAT"),
	JSON.stringify(slideBox.qa.groups.map(g => `${g.kind} ${g.subject}`)));
const driftBox = compile(keyed([{ f: 0, set: feetAt(up) }, { f: 20, set: feetAt(up) }, { f: 40, set: feetAt(up, [0.005, 0]) }, { f: 59, set: feetAt(up, [0.005, 0]) }]), onBox);
expect("ground: fix.slide holds a 5 mm drift on the box top as on the floor (QA's planted definition)", driftBox.qa.ok && driftBox.fixed.slide?.plants === 1, JSON.stringify(driftBox.fixed));
const hoverBox = compile(keyed([{ f: 0, set: feetAt(up) }, { f: 20, set: feetAt(up) }, { f: 25, set: feetAt(up + 0.05) }, { f: 35, set: feetAt(up + 0.05) }, { f: 40, set: feetAt(up) }, { f: 59, set: feetAt(up) }]), onBox);
expect("ground: both feet held 5 cm over the box top without falling is still FLOAT", hoverBox.qa.groups.some(g => g.kind === "FLOAT" && g.count >= 6) && hoverBox.observations.balance.air?.length === 1,
	JSON.stringify(hoverBox.qa.groups.map(g => `${g.kind} ${g.subject}`)));
// groundY on turned boxes reads the box frame: a yawed square's corner, a tilted top, a table top above the point
const groundAt = (rec, p) => groundY({ objectsAt: () => motionScene([boxRec(rec)]).objects }, 0, p);
const near = (a, b) => Math.abs(a - b) < 1e-6;
expect("groundY: off the box is the floor; on it the top; a top more than 5 cm above the point is not ground (under a table)",
	near(groundAt({}, [2, 0.5, 0]), 0) && near(groundAt({}, [0.5, 0.4, 0.5]), 0.3) && near(groundAt({}, [0.5, 0.29, 0.5]), 0.3) && near(groundAt({}, [0, 0.2, 0]), 0));
expect("groundY: a box yawed 45 deg covers its rotated footprint, not its unturned one",
	near(groundAt({ rot: 45 }, [0.8, 0.4, 0]), 0.3) && near(groundAt({ rot: 45 }, [0.55, 0.4, 0.55]), 0));
expect("groundY: a box tilted 20 deg about z is as high as its sloped top under the point", near(groundAt({ rotZ: 20 }, [0, 0.5, 0]), 0.3 / Math.cos(20 * Math.PI / 180)),
	groundAt({ rotZ: 20 }, [0, 0.5, 0]));
// the output budget keeps observations whole, after qa, even when groups are cut
const crowded = fitOutput({ frames: 48, specId: "spec-000000000000", qa: { ok: false, total: 400, groups: Array.from({ length: 80 }, (_, i) => ({ kind: "COLLIDE", subject: `hand_r x box-${i}`, count: 5, severity: 5, first: 0, last: 4, worst: 0.02, hint: "x".repeat(200) })) },
	observations: fastSwing.observations, timeline: [] }, 6000);
expect("output budget: observations kept whole and right after qa when groups are cut", JSON.stringify(crowded.observations) === JSON.stringify(fastSwing.observations)
	&& Object.keys(crowded).indexOf("observations") === Object.keys(crowded).indexOf("qa") + 1 && crowded.more.groups > 0 && new TextEncoder().encode(JSON.stringify(crowded)).length <= 6000);

// 6. Strict validation, exact messages.
const reject = (edit, scene = car) => { try { compile(broken(edit), scene); return ""; } catch (error) { return error.message; } };
const msg = reject(s => {
	s.fps = 30; s.keys[3].set.fpitch_left = 10; s.keys[4].set.root = [1, 2]; s.keys[5].f = 800; s.keys[6].set.knee_l = [0, 0, -1]; s.keys[7].set.w_handel_l = 1;
	s.anchors.grip_l = { kind: "world", p: [0, 1, 0] }; s.generators[0].heading = [125]; s.keys[8].set.fpitch_r = 95;
});
console.log(msg.split("\n").map(l => `  | ${l}`).join("\n"));
for (const line of [
	"spec.fps must be 24, the timeline rate, got 30",
	"corrected: keys[3] (f32) channel \"fpitch_left\" -> \"fpitch_l\"",
	"keys[4] (f38) root must be [x, y, z] (3 finite numbers), got [1,2]",
	"keys[5].f = 800 is outside 0..729 (spec.frames 730); set frames >= 801 or frames: \"auto\"",
	"keys[6] (f54) knee_l = [0,0,-1] points backward; knees bend toward +z.",
	"keys[7] (f66) sets w_handel_l, but there is no anchor \"handel\"; did you mean \"w_handle_l\"?",
	"anchors.grip_l: an anchor name may not end in _l or _r",
	"generators[0].heading must be [h0, h1] in degrees (yaw 0 faces +Z and + turns toward +X), got [125]",
	"fpitch_r = 95 is outside -60..90 (toe-down pitch, deg: + lifts the heel (toes flat), - lifts the toes)",
]) expect(`validator: ${line.slice(0, 60)}`, msg.includes(line), msg);
expect("validator: a foot target at the floor names the ankle convention", reject(s => { s.keys[0].set.foot_l = [0.65, 0, 0.4]; }).includes("foot_l y = 0 puts the ankle into the floor; foot_* is the ANKLE target"));
expect("validator: checks.zzz is named, not a crash, with skills present", /checks\.zzz is not a check \(checks: /.test(reject(s => { s.use = [{ skill: "sitInSeat", f0: 0, args: { car: "Car" } }]; s.checks.zzz = 1; })));
expect("validator: a frame word in a check entry points at when", reject(s => { s.checks.contacts[0].frames = [0, 9]; }).includes('checks.contacts[0] has unknown field "frames"; did you mean "when"? (fields: name, point, target, tol, when)'));
expect("validator: an unknown skill arg lists the skill's args", reject(s => { s.use = [{ skill: "sitInSeat", f0: 0, args: { car: "Car", zzz: 1 } }]; }).includes("use[0].args.zzz is not an arg of sitInSeat (args: car, seat, seatBack, wheel, offset, floor)"));
expect("validator: an unknown skill gets a suggestion", /use\[0\]\.skill "exitCra" is not a skill; did you mean "exitCar"\?/.test(reject(s => { s.use = [{ skill: "exitCra", f0: 0 }]; })));

// 7. Frames past the end (G3). The run2 session: a pick-up compiled from frames: "auto" (195
//    frames), installed, then base + patch appended drink keys up to f296 and a goal at
//    [218, 250]. The store keeps the "auto" intent, so the patch re-resolves the length; the take
//    keeps the number. A numeric base answers the length that fits and frames: "auto".
const RUN2_SPEC = {"schema": "cozyclay.motion-spec.v1", "fps": 24, "frames": "auto", "label": "step to table and pick up cup", "use": [{"skill": "standIdle", "f0": 0, "args": {"at": [0, 0], "heading": 0}}, {"skill": "walkTo", "f0": 10, "args": {"to": [0, 0.4], "steps": 2, "firstStep": 0.3, "step": 0.3, "heading": [0, 0]}}], "anchors": {"handle": {"kind": "world", "p": [0.268, 0.8, 0.85]}, "lift": {"kind": "world", "p": [0.24, 1.1, 0.66]}}, "props": {"handleGrip": {"hand": "l", "origin": ["LeftHandIndex2", "LeftHandMiddle2"], "points": {"fingers": [0, 0, 0]}}}, "fits": [{"side": "l", "anchor": "handle", "effector": {"prop": "handleGrip", "point": "fingers"}}, {"side": "l", "anchor": "lift", "effector": {"prop": "handleGrip", "point": "fingers"}}], "objects": {"empty-2": {"prop": "handleGrip", "grab": 122}}, "fix": {"penetration": 0.02}, "keys": [{"f": 86, "set": {"armw_l": 0, "w_handle_l": 0, "w_lift_l": 0, "pitch": 0, "spine_pitch": 0, "head_pitch": 0, "fingers_l": {"grip": 0}, "elbow_l": [1, -1, -0.3], "aswing_r": 0}}, {"f": 116, "set": {"armw_l": 1, "w_handle_l": 1, "pitch": 20, "spine_pitch": 35, "head_pitch": 15, "fingers_l": {"grip": 0.3}, "aswing_r": 35}}, {"f": 122, "set": {"w_handle_l": 1, "w_lift_l": 0, "pitch": 20, "spine_pitch": 35, "fingers_l": {"grip": 1}}}, {"f": 170, "set": {"w_handle_l": 0, "w_lift_l": 1, "pitch": 0, "spine_pitch": 4, "head_pitch": 12, "aswing_r": 0}}, {"f": 194, "set": {"w_lift_l": 1}}], "goals": [{"name": "fingers on the cup handle", "near": ["prop:handleGrip.fingers", "anchor:handle"], "tol": 0.05, "at": [116, 122]}, {"name": "cup lifted off the table", "moved": "object:empty-2", "by": 0.2, "at": [170, 194]}, {"name": "cup held above table", "above": ["object:empty-2.base", "object:cube.top"], "by": 0.15, "at": [170, 194]}]};
const RUN2_PATCH = [{"op": "replace", "path": "/label", "value": "pick up cup and drink coffee"}, {"op": "add", "path": "/anchors/sip", "value": {"kind": "landmark", "name": "mouth"}}, {"op": "add", "path": "/fits/-", "value": {"side": "l", "anchor": "sip", "effector": {"prop": "handleGrip", "point": "fingers"}, "offset": [0.07, -0.06, 0.06]}}, {"op": "add", "path": "/keys/0/set/w_sip_l", "value": 0}, {"op": "replace", "path": "/keys/4", "value": {"f": 182, "set": {"w_lift_l": 1, "w_sip_l": 0, "head_pitch": 12}}}, {"op": "add", "path": "/keys/-", "value": {"f": 208, "set": {"w_lift_l": 0, "w_sip_l": 1, "head_pitch": 0, "spine_pitch": 0}}}, {"op": "add", "path": "/keys/-", "value": {"f": 218, "set": {"head_pitch": -15, "spine_pitch": -4}}}, {"op": "add", "path": "/keys/-", "value": {"f": 250, "set": {"w_sip_l": 1, "head_pitch": -15, "spine_pitch": -4}}}, {"op": "add", "path": "/keys/-", "value": {"f": 276, "set": {"w_sip_l": 0, "w_lift_l": 1, "head_pitch": 10, "spine_pitch": 4}}}, {"op": "add", "path": "/keys/-", "value": {"f": 296, "set": {"w_lift_l": 1}}}, {"op": "add", "path": "/goals/-", "value": {"name": "cup at the mouth", "near": ["object:empty-2.top", "landmark:mouth"], "tol": 0.08, "at": [218, 250]}}];
const takes = new Map(), owner = { replace: (id, take) => takes.set(id, take), motionFor: id => takes.get(id) ?? null };
const registry = createStudioAppActions({ state: () => ({ characters: [CUP_CHARACTER], objects: CUP_OBJECTS, frameCount: 300 }), storeDomain: n => (n === "motion" ? owner : null) });
const act = (id, args) => { const out = registry.run(id, args); return out?.output ?? out; };
const refused = run => { try { run(); return ""; } catch (error) { return error.message; } };
const pickUp = act("motion.compile", { characterId: CUP_CHARACTER.id, spec: RUN2_SPEC, install: false });
const installedPickUp = act("motion.compile", { characterId: CUP_CHARACTER.id, base: pickUp.specId, install: true, repair: false });
expect("frames auto: the pick-up resolves to 195 frames, and the installed take keeps the number", pickUp.frames === 195 && installedPickUp.specId === pickUp.specId
	&& takes.get(CUP_CHARACTER.id)?.spec?.frames === 195, JSON.stringify({ frames: pickUp.frames, take: takes.get(CUP_CHARACTER.id)?.spec?.frames }));
let drink = null;
const appendRefusal = refused(() => { drink = act("motion.compile", { characterId: CUP_CHARACTER.id, base: installedPickUp.specId, patch: RUN2_PATCH, install: false }); });
expect("frames auto: base + patch appending keys to f296 re-resolves to 297 frames", appendRefusal === "" && drink?.frames === 297 && drink.specId !== pickUp.specId && drink.delta?.base === pickUp.specId,
	appendRefusal || JSON.stringify({ frames: drink?.frames }));
const numeric = act("motion.compile", { characterId: CUP_CHARACTER.id, spec: { ...RUN2_SPEC, frames: 196 }, install: false });
const pastEnd = refused(() => act("motion.compile", { characterId: CUP_CHARACTER.id, base: numeric.specId, patch: RUN2_PATCH, install: false }));
for (const line of [
	"keys[5].f = 208 is outside 0..195 (spec.frames 196); set frames >= 297 or frames: \"auto\"",
	"keys[9].f = 296 is outside 0..195 (spec.frames 196); set frames >= 297 or frames: \"auto\"",
	"goals[3].at = [218,250] is outside 0..195 (spec.frames 196); set frames >= 297 or frames: \"auto\"",
]) expect(`frames number: ${line.slice(0, 40)}`, pastEnd.split("\n").includes(line), pastEnd);
const autoAgain = refused(() => act("motion.compile", { characterId: CUP_CHARACTER.id, base: numeric.specId, patch: [{ op: "replace", path: "/frames", value: "auto" }, ...RUN2_PATCH], install: false }));
expect("frames number: following the advice (frames: \"auto\") compiles", autoAgain === "", autoAgain);
// a goal wholly past the last key: "auto" counts keys, not goals, so the advice is the number alone
// (a window that only runs past the end is cut to it, C19)
const lateGoal = reject(s => { s.goals = [{ name: "late", near: ["joint:LeftHand", "joint:RightHand"], at: [740, 760] }]; });
expect("frames: a goal past the end that \"auto\" would not cover gets the number alone",
	lateGoal.replace(/^MOTION_SPEC_INVALID: /, "").split("\n").includes("goals[0].at = [740,760] is outside 0..729 (spec.frames 730); set frames >= 761"), lateGoal);
const overview = refused(() => act("motion.describe", { topic: "overview" }));
expect("describe: an unknown topic names the allowed ones", overview === "$.args.topic: \"overview\" is not one of: essentials, spec, skills, anchors, props, objects, checks, goals, probes, channels, refs, fix, examples, fill.", overview);

if (failures) { console.error(`${failures} motion3 agent-loop check(s) failed`); process.exit(1); }
console.log("motion3 agent loop: all checks passed");
