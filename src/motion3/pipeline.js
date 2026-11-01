// One compile as motion.compile runs it: frames "auto" resolves (skills/frames-auto.js), open
// parameters are searched (search.js), unnamed checks get their index as a name (on a copy,
// qa/check-names.js), skills expand (skills/), the spec is validated strictly (leniently for a
// saved take compiled again), the compiler bakes and auto-fixes the frames, QA measures them with
// a cause and a hint per issue group against the agent's own spec, the style quantities are
// measured (qa/style.js observeMotion; keyed objects: every key as drawn, qa/key-checks.js
// heldReadings; each hand and foot against the nearest object, qa/near.js observeNear; each holding
// wrist's bend, qa/wrist-obs.js observeWrist; how mechanical it reads against the agent's own
// keys, qa/motion-life.js observeLife; a skill
// paced to fit a short span: observations.paced; a carried spring whose base is far from the hand:
// qa/spring-pivot.js observations.spring; a skill whose release or
// settle the last frame cut: observations.cut; what the spec asked against what it got, per skill,
// contact and goal: qa/asked.js observeAsked), and the timeline and the
// requested probes read the result.
// prepareSpec (correct.js) first corrects slips with one reading and fits walkTo strides, both kept in the
// stored spec; liftRequest takes what the agent obviously meant: spec.probes are request probes, and a
// bare goals[].moved id is object:<id>; relaxSpec (lenient.js) fixes mechanical slips in the expanded
// spec before validation and the answer lists each fix in notes.
import { expandPoses } from "./poses.js";
import { compileMotion } from "./compiler/compile.js";
import { validateSpec } from "./compiler/validate.js";
import { runMotionQa } from "./qa/index.js";
import { observeMotion } from "./qa/style.js";
import { nameChecks } from "./qa/check-names.js";
import { expandUse } from "./skills/index.js";
import { resolveFrames } from "./skills/frames-auto.js";
import { markFramesAuto } from "./spec-store.js";
import { findParams, searchParams } from "./search.js";
import { timelineOf } from "./timeline.js";
import { runProbes } from "./probes.js";
import { canonicalGoals } from "./compiler/validate-goals.js";
import { heldReadings, HELD_UNITS } from "./qa/key-checks.js";
import { observeNear, NEAR_UNITS } from "./qa/near.js";
import { observeWrist, WRIST_UNITS } from "./qa/wrist-obs.js";
import { observeLoad, LOAD_UNITS } from "./load.js";
import { observeLife, LIFE_UNITS } from "./qa/motion-life.js";
import { observeGait, GAIT_UNITS } from "./qa/gait-observe.js";
import { springPivots } from "./qa/spring-pivot.js";
import { planWalks, applyWalkPlans } from "./walk-plan.js";
import { relaxSpec } from "./lenient.js";
import { observeAsked } from "./qa/asked.js";
import { prepareSpec } from "./correct.js";
import { compareQa, noWorse } from "./qa/verdict.js";

const ms = t => Math.round(performance.now() - t);

/** A spec after retime: frame-range checks follow the keys they were written against. */
function warpChecks(spec, map) {
	const c = structuredClone(spec.checks ?? {}), w = r => (Array.isArray(r) ? [Math.round(map(r[0])), Math.round(map(r[1]))] : r);
	for (const name of ["contacts", "orient", "below"]) for (const k of c[name] ?? []) k.when = w(k.when);
	for (const k of c.clearance ?? []) k.frames = w(k.frames);
	return { ...spec, checks: c };
}

/**
 * fix.retime is kept only when QA is no worse with it (qa/verdict.js noWorse: no more problems, at as many no higher
 * summed severity, no goal lost); else the take compiles without it and fixed.retime says what it did (a session went from 30
 * problems to 1015 after a retime). -> { out, measured, qa }
 */
function keptRetime(out, expanded, compile, qaOf) {
	const qa = qaOf(out), measured = out.timeMap ? warpChecks(expanded, out.timeMap) : expanded;
	if (!out.fixed?.retime) return { out, measured, qa };
	const plain = compile({ ...expanded, fix: { ...expanded.fix, retime: false } }), base = qaOf(plain);
	if (noWorse(qa, base)) return { out, measured, qa };
	const v = compareQa(qa, base);
	plain.fixed = { ...plain.fixed, retime: { ...out.fixed.retime, kept: false, how: `${out.fixed.retime.how}; not kept: QA was worse with it (summed severity ${v.sev[0]} -> ${v.sev[1]}, problems ${v.problems[0]} -> ${v.problems[1]}), so the take is compiled without it` } };
	return { out: plain, measured: expanded, qa: base };
}

/**
 * liftRequest(spec, probes) -> { spec, probes }. spec.probes (sent inside the spec, or added by
 * a patch) join the request's probes after them and leave the spec, so they are never stored and
 * never change its specId; bare goals[].moved ids get their object: prefix (validate-goals.js).
 * The spec comes back as the same object when nothing changes.
 */
export function liftRequest(spec, probes) {
	if (!spec || typeof spec !== "object" || Array.isArray(spec)) return { spec, probes };
	const goals = canonicalGoals(spec.goals);
	if (spec.probes === undefined && goals === spec.goals) return { spec, probes };
	const { probes: inSpec, ...rest } = spec;
	const lifted = inSpec === undefined ? probes : probes ? [...probes, ...(Array.isArray(inSpec) ? inSpec : [inSpec])] : inSpec;
	return { spec: goals === spec.goals ? rest : { ...rest, goals }, probes: lifted };
}

/**
 * spec -> { out, qa, observations, spec (frames and open values filled in), expanded, used,
 * fixed, search, timeline, probes?, notes?, ms }. opts.checks replaces every check (the spec's and its skills') for a
 * re-measure; opts.lenient ignores unknown fields (take-source.js); opts.probes are measured
 * (with spec.probes, liftRequest).
 */
export function compileSpec(sent, { sk, scene }, opts = {}) {
	const notes = [], refusals = [];
	sent = expandPoses(sent, sk); // keys that name a pose (poses.js)
	try {
		return compilePrepared(opts.lenient ? sent : prepareSpec(sent, { sk, scene }, notes, refusals), { sk, scene }, opts, notes, refusals);
	} catch (error) {
		// a walk prepareSpec refused is listed with whatever refused the spec first (validateSpec lists it with its own)
		if (refusals.length && /^MOTION_SPEC_INVALID/.test(error.message) && !error.message.includes(refusals[0])) error.message = error.message.replace(/^MOTION_SPEC_INVALID: /, `MOTION_SPEC_INVALID: ${refusals.join("\n")}\n`);
		// a refusal says what was corrected first, so the paths it names (a moved generator: use[i]) read right
		if (notes.length && /^MOTION_SPEC_INVALID/.test(error.message)) error.message += `\n(adjusted before these checks: ${notes.join("; ")})`;
		throw error;
	}
}

function compilePrepared(prepared, { sk, scene }, opts, notes, refusals) {
	const { spec, probes: asked } = liftRequest(prepared, opts.probes);
	const t0 = performance.now(), ctx = { sk, scene, lenient: opts.lenient === true, problems: refusals };
	const checks = opts.checks && nameChecks({ checks: opts.checks }).checks;
	let plans = [];
	const expand = s => {
		const { spec: exp, used } = expandUse(nameChecks(applyWalkPlans(s, plans)), ctx);
		// plain JSON objects compile about twice as fast as structuredClone'd ones (V8 shapes)
		const full = relaxSpec(JSON.parse(JSON.stringify(checks ? { ...exp, checks } : exp)), scene, notes, sk);
		validateSpec(full, ctx);
		return { full, used };
	};
	// a walkTo with arrive gets its cadence planned on probe compiles of the walk alone (walk-plan.js); the spec keeps arrive
	plans = planWalks(spec, { sk, scene, trial: s => { const full = expand(s).full; return runMotionQa(sk, compileMotion({ fps: 24, ...full }, ctx), full, { explain: false }); } });
	const framed = spec?.frames === "auto" && plans.length ? { ...spec, frames: resolveFrames(applyWalkPlans(spec, plans), ctx).frames } : resolveFrames(spec, ctx), params = findParams(framed);
	let resolved = framed, search = null;
	if (params.length) ({ spec: resolved, search } = searchParams(framed, params, ctx, s => expand(s).full));
	// the store keeps the "auto" intent beside the resolved number (spec-store.js)
	if (spec?.frames === "auto") markFramesAuto(resolved);
	const t1 = performance.now();
	const { full: expanded, used } = expand(resolved);
	const { out, measured, qa } = keptRetime(compileMotion({ fps: 24, ...expanded }, ctx), expanded, s => compileMotion({ fps: 24, ...s }, ctx), o => runMotionQa(sk, o, o.timeMap ? warpChecks(expanded, o.timeMap) : expanded, { userSpec: resolved }));
	const compileMs = ms(t1), t2 = performance.now();
	const observations = observeMotion(sk, out, measured.checks), held = heldReadings(out);
	if (held) Object.assign(observations, { units: `${observations.units}; ${HELD_UNITS}`, held });
	const near = observeNear(sk, out), wrist = observeWrist(sk, out);
	if (near) Object.assign(observations, { units: `${observations.units}; ${NEAR_UNITS}`, near });
	if (wrist) Object.assign(observations, { units: `${observations.units}; ${WRIST_UNITS}`, wrist });
	const load = observeLoad(sk, out);
	if (load) Object.assign(observations, { units: `${observations.units}; ${LOAD_UNITS}`, load });
	Object.assign(observations, { units: `${observations.units}; ${LIFE_UNITS}`, life: observeLife(sk, out, resolved?.keys) });
	const gait = observeGait(sk, out, out.keys);
	// a walk too short to read is its steps alone, which need no units (the answer budget)
	if (gait) Object.assign(observations, gait.cadence ? { units: `${observations.units}; ${GAIT_UNITS}`, gait } : { gait });
	// a skill that paced its beats to fit a short span says so where every answer keeps it (C7 tier 1)
	const paced = used.filter(u => u.paced).map(u => `${u.skill} paced ${u.paced.toFixed(2)} to fit f${u.f0}..f${u.end}`);
	if (paced.length) observations.paced = paced;
	const cut = used.filter(u => u.cut).map(u => `${u.skill}: ${u.cut}`);
	if (cut.length) observations.cut = cut;
	const placed = used.filter(u => u.placed).map(u => `${u.skill} f${u.f0}: ${u.placed.why}: at [${u.placed.at.join(", ")}], heading ${u.placed.heading}`);
	if (placed.length) observations.placed = placed;
	if (plans.length) observations.planned = plans.map(p => p.note);
	const pivots = springPivots(out);
	if (pivots) observations.spring = pivots;
	const got = observeAsked(out, { used, use: resolved?.use, checks: measured.checks, goals: measured.goals, results: qa.goals });
	if (got) observations.asked = got;
	const timeline = timelineOf(out, { used, spec: expanded }), probes = asked && runProbes(out, asked, { spec: expanded, sk, scene, notes });
	return { out, qa, observations, spec: resolved, expanded, used, fixed: out.fixed, search, timeline, ...(probes ? { probes } : {}), ...(notes.length ? { notes } : {}),
		ms: { compile: compileMs, qa: ms(t2), total: ms(t0) } };
}
