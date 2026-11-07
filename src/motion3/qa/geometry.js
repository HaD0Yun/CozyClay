// Collision proxies for motion QA: body capsules on Mixamo joints, scene objects as oriented
// boxes (base pivot = bottom centre, CozyClay convention), the head as the measured ellipsoid.
import { add, sub, scale, dot, len, apply, T, clamp } from "../compiler/math.js";
import { bonePoint } from "../compiler/skeleton.js";

// [part, from joint, to joint, radius m]. Radii are fitted to the X/Y Bot skin.
export const CAPSULES = [
	["torso_lo", "Spine", "Spine2", 0.12], ["torso_hi", "Spine2", "Neck", 0.105], ["hips", "LeftUpLeg", "RightUpLeg", 0.095],
	["neck", "Neck", "Head", 0.055],
	...["Left", "Right"].flatMap(S => {
		const k = S === "Left" ? "l" : "r";
		return [[`thigh_${k}`, `${S}UpLeg`, `${S}Leg`, 0.07], [`shin_${k}`, `${S}Leg`, `${S}Foot`, 0.05],
			[`uarm_${k}`, `${S}Arm`, `${S}ForeArm`, 0.042], [`farm_${k}`, `${S}ForeArm`, `${S}Hand`, 0.033],
			[`hand_${k}`, `${S}Hand`, `${S}HandMiddle3`, 0.022]];
	}),
];

export const segPoints = (a, b, n = 9) => Array.from({ length: n }, (_, i) => add(a, scale(sub(b, a), i / (n - 1))));

/** A phalanx's skin radius (m); the skin ends this far past the fingertip joint (Hand<Finger>4). Measured on the X/Y Bot
 * skin: 0.8-1.0 cm round the phalanges, 0-0.3 cm past the tip joint. */
const PHALANX = 0.009, TIP_PAST = 0.002;
const FINGER_NAMES = ["Thumb", "Index", "Middle", "Ring", "Pinky"];

/**
 * The fingers of hand `side` at state s as capsules [part, a, b, radius]: each phalanx from its joint to the next
 * (Hand<Finger>1-2-3-4), part "fingers_<k>". The hand capsule ends at HandMiddle3, so a fingertip was never measured
 * (#1113: fingertips 9-18 cm under the floor with QA clean); the last phalanx's capsule stops TIP_PAST past the tip
 * joint, where its skin ends. [] for a rig without finger joints.
 */
export function fingerCapsules(sk, s, side) {
	const out = [], part = `fingers_${side === "Left" ? "l" : "r"}`;
	for (const f of FINGER_NAMES) {
		const J = [1, 2, 3, 4].map(i => sk.index[`${side}Hand${f}${i}`]);
		if (J.some(j => j === undefined)) return [];
		for (let i = 0; i < 3; i++) {
			const a = s.P[J[i]], tip = s.P[J[i + 1]], ab = sub(tip, a), l = len(ab);
			out.push([part, a, i === 2 && l > 1e-9 ? sub(tip, scale(ab, Math.min(0.9, (PHALANX - TIP_PAST) / l))) : tip, PHALANX]);
		}
	}
	return out;
}

/** Signed distance from p to a box (negative inside). */
export function sdBox(p, box) {
	const q = apply(T(box.R), sub(p, box.pos));
	const c = [0, box.half[1], 0];
	const d = [Math.abs(q[0] - c[0]) - box.half[0], Math.abs(q[1] - c[1]) - box.half[1], Math.abs(q[2] - c[2]) - box.half[2]];
	const outside = len([Math.max(d[0], 0), Math.max(d[1], 0), Math.max(d[2], 0)]);
	return outside + Math.min(Math.max(d[0], d[1], d[2]), 0);
}

export function segDist(p1, q1, p2, q2) {
	let best = Infinity;
	const d2 = sub(q2, p2), dd = dot(d2, d2);
	for (const a of segPoints(p1, q1)) {
		const u = dd < 1e-12 ? 0 : clamp(dot(sub(a, p2), d2) / dd, 0, 1);
		best = Math.min(best, len(sub(a, add(p2, scale(d2, u)))));
	}
	return best;
}

/** Depth (m) of point p inside the head ellipsoid, negative when outside. */
export function headDepth(sk, s, p) {
	const c = bonePoint(s, sk.index.Head, sk.landmarks.headCentre), R = s.R[sk.index.Head];
	const q = apply(T(R), sub(p, c)), r = sk.landmarks.headRadii;
	const v = len([q[0] / r[0], q[1] / r[1], q[2] / r[2]]);
	return (1 - v) * Math.min(...r);
}

/** The rig's standing ankle height (m): where foot_* stands a flat foot on the floor (X Bot 0.087, Y Bot 0.105). */
export const ankleY = sk => Math.round(sk.restWorldPos[sk.index.LeftFoot][1] * 1000) / 1000;

/** A point `drop` m straight below bone b's joint at bind, carried by b (the joint itself when 0). */
const below = (sk, s, b, drop) => (drop ? bonePoint(s, b, apply(T(sk.restWorldRot[b]), [0, -drop, 0])) : s.P[b]);

/**
 * Sole points carried by a foot, on the skin's sole (the surface verify_result's floor measure
 * reads): heel 4.5 cm behind and 0.5 cm above the bottom of the ankle at bind; ball under the
 * ToeBase joint at the toe pad; tip at the front edge. The rig's sole landmark says how far the
 * skin lies below the joints (X Bot: on the ball joint; Y Bot: 3.3 cm under it).
 */
export function solePoints(sk, s, side) {
	const I = sk.index, P = sk.restWorldPos, drop = sk.landmarks.sole ?? {};
	const foot = I[`${side}Foot`], toe = I[`${side}ToeBase`], toeEnd = I[`${side}Toe_End`] ?? toe;
	const heelRest = [P[foot][0], 0.005, P[foot][2] - 0.045];
	const heelLocal = apply(T(sk.restWorldRot[foot]), sub(heelRest, P[foot]));
	return { heel: bonePoint(s, foot, heelLocal), ball: below(sk, s, toe, drop.ball), tip: below(sk, s, toeEnd, drop.tip) };
}

/** Outward unit normal of a box at p (the nearest face from inside, the closest direction from outside). */
export function boxNormal(p, box) {
	const q = apply(T(box.R), sub(p, box.pos));
	q[1] -= box.half[1];
	const d = q.map((v, i) => Math.abs(v) - box.half[i]);
	let n;
	if (Math.max(...d) < 0) { const i = d.indexOf(Math.max(...d)); n = [0, 0, 0]; n[i] = Math.sign(q[i]) || 1; }
	else n = q.map((v, i) => (d[i] > 0 ? Math.sign(v) * d[i] : 0));
	const l = len(n);
	return apply(box.R, l > 1e-12 ? scale(n, 1 / l) : [0, 1, 0]);
}
