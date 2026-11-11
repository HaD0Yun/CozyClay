// QA of a take inside the fix pass, as pipeline.js reads it: the fixes that keep a change only where QA is no worse
// (index.js applyFixes, self-repair.js) measure with it.
import { runMotionQa } from "../qa/index.js";

/** QA of out as pipeline.js reads it (frame-range checks following the time map), unexplained. */
export function qaOf(out) {
	const spec = out.ctx.spec, map = out.timeMap, c = structuredClone(spec.checks ?? {}), w = r => (map && Array.isArray(r) ? [Math.round(map(r[0])), Math.round(map(r[1]))] : r);
	for (const name of ["contacts", "orient", "below"]) for (const k of c[name] ?? []) k.when = w(k.when);
	for (const k of c.clearance ?? []) k.frames = w(k.frames);
	return runMotionQa(out.ctx.sk, out, { ...spec, checks: c }, { explain: false });
}
