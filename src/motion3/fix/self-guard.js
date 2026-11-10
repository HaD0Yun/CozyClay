// What one move of the self repair (self-repair.js) must not do to its arm around the frames it moved, read as QA reads
// it: a POP of the elbow or the wrist (qa/style.js isPop on QA's kinematics, past L.accLimb) or a FLIP of the elbow's
// bend plane (more than L.flip deg a frame, read where the arm is bent FLIP_BEND or more, as qa/checks.js flipChecks).
// A move that adds one there, or makes one worse, is not made.
import { sub, len, cross, norm, angle } from "../compiler/math.js";
import { isPop } from "../qa/style.js";
import { QA_LIMITS } from "../qa/checks.js";
import { SIDES } from "./self-hits.js";

const FLIP_BEND = 20, BENT = Math.sin((FLIP_BEND * Math.PI) / 180);
/** popLevel (qa/style.js) reads 3 frames either side; the bend plane is read from the last bent frame within LOOK back. */
const POP_REACH = 3, LOOK = 8;

/** QA's acceleration of joint j over frame indices lo..hi (and the POP_REACH frames either side): { a, A } (qa/style.js kinematics). */
function kin(F, j, lo, hi) {
	const n = F.length, a = new Float64Array(n), A = new Array(n).fill([0, 0, 0]);
	for (let f = Math.max(2, lo - POP_REACH); f <= Math.min(n - 1, hi + POP_REACH); f++) {
		const [x0, x1, x2] = [F[f - 2], F[f - 1], F[f]].map(fr => fr.s.P[j]);
		A[f] = sub(sub(x2, x1), sub(x1, x0));
		a[f] = len(A[f]);
	}
	return { a, A };
}

/**
 * What the guard compares on side k over frame indices lo..hi: per frame index, the larger elbow or wrist pop (0 when
 * none) and the elbow's bend plane turn (deg a frame from the last bent frame; 0 where the arm is near straight).
 */
export function armMotion(out, k, lo, hi) {
	const F = out.frames, I = out.ctx.sk.index, S = SIDES[k], pops = new Float64Array(F.length), turns = new Float64Array(F.length);
	lo = Math.max(0, lo); hi = Math.min(F.length - 1, hi);
	for (const j of [I[`${S}ForeArm`], I[`${S}Hand`]]) {
		const m = kin(F, j, lo, hi);
		for (let f = Math.max(2, lo); f <= hi; f++) if (isPop(m, f, QA_LIMITS.accLimb)) pops[f] = Math.max(pops[f], m.a[f]);
	}
	const [s, e, w] = [`${S}Arm`, `${S}ForeArm`, `${S}Hand`].map(b => I[b]);
	let prev = null, at = 0;
	for (let f = Math.max(0, lo - LOOK); f <= hi; f++) {
		const P = F[f].s.P, up = sub(P[e], P[s]), down = sub(P[w], P[e]), nv = cross(up, down);
		if (len(nv) < BENT * len(up) * len(down)) continue;
		const u = norm(nv);
		if (prev && f >= lo) turns[f] = angle(u, prev) / (f - at);
		prev = u; at = f;
	}
	return { pops, turns, lo, hi };
}

/** Why the arm moves worse in `next` than in `prev` (armMotion over the same frames), or "" when it does not. */
export function moveWorse(prev, next) {
	for (let f = next.lo; f <= next.hi; f++) {
		if (next.pops[f] > prev.pops[f] + 1e-9) return "a pop";
		if (next.turns[f] > QA_LIMITS.flip && next.turns[f] > prev.turns[f] + 1e-9) return "a flip";
	}
	return "";
}
