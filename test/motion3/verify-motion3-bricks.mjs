#!/usr/bin/env node
// The MotionBricks converters (src/motion3/bricks) on synthetic poses: forward (SOMA joints -> spec channels) reads a hand-built
// skeleton's heading, root, targets and poles exactly; reverse (compiled X Bot frame -> SOMA pose) puts SOMA's wrists, ankles
// and hip sockets on the X Bot's and keeps every rotation proper, and the round trip gives back the keyed channels.
import { readFileSync } from "node:fs";
import { compileSpec } from "../../src/motion3/pipeline.js";
import { motionScene } from "../../src/motion3/scene.js";
import { skeletonFor } from "../../src/motion3/rigs/index.js";
import { apply, ry, add, mul, T } from "../../src/motion3/compiler/math.js";
import { frameChannels, XBOT_HIPMID } from "../../src/motion3/bricks/forward.js";
import { somaPose } from "../../src/motion3/bricks/reverse.js";
import { SOMA_JOINTS, SID, toSomaPoint, toCozyPoint } from "../../src/motion3/bricks/soma.js";
import { fillSource } from "../../src/commands/motion3-fill.js";
import { placementRows, samplePlacement, placementTrackKey } from "../../src/motion/placement-keys.js";
import { authoredFrames } from "../../src/motion3/bricks/authored-keys.js";
import { gapCheck, pinHands } from "../../src/motion3/bricks/fill.js";
import { spanReason } from "../../src/motion3/bricks/fill-spans.js";
import { densityNotes } from "../../src/motion3/bricks/fill-density.js";

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
}
const near = (a, b, tol) => (Array.isArray(a) ? a.every((v, i) => Math.abs(v - b[i]) <= tol) : Math.abs(a - b) <= tol);
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// 1. Forward: a straight standing figure (CozyClay space, facing +Z, left +X), knees bent slightly forward, elbows back,
// feet pointing along the body then turned 30 deg about Y and moved. Toes sit along the planted SOMA foot's angles.
const FLAT_PITCH = 20.8, TOE_OUT = 16.8, rad = d => d * Math.PI / 180;
const toe = (side, ankle) => { const yaw = rad(side * TOE_OUT), l = 0.14, p = rad(FLAT_PITCH); return add(ankle, [Math.sin(yaw) * l * Math.cos(p), -l * Math.sin(p), Math.cos(yaw) * l * Math.cos(p)]); };
const local = {
	Hips: [0, 1.0, 0], Spine1: [0, 1.05, 0], Spine2: [0, 1.12, 0], Chest: [0, 1.2, 0], Neck1: [0, 1.46, 0], Neck2: [0, 1.54, 0], Head: [0, 1.6, 0],
	Jaw: [0, 1.6, 0.03], LeftEye: [0.031, 1.6445, 0.0815], RightEye: [-0.031, 1.6445, 0.0815],
	LeftShoulder: [0.02, 1.43, 0], LeftArm: [0.17, 1.43, 0], LeftForeArm: [0.2, 1.15, -0.05], LeftHand: [0.22, 0.88, 0], LeftHandThumbEnd: [0.22, 0.8, 0.03], LeftHandMiddleEnd: [0.22, 0.75, 0],
	RightShoulder: [-0.02, 1.43, 0], RightArm: [-0.17, 1.43, 0], RightForeArm: [-0.2, 1.15, -0.05], RightHand: [-0.22, 0.88, 0], RightHandThumbEnd: [-0.22, 0.8, 0.03], RightHandMiddleEnd: [-0.22, 0.75, 0],
	LeftLeg: [0.09, 0.9325, -0.016], LeftShin: [0.09, 0.51, 0.03], LeftFoot: [0.09, 0.087, 0], RightLeg: [-0.09, 0.9325, -0.016], RightShin: [-0.09, 0.51, 0.03], RightFoot: [-0.09, 0.087, 0],
};
local.LeftToeBase = toe(1, local.LeftFoot);
local.RightToeBase = toe(-1, local.RightFoot);
const Y = ry(30), move = [0.4, 0, -0.2], place = p => add(apply(Y, p), move);
const P = SOMA_JOINTS.map(n => place(local[n]));
const ch = frameChannels(P);
expect("forward: heading, pitch and roll of the pelvis", near([ch.yaw, ch.pitch, ch.roll], [30, 0, 0], 1e-6), JSON.stringify([ch.yaw, ch.pitch, ch.roll]));
expect("forward: root puts the X Bot hip sockets on SOMA's", near(ch.root, place(add([0, 0.9325, -0.016], XBOT_HIPMID.map(v => -v))), 1e-9), JSON.stringify(ch.root));
expect("forward: a straight spine and head key 0", near([ch.spine_yaw, ch.spine_pitch, ch.spine_roll, ch.head_yaw, ch.head_pitch, ch.head_roll], [0, 0, 0, 0, 0, 0], 1e-6),
	JSON.stringify([ch.spine_yaw, ch.spine_pitch, ch.spine_roll, ch.head_yaw, ch.head_pitch, ch.head_roll]));
expect("forward: ankle and wrist targets are the joints", near(ch.foot_l, P[SID.LeftFoot], 1e-12) && near(ch.hand_r, P[SID.RightHand], 1e-12));
expect("forward: knee poles point forward in the body frame", ch.knee_l[2] > 0.9 && ch.knee_r[2] > 0.9, JSON.stringify([ch.knee_l, ch.knee_r]));
expect("forward: elbow poles point back in the body frame", ch.elbow_l[2] < -0.9 && ch.elbow_r[2] < -0.9, JSON.stringify([ch.elbow_l, ch.elbow_r]));
expect("forward: a flat foot along the body keys fpitch 0 and fyaw = yaw", near([ch.fpitch_l, ch.fpitch_r, ch.fyaw_l, ch.fyaw_r], [0, 0, 30, 30], 0.1),
	JSON.stringify([ch.fpitch_l, ch.fpitch_r, ch.fyaw_l, ch.fyaw_r]));

// 2. Reverse: one compiled X Bot frame (standing, turned 30 deg, hands on IK) as a SOMA pose.
const sk = skeletonFor("x-bot-tpose");
const set = {
	root: [0.4, 1.0, -0.2], yaw: 30, pitch: 5, roll: 0, spine_pitch: 10, head_pitch: -5,
	foot_l: place([0.1, 0.087, 0.05]), foot_r: place([-0.1, 0.087, -0.03]), fyaw_l: 30, fyaw_r: 30, fpitch_l: 0, fpitch_r: 0,
	knee_l: [0.1, 0, 1], knee_r: [-0.1, 0, 1], armw_l: 1, armw_r: 1,
	hand_l: place([0.25, 0.95, 0.12]), hand_r: place([-0.25, 0.9, 0.05]), elbow_l: [0.3, -0.2, -0.9], elbow_r: [-0.3, -0.2, -0.9],
};
const r = compileSpec({ schema: "cozyclay.motion-spec.v1", frames: 1, flow: false, keys: [{ f: 0, set }] }, { sk, scene: motionScene([]) });
const s = r.out.frames[0].s, soma = somaPose(sk, s), X = n => toSomaPoint(s.P[sk.index[n]]);
for (const [a, b] of [["LeftHand", "LeftHand"], ["RightHand", "RightHand"], ["LeftFoot", "LeftFoot"], ["RightFoot", "RightFoot"]])
	expect(`reverse: SOMA ${a} lands on the X Bot's`, dist(soma.P[SID[a]], X(b)) < 1e-3, `${(dist(soma.P[SID[a]], X(b)) * 100).toFixed(2)} cm`);
const hipmid = P => P[SID.LeftLeg].map((v, i) => (v + P[SID.RightLeg][i]) / 2);
expect("reverse: hip-socket midpoint matches", dist(hipmid(soma.P), X("LeftUpLeg").map((v, i) => (v + X("RightUpLeg")[i]) / 2)) < 1e-9);
const proper = soma.R.every(R => { const D = mul(T(R), R); return near(D.flat(), [1, 0, 0, 0, 1, 0, 0, 0, 1], 1e-9) && near(R[0][0] * (R[1][1] * R[2][2] - R[1][2] * R[2][1]) - R[0][1] * (R[1][0] * R[2][2] - R[1][2] * R[2][0]) + R[0][2] * (R[1][0] * R[2][1] - R[1][1] * R[2][0]), 1, 1e-9); });
expect("reverse: every rotation is proper and orthonormal", proper);
const back = frameChannels(soma.P.map(toCozyPoint));
expect("round trip: root, yaw and pitch come back", dist(back.root, set.root) < 0.01 && near(back.yaw, 30, 2) && near(back.pitch, 5, 3),
	JSON.stringify([back.root, back.yaw, back.pitch]));
expect("round trip: ankle and wrist targets come back within 1 cm", ["foot_l", "foot_r", "hand_l", "hand_r"].every(k => dist(back[k], set[k]) < 0.01),
	JSON.stringify(["foot_l", "foot_r", "hand_l", "hand_r"].map(k => (dist(back[k], set[k]) * 100).toFixed(2))));
expect("round trip: feet stay flat and straight within 5 deg", near([back.fpitch_l, back.fpitch_r, back.fyaw_l, back.fyaw_r], [0, 0, 30, 30], 5),
	JSON.stringify([back.fpitch_l, back.fpitch_r, back.fyaw_l, back.fyaw_r]));

// 3. motion.fill arguments: exactly one of spec or base, a known base (or the installed take's), 2+ authored key poses.
const refused = (run, code, words) => { try { run(); return false; } catch (error) { return error.code === code && words.test(error.message); } };
const two = { keys: [{ f: 0, set: {} }, { f: 20, set: {} }, { f: 9, set: {}, src: "fill" }] };
const none = () => undefined;
expect("fill args: spec and base together are refused", refused(() => fillSource({ spec: two, base: "spec-000000000000" }, none), "INVALID_ARGUMENT", /exactly one of spec or base/));
expect("fill args: neither is refused", refused(() => fillSource({}, none), "INVALID_ARGUMENT", /exactly one of spec or base/));
expect("fill args: an unknown base is refused", refused(() => fillSource({ base: "spec-0123456789ab" }, none), "INVALID_ARGUMENT", /not known/));
expect("fill args: one authored pose is refused (fill keys do not count)", refused(() => fillSource({ spec: { keys: [{ f: 0, set: {} }, { f: 5, set: {}, src: "fill" }] } }, none), "INVALID_ARGUMENT", /at least 2 authored key poses/));
const copy = fillSource({ spec: two }, none);
expect("fill args: a spec is taken as a copy", copy !== two && copy.keys.length === 3);
expect("fill args: base reads the spec store", fillSource({ base: "spec-0123456789ab" }, b => (b === "spec-0123456789ab" ? two : undefined)).keys.length === 3);

// 4. Pose-mode keys: placement interpolates (straight line, short way round), long gaps get middles, the fill policy guards.
const rows = placementRows([{ frame: 0, tracks: { placement: placementTrackKey({ x: 0, z: 0, rot: 170 }) } }, { frame: 100, tracks: { placement: placementTrackKey({ x: 3, z: -1, rot: -170 }), hips: { q: [{ x: 0, y: 0, z: 0, w: 1 }] } } }]);
const mid = samplePlacement(rows, 50);
expect("placement: mid frame is halfway, yaw turns the short way (170 -> -170 through 180)", near([mid.x, mid.z], [1.5, -0.5], 1e-9) && near(Math.abs(mid.rot), 180, 1e-9), JSON.stringify(mid));
expect("placement: holds before the first and after the last key", near(samplePlacement(rows, -5).x, 0, 0) && near(samplePlacement(rows, 400).x, 3, 0));
expect("placement: no keys, no placement", samplePlacement([], 10) === null);
expect("long gaps get middle poses until each fits 46 frames", JSON.stringify(authoredFrames([0, 100])) === "[0,25,50,75,100]" && JSON.stringify(authoredFrames([0, 40])) === "[0,40]", JSON.stringify(authoredFrames([0, 100])));
const bake = (a, b) => ({ root: { 0: a, 24: b }, pitch: { 24: 0 }, foot_l: { 0: [0, 0.087, 0], 24: [0, 0.087, 0] }, foot_r: { 0: [0, 0.087, 0], 24: [0, 0.087, 0] } });
expect("fill policy: 1 m in 24 frames is fine", gapCheck(bake([0, 1, 0], [0, 1, 1]), 0, 24).far === null);
expect("fill policy: 3 m in 24 frames is FILL_GAP_TOO_FAR", /^FILL_GAP_TOO_FAR: f0-f24 travels 3.00 m in 1.00 s/.test(gapCheck(bake([0, 1, 0], [0, 1, 3]), 0, 24).far ?? ""));
expect("fill policy: sitting 0.45 m lower warns", gapCheck(bake([0, 1, 0], [0, 0.55, 0.2]), 0, 24).warnings.length === 1);

// 5. Fill spans (parkour bench-2): a foot "still" goal over the recovery and one stride foot up are free motion, not a plant
const stand = (f, l = 0.087, r = 0.087) => ({ f, set: { foot_l: [0.1, l, 0], foot_r: [-0.1, r, 0] } });
const flat = { foot_l: Array(100).fill([0.1, 0.087, 0]), foot_r: Array(100).fill([-0.1, 0.087, 0]) };
const recovery = { frames: 100, goals: [{ name: "feet still", still: "joint:LeftFoot", at: [60, 96] }] };
expect("spans: a foot goal over the recovery does not block the fill", spanReason(recovery, [stand(60), stand(72)], flat, 60, 72) === null);
expect("spans: one stride foot 0.2 m up at an end key is not airborne", spanReason({ frames: 100 }, [stand(0), stand(12, 0.22, 0.087)], flat, 0, 12) === null);
expect("spans: a jump runs through the model (no airborne skip; Entry/Apex/Exit keys instead)", spanReason({ frames: 100 }, [stand(0), stand(12, 0.3, 0.3)], flat, 0, 12) === null);
expect("spans: a hand plant runs through the model (pinned after), only a clearance check skips", spanReason({ frames: 100, goals: [{ near: ["joint:LeftHand", "object:wall"], at: [18, 30] }] }, [stand(18), stand(30)], flat, 18, 30) === null
	&& spanReason({ frames: 100, checks: { clearance: [{ part: "hips", object: "wall", min: 0.05, frames: [20, 26] }] } }, [stand(18), stand(30)], flat, 18, 30) === "check_span");
expect("spans: a clearance check over the whole take (no frames, or over half of it) is a guard, not a span",
	spanReason({ frames: 100, checks: { clearance: [{ part: "hips", object: "wall", min: 0.05 }] } }, [stand(18), stand(30)], flat, 18, 30) === null
	&& spanReason({ frames: 100, checks: { clearance: [{ part: "hips", object: "wall", min: 0.05, frames: [0, 99] }] } }, [stand(18), stand(30)], flat, 18, 30) === null);
// the hand pin (upstream's IK pin): a planted end eases the hand onto the anchor over the second half; planted at both ends it holds
{
	const frames = Array.from({ length: 31 }, (_, f) => ({ s: { P: Object.assign([], { [sk.index.LeftHand]: f === 30 ? [0.3, 1.0, 1.2] : [0.2, 0.9, 0.5], [sk.index.RightHand]: [-0.2, 0.9, 0.5] }) } }));
	const dense = Array.from({ length: 31 }, () => ({ hand_l: [0, 0.8, 0], hand_r: [0, 0.8, 0] }));
	pinHands(dense, 0, 30, [{ f: 0, set: {} }, { f: 30, set: { w_plant_l: 1 } }], frames, sk);
	const at = i => dense[i].hand_l, end = [0.3, 1.0, 1.2];
	expect("pin: the hand is exactly on the anchor at the planted end key", JSON.stringify(at(30)) === JSON.stringify(end), JSON.stringify(at(30)));
	expect("pin: the first half of the gap is the model's, then a smoothstep ramp", JSON.stringify(at(10)) === JSON.stringify([0, 0.8, 0]) && Math.abs(at(23)[2] - 1.2 * (() => { const t = (23 / 30 - 0.5) / 0.5; return t * t * (3 - 2 * t); })()) < 1e-9, JSON.stringify([at(10), at(23)]));
	expect("pin: the other hand is untouched", JSON.stringify(dense[30].hand_r) === JSON.stringify([0, 0.8, 0]));
	const both = Array.from({ length: 31 }, () => ({ hand_l: [0, 0.8, 0] }));
	pinHands(both, 0, 30, [{ f: 0, set: { w_plant_l: 1 } }, { f: 30, set: { w_plant_l: 1 } }], frames, sk);
	expect("pin: planted at both ends, the hand holds the anchor spot for the whole gap", both.every(r => JSON.stringify(r.hand_l) === JSON.stringify(end)));
}

// the bench-2 r2 vault spec (an agent's own parkour take): run-up and recovery fill, the plant and the flight (f28-f48) do not
{
	const vault = JSON.parse(readFileSync(new URL("./fixtures/parkour-vault-spec.json", import.meta.url), "utf8"));
	const own = vault.keys.filter(k => !k.src), at = [...new Set(own.map(k => k.f))].sort((a, b) => a - b);
	const baked = compileSpec(vault, { sk, scene: motionScene([]) }).out.baked;
	const reasons = at.slice(1).map((f, i) => [at[i], f, spanReason(vault, own, baked, at[i], f)]);
	const wrong = reasons.filter(([, , why]) => why !== null);
	expect("vault spec: every gap goes to the model now (no clearance check in it); the plant is pinned, the jump keyed", wrong.length === 0, JSON.stringify(reasons));
}

// density thresholds: free keys closer than 19 frames get KEYS_TOO_DENSE (the fill's safe gap), 20 apart do not
{
	const free = Array(40).fill("free"), keysAt = (...fs) => fs.map(f => ({ f, set: {} }));
	expect("density: free keys 10 frames apart are KEYS_TOO_DENSE", /^KEYS_TOO_DENSE .*keys\[0\] f0 and keys\[1\] f10/.test(densityNotes(keysAt(0, 10), free, [], {})[0] ?? ""));
	expect("density: free keys 16 apart are KEYS_TOO_DENSE, 20 apart are fine", densityNotes(keysAt(0, 16), free, [], {}).length === 1 && densityNotes(keysAt(0, 20), free, [], {}).length === 0);
}

// stop rule: noImprovementRounds counts compiles in a row that did not beat the best QA; a new spec starts over
{
	const { createRoundWatch } = await import("../../src/commands/motion3-rounds.js");
	const watch = createRoundWatch(), qa = problems => ({ problems });
	const seq = [watch("c", qa(10), true), watch("c", qa(8), false), watch("c", qa(9), false), watch("c", qa(8), false), watch("c", qa(5), false), watch("c", qa(7), true)];
	expect("rounds: 0 on the first and on every improvement, +1 per flat or worse round, reset by a new spec", JSON.stringify(seq) === "[0,0,1,2,0,0]", JSON.stringify(seq));
}

// CONTACT_UNKEYED only while a hand or foot moves (> 2 cm) in a contact gap over 8 frames; a still or anchored hand needs two keys
{
	const contact = Array(40).fill("contact"), keysAt = (...fs) => fs.map(f => ({ f, set: {} }));
	const still = { hand_l: Array.from({ length: 40 }, () => [0.2, 1, 0.5]), hand_r: Array.from({ length: 40 }, () => [-0.2, 1, 0.5]) };
	const moving = { ...still, hand_r: Array.from({ length: 40 }, (_, f) => [-0.2, 1, 0.5 + f * 0.01]) };
	const anchored = { ...moving, w_bar_r: Array(40).fill(1) };
	const unkeyed = (baked, gap) => densityNotes(keysAt(0, gap), contact, [], baked).filter(n => n.startsWith("CONTACT_UNKEYED")).length;
	expect("density: a held hand is keyed again every 8-12 frames (12 ok, 30 not); a moving one every 8 (10 not); one on an anchor counts as held",
		unkeyed(still, 12) === 0 && unkeyed(still, 30) === 1 && unkeyed(moving, 10) === 1 && unkeyed(anchored, 12) === 0 && unkeyed(anchored, 30) === 1,
		JSON.stringify([unkeyed(still, 12), unkeyed(still, 30), unkeyed(moving, 10), unkeyed(anchored, 12), unkeyed(anchored, 30)]));
}

// HAND_COORDS_FREE: hand_l/r coordinates on free-motion keys with the arm on IK, one note naming them; a contact, or an FK arm, is not flagged
{
	const kind = [...Array(20).fill("free"), ...Array(20).fill("contact")], ik = { armw_r: Array(40).fill(1), armw_l: Array(40).fill(0) };
	const keys = [{ f: 0, set: { hand_r: [-0.2, 1, 0.4] } }, { f: 10, set: { hand_l: [0.2, 1, 0.4] } }, { f: 24, set: { root: [0, 0.9, 0] } }, { f: 30, set: { hand_r: [-0.2, 1, 0.4] } }, { f: 39, set: { root: [0, 0.9, 0] } }];
	const free = densityNotes(keys, kind, [], ik).filter(n => n.startsWith("HAND_COORDS_FREE"));
	expect("density: HAND_COORDS_FREE names the free IK hand key only (not the FK arm's, not the one in a contact)", free.length === 1 && /^HAND_COORDS_FREE keys\[0\] f0: hand coordinates in free motion; prefer FK/.test(free[0]), JSON.stringify(free));
}

// fix.retime is on by default (deep research 4: POP -1.58 frames) and kept only when QA is no worse; fix: { retime: false } opts out
{
	const { fixOptions } = await import("../../src/motion3/fix/index.js");
	expect("fix: retime on by default, off with retime: false or fix: false", fixOptions(undefined).retime === true && fixOptions({}).retime === true && fixOptions({ retime: false }).retime === false && fixOptions(false).retime === false);
}

if (failures) { console.error(`${failures} failed`); process.exit(1); }
console.log("all passed");
