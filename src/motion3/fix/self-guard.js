// What one move of the self repair (self-repair.js) must not do to its arm around the frames it moved, read as QA reads
// it: a POP of the elbow or the wrist (qa/style.js isPop on QA's kinematics, past L.accLimb) or a FLIP of the elbow's
// bend plane (more than L.flip deg a frame, read where the arm is bent FLIP_BEND or more, as qa/checks.js flipChecks).
// A move that adds one there, or makes one worse (a joint's POP by QA's grouping: more pops, or a harder one than its
// hardest in the take), is not made.
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
 * What the guard compares on side k over frame indices lo..hi: per frame index, the elbow's and the wrist's pop (pops
 * [elbow, wrist], 0 when none: QA reads a POP for each joint, so one getting worse is not hidden by the other getting
 * better) and the elbow's bend plane turn (deg a frame from the last bent frame; 0 where the arm is near straight).
 */
export function armMotion(out, k, lo, hi) {
	const F = out.frames, I = out.ctx.sk.index, S = SIDES[k], turns = new Float64Array(F.length);
	lo = Math.max(0, lo); hi = Math.min(F.length - 1, hi);
	const pops = [I[`${S}ForeArm`], I[`${S}Hand`]].map(j => {
		const m = kin(F, j, lo, hi), p = new Float64Array(F.length);
		for (let f = Math.max(2, lo); f <= hi; f++) if (isPop(m, f, QA_LIMITS.accLimb)) p[f] = m.a[f];
		return p;
	});
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

/** Each joint's hardest pop outside frame indices lo..hi in armMotion m of the whole take (0 when none). */
export const popsOutside = (m, lo, hi) => m.pops.map(p => p.reduce((x, v, f) => (f < lo || f > hi ? Math.max(x, v) : x), 0));

/**
 * Why the arm moves worse in `next` than in `prev` (armMotion over the same frames), or "" when it does not. QA's POP
 * group of a joint is its pop count times how far its hardest pop is past the limit (qa/severity.js), so per joint more
 * pops over these frames is worse, and so is a harder pop than the joint's hardest in the take (`rest`: popsOutside
 * these frames; none by default, so any harder pop is).
 */
export function moveWorse(prev, next, rest = [0, 0]) {
	const read = (p, r) => { let n = 0, max = r; for (let f = next.lo; f <= next.hi; f++) if (p[f] > 0) { n++; max = Math.max(max, p[f]); } return { n, max }; };
	for (let j = 0; j < next.pops.length; j++) {
		const a = read(prev.pops[j], rest[j]), b = read(next.pops[j], rest[j]);
		if (b.n > a.n || b.max > a.max + 1e-9) return "a pop";
	}
	for (let f = next.lo; f <= next.hi; f++) if (next.turns[f] > QA_LIMITS.flip && next.turns[f] > prev.turns[f] + 1e-9) return "a flip";
	return "";
}
