// Shallow penetration push-out (spec.fix.penetration = max depth in metres past the allowance):
// a hand or forearm capsule inside a scene box moves its wrist IK target out along the box
// normal, eased over neighbouring frames. Deeper hits are staging problems and stay for QA.
// Frames where that arm is FK (armw 0) cannot be pushed and are counted as skipped.
import { add, scale, len } from "../compiler/math.js";
import { QA_LIMITS, allowance } from "../qa/checks.js";
import { capsulesFor, segPoints, sdBox, boxNormal } from "../qa/geometry.js";
import { round4 } from "./ease.js";

const EASE = 4, MARGIN = 0.002, PASSES = 3;
const armParts = (sk, k) => capsulesFor(sk).filter(c => c[0] === `hand_${k}` || c[0] === `farm_${k}`);

/** Per-frame push vectors for side k: the needed exit (normal * excess) summed over boxes. */
function needs(out, k, maxDepth, allow, stats) {
	const { sk } = out.ctx, I = sk.index, n = out.frames.length, v = Array.from({ length: n }, () => null), arm = armParts(sk, k);
	for (let i = 0; i < n; i++) {
		const { s, c } = out.frames[i], objs = out.objectsAt(i);
		let sum = null;
		for (const [id, box] of Object.entries(objs)) {
			if (!box.half || box.ignore) continue;
			let best = null;
			for (const [part, a, b, r] of arm) {
				const lim = allowance(allow, part, id) ?? QA_LIMITS.allow;
				const pts = segPoints(s.P[I[a]], s.P[I[b]]), ds = pts.map(p => sdBox(p, box)), m = Math.min(...ds);
				const excess = r - m - lim;
				if (excess <= 0) continue;
				if (excess > maxDepth) { stats.deep++; continue; }
				if (!best || excess > best[0]) best = [excess, pts[ds.indexOf(m)]];
			}
			if (best) sum = add(sum ?? [0, 0, 0], scale(boxNormal(best[1], box), best[0] + MARGIN));
		}
		if (!sum) continue;
		if (!(c[`armw_${k}`] > 1e-4)) { stats.skipped++; continue; }
		v[i] = sum;
	}
	return v;
}

export function pushOut(out, engine, maxDepth) {
	const allow = out.ctx.spec.checks?.allow, n = out.frames.length, stats = { deep: 0, skipped: 0 };
	const hit = new Set();
	let max = 0;
	for (let pass = 0; pass < PASSES; pass++) {
		stats.deep = 0; stats.skipped = 0;
		const touched = new Set();
		for (const k of ["l", "r"]) {
			const v = needs(out, k, maxDepth, allow, stats), push = out.ctx.push[k];
			// eased dilation of the vectors: neighbours get the strongest nearby push, scaled down
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
		engine.solve([...touched]);
	}
	if (!hit.size && !stats.skipped) return null;
	return { frames: hit.size, max: round4(max), skipped: stats.skipped, tooDeep: stats.deep, how: "hand pushed out along the box normal" };
}
