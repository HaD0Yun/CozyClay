// Why a limb of a "reach:" row (measure.mjs) ends off its target, from the facts the engine put in that limb's reach
// entries (src/lowvis/engine-simple/reach.js) on the row's worst frame. Facts and numbers only. Every fact that holds
// there is weighed by how many millimetres of the miss it accounts for and told largest first. A reason that starts
// with "why:" lies in the spec (where the body, the target or the timing is, or another target of the same limb); one
// that starts with "engine limit:" is a miss, or the larger part of one, that no fact the engine knows accounts for.
// Works for any reach slot, whatever made its target.
import { LIMBS } from "../engine-simple/reach.js";
import { MAX_STEP } from "../engine-simple/solve.js";

const mm = v => `${Math.round(v * 1000)} mm`, m = v => `${v.toFixed(2)} m`;
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
// m: a fact under NAMED is not named; a part of the miss over TOLD that no fact accounts for is, and a settled miss (settledBy) that has moved by more is told again
const NAMED = 0.005, TOLD = 0.01;

/** The facts of entry e as [{ v: metres of the miss it accounts for, text }]; e0 is the limb's first entry of the action. */
function facts(e, e0, first, S, s) {
	const out = [], length = S.length * s, off = e.beyond == null ? 0 : S.exact ? Math.abs(e.beyond) : e.beyond;
	if (off > NAMED) {
		const where = !S.exact ? `${mm(e.beyond)} beyond the ${S.part}'s reach (${m(length)}) from the ${S.from}`
			: e.beyond > 0 ? `${mm(e.beyond)} farther from the ${S.from} than the ${S.part} is long (${m(length)})`
			: `${mm(-e.beyond)} nearer the ${S.from} than the ${S.part} is long (${m(length)}); an elbow is always that far from the ${S.from}`;
		const moved = e0?.r && e.r ? dist(e.r, e0.r) : 0, b0 = e0?.bend ?? 0, b = e.bend ?? 0, d0 = e0?.drop ?? 0, d1 = e.drop ?? 0;
		const assisted = Math.abs(b - b0) >= 0.01 || Math.abs(d1 - d0) >= 0.005; // the reach assist moved the body in between
		const since = moved > TOLD ? `; the ${S.from} is ${mm(moved)} from where it was at f${first}, the first frame after the blend${assisted ? `, and the reach assist moved the body in between (hinge ${b0.toFixed(2)} to ${b.toFixed(2)} rad, hips lowered ${mm(d0)} to ${mm(d1)})` : ""}` : "";
		out.push({ v: off, length: !!S.exact, text: `on that frame the target is ${where}${since}${e.spent ? "; the reach assist was hinged at the hips as far as it goes" : ""}` });
	}
	if (e.circle > NAMED) out.push({ v: e.circle, own: true, text: `the wrist's own target holds the elbow: with the wrist there the elbow comes no nearer than ${mm(e.circle)}` });
	if (e.slow > NAMED) out.push({ v: e.slow, text: S.exact ? `late: this elbow turns its free wrist with it, a wrist moves at most ${mm(MAX_STEP * s)} a frame in the body frame unless the key says fast, and that held the elbow ${mm(e.slow)} from where its blend had it on that frame`
		: `late: a wrist moves at most ${mm(MAX_STEP * s)} a frame in the body frame unless its key says fast, and on that frame it was still ${mm(e.slow)} short of where its blend had it` });
	if (e.floor > NAMED) out.push({ v: e.floor, text: `the floor holds the foot: the target is ${mm(e.floor)} lower than the floor lets the ankle go` });
	if (e.drift > NAMED) out.push({ v: e.drift, text: e.on == null ? `the target is on the own body and moved ${mm(e.drift)} with the pose that reached for it`
		: `the target is on ${e.on}, which moved it ${mm(e.drift)} on that frame after this pose was aimed at it${e.back ? `; ${e.on} has a target on this body too, so each aims at where the other was` : ""}${
			(e.bend ?? 0) >= 0.01 || (e.drop ?? 0) >= NAMED ? `; on that frame the reach assist has this body hinged ${e.bend.toFixed(2)} rad at the hips and its hips ${mm(e.drop)} lower` : ""}` });
	return out.sort((x, y) => y.v - x.v);
}

/** The reason of one limb: list = that limb's entries by frame (null where it has none), f = the worst frame, slot =
 *  its place in the reach row (0 L hand .. 5 R elbow), s = the body's scale. */
export function reachWhy(list, f, slot, s = 1) {
	const e = list[f], S = LIMBS[slot], first = list.findIndex(x => x && x.key === e.key);
	// rest: the part of the miss the facts together do not reach (two facts may overlap, so it is never over-told)
	const all = facts(e, list[first], first, S, s), top = all[0]?.v ?? 0, rest = e.d - all.reduce((sum, x) => sum + x.v, 0);
	if (!all.length) return `engine limit: ${e.beyond == null ? "" : `the target is in the ${S.part}'s reach and `}no fact the engine knows holds the ${S.joint} on that frame; it misses by ${mm(e.d)}`;
	const why = `why: ${all.map(x => x.text).join("; also: ")}`;
	if (rest <= TOLD) return why;
	return rest > top ? `engine limit: no fact the engine knows accounts for ${mm(rest)} of the ${mm(e.d)}; ${why}` : `${why}; ${mm(rest)} of the ${mm(e.d)} no fact the engine knows accounts for`;
}

/** Whether one action of a limb (k: byAction's record, from instances.mjs) ends where the spec's own order of targets puts
 *  it: on every frame it is over TOLD off, the facts are only that the same arm's wrist target holds the elbow (the
 *  nearest the elbow can come with the wrist there and the upper arm its length) and that the target is off the sphere
 *  the upper arm's length gives, and the first accounts for the miss to within TOLD. The SPEC text gives that order
 *  (engine.js, elbowL|elbowR: the elbow "lies on it when the wrist's place and the arm's length allow"), so such a miss
 *  is what the two targets ask together. Never for a hand or a foot: no target of theirs yields to another.
 *  -> false, or TOLD in millimetres: how far such a miss may move before it is told again (told.mjs). */
export function settledBy(list, k, slot, s = 1) {
	const S = LIMBS[slot], first = list.findIndex(x => x && x.key === k.key);
	for (let f = k.a; f <= k.b; f++) {
		const e = list[f];
		if (!e || e.key !== k.key || e.d <= TOLD) continue;
		const all = facts(e, list[first], first, S, s), own = all.find(x => x.own);
		if (!own || all.some(x => !x.own && !x.length) || e.d - own.v > TOLD) return false;
	}
	return TOLD * 1000;
}
