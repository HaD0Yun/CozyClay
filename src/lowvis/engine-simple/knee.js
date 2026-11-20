// The side a knee bends to. The solver's own pole (the pelvis's forward plus half the foot's) is kept wherever it puts
// the knee on the side a knee can bend to and leaves enough of itself across the hip-ankle line; elsewhere the knee
// is turned about that line to the allowed side. Everything is in the pelvis frame, so it is a property of the leg,
// whatever way the whole figure is turned.
//
// The allowed side: at rest the knee bends about the pelvis's left axis X. That hinge is carried with the thigh by the
// shortest turn from a reference direction 45 degrees forward of hanging straight down to where the thigh points (a
// thigh not twisted about itself). The twist is the angle, about the thigh, from that carried hinge to the knee's own
// hinge (thigh x shin); past 90 degrees the knee bends the wrong way. A knee past it is turned to the twist mirrored
// about 90 (150 becomes 30), on the side nearest its own; a pole that hardly lies across the leg gives way to twist 0
// as it shrinks. The one direction where the carry is undefined points up and back (a hip extended past 135 degrees,
// which no hip reaches).
import { INDEX as J, OFFSET } from "../rig17.js";
import { X, add, clamp, cross, dot, len, mul, norm, qConj, qRotate, sub } from "./math.js";

const REF = norm([0, -1, 1]);
const BAND = 0.25; // how much of the pole (length 0.5..1.5) must lie across the leg for its side to be taken as it is
const L1 = len(OFFSET[J.LeftLeg]), L2 = len(OFFSET[J.LeftFoot]);
const SAMPLES = 36;
const wrapA = x => Math.atan2(Math.sin(x), Math.cos(x));

/** X turned by the shortest turn from REF to unit v (pelvis frame); null near the one undefined direction. */
function hingeAt(v) {
	const c = dot(REF, v), k = cross(REF, v);
	return 1 + c < 1e-6 ? null : add(add(mul(X, c), cross(k, X)), mul(k, dot(k, X) / (1 + c)));
}

/** The pole that bends a knee on a leg from `hip` to `ankle` under the pelvis turn qP, given the solver's `pole`
 *  (solve.js limb's lengths and clamp; the body at the rig's own size). */
export function kneePole(qP, hip, ankle, pole) {
	const inv = qConj(qP), d = qRotate(inv, norm(sub(ankle, hip), [0, -1, 0])), pl = qRotate(inv, pole);
	const across = sub(pl, mul(d, dot(pl, d))), m = len(across);
	const dist = Math.min(Math.max(len(sub(ankle, hip)), Math.abs(L1 - L2) + 1e-4), (L1 + L2) * 0.9995);
	const a = (L1 * L1 - L2 * L2 + dist * dist) / (2 * dist), h = Math.sqrt(Math.max(0, L1 * L1 - a * a));
	// the knee side at angle phi about the leg from e1, and the twist (rad, signed) it gives; null where undefined
	const e0 = hingeAt(d);
	if (!e0) return pole;
	const e1 = cross(d, e0), e2 = cross(d, e1);
	const side = phi => add(mul(e1, Math.cos(phi)), mul(e2, Math.sin(phi)));
	const twist = p => {
		const t = norm(add(mul(d, a), mul(p, h))), c = hingeAt(t), b = cross(p, d);
		return c && Math.atan2(dot(cross(c, b), t), dot(c, b));
	};
	const w = clamp(m / BAND), phiB = m > 1e-12 ? Math.atan2(dot(across, e2), dot(across, e1)) : 0, tB = m > 1e-12 ? twist(norm(across)) : 0;
	if (tB === null) return pole;
	if (w >= 1 && Math.abs(tB) <= Math.PI / 2) return pole;
	const goal = w * (Math.abs(tB) <= Math.PI / 2 ? tB : Math.sign(tB) * (Math.PI - Math.abs(tB)));
	// the side whose twist is the goal: the crossing nearest the pole's own angle among SAMPLES steps, halved; with no
	// crossing, the side whose twist comes nearest the goal
	const f = phi => { const v = twist(side(phi)); return v === null ? null : wrapA(v - goal); };
	const step = 2 * Math.PI / SAMPLES;
	let best = null, near = null, nearF = Infinity;
	for (let i = 0; i < SAMPLES; i++) {
		const p0 = phiB + step * (i - SAMPLES / 2), p1 = p0 + step, f0 = f(p0), f1 = f(p1);
		if (f0 !== null && Math.abs(f0) < nearF) { nearF = Math.abs(f0); near = p0; }
		if (f0 === null || f1 === null || f0 * f1 > 0 || Math.abs(f0 - f1) > Math.PI) continue;
		let lo = p0, hi = p1, flo = f0;
		for (let n = 0; n < 40; n++) { const mid = (lo + hi) / 2, fm = f(mid); if (fm === null) break; if (fm * flo > 0) { lo = mid; flo = fm; } else hi = mid; }
		const at = (lo + hi) / 2;
		if (best === null || Math.abs(wrapA(at - phiB)) < Math.abs(wrapA(best - phiB))) best = at;
	}
	if (best === null && near !== null) {
		let lo = near - step, hi = near + step;
		const g = phi => Math.abs(f(phi) ?? Math.PI);
		for (let n = 0; n < 40; n++) { const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3; if (g(m1) < g(m2)) hi = m2; else lo = m1; }
		best = (lo + hi) / 2;
	}
	return best === null ? pole : qRotate(qP, side(best));
}
