// C6. A hint's patch is offered only when it was compiled and helped. The logs: a patch applied as sent made the take
// worse 49% of the time (better 40%), and the agent spent compiles finding that out. So the first CHECKED groups that
// carry a patch (qa.groups order) each get one compile of the spec with their patch, and the patch stays on the group
// only when its own group gets lower and qa/verdict.js compareQa calls the whole result better (no goal lost, no more
// problems, nothing that got worse costs more than half of what got better); the group then says what it measured
// (patchChecked). Otherwise the patch is taken off and patchTried says what it did; the hint's words stay. A patch past
// the first CHECKED is not compiled and not offered. A spec repair or an earlier check already
// compiled is not compiled again (`compile` may answer from its cache).
import { applyPatch } from "./json-patch.js";
import { groupKey } from "./qa/severity.js";
import { compareQa, severityIn } from "./qa/verdict.js";

const CHECKED = 2;
const r2 = x => Math.round(x * 100) / 100;

/**
 * checkHints(spec, qa, compile) -> qa (its groups changed in place)
 * @param {object} spec  the spec the patches address (qa's own)
 * @param {object} qa  runMotionQa's answer for spec
 * @param {(spec: object) => object | null} compile  spec -> its qa, or null when it is out of time (the patch is dropped)
 */
export function checkHints(spec, qa, compile) {
	let n = 0;
	for (const g of qa?.groups ?? []) {
		if (!g.patch) continue;
		if (n >= CHECKED) { delete g.patch; continue; }
		n += 1;
		const key = groupKey(g);
		let next;
		try { next = compile(applyPatch(spec, g.patch)); } catch (error) { next = { error: String(error?.message ?? error).slice(0, 160) }; }
		const tried = g.patch.map(o => `${o.op} ${o.path}`).join(", "), patch = g.patch;
		delete g.patch;
		// null: the compile had used its time (compile-job.js HINT_LIMIT_MS), so the patch is not compiled and not offered
		if (next === null) { g.patchTried = `${tried}: not compiled (the compile had used its time)`; continue; }
		if (next?.error || !next?.groups) { g.patchTried = `${tried}: does not compile (${next?.error ?? "no QA"})`; continue; }
		const own = [r2(severityIn(qa, key)), r2(severityIn(next, key))], v = compareQa(next, qa);
		if (own[1] < own[0] && v.better) {
			g.patch = patch;
			g.patchChecked = { severity: own, total: v.sev, problems: v.problems };
			continue;
		}
		const why = !(own[1] < own[0]) ? `this group ${own[0]} -> ${own[1]}` : v.why;
		g.patchTried = `${tried}: compiled, did not help (${why}${why.startsWith("problems") ? "" : `; problems ${v.problems[0]} -> ${v.problems[1]}`})`;
	}
	return qa;
}
