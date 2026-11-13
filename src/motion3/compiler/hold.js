// The hand follows a held object (docs/motion-api-v3.1.md C14). On frames where
// spec.objects[id].keys lead (../object-keys.js), pose.js calls holdHand after the plain arm
// (IK or FK, wrist channels, fingers): the wrist target and the hand's orientation are solved so
// the grip (the prop's palm frame) lands on the pose the object keys ask for, hand = object o
// attach^-1. The whole arm turns the object (arm-orient.js, lane K8): the elbow swings about the
// shoulder-wrist axis to the pole that leaves the wrist least strained, the forearm takes its
// share of the turn about its own axis, and the wrist adds the rest within anatomical limits
// relative to the forearm: twist about the forearm, flex about the knuckle line, deviation toward
// the thumb (+, radial) or the little finger (-, ulnar). What the arm or the wrist cannot do is
// left as a residual: QA measures it on the object (qa/key-checks.js) and reads the reasons from
// diag.hold_<side>.
import { add, sub, scale, norm, dot, len, mul, T, apply, axisRot, angle, quatFromMat, matFromQuat } from "./math.js";
import { twoBone, palmAxes, carried, askedFold, reachAt, ELBOW_FOLD } from "./limbs.js";
import { rotateSubtree } from "./skeleton.js";
import { clampTo } from "./wrist-clamp.js";
import { slerp } from "./quat.js";
import { bodyFor, segmentDepth } from "../body.js";
import { WRIST_LIMITS, FOREARM_SHARE, ELBOW_REST, wristNeed, swivel, landscape, shoulderPrice, comfortPrice } from "./arm-orient.js";

// STRAIGHT: a plain arm whose elbow sits less than this (m) off its shoulder-wrist midpoint is
// straight and has no bend plane of its own. A straight FK arm keeps 1 to 3 mm there from its bone
// lengths (Y Bot: the upper arm is 2 mm shorter than the forearm, so the elbow sits 1 mm up the
// arm), and that direction is no bend: as the swivel's reference it put the elbow "up", so the
// limit 100 deg from it ruled out an elbow pointing down (session d5c110a7's batting stance).
// ROLL_MARGIN: the share of each wrist half range by which holdCost tightens the limits, so the
// roll picked for a key leaves the frames between keys (they turn between the picks) some room.
// The fold price (holdCost): an arm folded near flat turns the hand any way at all, so without a price
// the roll of a stance key at the shoulder folded it (session d5c110a7: wrist 6-9 cm from the shoulder,
// 162 deg), and the frames between keys, where the wrist moves a few cm, broke away from it. twoBone
// now stops the fold (limbs.js ELBOW_FOLD, ELBOW_STOP); the price still steers the roll off it.
const ITERATIONS = 3, REACH_PRICE = 1, STRAIGHT = 0.005, ROLL_MARGIN = 0.15, BODY_PRICE = 4;

/**
 * Turn the hand (and its fingers) about the wrist so its world rotation is `goal`, as far as the
 * limits let it: the forearm bone turns FOREARM_SHARE of the twist about its own axis, the hand
 * the rest plus flex and deviation. Returns what it needed, degrees { twist, flex, dev }.
 */
export function orient(sk, s, side, h, fa, goal) {
	const axT = scale(sub(s.P[h], s.P[fa]), 1 / len(sub(s.P[h], s.P[fa]))), neutral = mul(s.R[fa], mul(T(sk.restWorldRot[fa]), sk.restWorldRot[h]));
	const { axF, axD, ...need } = wristNeed(neutral, goal, axT, apply(mul(neutral, T(s.R[h])), palmAxes(sk, s, side).l));
	const got = Object.fromEntries(Object.entries(need).map(([k, v]) => [k, clampTo(v, WRIST_LIMITS[k])]));
	const want = mul(mul(axisRot(add(scale(axF, got.flex), scale(axD, got.dev)), Math.hypot(got.flex, got.dev)), axisRot(axT, got.twist)), neutral);
	rotateSubtree(sk, s, fa, s.P[fa].slice(), axisRot(axT, FOREARM_SHARE * got.twist));
	rotateSubtree(sk, s, h, s.P[h].slice(), mul(want, T(s.R[h])));
	return need;
}

/**
 * The bend direction the channels gave the arm of `side` on pose s, what its swivel turns from: the
 * elbow off the shoulder-wrist midpoint, or for a straight arm (STRAIGHT) where its elbow would
 * point if it bent, the upper arm's rest bend carried by the bone, so the swivel's limits sit on
 * the upper arm's own roll.
 */
export function bendPlane(sk, s, side) {
	const I = sk.index, a = I[`${side}Arm`], bend = sub(s.P[I[`${side}ForeArm`]], scale(add(s.P[a], s.P[I[`${side}Hand`]]), 0.5));
	return len(bend) > STRAIGHT ? bend : carried(sk, s, a, ELBOW_REST);
}

/**
 * What holding `palm` with weight w needs on pose s: the hand's goal rotation, the wrist target for
 * a hand rotation (pin "wrist": where it is; "palm": where the palm stays put), the bend direction
 * (bendPlane).
 */
export function aimArm(sk, s, side, palm, now, w, pin) {
	const I = sk.index, h = I[`${side}Hand`];
	// the palm frame in the hand bone's frame: fixed for this frame's finger curl
	const localR = mul(T(s.R[h]), now.R), localP = apply(T(s.R[h]), sub(now.pos, s.P[h]));
	const goal = matFromQuat(slerp(quatFromMat(s.R[h]), quatFromMat(mul(palm.R, T(localR))), w));
	const from = s.P[h].slice();
	// the wrist goes where the grip lands with the orientation the wrist reached (the goal at first)
	const grip = R => sub(palm.pos, apply(R, localP));
	return { goal, plane: bendPlane(sk, s, side), wristAt: pin === "wrist" ? () => from : pin === "palm" ? grip : R => add(from, scale(sub(grip(R), from), w)) };
}

/**
 * held = { w, palm: { pos, R }, measure(s) -> { pos, R }, pole?, second?, pin? }: blend weight
 * (1 inside the keyed span), the palm frame the keys ask for, the function that measures it on a
 * pose, the planned elbow pole (../hold-plan.js; searched here when absent) and, for a second hand
 * (../second-hand.js), the id of the object it grips and what stays put (pin "wrist" or "palm").
 */
export function holdHand(sk, s, side, held, restBend, diag, k) {
	const I = sk.index, a = I[`${side}Arm`], fa = I[`${side}ForeArm`], h = I[`${side}Hand`], { w } = held;
	const { goal, plane, wristAt } = aimArm(sk, s, side, held.palm, held.measure(s), w, held.pin);
	const arm = swivel(sk, s, side, goal, wristAt(goal), plane, restBend, { toward: held.pole, w, comfort: held.comfort });
	let miss = 0, fold = 0, need = { twist: 0, flex: 0, dev: 0 };
	for (let i = 0; i < ITERATIONS; i++) {
		const W = wristAt(i ? s.R[h] : goal);
		fold = askedFold(sk, s, side, W);
		miss = twoBone(sk, s, a, fa, h, W, arm.pole, restBend, "elbow");
		need = orient(sk, s, side, h, fa, goal);
	}
	// fold: the flexion (deg) the wrist asked when past ELBOW_FOLD; miss is then how far inside the fold it is
	diag[`hold_${k}`] = { w, miss: Math.max(0, miss), ...need, swivel: swungFrom(s, a, fa, h, plane), ...(fold > ELBOW_FOLD ? { fold } : {}), ...(held.second ? { second: held.second } : {}) };
	diag[`arm_miss_${k}`] *= 1 - w;
}

/**
 * The swivel landscape holdHand searches for `held` on pose s (the plain arm of `side`): what
 * ../hold-plan.js plans the elbow's path on.
 */
export function holdLandscape(sk, s, side, held) {
	const { goal, plane, wristAt } = aimArm(sk, s, side, held.palm, held.measure(s), held.w);
	return landscape(sk, s, side, goal, wristAt(goal), plane, ELBOW_REST, 0, held.comfort);
}

/**
 * The arm's cost of holding the palm frame `palm` on pose s (the plain arm of `side`, `now` its
 * palm frame there): the wrist strain at the pole holdHand would take, its limits ROLL_MARGIN
 * tighter, plus REACH_PRICE per squared centimetre the arm is short or the wrist nearer the shoulder
 * than the elbow folds (ELBOW_FOLD), plus the shoulder's price with opts.shoulder. An aim key without roll takes the cheapest roll (key-aim.js).
 */
export function holdCost(sk, s, side, palm, now, { shoulder = false } = {}) {
	const { goal, plane, wristAt } = aimArm(sk, s, side, palm, now, 1), W = wristAt(goal);
	const arm = swivel(sk, s, side, goal, W, plane, ELBOW_REST, { margin: ROLL_MARGIN });
	// the wrist no nearer the shoulder than the elbow folds (ELBOW_FOLD): an arm folded flat holds anything, and nothing between keys
	const I = sk.index, S = s.P[I[`${side}Arm`]], A = len(sub(s.P[I[`${side}ForeArm`]], S)), B = len(sub(s.P[I[`${side}Hand`]], s.P[I[`${side}ForeArm`]]));
	const fold = Math.max(0, reachAt(A, B, ELBOW_FOLD) - len(sub(W, S)));
	// opts.shoulder adds the shoulder's price at that elbow (arm-orient.js shoulderPrice) and the arm's depth into the body
	// (body.js, priced as grip-choice.js prices it): a leaning aim key's pick (key-aim.js) keeps the elbow down, not in the chest
	const arm2 = shoulder ? swivel(sk, s, side, goal, W, plane, ELBOW_REST, { comfort: true }) : arm;
	return (shoulder ? comfortPrice(arm2.need) + shoulderPrice(S, arm2.elbow) + intoBody(sk, s, side, S, arm2.elbow, W) : arm.cost) + REACH_PRICE * ((arm.miss * 100) ** 2 + (fold * 100) ** 2);
}

/** BODY_PRICE per squared centimetre the upper arm or the forearm at elbow E and wrist W goes into the body (body.js). */
function intoBody(sk, s, side, S, E, W) {
	const body = bodyFor(sk), I = sk.index;
	return body ? BODY_PRICE * (Math.max(segmentDepth(body, sk, s, I[`${side}Arm`], S, E), segmentDepth(body, sk, s, I[`${side}ForeArm`], E, W)) * 100) ** 2 : 0;
}

/** Degrees the elbow swung about the shoulder-wrist axis from the bend direction `plane` the channels gave. */
function swungFrom(s, a, fa, h, plane) {
	const u = norm(sub(s.P[h], s.P[a])), off = v => sub(v, scale(u, dot(v, u)));
	return angle(off(sub(s.P[fa], s.P[a])), off(plane));
}
