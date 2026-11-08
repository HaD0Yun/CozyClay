// v4 qa: the old engine's motion QA (runMotionQa) on the current raw take, as information only.
// There is no ok, no gate and no blocking flag: on the bench this QA agreed with the owner on 1 of 10
// tasks and went the other way on 5 (research wave-2-Vraw), so the model reads it as hints. On top of
// runMotionQa: POP frames that end a ballistic air run move to impacts (impact.js), air runs that
// fall slower or faster than g are listed (air.js), and spec-free hand checks run (hands.js).
import { runMotionQa } from "../../motion3/qa/index.js";
import { ballisticImpacts } from "./impact.js";
import { airAccel } from "./air.js";
import { handChecks } from "./hands.js";

const FIELDS = ["kind", "subject", "count", "first", "last", "worstFrame", "worst"];
const pick = g => Object.fromEntries(FIELDS.map(k => [k, g[k]]));

/**
 * runV4Qa(out, { from, to, kinds, hands = true }) -> { total, groups, impacts, air, hands, ms }
 *   groups  runMotionQa groups without the ballistic landings: [{ kind, subject, count, first, last, worstFrame, worst }]
 *   impacts [{ joint, frame, run: [a, b], gRatio }]   air [{ from, to, g }]   hands  hand groups (group fields)
 *   total   the frame-level issues in groups and hands; ms the time it took
 * from/to (absolute frames, inclusive) keep groups and rows that overlap the range. kinds keeps those
 * group kinds; with kinds, impacts stay when it names IMPACT or POP and air rows when it names AIR.
 */
export function runV4Qa(out, { from, to, kinds, hands = true } = {}) {
	const t0 = performance.now(), f0 = out.f0 ?? 0, last = f0 + out.frames.length - 1;
	const lo = Math.max(f0, from ?? f0), hi = Math.min(last, to ?? last);
	const want = kind => !kinds?.length || kinds.includes(kind), overlaps = (a, b) => b >= lo && a <= hi;
	const keep = gs => gs.filter(g => want(g.kind) && overlaps(g.first, g.last)).map(pick);
	const qa = runMotionQa(out.ctx.sk, out, out.ctx.spec, { explain: false });
	const split = ballisticImpacts(out, qa.groups);
	const groups = keep(split.groups), handGroups = hands ? keep(handChecks(out)) : [];
	const impacts = want("IMPACT") || want("POP") ? split.impacts.filter(r => overlaps(r.frame, r.frame)) : [];
	const air = want("AIR") ? airAccel(out).filter(r => overlaps(r.from, r.to)) : [];
	const total = [...groups, ...handGroups].reduce((s, g) => s + g.count, 0);
	return { total, groups, impacts, air, hands: handGroups, ms: Math.round(performance.now() - t0) };
}
