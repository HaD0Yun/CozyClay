// Why a limb of a "reach:" row (measure.mjs) ends off its target, from the facts the engine put in that limb's reach
// entries (src/lowvis/engine-simple/reach.js) on the row's worst frame. Facts and numbers only. A reason that starts with
// "why:" lies in the spec (where the body, the target or the timing is, or another target of the same limb); one that
// starts with "engine limit:" does not, and no spec removes it. Works for any reach slot, whatever made its target.
import { LIMBS } from "../engine-simple/reach.js";
import { MAX_STEP } from "../engine-simple/solve.js";

const mm = v => `${Math.round(v * 1000)} mm`, m = v => `${v.toFixed(2)} m`;
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** The reason of one limb: list = that limb's entries by frame (null where it has none), f = the worst frame, slot =
 *  its place in the reach row (0 L hand .. 5 R elbow), s = the body's scale. */
export function reachWhy(list, f, slot, s = 1) {
	const e = list[f], S = LIMBS[slot], length = S.length * s;
	const first = list.findIndex(x => x && x.key === e.key), e0 = list[first];
	if (e.beyond != null && (S.exact ? Math.abs(e.beyond) : e.beyond) > 0.01) {
		const where = !S.exact ? `${mm(e.beyond)} beyond the ${S.part}'s reach (${m(length)}) from the ${S.from}`
			: e.beyond > 0 ? `${mm(e.beyond)} farther from the ${S.from} than the ${S.part} is long (${m(length)})`
			: `${mm(-e.beyond)} nearer the ${S.from} than the ${S.part} is long (${m(length)}); an elbow is always that far from the ${S.from}`;
		// the root moved by the spec's own actions (the reach assist's hinge the same on both frames)
		const moved = e0?.r && e.r && Math.abs((e.bend ?? 0) - (e0.bend ?? 0)) < 0.01 ? dist(e.r, e0.r) : 0;
		return `why: on that frame the target is ${where}${moved > 0.01 ? `; the ${S.from} is ${mm(moved)} from where it was at f${first}, the first frame after the blend` : ""}${e.spent ? "; the reach assist was hinged at the hips as far as it goes" : ""}`;
	}
	if (e.circle > 0.01 && e.circle > e.d - 0.01) return `why: the wrist's own target holds the elbow: with the wrist there the elbow comes no nearer than ${mm(e.circle)}`;
	if (e.slow) return `why: late: a wrist moves at most ${mm(MAX_STEP * s)} a frame in the body frame unless its key says fast, and on that frame it was still on its way`;
	if (e.floor > 0.01) return `why: the floor holds the foot: the target is ${mm(e.floor)} lower than the floor lets the ankle go`;
	return `engine limit: the target is in the ${S.part}'s reach and nothing the engine knows holds the ${S.joint}; it misses by ${mm(e.d)}, and no spec removes that`;
}
