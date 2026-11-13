// The wrist an elbow turn leaves (fix.self, lane selfwrist). fix/self.js turns an elbow about the shoulder-wrist
// line to take an arm out of the body, and limbs.js swivelElbow keeps the hand's world turn while it does. With
// the elbow bent (a cigarette at the lips) that line runs well off the forearm, so the turn lands on the wrist
// as flex and deviation: the car exit's smoking hand went 57 deg toward the thumb (limit 20) on 88 frames, the
// squat smoke 56, the kits 26-57 (QA WRIST). No turn of the elbow both clears the body and keeps that wrist in
// range (the car exit at f500: 45 deg leaves the forearm 2.8 cm in the chest at 31 deg, 75 deg clears it at 57).
// So the wrist stops at its limits and the hand turns on with the elbow for the rest, as a wrist does; a fit
// (the filter at the lips) then moves the wrist until its point is back on its target (compile.js runs the turn
// in the fit's passes too). A wrist the turn leaves within its limits is not touched: the hand keeps its world
// turn exactly as before.
import { add, sub, scale, norm, mul, T, apply, axisRot } from "./math.js";
import { rotateSubtree } from "./skeleton.js";
import { palmAxes } from "./limbs.js";
import { WRIST_LIMITS, wristNeed } from "./arm-orient.js";

export const clampTo = (v, [lo, hi]) => Math.min(hi, Math.max(lo, v));

/**
 * clampWrist(sk, s, side): the hand of `side` turned back within WRIST_LIMITS on its forearm (twist, flex and
 * deviation each clamped, the hand alone: the forearm bone keeps its turn). Returns { need, got } in degrees
 * when it turned the hand, null when the wrist was within its limits.
 */
export function clampWrist(sk, s, side) {
	const I = sk.index, h = I[`${side}Hand`], fa = I[`${side}ForeArm`], rw = sk.restWorldRot;
	const axT = norm(sub(s.P[h], s.P[fa])), neutral = mul(s.R[fa], mul(T(rw[fa]), rw[h]));
	const { axF, axD, ...need } = wristNeed(neutral, s.R[h], axT, apply(mul(neutral, T(s.R[h])), palmAxes(sk, s, side).l));
	const got = Object.fromEntries(Object.entries(need).map(([k, v]) => [k, clampTo(v, WRIST_LIMITS[k])]));
	if (Object.keys(need).every(k => Math.abs(need[k] - got[k]) < 1e-6)) return null;
	const want = mul(mul(axisRot(add(scale(axF, got.flex), scale(axD, got.dev)), Math.hypot(got.flex, got.dev)), axisRot(axT, got.twist)), neutral);
	rotateSubtree(sk, s, h, s.P[h].slice(), mul(want, T(s.R[h])));
	return { need, got };
}
