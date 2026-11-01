// CozyClay 3 motion: the agent writes a motion spec (keys, anchors, props, fits, generators,
// checks, goals), the deterministic compiler bakes every frame, QA measures it, and the take is
// installed on the character. Cheap enough to run in a loop until QA reports nothing. The words
// the agent reads live in motion3/docs.js; the contracts in docs/motion-api-v3.1.md.
import { fail, characterOf } from "./shared.js";
import { motionScene } from "../motion3/scene.js";
import { skeletonFor } from "../motion3/rigs/index.js";
import { expandPoses } from "../motion3/poses.js";
import { fk } from "../motion3/compiler/skeleton.js";
import { add, apply, ry } from "../motion3/compiler/math.js";
import { resolveBone } from "../motion3/bones.js";
import { MOTION_ACTION_HELP as HELP } from "../motion3/docs.js";
import { DESCRIBE_TOPICS } from "../motion3/schema/fields.js";
import { describe, describeMany } from "../motion3/describe.js";
import { createSpecStore, specIdOf, SPEC_STORE_SIZE } from "../motion3/spec-store.js";
import { applyPatch } from "../motion3/json-patch.js";
import { deltaOf } from "../motion3/delta.js";
import { fitOutput, reportPage } from "../motion3/report.js";
import { keyObject } from "../motion3/key-edit.js";
import { expandUse } from "../motion3/skills/index.js";
import { publishDraft } from "../agent-progress.js";
import { qaProblems, qaSay } from "../qa-label.js";
import { noteTurnDraft } from "../workflow/agent-turn-telemetry.js";
import { noteDraftCompiled } from "../motion-draft-telemetry.js";
import { carryEdit } from "../motion3/edit-carry.js";
import { normalizeCompileArgs } from "../motion3/lenient.js";
import { createCompileRunner } from "./motion3-compile.js";
import { autoFill } from "./motion3-fill.js";
import { createRoundWatch } from "./motion3-rounds.js";
import { createRepairWatch } from "../motion3/repair-watch.js";
import { peopleOf } from "../motion3/people.js";
import { hybridCapsuleHint } from "../motion3/hybrid-hint.js";
import { patchTooBroad, keptFill } from "../motion3/patch-guard.js";
import { createInstalledQa } from "./motion3-installed.js";

const TIMELINE_FPS = 24;
const id = { type: "string", minLength: 1 };
const specId = { type: "string", pattern: "^spec-[0-9a-f]{12}$" };
const openObject = { type: "object", properties: {}, required: [], additionalProperties: true };
const input = (properties, required = Object.keys(properties)) => ({ type: "object", properties, required, additionalProperties: false });
const list = (items, maxItems) => ({ type: "array", items, minItems: 1, maxItems });
const numbers = n => ({ type: "array", items: { type: "number" }, minItems: n, maxItems: n });

// readOnly: reads the scene and the take, never changes them (C10).
const declarations = Object.freeze([
	// motion jobs get 240 s (deep research 28: box compiles take up to 108 s, 5.6-8.7% passed 120 s; elsewhere p99 is 40 s)
	{ id: "motion.compile", label: "Compile motion", kind: "job", domain: "motion", timeoutMs: 240000, description: HELP.compile,
		// patch may be empty: base alone (or patch: []) re-measures the stored spec, with new probes; "never" is install: false
		input: input({ characterId: id, spec: openObject, base: specId, patch: { type: "array", items: openObject, maxItems: 64 },
			install: { oneOf: [{ type: "boolean" }, { const: "ifClean" }, { const: "never" }], default: true },
			probes: list(openObject, 16), repair: { oneOf: [input({ rounds: { type: "integer", minimum: 1, maximum: 8, default: 4 } }, []), { const: false }] }, thin: { type: "boolean" } }, ["characterId"]) },
	{ id: "motion.qa", label: "Measure motion", kind: "job", domain: "motion", timeoutMs: 240000, readOnly: true, description: HELP.qa,
		input: input({ characterId: id, checks: openObject }, ["characterId"]) },
	{ id: "motion.sample", label: "Sample motion", kind: "job", domain: "motion", timeoutMs: 30000, readOnly: true, description: HELP.sample,
		input: input({ characterId: id, frames: { type: "array", items: { type: "integer", minimum: 0 }, minItems: 1, maxItems: 64 },
			bones: { type: "array", items: id, maxItems: 65 } }, ["characterId", "frames"]) },
	{ id: "motion.describe", label: "Describe motion spec", kind: "job", domain: "motion", timeoutMs: 10000, readOnly: true, description: HELP.describe,
		input: input({ topic: { type: "string", enum: DESCRIBE_TOPICS }, name: id,
			topics: list({ oneOf: [{ type: "string", enum: DESCRIBE_TOPICS }, input({ topic: { type: "string", enum: DESCRIBE_TOPICS }, name: id }, ["topic"])] }, 8) }, []) },
	{ id: "motion.report", label: "Read motion report", kind: "job", domain: "motion", timeoutMs: 10000, readOnly: true, description: HELP.report,
		input: input({ specId, characterId: id, part: { type: "string", enum: ["groups", "timeline", "probes"], default: "groups" }, from: { type: "integer", minimum: 0, default: 0 } }, []) },
	{ id: "motion.keyObject", label: "Key held object", kind: "job", domain: "motion", timeoutMs: 240000, description: HELP.keyObject,
		input: input({ characterId: id, objectId: id, frame: { type: "integer", minimum: 0 }, pos: numbers(3), rot: numbers(4), aim: numbers(3), roll: { type: "number" },
			angle: { type: "number" }, remove: { type: "boolean", default: false } }, ["characterId", "objectId", "frame"]) },
]);
export { declarations };

const DEFAULT_BONES = ["Hips", "Head", "LeftHand", "RightHand", "LeftFoot", "RightFoot"];
// the inputs a compile fixed instead of refusing (lenient.js), kept in every answer (report.js keeps the head)
const MAX_ADJUSTED = 8;
const adjustedOf = notes => (notes.length ? { adjusted: notes.length > MAX_ADJUSTED ? [...notes.slice(0, MAX_ADJUSTED - 1), `${notes.length - MAX_ADJUSTED + 1} more`] : notes } : {});
const adjustedSay = notes => (notes.length ? `; ${notes.length} input${notes.length > 1 ? "s" : ""} adjusted (output.adjusted)` : "");
const unknownSpec = (what, value, then = "send spec") => fail("INVALID_ARGUMENT", `${what} "${value}" is not known (the editor keeps the last ${SPEC_STORE_SIZE} compiled specs this session); ${then}`);

const sameArray = (a, b) => a?.length === b?.length && Array.prototype.every.call(a, (v, i) => v === b[i]);
/** True when `installed` is the take `take` would install: the same spec, placement, bones and object tracks. */
function sameTake(installed, take) {
	return installed?.schema === take.schema && installed.frameCount === take.frameCount && installed.rig === take.rig
		&& specIdOf(installed.spec ?? null) === specIdOf(take.spec) && JSON.stringify(installed.placement) === JSON.stringify(take.placement)
		&& sameArray(installed.rot, take.rot) && sameArray(installed.hips, take.hips) && JSON.stringify(installed.objects ?? {}) === JSON.stringify(take.objects);
}

/** then(value) now, or when the promise settles (a compile answers at once in Node, later from the browser's worker). */
const after = (value, then) => (typeof value?.then === "function" ? value.then(then) : then(value));
/** Runs `run`, turning a MOTION_SPEC_INVALID error into INVALID_ARGUMENT with the exact message. */
function asArgument(run) {
	try {
		return run();
	} catch (error) {
		if (/^MOTION_SPEC_INVALID/.test(error.message)) fail("INVALID_ARGUMENT", error.message.replace(/^MOTION_SPEC_INVALID:\s*/, ""));
		throw error;
	}
}

export function register(registry, ports) {
	const store = createSpecStore();
	registry.motionSpecOf = base => store.get(base); // motion.fill (motion3-fill.js) reads a base the same way
	// the stop rule: output.stuck when more compiles stopped paying (repair-watch.js)
	const watch = createRepairWatch(), compiledOnce = new Set();
	const rounds = createRoundWatch(); // output.noImprovementRounds (motion3-rounds.js)
	const owner = () => ports.storeDomain("motion");
	const mounted = () => Boolean(ports.storeDomain?.("motion")) || "The motion owner is not mounted.";
	const always = () => true;
	const rigOf = character => {
		const sk = skeletonFor(character.model);
		if (!sk) fail("TARGET_NOT_READY", `${character.subject || character.id} is a ${character.model} body, which motion compile cannot drive; use an X Bot or Y Bot character.`);
		if (Math.abs((character.scale ?? 1) - 1) > 1e-6) fail("TARGET_NOT_READY", "Set the character's scale back to 1 before compiling motion.");
		return sk;
	};
	// the scene a compile sees: the objects, and the other characters' installed takes as moving bodies (people.js)
	const sceneFor = character => {
		const state = ports.state(), people = peopleOf(state.characters, character.id, id => owner().motionFor(id));
		return { ...motionScene(state.objects), ...(Object.keys(people).length ? { people } : {}) };
	};
	// one compile worker per editor in the browser, the calling thread elsewhere (motion3-compile.js)
	const runner = createCompileRunner();
	const workerWarning = () => { const note = runner.takeWarning(); return note ? { warnings: [note] } : {}; };
	/**
	 * spec on the character's rig and the current scene (compile-job.js) -> { stored (the spec a take keeps and its specId
	 * names), qa, ..., take when bake is given }, at once or as a promise. opts: probes, checks, lenient, repair.
	 */
	const compile = (character, spec, opts = {}, bake, taskId = null, scene = sceneFor(character)) => {
		rigOf(character);
		const placed = bake && { position: [character.x ?? 0, character.y ?? 0, character.z ?? 0], yaw: character.rot ?? 0, ...bake };
		return runner.run({ model: character.model, scene, spec, ...opts, ...(placed ? { bake: placed } : {}) }, { taskId, characterId: character.id });
	};
	// where a take was baked: the body's place and a hash of the scene's bodies (a take kept for the stop rule fits only
	// there): 0.14 ms for 860 bodies, where their JSON took 0.9 ms and 295 KB a key
	// the installed take's QA for ifClean and INSTALL_WORSE: stored, or measured once from its spec (a reload empties the store)
	const installedQa = createInstalledQa({ store, owner, compile });
	const placeKey = (character, scene) => {
		let h = 2166136261;
		const mix = v => { h = Math.imul(h ^ Math.round(v * 1e4), 16777619); };
		for (const [id, o] of Object.entries(scene.objects ?? {})) {
			for (let i = 0; i < id.length; i++) mix(id.charCodeAt(i) / 1e4);
			for (const list of [o.pos, o.half, ...o.R]) for (let i = 0; i < list.length; i++) mix(list[i]);
		}
		return `${character.model} ${[character.x ?? 0, character.y ?? 0, character.z ?? 0, character.rot ?? 0].join(" ")} ${(h >>> 0).toString(36)}`;
	};
	/** The whole output, kept in the store (motion.report, delta) and cut to the receipt budget (report.js). */
	const report = (r, head, extra = {}) => {
		const specIdValue = store.put(r.stored);
		store.keepParts(specIdValue, { groups: r.qa.groups, timeline: r.timeline, probes: r.probes ?? {} });
		return fitOutput({ ...head, specId: specIdValue, qa: r.qa, observations: r.observations, ...extra, ...(r.probes ? { probes: r.probes } : {}), timeline: r.timeline,
			fixed: r.fixed, ...(r.search ? { search: r.search } : {}), ...(r.used.length ? { skills: r.used } : {}), ms: r.ms });
	};
	/**
	 * A compiled take on the character, installed as one undo entry; put() keeps the timing edit of the take it replaces
	 * (edit-carry.js) and returns what it did with it (a note for the receipt), or undefined.
	 */
	const put = (character, take, context) => {
		let note;
		const apply = () => {
			const id = character.id, edit = owner().layer?.(id)?.take?.edit, full = edit && owner().fullMotionFor?.(id), carried = full && carryEdit(edit, full.frames ?? full.frameCount, take.frameCount);
			owner().replace(id, { ...take, frames: take.frameCount });
			if (carried?.edit) { owner().writeLayer(id, { take: { ...owner().layer(id).take, edit: carried.edit } }); ports.storeDomain("cast")?.syncTimeline?.(); }
			note = carried?.note;
		};
		if (context?.commit) context.commit(apply); else apply();
		return note;
	};
	const installed = characterId => owner().motionFor(characterId)?.schema === "cozyclay.take.v3" ? owner().motionFor(characterId)
		: fail("TARGET_NOT_READY", "This character has no compiled take; run motion.compile first.");

	// normalizeArgs: other spellings of install and repair become the declared ones before the schema check (lenient.js)
	registry.register({ ...declarations[0], normalizeArgs: normalizeCompileArgs, available: mounted, target: args => args.characterId, run({ characterId, spec, base, patch, install: asked = true, probes, repair, thin, filled }, context) {
		const install = asked === "never" ? false : asked;
		const character = characterOf(ports, characterId);
		if ((spec === undefined) === (base === undefined)) fail("INVALID_ARGUMENT", "Send exactly one of spec or base (the specId of a compiled spec, with patch).");
		if (patch !== undefined && base === undefined) fail("INVALID_ARGUMENT", "patch applies to base, the specId of a compiled spec; send base with it, or the whole spec.");
		// a base the store forgot (a reload) may still be the installed take's spec: a document read names it by specId
		const installedSpec = () => { const take = owner().motionFor(characterId); return take?.spec && specIdOf(take.spec) === base ? structuredClone(take.spec) : null; };
		const patched = [], source = spec ? expandPoses(spec, skeletonFor(characterOf(ports, characterId).model)) : asArgument(() => applyPatch(store.get(base) ?? installedSpec() ?? unknownSpec("base", base), patch ?? [], patched));
		const scene = sceneFor(character), at = placeKey(character, scene);
		// the take is always baked: the user watches every draft, installed or not
		// MotionBricks fills between the authored key poses first when spec.fill is true and the dev server can run it (motion3-fill.js autoFill)
		// the repair engine runs by default (2 rounds) on an installing compile; repair: false opts out (deep research 5: hand-keyed sessions
		// repaired 93% of first compiles, ours 2-4%, and without it the hints carry no patch)
		// rounds 2 on a character's first compile, 1 on the repeats (variant I: repair cost +20 s a step on 45% of the compiles)
		const repairWith = repair === false ? undefined : repair ?? (install === false ? undefined : { rounds: compiledOnce.has(characterId) ? 1 : 2 });
		compiledOnce.add(characterId);
		// the frames this patch touched stay through key thinning (thin.js)
		const before = base === undefined ? null : store.get(base) ?? installedSpec(), keysAt = (sp, f) => JSON.stringify((sp?.keys ?? []).filter(k => k.f === f));
		const protect = before ? [...new Set((source.keys ?? []).map(k => k.f))].filter(f => keysAt(before, f) !== keysAt(source, f)) : [];
		// a small patch on one authored key keeps the fill beside it (patch-guard.js): re-fills there made 14-22% of the new problems
		const keepFill = base === undefined ? null : keptFill(store.get(base) ?? installedSpec(), source);
		// the installed take's QA, measured before this compile when the store lost it (motion3-installed.js)
		return after(install === false ? null : installedQa.measure(character, scene), on => after(filled ? { spec: source, fill: filled } : keepFill ? { spec: source, fill: keepFill } : autoFill(ports, character, source), auto => after(compile(character, auto.spec, { probes, repair: repairWith, installing: install !== false, thin, protect }, {}, context?.taskId, scene), r => {
			const { qa, take } = r, notes = [...patched, ...(r.notes ?? [])];
			// ifClean: install a clean result (qa.ok includes the goals; after repair when asked), and one that beats the installed
			// take's QA (fewer groups, then fewer frame issues) or the first when none is on (variant K: box ended with no take in 4 of
			// 5 runs under ifClean / never); over a take whose QA cannot be measured, any take (with a note)
			const verdict = install === "ifClean" ? installedQa.verdict(on, qa) : { wanted: install };
			const wanted = verdict.wanted;
			let installs = wanted, kept = false, timing;
			const worse = install === true ? installedQa.worse(on, qa) : null;
			// open ranges are stored with the values the search chose, so motion.qa re-measures this take
			if (wanted) {
				// ifClean of the take already installed changes nothing (no undo entry; IK edits on it stay)
				kept = install === "ifClean" && sameTake(owner().motionFor(characterId), take);
				installs = !kept;
				if (installs) timing = put(character, take, context);
			}
			const delta = base === undefined ? {} : { delta: deltaOf(store.parts(base)?.groups ?? [], qa.groups, base) };
			// the stop rule (repair-watch.js): a note, and the best take so far put on when the note would leave the take empty or worse
			const own = specIdOf(r.stored), carried = owner().motionFor(characterId)?.spec, current = carried ? specIdOf(carried) : null;
			const { say: stuck, install: best } = watch.note({ characterId, turnId: context?.turnId, callId: context?.callId, specId: own, base, qa, at, take, installed: Boolean(installs || kept), current });
			if (best) timing = put(character, best.take, context) ?? timing;
			const self = best?.specId === own, how = kept ? "; already installed, unchanged" : self ? "; installed as the best take so far"
				: best ? `; not installed; the best take so far, ${best.specId}, installed` : install === "ifClean" ? (installs ? "; installed" : "; not installed") : "";
			const hint = hybridCapsuleHint(ports.storeDomain?.("scenes")?.metadata?.().castStyle, { stuck, qa });
			const flat = rounds(characterId, qa, base === undefined), broad = patchTooBroad(patch);
			const output = report(r, { frames: r.frameCount, fps: TIMELINE_FPS, installed: Boolean(wanted) || self, ...(flat ? { noImprovementRounds: flat } : {}), ...(stuck ? { stuck } : {}), ...(hint ? { hint } : {}), ...adjustedOf(notes), ...(broad || worse || verdict.note ? { notes: [broad, worse, verdict.note].filter(Boolean) } : {}) }, { ...delta, ...(r.repair ? { repair: r.repair } : {}), ...(timing ? { timing } : {}), ...(auto.fill ? { fill: auto.fill } : {}), ...(r.thinned ? { thinned: r.thinned } : {}) });
			// agent-progress.js: viewport ghost, timeline beats, agent panel
			const draft = publishDraft(characterId, { take, installed: installs || kept || self, specId: output.specId, label: r.label, qa, timeline: r.timeline });
			noteDraftCompiled(draft, r, { installed: installs || kept || self, stuck, repaired: Boolean(r.repair), adjusted: notes.length > 0 });
			// agent:turn_summary: this turn's drafts and their QA (agent-turn-telemetry.js)
			noteTurnDraft(context?.turnId, { clean: Boolean(qa.ok), problems: qaProblems(qa), stuck: Boolean(stuck) });
			return { affectedIds: installs || best ? [characterId] : [], summary: `${auto.fill?.calls ? `MotionBricks filled ${auto.fill.calls} gap${auto.fill.calls === 1 ? "" : "s"}. ` : ""}Compiled ${r.frameCount} frames; QA ${qaSay(qa)}${how}${adjustedSay(notes)}.${install !== false && qaProblems(qa) === 0 ? " QA clean — done (no further rounds)." : ""}${installs || kept || self ? ` Installed take: ${output.specId}.` : best ? ` Installed take: ${best.specId}.` : ""}${r.thinned ? ` Thinned ${r.thinned.removed.length} free-span key${r.thinned.removed.length === 1 ? "" : "s"} QA did not need (output.thinned).` : ""}`, output, ...workerWarning() };
		})));
	} });
	registry.register({ ...declarations[1], available: mounted, run({ characterId, checks }) {
		const character = characterOf(ports, characterId), take = installed(characterId);
		return after(compile(character, take.spec, { checks }), r => ({ affectedIds: [], summary: `QA ${qaSay(r.qa)}${adjustedSay(r.notes ?? [])}.`,
			output: report(r, adjustedOf(r.notes ?? [])), ...workerWarning() }));
	} });
	registry.register({ ...declarations[2], available: mounted, run({ characterId, frames, bones = DEFAULT_BONES }) {
		const character = characterOf(ports, characterId), take = installed(characterId), sk = rigOf(character);
		const yaw = ry(take.placement?.yaw ?? 0), at = take.placement?.position ?? [0, 0, 0], B = take.bones.length;
		const rows = frames.map(f => {
			const ff = Math.min(take.frameCount - 1, f);
			const quats = Array.from({ length: B }, (_, b) => Array.from(take.rot.subarray((ff * B + b) * 4, (ff * B + b) * 4 + 4)));
			const state = fk(sk, quats, Array.from(take.hips.subarray(ff * 3, ff * 3 + 3)));
			return { frame: ff, bones: Object.fromEntries(bones.map(name => {
				const { bone, hint } = resolveBone(sk, name);
				if (bone === null) fail("INVALID_ARGUMENT", `Unknown bone ${name}${hint || "."}`);
				return [name, add(at, apply(yaw, state.P[sk.index[bone]])).map(v => Math.round(v * 1e4) / 1e4)];
			})) };
		});
		return { affectedIds: [], summary: `Sampled ${rows.length} frames.`, output: { frames: rows } };
	} });
	registry.register({ ...declarations[3], available: always, run({ topic, name, topics }) {
		if (topic === undefined && topics === undefined) fail("INVALID_ARGUMENT", "Send topic (and name) for one answer, or topics: [{ topic, name? }] for several in one call.");
		if (topics) {
			// C19: a topic beside topics joins them; a name beside topics goes to the one ask that can take it
			const asks = [...(topic === undefined ? [] : [{ topic }]), ...topics.map(t => (typeof t === "string" ? { topic: t } : { ...t }))];
			const open = asks.filter(a => a.name === undefined && (asks.length === 1 || a.topic === "skills"));
			if (name !== undefined && open.length !== 1) fail("INVALID_ARGUMENT", "name goes with one topic; inside topics give each its own: topics: [{ topic, name? }].");
			if (name !== undefined) open[0].name = name;
			const output = asArgument(() => describeMany(asks));
			return { affectedIds: [], summary: `Described ${output.topics.map(a => (a.name ? `${a.topic} ${a.name}` : a.topic)).join(", ")}${output.more ? `; ${output.more.length} more did not fit` : ""}.`, output };
		}
		return { affectedIds: [], summary: `Described ${topic}${name ? ` ${name}` : ""}.`, output: asArgument(() => describe(topic, name)) };
	} });
	// a characterId reads the installed take's report (session 2ad2760a asked for it that way and was refused): the stored
	// one when this session compiled that spec, else the take's QA run now
	registry.register({ ...declarations[4], available: always, run({ specId: wanted, characterId, part = "groups", from = 0 }) {
		const answer = (parts, id) => { const page = reportPage(parts, id, part, from); return { affectedIds: [], summary: `${page.items.length} ${part} from ${from}.`, output: page }; };
		if (wanted) return answer(store.parts(wanted) ?? unknownSpec("specId", wanted, "compile it again"), wanted);
		if (!characterId) fail("INVALID_ARGUMENT", "motion.report needs specId (from a motion.compile or motion.qa answer) or characterId (its installed take).");
		const take = installed(characterId), id = specIdOf(take.spec), kept = store.parts(id);
		if (kept) return answer(kept, id);
		return after(compile(characterOf(ports, characterId), take.spec), r => { const out = report(r, {}); return answer(store.parts(out.specId), out.specId); });
	} });
	// motion.keyObject (C14): one key of a held object (or a hinge angle) in the installed take's spec, compiled
	// and installed whatever QA says (a user edit), as one undo entry
	registry.register({ ...declarations[5], available: mounted, target: args => args.characterId, run({ characterId, ...args }, context) {
		const character = characterOf(ports, characterId), take = installed(characterId), scene = sceneFor(character);
		const { spec, keyed } = asArgument(() => keyObject(take.spec, scene, args, expandUse(take.spec, { sk: rigOf(character), scene, lenient: true }).spec.objects));
		return after(compile(character, spec, { lenient: true }, { prompt: take.prompt }), r => {
			const timing = put(character, r.take, context);
			return { affectedIds: [characterId], summary: `${keyed.removed ? "Removed the key of" : "Keyed"} ${keyed.objectId} at f${keyed.f}; QA ${qaSay(r.qa)}; installed.`,
				output: report(r, { frames: r.frameCount, fps: TIMELINE_FPS, installed: true, keyed }, timing ? { timing } : {}), ...workerWarning() };
		});
	} });
}
