// install: "ifClean" (variant K): does a take with this QA go on over the installed one? A clean take, the first take, any take
// over one whose QA cannot be measured, and one that beats the installed take (fewer groups, then fewer frame issues). Plain data
// in and out, so the compile job (compile-job.js: a take that will not go on is not thinned) and the command (motion3-installed.js)
// decide it the same way.
const issues = groups => groups.reduce((n, g) => n + (g.count ?? 1), 0);
const UNMEASURED = "the installed take's QA could not be measured (it carries no spec, or its spec no longer compiles), so install: \"ifClean\" installed this take";

/** on: { groups } of the installed take (groups null: not measurable), or null when none is on; qa: the new take's. */
export function installVerdict(on, qa) {
	if (qa.ok || !on) return { wanted: true };
	if (!on.groups) return { wanted: true, note: UNMEASURED };
	const was = on.groups;
	return { wanted: qa.groups.length < was.length || (qa.groups.length === was.length && issues(qa.groups) < issues(was)) };
}
