// Whole-body angular momentum about the centre of mass, for the flight checks (qa/flight-checks.js SPIN) and the
// spin fix (fix/spin.js). The segments, their masses and their centres are com.js SEGMENT_FRACTIONS (one COM model);
// this file adds each segment's own moment of inertia beside it.
//   inertia    each segment is a body symmetric about its long axis (the line from its start joint to its end joint):
//              I = m l^2 [kt^2 (1 - u u^T) + kl^2 u u^T], u the axis, l the rig's own segment length (rest pose),
//              kt the transverse radius of gyration (the mean of the sagittal and the transverse one) and kl the
//              longitudinal one, both as fractions of l. The radii are de Leva (1996), "Adjustments to
//              Zatsiorsky-Seluyanov's segment inertia parameters", J. Biomech. 29(9):1223-1230, Table 4 (males):
//              head 30.3/31.5/26.1 %, upper and middle trunk (thorax) 50.5/32.0/46.5 and 48.2/38.3/46.8 % of their
//              own lengths, which the whole trunk's 32.8/30.6/16.9 % gives over the rig's Spine1-Neck length, lower
//              trunk (pelvis) 61.5/55.1/58.7 %, upper arm 28.5/26.9/15.8 %, forearm 27.6/26.5/12.1 %, thigh
//              32.9/32.9/14.9 %, shank 25.5/24.9/10.3 %. The hand rides on the forearm and the foot on the shank
//              (com.js), so those segments take the forearm's and the shank's radii.
//   momentum   L = sum_i [ m_i (r_i - c) x (v_i - v_c) + I_i w_i ] about the centre of mass c, with central finite
//              differences at the take's fps (r_i the segment's centre, v its velocity, w_i the angular velocity of
//              its start bone's world turn, s.R). BODY_MASS kg (the physics bench's body, DEF.bodyMass) scales it.
// Pure: frames in, numbers out.
import { SEGMENT_FRACTIONS } from "./com.js";
import { add, sub, scale, cross, dot, len, mul, T } from "../compiler/math.js";

/** kg: the body the momentum is measured for (a 70 kg adult). */
const BODY_MASS = 70;

/** de Leva (1996) radii of gyration [transverse, longitudinal] as fractions of the segment's length, by SEGMENT_FRACTIONS id. */
const GYRATION = {
	pelvis: [(0.615 + 0.551) / 2, 0.587], torso: [(0.328 + 0.306) / 2, 0.169], head: [(0.303 + 0.315) / 2, 0.261],
	leftUpperArm: [(0.285 + 0.269) / 2, 0.158], rightUpperArm: [(0.285 + 0.269) / 2, 0.158],
	leftForeArmHand: [(0.276 + 0.265) / 2, 0.121], rightForeArmHand: [(0.276 + 0.265) / 2, 0.121],
	leftThigh: [0.329, 0.149], rightThigh: [0.329, 0.149], leftShankFoot: [(0.255 + 0.249) / 2, 0.103], rightShankFoot: [(0.255 + 0.249) / 2, 0.103],
};

const segCache = new WeakMap();
/** The segments of skeleton sk: { a, b (joint indexes), m (kg), kt2, kl2 (m^2: (k l)^2) } | null when sk lacks a bone. */
function segmentsOf(sk) {
	if (segCache.has(sk)) return segCache.get(sk);
	const I = sk.index, P = sk.restWorldPos;
	const segs = SEGMENT_FRACTIONS.every(s => I[s.start] !== undefined && I[s.end] !== undefined) ? SEGMENT_FRACTIONS.map(s => {
		const a = I[s.start], b = I[s.end], l = len(sub(P[b], P[a])), [kt, kl] = GYRATION[s.id];
		return { a, b, m: s.mass * BODY_MASS, kt2: (kt * l) ** 2, kl2: (kl * l) ** 2 };
	}) : null;
	segCache.set(sk, segs);
	return segs;
}

/** The rotation vector (axis * angle, rad) of rotation matrix D. */
export function rotationVector(D) {
	const v = [D[2][1] - D[1][2], D[0][2] - D[2][0], D[1][0] - D[0][1]], s = len(v) / 2, c = (D[0][0] + D[1][1] + D[2][2] - 1) / 2;
	const th = Math.atan2(s, Math.max(-1, Math.min(1, c)));
	return s < 1e-12 ? scale(v, 0.5) : scale(v, th / (2 * s));
}

const centre = (s, g) => scale(add(s.P[g.a], s.P[g.b]), 0.5);

/** Inertia tensor (kg m^2) of segment g at pose s about its own centre: m [kt^2 (1 - u u^T) + kl^2 u u^T]. */
function segInertia(s, g) {
	const d = sub(s.P[g.b], s.P[g.a]), l = len(d) || 1, u = scale(d, 1 / l), J = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
	for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) J[i][j] = g.m * (g.kt2 * ((i === j ? 1 : 0) - u[i] * u[j]) + g.kl2 * u[i] * u[j]);
	return J;
}

/** Centre of mass (m) of pose s by the segments' masses (the same point as com.js centerOfMass). */
const comOf = (segs, s) => scale(segs.reduce((acc, g) => add(acc, scale(centre(s, g), g.m)), [0, 0, 0]), 1 / BODY_MASS);

/**
 * The body's momentum at pose `s` between the poses `before` and `after` (dt s apart in all: two frames for a central
 * difference): { L (kg m^2/s, about the centre of mass), J (the whole-body inertia tensor about it, kg m^2), c (m) },
 * or null when sk lacks a segment bone.
 */
function momentumAt(sk, before, s, after, dt) {
	const segs = segmentsOf(sk);
	if (!segs) return null;
	const c = comOf(segs, s), vc = scale(sub(comOf(segs, after), comOf(segs, before)), 1 / dt);
	let L = [0, 0, 0];
	const J = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
	for (const g of segs) {
		const r = sub(centre(s, g), c), v = sub(scale(sub(centre(after, g), centre(before, g)), 1 / dt), vc);
		const w = scale(rotationVector(mul(after.R[g.a], T(before.R[g.a]))), 1 / dt), Jg = segInertia(s, g), rr = dot(r, r);
		L = add(add(L, scale(cross(r, v), g.m)), [0, 1, 2].map(i => dot(Jg[i], w)));
		for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) J[i][j] += Jg[i][j] + g.m * ((i === j ? rr : 0) - r[i] * r[j]);
	}
	return { L, J, c };
}

/** momentumAt for frame index f of frames F (central difference at fps), or null at either end of the take. */
export function momentumOf(sk, F, f, fps) {
	if (f < 1 || f > F.length - 2) return null;
	return momentumAt(sk, F[f - 1].s, F[f].s, F[f + 1].s, 2 / fps);
}
