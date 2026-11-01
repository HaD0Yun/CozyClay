// A compiled X Bot frame (world bone positions and rotations, CozyClay space) -> the SOMA pose the model reads:
// a root position and 30 world rotations in SOMA space, positions by SOMA forward kinematics so they agree with the
// rotations the way the model's training data does. Each SOMA joint turns with an X Bot bone and a constant frame
// offset between the two rigs' rest frames (soma-calib.js). The arms and legs are then re-aimed by two-bone IK on
// SOMA's bone lengths so the wrists and ankles land on the X Bot's, the elbows and knees bending toward the X Bot's
// (only the two limb bones turn; hands and feet keep their own orientation). Dropped X Bot detail: SOMA's Neck2
// follows the Neck, the Jaw and eyes the Head, the finger tips the hand.
import { add, sub, scale, cross, dot, norm, len, mul, apply, axisRot, matFromQuat, clamp } from "../compiler/math.js";
import { SOMA_JOINTS, SOMA_OFFSET, SOMA_PARENT, SID, XBOT_BONE, toSomaPoint, toSomaRot, somaFK } from "./soma.js";
import { SOMA_CALIB } from "./soma-calib.js";

const CALIB = SOMA_CALIB.map(q => { const n = Math.hypot(...q); return matFromQuat(q.map(v => v / n)); });
const LIMBS = ["Left", "Right"].flatMap(S => [[`${S}Arm`, `${S}ForeArm`, `${S}Hand`, `${S}Arm`, `${S}ForeArm`, `${S}Hand`],
	[`${S}Leg`, `${S}Shin`, `${S}Foot`, `${S}UpLeg`, `${S}Leg`, `${S}Foot`]]);

/** The rotation taking unit direction a onto unit direction b by the shortest arc. */
function arc(a, b) {
	const c = cross(a, b), s = len(c);
	if (s < 1e-9) return [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
	return axisRot(norm(c), Math.atan2(s, dot(a, b)) * 180 / Math.PI);
}

function worldPos(root, R, j) {
	let p = [0, 0, 0];
	for (let a = j; a > 0; a = SOMA_PARENT[a]) p = add(p, apply(R[SOMA_PARENT[a]], SOMA_OFFSET[a]));
	return add(root, p);
}

/** Aims limb a-b-c (SOMA joints) at target t with the middle joint toward pole point m. Mutates R. */
function aimLimb(root, R, a, b, c, t, m) {
	const A = worldPos(root, R, a), l1 = len(SOMA_OFFSET[b]), l2 = len(SOMA_OFFSET[c]);
	const d = clamp(len(sub(t, A)), Math.abs(l1 - l2) + 1e-4, l1 + l2 - 1e-4), u = norm(sub(t, A));
	const pm = sub(m, A), v = norm(sub(pm, scale(u, dot(pm, u))));
	const ca = clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1);
	const B = add(A, add(scale(u, l1 * ca), scale(v, l1 * Math.sqrt(1 - ca * ca)))), E = add(A, scale(u, d));
	R[a] = mul(arc(norm(apply(R[a], SOMA_OFFSET[b])), norm(sub(B, A))), R[a]);
	R[b] = mul(arc(norm(apply(R[b], SOMA_OFFSET[c])), norm(sub(E, B))), R[b]);
}

/**
 * sk: the compiler skeleton (index), s: a compiled frame state { P, R } (CozyClay space).
 * Returns { root, R, P } in SOMA space.
 */
export function somaPose(sk, s) {
	const R = SOMA_JOINTS.map((_, j) => toSomaRot(mul(s.R[sk.index[XBOT_BONE[j]]], CALIB[j])));
	const X = n => toSomaPoint(s.P[sk.index[n]]);
	const hipmid = scale(add(X("LeftUpLeg"), X("RightUpLeg")), 0.5);
	const root = sub(hipmid, apply(R[0], scale(add(SOMA_OFFSET[SID.LeftLeg], SOMA_OFFSET[SID.RightLeg]), 0.5)));
	for (const [a, b, c, xa, xb, xc] of LIMBS) {
		// the pole point: the X Bot's elbow/knee, moved with the limb root so it is read relative to SOMA's joint
		const shift = sub(worldPos(root, R, SID[a]), X(xa));
		aimLimb(root, R, SID[a], SID[b], SID[c], X(xc), add(X(xb), shift));
	}
	return { root, R, P: somaFK(root, R) };
}
