// What one move of the self repair (self-repair.js) must not do to its arm around the frames it moved, read as QA reads
// it: a POP of the elbow or the wrist (qa/style.js isPop on QA's kinematics, past L.accLimb) or a FLIP of the elbow's
// bend plane (more than L.flip deg a frame, read where the arm is bent FLIP_BEND or more, as qa/checks.js flipChecks).
// A move that adds one there, or makes one worse (a joint's POP by QA's grouping: more pops, or a harder one than its
// hardest in the take), is not made.
import { sub, len, cross, norm, angle } from "../compiler/math.js";
import { isPop } from "../qa/style.js";
import { QA_LIMITS } from "../qa/checks.js";
import { SIDES, handHold } from "./self-hits.js";
import { bodyDistance } from "../body.js";

/** A span may pull a keyed free hand's wrist no more than KEY_TOL (m) farther off its key than it was, where the key is
 * KEY_CLEAR or more clear of the skin (a reach out in front: a cup); a key nearer the skin is where the body is in the
 * way (a hand keyed at the far hip, on the opposite shoulder, into the thigh) and the repair moves the hand off it. */
export const KEY_TOL = 0.01;
const KEY_CLEAR = 0.08;
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

/**
 * The key frames of free IK hands (out.keys setting hand_l or hand_r, no anchor, fit, carry or contact on the hand, armw
 * 0.5 or more) whose keyed target is KEY_CLEAR or more clear of the skin:
 * [{ j (frame index), k, t (the target), b (the hand bone) }]. QA reads a REACH against the target the repair pushed, so it
 * cannot see a hand pulled off its key; the repair's gate reads it here (keyOff).
 */
export function keyedHands(out, body) {
	const { sk, spec } = out.ctx, f0 = out.f0 ?? 0, list = [];
	for (const key of out.keys ?? []) for (const k of ["r", "l"]) {
		const j = key.f - f0, fr = out.frames[j], ch = `hand_${k}`, b = sk.index[`${SIDES[k]}Hand`];
		if (!fr || !(ch in (key.set ?? {})) || !Array.isArray(fr.c[ch]) || (fr.c[`armw_${k}`] ?? 0) < 0.5 || handHold(spec, fr, f0 + j, k).hold !== null) continue;
		if (bodyDistance(body, fr.s, fr.c[ch], body.skip.get(b)).d >= KEY_CLEAR && !list.some(x => x.j === j && x.k === k)) list.push({ j, k, t: fr.c[ch], b });
	}
	return list;
}

/** How far (m) each keyed hand of `keyed` (keyedHands) on frame indices a..b is from its key now: [{ ...x, d }]. */
export const keyOff = (out, keyed, a, b) => keyed.filter(x => x.j >= a && x.j <= b).map(x => ({ ...x, d: len(sub(out.frames[x.j].s.P[x.b], x.t)) }));
