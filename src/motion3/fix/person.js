// Person push-out (spec.fix.person, on by default): an arm capsule (upper arm, forearm, hand) inside another character
// (scene.people, their installed take; qa/people-checks.js PERSON) moves its wrist IK target out by the depth plus a margin,
// eased over neighbouring frames, the same way push.js takes a hand out of a box. No depth limit: a hand keyed deep into
// someone comes out too. The escape keeps the side the hand came from: a normal that points the opposite way from the
// previous frame's (the first frame of a pass: from their hips to mine, level), or away from my side of them (that level
// line), is replaced by the previous one, so a hand past their axis is pulled back the way it came instead of out through
// their back (the previous frame alone lets the normal turn a little each frame until it points through them). Fixed passes and fixed order (people by id, their
// capsules in CAPSULES order), no time or random cut-off: the same spec gives the same take. Frames where that arm is FK
// (armw 0) cannot be pushed and are counted as skipped. An intended touch (checks.allow { part, object: "person:<id>",
// depth }) may go that deep.
import { add, sub, scale, dot, len, clamp } from "../compiler/math.js";
import { QA_LIMITS, allowance } from "../qa/checks.js";
import { CAPSULES, capsulesFor, segPoints } from "../qa/geometry.js";
import { personCapsules } from "../qa/people-checks.js";
import { round4 } from "./ease.js";

const EASE = 4, MARGIN = 0.004, PASSES = 6, APART = 2.2;
const armParts = (sk, k) => capsulesFor(sk).filter(c => c[0] === `uarm_${k}` || c[0] === `farm_${k}` || c[0] === `hand_${k}`);

/** The closest points of segment PQ (sampled as qa/geometry.js segDist does, so the depth is QA's) and segment CD. */
function closest(P, Q, C, D) {
	const d2 = sub(D, C), dd = dot(d2, d2);
	let best = null;
	for (const a of segPoints(P, Q)) {
		const u = dd < 1e-12 ? 0 : clamp(dot(sub(a, C), d2) / dd, 0, 1), b = add(C, scale(d2, u)), d = len(sub(a, b));
		if (!best || d < best.d) best = { a, b, d };
	}
	return best;
}

/** Level unit vector from a to b (their hips to mine), or null when they are on top of each other. */
function level(a, b) {
	const v = [b[0] - a[0], 0, b[2] - a[2]], l = len(v);
	return l > 1e-6 ? scale(v, 1 / l) : null;
}

/** The bodies to keep out of: [id, person] sorted by id, only those whose take has every capsule joint. */
function bodies(out) {
	return Object.entries(out.ctx?.scene?.people ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.filter(([, p]) => CAPSULES.every(([, a, b]) => p.names.includes(a) && p.names.includes(b)));
}

/** Per-frame push vectors for side k: the escape (side-kept normal * (depth past what is allowed + margin)) summed over people. */
function needs(out, k, people, lim, allow, stats) {
	const { sk } = out.ctx, I = sk.index, n = out.frames.length, f0 = out.f0 ?? 0, v = Array.from({ length: n }, () => null), arm = armParts(sk, k);
	const prev = new Map();
	for (let i = 0; i < n; i++) {
		const { s, c } = out.frames[i];
		let sum = null;
		for (const [id, p] of people) {
			const theirs = personCapsules(p, i + f0), hips = theirs.find(t => t[0] === "hips")[1];
			if (len(sub(s.P[I.Hips], hips)) > APART) continue;
			let best = null;
			for (const [part, a, b, r] of arm) {
				const meant = allowance(allow, part, `person:${id}`), limit = meant ?? lim, A = s.P[I[a]], B = s.P[I[b]];
				for (const [, C, D, q] of theirs) {
					const hit = closest(A, B, C, D), depth = r + q - hit.d;
					if (depth > limit && (!best || depth - (meant ?? 0) > best.need)) best = { need: depth - (meant ?? 0), hit };
				}
			}
			if (!best) continue;
			const side = level(hips, s.P[I.Hips]) ?? [0, 0, 0], ref = prev.get(id) ?? side;
			let nrm = best.hit.d > 1e-6 ? scale(sub(best.hit.a, best.hit.b), 1 / best.hit.d) : ref;
			if (dot(nrm, ref) < 0 || dot(nrm, side) < 0) nrm = ref;
			prev.set(id, nrm);
			sum = add(sum ?? [0, 0, 0], scale(nrm, best.need + MARGIN));
		}
		if (!sum) continue;
		if (!(c[`armw_${k}`] > 1e-4)) { stats.skipped++; continue; }
		v[i] = sum;
	}
	return v;
}

export function personOut(out, engine) {
	const people = bodies(out);
	if (!people.length) return null;
	const { checks = {} } = out.ctx.spec, lim = { ...QA_LIMITS, ...checks.limits }.allow, n = out.frames.length, stats = { skipped: 0 };
	const hit = new Set();
	let max = 0, passes = 0;
	for (let pass = 0; pass < PASSES; pass++) {
		stats.skipped = 0;
		const touched = new Set();
		for (const k of ["l", "r"]) {
			const v = needs(out, k, people, lim, checks.allow, stats), push = out.ctx.push[k];
			// eased dilation of the vectors: neighbours get the strongest nearby push, scaled down (push.js)
			const eased = Array.from({ length: n }, () => null);
			for (let i = 0; i < n; i++) {
				if (!v[i]) continue;
				hit.add(`${k}${i}`);
				for (let j = Math.max(0, i - EASE - 1); j <= Math.min(n - 1, i + EASE + 1); j++) {
					const t = 1 - Math.abs(i - j) / (EASE + 1), w = scale(v[i], t * t * (3 - 2 * t));
					if (!eased[j] || len(w) > len(eased[j])) eased[j] = w;
				}
			}
			for (let i = 0; i < n; i++) {
				if (!eased[i]) continue;
				const f = out.f0 + i, next = add(push.get(f) ?? [0, 0, 0], eased[i]);
				push.set(f, next);
				max = Math.max(max, len(next));
				touched.add(f);
			}
		}
		if (!touched.size) break;
		passes++;
		engine.solve([...touched]);
	}
	if (!hit.size && !stats.skipped) return null;
	return { frames: hit.size, max: round4(max), passes, skipped: stats.skipped, how: "hand pushed out of the other person, back the way it came" };
}
