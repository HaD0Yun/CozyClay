// Effector-level pose solver: a body state B plus upper-body overrides U become the 17 world positions and
// rotations of the clip convention. Arms and legs are analytic two-bone IK; time comes in only as the frame before's values in U.
//
// B = { p: Hips world position, q: pelvis world quaternion, yaw: heading (rad), lean, twist: chest relative to the
//       pelvis (rad), feet: [L, R] of { a: ankle world position, q: foot world quaternion, planted, floor },
//       hands: [L, R] rest hand positions in the pelvis frame, relative to the Hips joint }
// U = { hands: [L, R] of { from, to: world points or null (= rest), w: blend, up: 0..1 hand turned up, offset,
//                          aim: world direction of the hand's thumb side, aimW: 0..1, or axes: { a, b, w } two
//                          lists of [hand axis, world direction] blended a to b by w (aimW still weighs them),
//                          elbow: { from, to, w, fast } world points the elbow bends toward (null = its own direction),
//                          prev: where the hand was last frame, carried with the body (limits its speed) },
//       hipTurn: pelvis turn about Y over planted feet (rad), bow: forward hinge at the hips (rad),
//       lean, twist (rad), hip: [x, y, z] pelvis shift in the heading frame, look: [yaw, pitch] of the head,
//       assist: the previous frame's { bend, drop } of the reach assist, knee: the previous frame's knee [L, R] (knee.js) }
import { ANKLE_HEIGHT, INDEX as J, JOINT_COUNT, OFFSET, PARENT, REST, TIPS, qAxisAngle } from "../rig17.js";
import { kneePole } from "./knee.js";
import { X, Y, Z, add, clamp, cross, dot, len, mix, mixV, mul, norm, qConj, qFrame, qMul, qRotate, qSlerp, qX, qY, qZ, sub } from "./math.js";

export const SIDES = [
	{ s: 1, arm: J.LeftArm, fore: J.LeftForeArm, hand: J.LeftHand, up: J.LeftUpLeg, leg: J.LeftLeg, foot: J.LeftFoot },
	{ s: -1, arm: J.RightArm, fore: J.RightForeArm, hand: J.RightHand, up: J.RightUpLeg, leg: J.RightLeg, foot: J.RightFoot },
];
export const ARM_LEN = len(OFFSET[J.LeftForeArm]) + len(OFFSET[J.LeftHand]);
export const LEG_LEN = len(OFFSET[J.LeftLeg]) + len(OFFSET[J.LeftFoot]);
/** Toe tip and heel (sole point under the ankle) relative to the ankle joint, in the foot's rest frame. */
export const TOE = sub(TIPS.LeftFoot, REST[J.LeftFoot]);
export const SOLE = [0, -ANKLE_HEIGHT, 0];

export const MAX_STEP = 0.12; // m per frame a hand may move in the body frame unless its key says fast (2.9 m/s)
export const ASSIST_BEND = 1.5; // rad: the most the reach assist hinges at the hips

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

/** The hand turn that sends each [hand axis, direction] pair of `list` that way: the first exactly, the second as near
 *  as it can; with one pair the hand's long axis stays as near the forearm `fore` as it can (rest axis `long`). */
function aimTurn(list, fore, long) {
	const [a1, d1] = list[0], [a2, d2] = list[1] ?? (Math.abs(dot(a1, norm(long))) > 0.9 ? [Y, qRotate(qFrame(fore, Y), Y)] : [long, fore]);
	return qMul(qFrame(d1, d2), qConj(qFrame(a1, a2)));
}
/** The pole that bends an elbow from `root` toward `p` (the part of it across the line to the hand `dir`). */
const toward = (p, root, dir, fallback) => { const v = sub(p, root), across = sub(v, mul(dir, dot(v, dir))); return len(across) > 1e-6 ? norm(across) : fallback; };

/** The turn that takes unit direction a the part w of the way to unit direction b, about the axis square to both
 *  (`side` when they point opposite ways). */
const turnPart = (a, b, w, side) => { const ax = cross(a, b), s = len(ax); return qAxisAngle(s > 1e-9 ? mul(ax, 1 / s) : side, w * Math.atan2(s, dot(a, b))); };

/** A wrist with no target of its own (free: 0..1, the part of it that is not aimed) under an elbow target e: the whole
 *  arm turns about the shoulder `sh` as one piece, keeping its bend, so that the elbow points at e's blend of targets;
 *  so the elbow lies on a target as far from the shoulder as the upper arm. The turn is the one that takes the arm's own
 *  elbow to the key's first target and then turns it by angle toward its second (one axis for the whole blend), so the
 *  arm swings through the frames of the blend; side: the turn's axis when two directions point opposite ways.
 *  -> { wrist, pole: the elbow's bend direction turned with the arm } */
function freeWrist(sh, w, pole, e, free, S, side) {
	const arm = limb(sh, w, pole, S.fore, S.hand, [0, 0, -1]), own = norm(sub(arm.mid, sh)), at = q => (q ? norm(sub(q, sh)) : own);
	const from = at(e.from), q = qSlerp([0, 0, 0, 1], qMul(turnPart(from, at(e.to), e.w, side), turnPart(own, from, 1, side)), free);
	return { wrist: add(sh, qRotate(q, sub(w, sh))), pole: qRotate(q, arm.perp) };
}
/** A turned arm held to the hands' top speed: its wrist goes from `prev` toward `w` along an arc about the shoulder `sh`,
 *  at most MAX_STEP, and the arm turns with it. -> { wrist, pole } */
function swingCapped(sh, prev, w, pole, side) {
	const a = sub(prev, sh), b = sub(w, sh), at = k => add(sh, mul(qRotate(turnPart(norm(a), norm(b), k, side), norm(a)), mix(len(a), len(b), k)));
	let lo = 0, hi = 1;
	for (let n = 0; n < 20; n++) { const k = (lo + hi) / 2; if (len(sub(at(k), prev)) > MAX_STEP) hi = k; else lo = k; }
	const wrist = at(lo);
	return { wrist, pole: qRotate(turnPart(norm(b), norm(sub(wrist, sh)), 1, side), pole) };
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
	const turned = H.map((h, i) => !!h?.elbow && aimed[i] < 1); // a free wrist that an elbow target turns (freeWrist)
	// a hand at most MAX_STEP from where it was last frame -> [point, metres the cap held it back that the arm from the
	// shoulder sh could have gone: the part of the point past the arm's reach is not counted]
	const capped = (t, prev, sh) => {
		const d = sub(t, prev), l = len(d);
		return l > MAX_STEP ? [add(prev, mul(d, MAX_STEP / l)), Math.max(0, l - MAX_STEP - Math.max(0, len(sub(t, sh)) - ARM_LEN))] : [t, 0];
	};
	// Reach assist: when a hand target is out of arm's reach and not overhead, hinge at the hips and bend the knees.
	let bend = 0, drop = 0;
	const torso = (extraDrop = 0) => {
		const b = bend + (U.bow ?? 0); // bow: a hinge at the hips asked for by the spec; bend: the same hinge added by the reach assist
		const hips = [hips0[0] + fwd[0] * 0.12 * bend, hips0[1] - drop - extraDrop, hips0[2] + fwd[2] * 0.12 * bend];
		// roll (rad, + = left side up): B.roll tips the pelvis, B.rollChest the chest; the spine shares the difference
		const roll = B.roll ?? 0, rollC = B.rollChest ?? 0, qB = roll ? qMul(B.q, qZ(roll)) : B.q;
		const qP = qMul(qMul(qY(U.hipTurn ?? 0), qB), qX(0.6 * b)), lean = lean0 + 0.4 * b;
		const q1 = qMul(roll || rollC ? qMul(qP, qZ(0.5 * (rollC - roll))) : qP, qMul(qY(0.4 * twist), qX(0.4 * lean)));
		const q2 = qMul(roll || rollC ? qMul(qP, qZ(rollC - roll)) : qP, qMul(qY(twist), qX(lean)));
		const p2 = add(add(hips, qRotate(qP, OFFSET[J.Spine])), qRotate(q1, OFFSET[J.Spine2]));
		const sh = SIDES.map(S => add(p2, qRotate(q2, OFFSET[S.arm])));
		const slow = [0, 0], hand = SIDES.map((S, i) => {
			const rest = add(hips, qRotate(B.q, B.hands[i])), h = H[i];
			if (!h) return rest;
			let t = h.line ? mixV(h.from ?? rest, h.to ?? rest, h.w) : arc(h.from ?? rest, h.to ?? rest, h.w, sh0?.[i] ?? sh[i]); // about the shoulder of the unbent body
			if (h.offset) t = add(t, h.offset);
			if (h.prev && !turned[i]) [t, slow[i]] = capped(t, h.prev, sh[i]); // a turned wrist is held to its speed where it ends
			return t;
		});
		return { hips, qP, q1, q2, hand, sh, slow };
	};
	let sh0 = null, T = torso();
	sh0 = T.sh;
	// Only wrist targets count: an elbow target does not move the body (an own-body one moves with it, and an elbow
	// is exactly the upper arm's length from the shoulder, so a bend overshoots as often as it lands); its row tells the gap.
	if (!U.noAssist && active.some(Boolean)) for (let it = 0; it < 14; it++) {
		let d = 0, ahead = 0; // ahead: bending forward only helps a target in front of the hips
		SIDES.forEach((S, i) => {
			const di = active[i] && T.hand[i][1] < T.sh[i][1] + 0.1 ? (len(sub(T.hand[i], T.sh[i])) - 0.95 * ARM_LEN) * aimed[i] : 0;
			if (di > d) { d = di; ahead = clamp((dot(sub(T.hand[i], T.hips), fwd) + 0.1) / 0.3); }
		});
		bend = Math.min(ASSIST_BEND, bend + 1.4 * d * ahead); drop = Math.min(0.58, Math.max(0, hips0[1] - 0.45), drop + 0.6 * d);
		T = torso();
	}
	// straighten up gradually when the target comes back into reach
	if (U.assist && !U.noAssist) { bend = Math.max(bend, U.assist.bend - 0.09); drop = Math.max(drop, U.assist.drop - 0.035); T = torso(); }
	// Feet: keep the toe tip and the heel on or over the floor, then lower the pelvis until planted feet are in reach.
	const feet = B.feet.map(f => {
		const low = Math.min(0, qRotate(f.q, TOE)[1], qRotate(f.q, SOLE)[1]);
		return { q: f.q, a: [f.a[0], Math.max(f.a[1], (f.floor ?? 0) - low), f.a[2]], lift: Math.max(0, (f.floor ?? 0) - low - f.a[1]) };
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
	const late = [0, 0], knee = [null, null]; // late: metres the top speed held a turned arm's elbow from where its blend had it
	SIDES.forEach((S, i) => {
		place(S.arm);
		const e = H[i]?.elbow, sh = pos[S.arm];
		// the pole that bends the elbow toward e's blend of targets about the line from the shoulder to the wrist w
		const aimPole = w => { const p = elbowPole(S, sh, w, T.q2), dir = norm(sub(w, sh)), own = toward(add(sh, p), sh, dir, p), at = q => (q ? toward(q, sh, dir, own) : own); return mixV(at(e.from), at(e.to), e.w); };
		let wrist = T.hand[i], bend = elbowPole(S, sh, wrist, T.q2);
		if (turned[i]) { // the free wrist turned by its elbow target; the cap holds it back unless the hand's or the elbow's key says fast
			const side = qRotate(T.q2, X), free = freeWrist(sh, wrist, bend, e, 1 - aimed[i], S, side);
			const held = H[i].prev && !e.fast && len(sub(free.wrist, H[i].prev)) > MAX_STEP ? swingCapped(sh, H[i].prev, free.wrist, free.pole, side) : free;
			wrist = held.wrist; bend = held.pole;
			if (held !== free) { T.slow[i] = len(sub(free.wrist, wrist)); late[i] = len(sub(limb(sh, free.wrist, free.pole, S.fore, S.hand, [0, 0, -1]).mid, limb(sh, wrist, bend, S.fore, S.hand, [0, 0, -1]).mid)); }
			if (aimed[i] > 0) bend = mixV(bend, aimPole(wrist), aimed[i]); // the aimed part of the wrist bends the elbow as a wrist on its target does
		} else if (e) bend = aimPole(wrist);
		const A = limb(sh, wrist, bend, S.fore, S.hand, [0, 0, -1]);
		quat[S.arm] = A.qU; quat[S.fore] = A.qL;
		const dir = norm(mixV(norm(sub(A.end, A.mid)), Y, H[i]?.up ?? 0));
		quat[S.hand] = qMul(qFrame(dir, A.perp), qConj(qFrame(OFFSET[S.hand], [0, 0, -1])));
		// aim: the hand's thumb side (rest +Z, the long axis of a prop held in it) points along a world direction
		if (H[i]?.aimW > 0 && !H[i].axes) quat[S.hand] = qSlerp(quat[S.hand], qMul(qFrame(H[i].aim, sub(A.end, A.mid)), qConj(qFrame(Z, OFFSET[S.hand]))), H[i].aimW);
		else if (H[i]?.aimW > 0) { const fore = norm(sub(A.end, A.mid)), x = H[i].axes; quat[S.hand] = qSlerp(quat[S.hand], qSlerp(aimTurn(x.a, fore, OFFSET[S.hand]), aimTurn(x.b, fore, OFFSET[S.hand]), x.w), H[i].aimW); }
		place(S.fore); place(S.hand);
		place(S.up);
		const pole = add(qRotate(T.qP, Z), mul(qRotate(feet[i].q, Z), 0.5));
		const K = knee[i] = kneePole(T.qP, pos[S.up], feet[i].a, pole, U.knee?.[i], B.feet[i].floor ?? 0), L = limb(pos[S.up], feet[i].a, K.pole, S.leg, S.foot, Z);
		quat[S.up] = L.qU; quat[S.leg] = L.qL; quat[S.foot] = feet[i].q;
		place(S.leg); place(S.foot);
	});
	return { pos, quat, assist: { bend, drop }, slow: T.slow, late, lift: feet.map(f => f.lift), knee: knee.map(({ d, side, off }) => ({ d, side, off })) };
}
