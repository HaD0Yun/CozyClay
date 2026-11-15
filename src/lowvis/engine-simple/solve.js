// Effector-level pose solver: a body state B plus upper-body overrides U become the 17 world positions and
// rotations of the clip convention. Arms and legs are analytic two-bone IK; nothing here knows about time.
//
// B = { p: Hips world position, q: pelvis world quaternion, yaw: heading (rad), lean, twist: chest relative to the
//       pelvis (rad), feet: [L, R] of { a: ankle world position, q: foot world quaternion, planted, floor },
//       hands: [L, R] rest hand positions in the pelvis frame, relative to the Hips joint }
// U = { hands: [L, R] of { from, to: world points or null (= rest), w: blend, up: 0..1 hand turned up, offset,
//                          aim: world direction of the hand's thumb side, aimW: 0..1,
//                          prev: where the hand was last frame, carried with the body (limits its speed) },
//       hipTurn: pelvis turn about Y over planted feet (rad), bow: forward hinge at the hips (rad),
//       lean, twist (rad), hip: [x, y, z] pelvis shift in the heading frame, look: [yaw, pitch] of the head,
//       assist: the previous frame's { bend, drop } of the reach assist }
import { ANKLE_HEIGHT, INDEX as J, JOINT_COUNT, OFFSET, PARENT, REST, TIPS } from "../rig17.js";
import { Y, Z, add, clamp, dot, len, mix, mixV, mul, norm, qConj, qFrame, qMul, qRotate, qSlerp, qX, qY, sub } from "./math.js";

export const SIDES = [
	{ s: 1, arm: J.LeftArm, fore: J.LeftForeArm, hand: J.LeftHand, up: J.LeftUpLeg, leg: J.LeftLeg, foot: J.LeftFoot },
	{ s: -1, arm: J.RightArm, fore: J.RightForeArm, hand: J.RightHand, up: J.RightUpLeg, leg: J.RightLeg, foot: J.RightFoot },
];
export const ARM_LEN = len(OFFSET[J.LeftForeArm]) + len(OFFSET[J.LeftHand]);
export const LEG_LEN = len(OFFSET[J.LeftLeg]) + len(OFFSET[J.LeftFoot]);
/** Toe tip and heel (sole point under the ankle) relative to the ankle joint, in the foot's rest frame. */
export const TOE = sub(TIPS.LeftFoot, REST[J.LeftFoot]);
export const SOLE = [0, -ANKLE_HEIGHT, 0];

const MAX_STEP = 0.12; // m per frame a hand may move in the body frame unless its key says fast (2.9 m/s)

/** Blend of two hand points along an arc about the shoulder (direction and distance apart), not through the body. */
export function arc(a, b, w, sh) {
	const da = sub(a, sh), db = sub(b, sh), d = mixV(norm(da), norm(db), w);
	// straight line instead when the two directions oppose each other or a point sits on the shoulder
	const k = clamp((len(d) - 0.1) / 0.3) * clamp((Math.min(len(da), len(db)) - 0.12) / 0.2);
	const line = mixV(a, b, w);
	return k <= 0 ? line : mixV(line, add(sh, mul(norm(d), mix(len(da), len(db), w))), k);
}

/** Elbow direction from where the hand is relative to the shoulder (chest frame): down and back for a hanging arm,
 *  out to the side as the hand rises, folds close to the shoulder or crosses the body. Continuous in the hand position. */
function elbowPole(S, sh, hand, q2) {
	const n = mul(qRotate(qConj(q2), sub(hand, sh)), 1 / ARM_LEN), up = clamp(n[1] + 0.2), fold = clamp(1 - len(n));
	return qRotate(q2, [S.s * (0.2 + 1.1 * up + 0.9 * fold + 0.5 * Math.max(0, -S.s * n[0])), -0.6 + 0.3 * up, -0.7 * (1 - up)]);
}

/** Two-bone IK: joints jm (middle) and je (end) hang from `root`; the middle joint bends toward `pole`. */
function limb(root, target, pole, jm, je, restPole) {
	const l1 = len(OFFSET[jm]), l2 = len(OFFSET[je]), d = sub(target, root);
	const dist = Math.min(Math.max(len(d), Math.abs(l1 - l2) + 1e-4), (l1 + l2) * 0.9995), dir = norm(d, [0, -1, 0]);
	const a = (l1 * l1 - l2 * l2 + dist * dist) / (2 * dist), h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
	let perp = sub(pole, mul(dir, dot(pole, dir)));
	perp = norm(len(perp) < 1e-6 ? qRotate(qFrame(dir, Z), Y) : perp);
	const mid = add(root, add(mul(dir, a), mul(perp, h))), end = add(root, mul(dir, dist));
	return {
		mid, end, perp,
		qU: qMul(qFrame(sub(mid, root), perp), qConj(qFrame(OFFSET[jm], restPole))),
		qL: qMul(qFrame(sub(end, mid), perp), qConj(qFrame(OFFSET[je], restPole))),
	};
}

export function solve(B, U = {}) {
	const yawQ = qY(B.yaw), fwd = qRotate(yawQ, Z), H = U.hands ?? [];
	const hips0 = add(B.p, qRotate(yawQ, U.hip ?? [0, 0, 0]));
	const lean0 = B.lean + (U.lean ?? 0), twist = B.twist + (U.twist ?? 0);
	const active = H.map(h => !!h && (!!h.from || !!h.to));
	const aimed = H.map(h => h ? (h.from ? 1 - h.w : 0) + (h.to ? h.w : 0) : 0); // how much of the hand target is not the rest pose
	// Reach assist: when a hand target is out of arm's reach and not overhead, hinge at the hips and bend the knees.
	let bend = 0, drop = 0;
	const torso = (extraDrop = 0) => {
		const b = bend + (U.bow ?? 0); // bow: a hinge at the hips asked for by the spec; bend: the same hinge added by the reach assist
		const hips = [hips0[0] + fwd[0] * 0.12 * bend, hips0[1] - drop - extraDrop, hips0[2] + fwd[2] * 0.12 * bend];
		const qP = qMul(qMul(qY(U.hipTurn ?? 0), B.q), qX(0.6 * b)), lean = lean0 + 0.4 * b;
		const q1 = qMul(qP, qMul(qY(0.4 * twist), qX(0.4 * lean))), q2 = qMul(qP, qMul(qY(twist), qX(lean)));
		const p2 = add(add(hips, qRotate(qP, OFFSET[J.Spine])), qRotate(q1, OFFSET[J.Spine2]));
		const sh = SIDES.map(S => add(p2, qRotate(q2, OFFSET[S.arm])));
		const hand = SIDES.map((S, i) => {
			const rest = add(hips, qRotate(B.q, B.hands[i])), h = H[i];
			if (!h) return rest;
			let t = h.line ? mixV(h.from ?? rest, h.to ?? rest, h.w) : arc(h.from ?? rest, h.to ?? rest, h.w, sh0?.[i] ?? sh[i]); // about the shoulder of the unbent body
			if (h.offset) t = add(t, h.offset);
			if (h.prev) { const d = sub(t, h.prev), l = len(d); if (l > MAX_STEP) t = add(h.prev, mul(d, MAX_STEP / l)); }
			return t;
		});
		return { hips, qP, q1, q2, hand, sh };
	};
	let sh0 = null, T = torso();
	sh0 = T.sh;
	if (!U.noAssist && active.some(Boolean)) for (let it = 0; it < 14; it++) {
		let d = 0, ahead = 0; // ahead: bending forward only helps a target in front of the hips
		SIDES.forEach((S, i) => {
			const di = active[i] && T.hand[i][1] < T.sh[i][1] + 0.1 ? (len(sub(T.hand[i], T.sh[i])) - 0.95 * ARM_LEN) * aimed[i] : 0;
			if (di > d) { d = di; ahead = clamp((dot(sub(T.hand[i], T.hips), fwd) + 0.1) / 0.3); }
		});
		bend = Math.min(1.5, bend + 1.4 * d * ahead); drop = Math.min(0.58, Math.max(0, hips0[1] - 0.45), drop + 0.6 * d);
		T = torso();
	}
	// straighten up gradually when the target comes back into reach
	if (U.assist && !U.noAssist) { bend = Math.max(bend, U.assist.bend - 0.09); drop = Math.max(drop, U.assist.drop - 0.035); T = torso(); }
	// Feet: keep the toe tip and the heel on or over the floor, then lower the pelvis until planted feet are in reach.
	const feet = B.feet.map(f => {
		const low = Math.min(0, qRotate(f.q, TOE)[1], qRotate(f.q, SOLE)[1]);
		return { q: f.q, a: [f.a[0], Math.max(f.a[1], (f.floor ?? 0) - low), f.a[2]] };
	});
	let lower = 0;
	SIDES.forEach((S, i) => {
		if (!B.feet[i].planted) return;
		const hj = add(T.hips, qRotate(T.qP, OFFSET[S.up])), a = feet[i].a, R = 0.998 * LEG_LEN;
		const over = hj[1] - lower - a[1] - Math.sqrt(Math.max(0, R * R - (hj[0] - a[0]) ** 2 - (hj[2] - a[2]) ** 2));
		if (over > 0) lower += over;
	});
	if (lower > 0) T = torso(lower);

	const quat = new Array(JOINT_COUNT), pos = new Array(JOINT_COUNT);
	const place = j => { pos[j] = add(pos[PARENT[j]], qRotate(quat[PARENT[j]], OFFSET[j])); };
	const [ly, lp] = U.look ?? [0, 0];
	pos[0] = T.hips; quat[0] = T.qP; quat[1] = T.q1; quat[2] = T.q2;
	quat[3] = qMul(T.q2, qMul(qY(0.5 * ly), qX(0.5 * lp))); quat[4] = qMul(T.q2, qMul(qY(ly), qX(lp)));
	for (let j = 1; j <= 4; j++) place(j);
	SIDES.forEach((S, i) => {
		place(S.arm);
		const A = limb(pos[S.arm], T.hand[i], elbowPole(S, pos[S.arm], T.hand[i], T.q2), S.fore, S.hand, [0, 0, -1]);
		quat[S.arm] = A.qU; quat[S.fore] = A.qL;
		const dir = norm(mixV(norm(sub(A.end, A.mid)), Y, H[i]?.up ?? 0));
		quat[S.hand] = qMul(qFrame(dir, A.perp), qConj(qFrame(OFFSET[S.hand], [0, 0, -1])));
		// aim: the hand's thumb side (rest +Z, the long axis of a prop held in it) points along a world direction
		if (H[i]?.aimW > 0) quat[S.hand] = qSlerp(quat[S.hand], qMul(qFrame(H[i].aim, sub(A.end, A.mid)), qConj(qFrame(Z, OFFSET[S.hand]))), H[i].aimW);
		place(S.fore); place(S.hand);
		place(S.up);
		const pole = add(qRotate(T.qP, Z), mul(qRotate(feet[i].q, Z), 0.5));
		const L = limb(pos[S.up], feet[i].a, pole, S.leg, S.foot, Z);
		quat[S.up] = L.qU; quat[S.leg] = L.qL; quat[S.foot] = feet[i].q;
		place(S.leg); place(S.foot);
	});
	return { pos, quat, assist: { bend, drop } };
}
