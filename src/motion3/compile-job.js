// One motion compile as a job of plain data, the same in the compile worker (compile-worker.js) and on
// the calling thread (commands/motion3-compile.js, where no worker runs: Node, tests): the rig by model
// name, the motion scene (scene.js motionScene of the editor's objects: oriented boxes; shapes.js reads a sphere or a cylinder round from them), the spec as sent, and
// what to do with it (probes, checks, lenient, repair, bake). The answer is plain data and typed arrays
// only (the compiler's out holds closures), so it crosses a worker boundary: QA, observations, the stored
// spec, and the baked take when asked. The hint patches QA offers are compiled first (hint-check.js).
// A refusal is an Error with a code (INVALID_ARGUMENT, MOTION_SPEC_INVALID turned into it), which the
// client turns back into the Studio's protocol error.
import { compileSpec, liftRequest } from "./pipeline.js";
import { prepareSpec } from "./correct.js";
import { repairSpec } from "./repair.js";
import { thinSpec } from "./thin.js";
import { checkHints } from "./hint-check.js";
import { bakeTake } from "./take.js";
import { skeletonFor } from "./rigs/index.js";
import { keptPeople } from "./people.js";

const TIMELINE_FPS = 24, HINT_LIMIT_MS = 20000;
const refuse = (code, message) => { throw Object.assign(new Error(message), { code }); };

/** Runs `run`, turning a MOTION_SPEC_INVALID error into INVALID_ARGUMENT with the exact message. */
function asArgument(run) {
	try {
		return run();
	} catch (error) {
		if (/^MOTION_SPEC_INVALID/.test(error.message)) refuse("INVALID_ARGUMENT", error.message.replace(/^MOTION_SPEC_INVALID:\s*/, ""));
		throw error;
	}
}

/**
 * The same plain data as fresh literals. Objects that came through a structured clone (a worker message) make
 * the compiler's hot loops ~60% slower in V8 (their shapes); a copy built from literals runs at full speed and
 * keeps every value exactly (unlike a JSON round trip: -0, NaN, Infinity).
 */
const fresh = value => (Array.isArray(value) ? value.map(fresh) : value && typeof value === "object" && !ArrayBuffer.isView(value)
	? Object.fromEntries(Object.keys(value).map(k => [k, fresh(value[k])])) : value);

/**
 * runCompileJob({ model, scene, spec, probes?, checks?, lenient?, repair?, installing?, thin?, protect?, bake? }) -> { stored, qa,
 * observations, used, fixed, search, timeline, probes?, notes?, ms (+ repair: its wall ms), frameCount, label, repair?, thinned?, take? }
 * installing: the compile installs (motion3.js), so it thins its keys (thin.js) unless thin is false; protect: frames never thinned.
 * bake: { position, yaw, prompt? } bakes the final result's take (prompt: given, else the final spec's label).
 * hintLimitMs: the job's time after which hint patches are no longer compiled (default HINT_LIMIT_MS; tests pass 0).
 * thinLimitMs: the thinning's own time limit (default thin.js LIMIT_MS; tests pass more, so a loaded machine thins the same keys).
 */
export function runCompileJob({ model, scene, spec: asked, probes: sentProbes, checks, lenient, repair, installing, thin, protect, bake, hintLimitMs, thinLimitMs }) {
	const sk = skeletonFor(model);
	const opts = { ...(checks ? { checks } : {}), ...(lenient ? { lenient: true } : {}) };
	// spec.probes and bare moved ids are lifted before fps is filled in, so the specId stays the spec's own
	const once = s => {
		const { spec, probes } = liftRequest(s, sentProbes);
		if (spec?.fps !== undefined && spec.fps !== TIMELINE_FPS) refuse("INVALID_ARGUMENT", `spec.fps must be ${TIMELINE_FPS}, the timeline rate.`);
		const sent = { fps: TIMELINE_FPS, ...spec };
		const r = asArgument(() => compileSpec(sent, { sk, scene }, { ...opts, probes }));
		return { ...r, stored: r.spec === sent ? spec : r.spec };
	};
	// repair patches address the stored spec, so a repair starts from it corrected (correct.js), and says what was
	const corrected = [], start = repair && !lenient ? prepareSpec(asked, { sk, scene }, corrected) : asked;
	// every compile's QA by its spec, so a hint patch repair already tried is not compiled again (hint-check.js)
	const seen = new Map(), measured = s => { const r = once(s); seen.set(JSON.stringify(s), r.qa); return r; };
	const t0 = performance.now(), repaired = repair ? repairSpec(start, repair, measured) : { spec: asked, result: measured(asked) };
	// repair.ms: the repair's own wall time (before thinning)
	const repairMs = repair ? Math.round(performance.now() - t0) : 0;
	// key thinning (thin.js): an installing compile drops the free-span keys QA does not miss; thin: false opts out
	const thinned = installing && thin !== false && !lenient ? thinSpec(repaired.spec, repaired.result, measured, { protect: protect ?? [], ...(thinLimitMs === undefined ? {} : { limitMs: thinLimitMs }) }) : null;
	const fixed = thinned ? { ...repaired, spec: thinned.spec, result: thinned.result } : repaired;
	// a hint's patch is offered only when its compile helped (hint-check.js), and only by a compile that repairs: repair has
	// compiled most of the patches already (seen), where a plain compile paid two more compiles for them (bench replay: first
	// compile 1.6 -> 5.2 s median) and the agent applied an offered patch as sent once in the 60 bench runs (374 direct
	// compiles, 319 with repair; a plain compile is mostly a variant in a sweep); a plain compile keeps the hint's words only
	// past HINT_LIMIT_MS since the job began a patch not compiled yet is dropped (bench box, M2: two hint compiles of a slow
	// walk added 155 s to a 33 s compile on the Mac, and the job ran past the hub's 240 s on the box)
	if (repair) checkHints(fixed.spec, fixed.result.qa, s => seen.get(JSON.stringify(s)) ?? (performance.now() - t0 > (hintLimitMs ?? HINT_LIMIT_MS) ? null : measured(s).qa));
	else for (const g of fixed.result.qa?.groups ?? []) delete g.patch;
	// ms.repair: the whole repair's wall time, so a sweep that repairs every variant shows what it costs
	const r = fixed.result, label = fixed.spec?.label ?? null, ms = fixed.repair ? { ...r.ms, repair: Math.round(performance.now() - t0) } : r.ms;
	const take = bake ? bakeTake(sk, r.out, { position: bake.position, yaw: bake.yaw }, { spec: r.stored, prompt: ("prompt" in bake ? bake.prompt : label) ?? "" }) : undefined;
	// a person anchor's joints (and the bodies fix.person pushed an arm out of) ride with the take, so its saved source
	// compiles the same without the others' takes (people.js)
	const people = take && keptPeople(scene, [r.expanded, r.stored], r.out);
	if (people) take.people = people;
	return { stored: r.stored, qa: r.qa, observations: r.observations, used: r.used, fixed: r.fixed, search: r.search, timeline: r.timeline,
		...(r.probes ? { probes: r.probes } : {}), ...(r.notes || corrected.length ? { notes: [...corrected, ...(r.notes ?? [])] } : {}), ms, frameCount: r.out.frameCount, label,
		...(fixed.repair ? { repair: { ...fixed.repair, ms: repairMs } } : {}), ...(thinned ? { thinned: thinned.thinned } : {}), ...(take ? { take } : {}) };
}

/** The ArrayBuffers under a job answer's typed arrays (each once), to transfer instead of copy. */
function buffersOf(value, found = new Set()) {
	if (ArrayBuffer.isView(value)) found.add(value.buffer);
	else if (value && typeof value === "object") for (const v of Object.values(value)) buffersOf(v, found);
	return [...found];
}

/** The worker's answer to { id, job }: { message: { id, value }, transfer } or { message: { id, error: { message, code, name } }, transfer: [] }. */
export function answerOf({ id, job }) {
	try {
		const value = runCompileJob(fresh(job));
		return { message: { id, value }, transfer: buffersOf(value) };
	} catch (error) {
		return { message: { id, error: { message: String(error?.message ?? error), code: error?.code ?? null, name: error?.name ?? "Error" } }, transfer: [] };
	}
}
