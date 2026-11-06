// One frame of the body: channel values -> world-space bone state.
// Conventions (CozyClay): metres, +Y up, yaw 0 faces +Z, positive yaw turns toward +X,
// the character's left is +X at yaw 0. Body-frame vectors (poles, body-local targets) are
// rotated by the root yaw only.
import { add, sub, scale, norm, len, apply, mul, rx, ry, rz } from "./math.js";
import { restState, rotateSubtree } from "./skeleton.js";
import { twoBone, orientFoot, wrist, fingers, limitFold, askedFold, swivelElbow, ELBOW_FOLD, KNEE_FOLD } from "./limbs.js";
import { holdHand } from "./hold.js";
import { closeOnShape } from "./finger-close.js";
import { clampWrist } from "./wrist-clamp.js";
import { ELBOW_REST } from "./arm-orient.js";
import { wristBody, bodyDistance } from "../body.js";
import { poseWasm, poseWasmReady } from "./pose-wasm.js";

export const SIDES = { l: "Left", r: "Right" };
/** How much of an auto-fix elbow turn an arm at IK weight w takes (fix/self.js plans with the same). */
export const turnWeight = w => { const x = Math.min(1, Math.max(0, w)); return x * x * (3 - 2 * x); };
const KNEE_REST = [0, 0, 1], LEG = ["UpLeg", "Leg", "Foot"];

const v3 = (x, d = [0, 0, 0]) => (Array.isArray(x) || ArrayBuffer.isView(x) ? [x[0], x[1], x[2]] : d);
const num = (x, d = 0) => (typeof x === "number" && Number.isFinite(x) ? x : d);

/** Split a body-frame rotation over a chain of bones (k shares), each turning about its own joint. */
function spread(sk, s, bones, yaw, pitch, roll, k = bones.length) {
	for (const name of bones) {
		const b = sk.index[name];
		rotateSubtree(sk, s, b, s.P[b].slice(), mul(ry(yaw / k), mul(rx(pitch / k), rz(roll / k))));
	}
}

// Soft reach (spec.fix.reach): a wrist target up to 5 cm beyond the arm's reach is pulled onto
// the reach sphere through a C1 soft knee, so the arm never snaps straight; the overshoot is
// recorded. Farther targets are staging errors and stay for QA (REACH).
const SOFT_KNEE = 0.99, SOFT_MAX = 0.9995;
export const REACH_FIX_MAX = 0.05;
function softReach(sk, s, a, fa, h, target, diag, k) {
	const R = len(sub(s.P[fa], s.P[a])) + len(sub(s.P[h], s.P[fa])), v = sub(target, s.P[a]), d = len(v);
	const k0 = SOFT_KNEE * R, w = (SOFT_MAX - SOFT_KNEE) * R;
	if (d <= k0 || d - SOFT_MAX * R > REACH_FIX_MAX) return target;
	const dc = k0 + w * (1 - Math.exp(-(d - k0) / w));
	diag[`reach_over_${k}`] = Math.max(0, d - SOFT_MAX * R);
	return add(s.P[a], scale(v, dc / d));
}

/**
 * hooks.handTarget(side, s) -> { target:[x,y,z] } world wrist target before the FK/IK blend
 * hooks.afterArm(side, s, diag) lets the caller measure props carried by that hand.
 * hooks.push(side) -> [x,y,z] | undefined, a world offset added to the IK target (auto-fix); hooks.skinPush(side) the same
 * for the self fix (fix/self.js), taken as far as the arm is on its IK.
 * hooks.softReach clamps unreachable wrist targets smoothly (auto-fix).
 * hooks.foldFree lets the arm IK fold past the elbow's stop (a fit's measuring passes, compile.js).
 * hooks.hold(side, s) -> { w, palm, measure, pole?, second? } | null: a held object's keys lead the hand (hold.js).
 * hooks.keepOut(side, s, target) -> target: the blended wrist target kept out of the body (auto-fix, compile.js).
 * hooks.swivel(side) -> deg | undefined, an elbow turn about the shoulder-wrist line, the hand kept (auto-fix, fix/self.js).
 * diag.arm_fold_<k>: the flexion (deg) the wrist target asked when past ELBOW_FOLD (arm_miss_<k> is then how far inside).
 * diag.leg_fold_<k>: the knee flexion (deg) the ankle target asked when past KNEE_FOLD (leg_miss_<k> is then how far inside).
 */
// arm_hang (keyed by standIdle and the walk): a free FK forearm hangs plumb from the elbow, as a person's does,
// instead of carrying on the upper arm's slant out from the body (the hands sat about 9 cm wider than a person's);
// a working arm (on IK, or a hand that holds something: compile.js hangoff, idle.js busyHands) takes none of it. A rig whose thigh comes near (the X Bot) stops HANG_BACK
// degrees short of the first angle that brings its forearm or hand within HANG_CLEAR of the skin standing, so the
// walk's sway does not carry it into the thigh. Faded out as arm_rest raises the arms (none at 45); once per rig and rest.
const HANG_CLEAR = 0.095, HANG_BACK = 2, hangs = new Map();
function hangOf(sk, down) {
	const key = `${sk.model}|${down}`;
	if (hangs.has(key)) return hangs.get(key);
	const full = (90 - down) * Math.min(1, Math.max(0, (down - 45) / 27)), wb = wristBody(sk);
	const clearAt = h => {
		const s = restState(sk);
		return [["Left", -1], ["Right", 1]].every(([side, sg]) => {
			const a = sk.index[`${side}Arm`], fa = sk.index[`${side}ForeArm`], hd = sk.index[`${side}Hand`], tip = sk.index[`${side}HandMiddle1`];
			rotateSubtree(sk, s, a, s.P[a].slice(), rz(sg * down));
			rotateSubtree(sk, s, fa, s.P[fa].slice(), rz(sg * h));
			const pts = [0.5, 0.75, 1].map(t => add(s.P[fa], scale(sub(s.P[hd], s.P[fa]), t))).concat([s.P[tip]]);
			return pts.every(p => bodyDistance(wb.body, s, p, wb.skip).d >= HANG_CLEAR);
		});
	};
	let hang = full;
	if (wb && full > 0) {
		for (let h = 0; h <= full; h += 0.5) if (!clearAt(h)) { hang = Math.max(0, h - HANG_BACK); break; }
	}
	hangs.set(key, hang);
	return hang;
}

/**
 * The frame the knee and elbow poles and the feet are read in once the whole body turns well past upright (a flip, a
 * cartwheel): the root's yaw, pitch and roll, the tilt eased in from TILT_FROM to TILT_FULL degrees (the larger of the
 * wrapped pitch and roll). Under TILT_FROM it is null and the poles turn with the yaw only, as they always have, so an
 * upright take is unchanged.
 */
const TILT_FROM = 60, TILT_FULL = 120;
const wrap180 = a => a - 360 * Math.round(a / 360);
export function tiltFrame(yaw, pitch, roll) {
	const p = wrap180(pitch), r = wrap180(roll), u = (Math.max(Math.abs(p), Math.abs(r)) - TILT_FROM) / (TILT_FULL - TILT_FROM);
	if (u <= 0) return null;
	const w = u >= 1 ? 1 : u * u * (3 - 2 * u);
	return { yaw, R: mul(ry(yaw), mul(rx(p * w), rz(r * w))) };
}

/** One frame: channels -> { s, diag }, on the WebAssembly module once it is ready (pose-wasm.js), the same bit for bit. */
export function pose(sk, c, hooks = {}) {
	return poseWasmReady() ? poseWasm(sk, c, hooks, { num, v3, hangOf, tiltFrame, softReach, turnWeight, KNEE_REST, SIDES }) : poseJs(sk, c, hooks);
}

/** pose() in JS: the reference the module matches, and the path until it loads. */
export function poseJs(sk, c, hooks = {}) {
	const s = restState(sk);
	const diag = {};
	// Base: arms down from the bind T-pose (body frame, before everything else).
	const down = num(c.arm_rest, 72), hang = num(c.arm_hang) && num(c.arm_hang) * hangOf(sk, down);
	for (const [side, sg, k] of [["Left", -1, "l"], ["Right", 1, "r"]]) {
		const a = sk.index[`${side}Arm`], fa = sk.index[`${side}ForeArm`], h = hang * (1 - Math.min(1, Math.max(0, num(c[`armw_${k}`]) + num(c[`hangoff_${k}`]))));
		rotateSubtree(sk, s, a, s.P[a].slice(), rz(sg * down));
		if (h) rotateSubtree(sk, s, fa, s.P[fa].slice(), rz(sg * h));
	}
	// FK arm swing (forward +) and elbow bend, body frame.
	for (const [k, side] of Object.entries(SIDES)) {
		const bd = num(c[`abend_${k}`]), sw = num(c[`aswing_${k}`]);
		const fa = sk.index[`${side}ForeArm`], a = sk.index[`${side}Arm`];
		// an FK bend past the fold eases to its stop like the IK (limbs.js elbowFold)
		if (bd) { rotateSubtree(sk, s, fa, s.P[fa].slice(), rx(-bd)); limitFold(sk, s, side); }
		if (sw) rotateSubtree(sk, s, a, s.P[a].slice(), rx(-sw));
	}
	spread(sk, s, ["Neck", "Head"], num(c.head_yaw), num(c.head_pitch), num(c.head_roll));
	// the top spine bone turns its share of chest_* when flow bakes one (channels.js overlap: it breaks after the two below)
	const sy = num(c.spine_yaw), sp = num(c.spine_pitch), sr = num(c.spine_roll);
	spread(sk, s, ["Spine", "Spine1"], sy, sp, sr, 3);
	spread(sk, s, ["Spine2"], num(c.chest_yaw, sy), num(c.chest_pitch, sp), num(c.chest_roll, sr), 3);
	// Root: turn about the hips joint, then put the hips at `root`.
	const hips = sk.index.Hips, yaw = num(c.yaw);
	rotateSubtree(sk, s, hips, s.P[hips].slice(), mul(ry(yaw), mul(rx(num(c.pitch)), rz(num(c.roll)))));
	const shift = sub(v3(c.root, s.P[hips]), s.P[hips]);
	for (let j = 0; j < s.P.length; j++) s.P[j] = add(s.P[j], shift);
	const tilt = tiltFrame(yaw, num(c.pitch), num(c.roll)), body = tilt?.R ?? ry(yaw);
	// Legs: two-bone IK to the ankle targets, the knee no further folded than its stop (limbs.js KNEE_STOP), then aim the feet.
	for (const [k, side] of Object.entries(SIDES)) {
		if (!c[`foot_${k}`]) continue;
		const target = v3(c[`foot_${k}`]);
		diag[`leg_miss_${k}`] = twoBone(sk, s, sk.index[`${side}UpLeg`], sk.index[`${side}Leg`], sk.index[`${side}Foot`],
			target, apply(body, v3(c[`knee_${k}`], KNEE_REST)), KNEE_REST, "knee");
		// a target nearer the hip than the knee folds leaves a residual (leg_miss); leg_fold says what it asked
		const fold = askedFold(sk, s, side, target, LEG);
		if (fold > KNEE_FOLD) diag[`leg_fold_${k}`] = fold;
		orientFoot(sk, s, side, num(c[`fyaw_${k}`], yaw), num(c[`fpitch_${k}`]), tilt);
	}
	// Arms: blend the FK hand toward the hook's target, poles blended the same way.
	for (const k of hooks.armOrder ?? ["r", "l"]) {
		const side = SIDES[k], w = num(c[`armw_${k}`]);
		const a = sk.index[`${side}Arm`], fa = sk.index[`${side}ForeArm`], h = sk.index[`${side}Hand`];
		const poleIk = norm(apply(body, v3(c[`elbow_${k}`], [0, -1, -0.3])));
		diag[`arm_miss_${k}`] = 0;
		if (w > 1e-4 && hooks.handTarget) {
			const fkHand = s.P[h].slice();
			const goal = hooks.handTarget(k, s, diag) ?? fkHand;
			let target = add(fkHand, scale(sub(goal, fkHand), w));
			if (hooks.keepOut) target = hooks.keepOut(k, s, target);
			const push = hooks.push?.(k);
			if (push) target = add(target, push);
			// what the hand carries weighs it down (load.js)
			const sag = hooks.sag?.(k, s, target);
			if (sag) target = add(target, sag);
			// the self fix's push rides the IK as far as the arm is on it (an arm coming in from FK would jump)
			const skinPush = hooks.skinPush?.(k);
			if (skinPush) target = add(target, scale(skinPush, turnWeight(w)));
			if (hooks.softReach) target = softReach(sk, s, a, fa, h, target, diag, k);
			const poleFk = norm(sub(s.P[fa], scale(add(s.P[a], fkHand), 0.5)));
			const pole = add(scale(poleFk, 1 - w), scale(poleIk, w));
			// a target nearer the shoulder than the elbow folds leaves a residual too; arm_fold says what it asked
			diag[`arm_miss_${k}`] = twoBone(sk, s, a, fa, h, target, pole, ELBOW_REST, hooks.foldFree ? null : "elbow");
			const fold = askedFold(sk, s, side, target);
			if (fold > ELBOW_FOLD && !hooks.foldFree) diag[`arm_fold_${k}`] = fold;
		}
		wrist(sk, s, side, num(c[`wtwist_${k}`]), num(c[`wflex_${k}`]));
		fingers(sk, s, side, hooks.fingerWeights?.(k) ?? c[`fingers_${k}`]);
		const held = hooks.hold?.(k, s);
		// a keyed carry's hand follows its object; else a fit's hand takes a grip on the body under its anchor (grip.js),
		// and while the keys only ease in (before the first key) the arm they ease from takes it too
		if (!held || held.w < 1) hooks.grip?.(k, s, diag);
		if (held) holdHand(sk, s, side, held, ELBOW_REST, diag, k);
		// after a held object's grip, so its hand keeps the grip the hold solved; an arm coming in from FK turns
		// no more than its IK weight (the IK elbow already lands somewhere else than the FK one)
		const turn = hooks.swivel?.(k);
		// the turn keeps the hand's world turn; a wrist it takes past its limits stops there and the hand turns with the elbow
		// (wrist-clamp.js), unless keys lead what the hand holds: that hand keeps the object's grip (hold.js limits its wrist)
		if (turn) { swivelElbow(sk, s, side, turn * turnWeight(w)); if (!held) clampWrist(sk, s, side); }
		const grasped = hooks.heldShapes?.(k, s);
		if (grasped) diag[`closed_${k}`] = closeOnShape(sk, s, side, grasped).touched;
		hooks.afterArm?.(k, s, diag);
	}
	return { s, diag };
}
