// The motion tool of the Studio agent: the user's message of the turn, as typed, and the agent's note go to the motion
// environment (motion-run.mjs runMotion) and a report comes back. The route builds one door per turn
// (agent-routes.mjs) and adds it to the agent's tools while the lowvis engine is the motion engine and the motion
// writer's model is reachable (motionAvailable). In a plain turn the motion is written while the agent goes on, and its
// result reaches the agent before the turn can end (createMotionDoor background). A motion of a plain turn outlives a
// stopped or failed turn (motion-job.mjs): the next turn of the conversation collects it and installs it then.
import { cliproxyBase, fetchModelList } from "./cliproxy-provider.mjs";
import { motionEngine } from "./motion-engine.mjs";
import { motionWriter } from "./motion-engine.mjs";
import { runMotion } from "./motion-run.mjs";
import { refitMotion } from "./motion-refit.mjs";
import { createJob, cutWith, installIn, jobNote } from "./motion-job.mjs";

const DESCRIPTION = "Makes the body motion of rig characters. The user's message of this turn reaches it by itself, as typed; request is your note: which body and objects, what to keep or change. It reads the scene, uses the characters and objects there, adds the characters and the objects the body touches, stands on, sits on, holds or moves that the scene lacks (each a plain box or ball at the place and size the motion needs, never an object of another kind), installs the motion and moves the objects it handles. An effect, a light or another object with no box of its own that is in the scene can be moved too: carried names those it moves, as they are. An object one bone carries the whole motion is attached to that bone (attached: id, characterId, bone) instead of following a track; one that other objects are grouped under keeps its track, which they go with. An attached object whose place on its bone you or the user set later keeps it (kept: true) while the motion carries it on that bone. used names the objects the motion uses as boxes and the floor the bodies cross. A body is as large as its character's scale and has its character's tint: the motion is written for the scale a character has, and sets the scale and the tint the request gives a body; bodies names each animated character's scale and tint when one has another scale than 1 or a tint, bodiesSet the scale and tint this motion set. The writer starts from the scene and spec kept with the take a character plays (kept names that motion; keptNone the characters whose take keeps none, so the motion is written new). Its report ends with a Missing line. A motion is installed only when the writer's report answers for it: installed true, with undo, the receipt ids of the install's edits (in this message undo_edit of each in that order takes that install back); otherwise installed false, with notInstalled saying why. images: true sends the user's pictures.";
// A call without request (motion-refit.mjs); said last, after what a call with a request answers in this turn (STARTED)
const REFIT = " Called without request, it writes nothing and uses no model: each motion that plays is compiled again from its kept scene and spec for the scale and tint its characters have now (after you or the user changed one) and installed; refit names each with the engine's rows new or worse than at the old size, both compiled now (empty: none), kept the motions no size change touched, skipped those it did not take over, each with why (a scene that changed otherwise needs the writer), keptNone the takes that keep no spec, undo the receipt ids of its edits, as above.";
// A plain turn's motion runs while the agent works (createMotionDoor background): the facts the agent reads of it.
const STARTED = " In this turn a call with a request answers started once it has read the scene; the motion is then written and installed while you go on (minutes). Its result is what it answers otherwise: the report and its Missing line, frames, the characters and objects, used, motionFit, propsSet. When the motion writer's first compile goes through, the props of that compile that the scene lacks are added at once as stand-ins: a draft, which the writer is not told of. The first motion_result called before the install answers that draft as soon as it is made (draft: true, standIns, used of that compile, and a note on what the install does with the stand-ins); a later motion_result answers the installed result, waiting only for what is left of the motion. Until the motion is installed, a call that changes a character or object it is written against is undone and refused: of the scene it read, the visible characters it can animate, the objects attached to them, the first 40 visible, upright, unattached solid objects at least 0.03 m tall, and the first 40 visible, unattached objects that are upright solids under 0.03 m in every side or have no box of their own and are grouped under none, as they were. Any other call goes through, on the draft's stand-ins too; the result's motionFit names an object changed or added meanwhile that differs from the box the motion used or stands on floor the feet use, and propsSet what the install changed since the draft, per object. A motion that is not installed after the draft removes the stand-ins not changed since it, and its error or notInstalled says what it removed and what it left. The turn does not end before the result has reached you: if you end first, it comes to you as a message.";
const RESULT_DESCRIPTION = "Answers the result of the motion that motion started in this turn or an earlier turn of this conversation (the report and its Missing line, frames, the characters and objects, used), waiting for what is left of it; a motion of an earlier turn is installed then, as motion says. Before the install, its first call answers the draft once the motion writer's first compile has made one (draft: true); the next call waits for the install. A motion that failed answers its error. install: true installs the compiled motion that the last answer's notInstalled kept out. stop: true stops the writer and answers what it has, not installed; only when the user asks to stop the motion.";
// labelled as the editor's own message (session-store.mjs OBSERVATION_LABEL): a restored transcript does not show it as the user's words
const ENDED = "Studio motion observation: the motion started in this turn has ended. Its result, as motion_result answers it:";
const ENDED_LATER = ENDED.replace("the motion started in this turn", "the motion an earlier turn started"); // one this turn took over
const PARAMETERS = {
	type: "object",
	properties: { request: { type: "string", minLength: 1, maxLength: 4000 }, images: { type: "boolean" } },
	required: [], additionalProperties: false,
};
const RESULT_PARAMETERS = { type: "object", properties: { install: { type: "boolean" }, stop: { type: "boolean" } }, required: [], additionalProperties: false };
const AVAILABLE_MS = 60_000;
let known = null; // { at, ok } of the last availability check

/** The pictures of a turn's attachments ([{ dataUrl }]) as the motion writer takes them: [{ data, mimeType }], at most 4. */
export function picturesOf(attachments) {
	return (Array.isArray(attachments) ? attachments : []).flatMap(attachment => {
		const match = /^data:([^;]+);base64,(.*)$/.exec(attachment?.dataUrl ?? "");
		return match ? [{ data: match[2], mimeType: match[1] }] : [];
	}).slice(0, 4);
}

/**
 * Whether the motion writer can run: the environment names CLIProxyAPI (CLIPROXY_BASE_URL and CLIPROXY_API_KEY, which
 * the motion writer reads) and the proxy lists its model. The answer is kept for a minute.
 */
export async function motionAvailable(env = process.env) {
	if (known && Date.now() - known.at < AVAILABLE_MS) return known.ok;
	let ok = false;
	try {
		if (env?.CLIPROXY_BASE_URL && env?.CLIPROXY_API_KEY) ok = (await fetchModelList(`${cliproxyBase({ env })}/v1`, env.CLIPROXY_API_KEY, "CLIProxyAPI")).some(entry => (typeof entry === "string" ? entry : entry?.id) === motionWriter(env).model);
	} catch { ok = false; }
	known = { at: Date.now(), ok };
	return ok;
}

const coded = (code, message) => Object.assign(new Error(message), { code });
const answerOf = done => ({ ok: true, report: done.report, missing: done.missing, frames: done.frames, clipSeconds: done.clipSeconds, tookSeconds: done.tookSeconds, compiles: done.compiles, characters: done.characterIds, objects: done.objectIds, switched: done.switched, used: done.used ?? null, ...(done.carried ? { carried: done.carried } : {}), ...(done.attached ? { attached: done.attached } : {}), ...(done.propsSet ? { propsSet: done.propsSet } : {}), ...(done.motionFit ? { motionFit: done.motionFit } : {}),...(done.bodies ? { bodies: done.bodies } : {}), ...(done.bodiesSet ? { bodiesSet: done.bodiesSet } : {}), ...(done.kept ? { kept: done.kept } : {}), ...(done.keptNone ? { keptNone: done.keptNone } : {}),
	...(done.installed === undefined ? {} : { installed: done.installed }), ...(done.undo ? { undo: done.undo } : {}), ...(done.notInstalled ? { notInstalled: done.notInstalled } : {}) });
// The ids a tool call changed: its own, and those of each call of a script (script-tool.mjs calls).
const touched = result => [...(Array.isArray(result?.affectedIds) ? result.affectedIds : []), ...(Array.isArray(result?.calls) ? result.calls.flatMap(call => (Array.isArray(call?.affectedIds) ? call.affectedIds : [])) : [])];

/**
 * createMotionDoor({ run, mark, rollback, images, background, sceneOf, refit, key, jobs }) -> the model-facing `motion`
 * tool (bin/agent/pi-tools.mjs toAgentTools shape), plus with(list) (the turn's tools and the motion's), unfinished and note.
 * run({ request, images, signal, onCompile, onBodies, onScene, exclusive, seat }) -> runMotion's answer (the route binds
 * the rest); seat() is the turn that holds the motion now (its invoke and workspaceHandle run the install).
 * mark() / rollback(): the turn transaction's (studio-turn-transaction.mjs); both answer null when the turn is not wrapped.
 * images(): the pictures the user attached to this request ([{ data, mimeType }]).
 * background false: the call waits for the motion (a task's run). background true: the call answers started once the
 * scene is read and motion_result collects the result. Until the install, with(list)'s tools and the install hold the
 * scene one at a time, and a call that changed an id the motion is written against (every character and object id of
 * the scene it read, onScene) is rolled back and refused. changed(): the ids the calls that went through changed
 * meanwhile (motion-run.mjs checks them after the install). sceneOf(): the scene the turn's tools act on; the install is refused once it is another than at the start.
 * drafting(steps) and onDraft(answer) go to the run only then (motion-draft.mjs): the draft's steps hold the scene like
 * the install, and the first motion_result before the install answers the draft once it is made.
 * key and jobs (a Map): the conversation and where its motion is kept between turns (motion-job.mjs). With them a
 * stopped or failed turn does not stop the motion: it goes on without a turn, installs nothing until a later door's
 * motion_result takes it over, and note() tells that door's agent of it. Without them a stopped turn stops the motion.
 * turn: this turn's id, kept with a motion it starts (turnMotionDoor drops the motion of a turn the user's edit cut).
 * stopped: the turn's own stop signal: the motion leaves the turn the moment the user stops it (the run may take a
 * while to wind down, and unfinished comes only then), so a writer that ends meanwhile installs nothing in it.
 * An install waits for a turn that holds the motion and whose scene is the motion's: with another scene open the run
 * is told (an Error with code "scene") and keeps the motion out (motion-run.mjs), to be installed on request later.
 * unfinished({ failed }) -> null, or the text of a result the agent has not collected, which the runner hands to the
 * model before the turn may end (agent-runner.mjs); failed (the turn ended on an error or a stop): see key and jobs.
 */
export function createMotionDoor({ run, mark, rollback, images = () => [], background = false, sceneOf = () => null, refit = null, key = null, jobs = null, invoke = null, workspaceHandle = null, turn = null, stopped = null }) {
	let tail = Promise.resolve(); // the scene's holder: one guarded call or the install at a time
	const hold = step => { const next = tail.then(step); tail = next.catch(() => {}); return next; };
	const seat = { hold, mark, rollback, sceneOf, invoke, workspaceHandle }; // this turn, as a motion's holder
	const progress = rowOf => {
		let steps = 0; // one progress frame per compile (the shape of script-tool.mjs progressFrame); a failing view never fails the call
		// the row it goes to now: a waiting door's call, or a job's (its motion call, then the motion_result that waits for it)
		const frame = (ok, summary) => { const to = rowOf(); if (to?.toolCallId && typeof to.emit === "function") try { to.emit({ type: "tool.progress", callId: to.toolCallId, index: ++steps, name: "motion", status: ok ? "done" : "failed", summary: summary.slice(0, 160) }); } catch { /* advisory */ } };
		// and one, "bodiesSet ...", when the install set a character's scale or tint (motion-run.mjs onBodies)
		return { onCompile: ({ n, ok, line }) => frame(ok, ok ? `compile ${n}` : line), onBodies: list => frame(true, `bodiesSet ${list.map(body => `${body.id}${body.scale === undefined ? "" : ` scale ${body.scale}`}${body.tint ? ` tint ${body.tint}` : ""}`).join(", ")}`) };
	};
	const waiting = async (args, { signal, toolCallId, emit } = {}) => {
		await mark();
		try {
			const done = await run({ request: args.request, images: args.images ? images() : [], signal, seat: () => seat, ...progress(() => ({ toolCallId, emit })) });
			return answerOf(done);
		} catch (error) {
			if (error?.code === "studio") await rollback();
			throw error;
		}
	};
	const stored = () => (jobs && key != null ? jobs.get(key) ?? null : null);
	let job = stored(); // this conversation's motion: one of this turn, or one an earlier turn left (taken over by motion_result)
	const own = current => { if (current && current.seat !== seat) current.adopt(seat); return current; };
	if (jobs && key != null) stopped?.addEventListener("abort", () => { if (job?.seat === seat && !job.collected) job.leave(); }, { once: true });
	const collect = async current => {
		try {
			const done = await current.result, answer = answerOf(done);
			current.offer = done.install ?? null;
			// the receipts of an install an earlier turn made are no edits of this turn: undo_edit would refuse them
			if (current.wentIn && current.wentIn !== seat) delete answer.undo;
			return answer;
		// a call of a turn that has ended since (it left the motion) collects nothing: a later turn's does
		} finally { if (current.seat === seat) { current.collected = true; if (!current.offer && stored() === current) jobs.delete(key); } }
	};
	const starting = async (args, { signal, toolCallId, emit } = {}) => {
		if (job && !job.collected) { own(job); throw coded("MOTION_RUNNING", "A motion of this conversation has no answered result yet: motion_result answers it; a change to it is another motion call after that."); }
		// with a place to keep it, the motion does not hang on this turn's signal: a stopped turn leaves it running
		const current = createJob({ seat, scene: sceneOf(), row: { toolCallId, emit }, turn });
		let read;
		const scene = new Promise(resolve => { read = resolve; });
		current.draft = new Promise(resolve => { current.onDraft = resolve; });
		// the draft's editor steps (and their removal when the motion fails) hold the scene like the install, under their own
		// mark; with no turn holding the motion they are not made
		const drafting = steps => {
			if (!current.seat) return Promise.reject(coded("NO_TURN", "no turn runs"));
			const s = current.seat;
			return s.hold(async () => {
				if (s.sceneOf() !== current.scene) throw coded("studio", "Another scene is open.");
				await s.mark();
				try { return await steps(); } catch (error) { await s.rollback(); throw error; }
			});
		};
		// the install holds the scene alone, in the turn that holds the motion then (motion-job.mjs installIn)
		const exclusive = install => installIn(current, install);
		const onScene = ids => { current.held = new Set([...Object.values(ids?.characters ?? {}), ...Object.values(ids?.props ?? {}).map(prop => prop?.id)]); read(); };
		const writerSignal = jobs && key != null ? current.stop.signal : signal ? AbortSignal.any([signal, current.stop.signal]) : current.stop.signal;
		const shown = progress(() => current.row);
		current.result = run({ request: args.request, images: args.images ? images() : [], signal: writerSignal, seat: () => current.seat ?? current.last, onBodies: shown.onBodies, onCompile: shown.onCompile, onScene, changed: () => [...current.changed], exclusive, drafting, onDraft: (answer, watch) => { current.watch = watch; current.onDraft(answer); } });
		current.result.catch(() => {}).finally(() => { current.installed = true; current.settled = true; read(); });
		job = current;
		if (jobs && key != null) jobs.set(key, current);
		await scene;
		// a motion that ended before it read the scene: its answer or its error is this call's
		return current.held ? { ok: true, started: true } : collect(current);
	};
	let seen = null; // the full ids the nested calls of the guarded call changed (nested): a script's summary keeps 8 per call
	// a draft's stand-in removed by this call or by another caller before it: the draft reads the scene before and after
	// each call until the install (motion-draft.mjs watch)
	const watched = async current => { if (current?.watch && !current.installed) try { await current.watch(); } catch { /* a stand-in not seen gone stays the draft's */ } };
	const guard = tool => ({ ...tool, handler: async (args, call) => {
		const current = job?.seat === seat ? job : null;
		if (!current || current.installed) return tool.handler(args, call);
		return hold(async () => {
			// a call that waited for the install runs after it unguarded; the ids it changed still reach the result (motion-run.mjs)
			const guarded = !current.installed && current.held?.size > 0;
			if (guarded) await mark();
			await watched(current);
			const ids = seen = new Set();
			let result;
			try { result = await tool.handler(args, call); } finally { seen = null; }
			const all = [...new Set([...touched(result), ...ids])], hit = guarded ? all.filter(id => current.held.has(id)) : [];
			if (!hit.length) {
				if (result?.ok !== false) for (const id of all) current.changed.add(id);
				await watched(current);
				return result;
			}
			// a failed script already rolled back its own edits (agent-routes.mjs scriptTool), or changed nothing; the mark is spent
			const failed = result?.ok === false ? `This call failed (${result.error?.message ?? result.message ?? "no message"}) and ${result.rollback ? "its edits were undone" : "changed nothing"}. It also changed` : null;
			let undone = Boolean(result?.rollback), why = "";
			if (!failed) try { undone = Boolean(await rollback()); } catch (error) { why = ` (${error?.code ?? "error"}: ${error?.message ?? String(error)})`; }
			throw coded("MOTION_RUNNING", `${failed ?? "This call changed"} ${hit.join(", ")}, which the motion being written uses as it was when the motion started${failed ? "" : `; ${undone ? "its edits were undone" : `its edits could not be undone${why}`}`}. Such a change works once the motion is installed, which motion_result waits for.`);
		});
	} });
	// the tools a script calls: each records the full ids it changed for the guarded call around the script
	const nested = list => (background ? list.map(tool => ({ ...tool, handler: async (args, call) => {
		const current = seen && job?.seat === seat ? job : null;
		await watched(current);
		const result = await tool.handler(args, call);
		await watched(current);
		if (seen && Array.isArray(result?.affectedIds)) for (const id of result.affectedIds) seen.add(id);
		return result;
	} })) : list);
	const resultTool = {
		name: "motion_result", label: "Motion result", description: RESULT_DESCRIPTION, parameters: RESULT_PARAMETERS,
		handler: async (args = {}, { toolCallId, emit } = {}) => {
			const current = own(job);
			if (!current) throw coded("NO_MOTION", "This conversation has no motion that is being written or waits to be collected.");
			if (args.install) {
				if (!current.collected) throw coded("MOTION_RUNNING", "The motion has no answered result yet: motion_result without install answers it (and installs it when the writer answered for it).");
				if (!current.offer) throw coded("NO_OFFER", "The last motion result has no motion left to install: it was installed, or it was the motion that plays, or it compiled none.");
				// an install the Studio refused keeps the offer; one kept out again (another scene) offers itself again
				const done = await current.offer();
				current.offer = done.install ?? null;
				current.result = Promise.resolve(done);
				if (!current.offer && stored() === current) jobs.delete(key);
				return answerOf(done);
			}
			if (args.stop && !current.settled) current.stop.abort();
			current.row = { toolCallId, emit }; // the writer's compiles show on this call's row while it waits
			// the first call while the writer works answers the draft once it is made; the result when the writer ends first
			if (!args.stop && !current.told && !current.settled) {
				const draft = await Promise.race([current.draft, current.result.then(() => null, () => null)]);
				if (draft && !current.settled && !current.told) { current.told = true; return draft; }
			}
			return collect(current);
		},
	};
	// a call without request: the refit (motion-refit.mjs), which holds the scene like an install and is rolled back when
	// the Studio refused a step; never while this conversation's motion is still being written
	const refitting = async () => {
		if (job && !job.collected) throw coded("MOTION_RUNNING", "A motion of this conversation has no answered result yet: motion_result answers it; a refit is another motion call after that.");
		if (!refit) throw coded("NO_REFIT", "This motion tool cannot refit.");
		return hold(async () => {
			await mark();
			try { return await refit(); } catch (error) { if (error?.code === "studio") await rollback(); throw error; }
		});
	};
	const door = {
		name: "motion",
		label: "Make the motion",
		description: background ? `${DESCRIPTION}${STARTED}${REFIT}` : `${DESCRIPTION}${REFIT}`,
		parameters: PARAMETERS,
		handler: (args, call) => (typeof args?.request === "string" && args.request ? (background ? starting : waiting)(args, call) : refitting()),
		with: list => (background ? [...list.map(guard), door, resultTool] : [...list, door]),
		nested,
		// what the agent is told at the start of the turn of a motion an earlier turn left (motion-job.mjs jobNote)
		note: () => (job && job.seat !== seat ? jobNote(job) : null),
		unfinished: async ({ failed = false } = {}) => {
			const current = job?.seat === seat ? job : null;
			if (!current || current.collected) return null;
			if (failed) {
				// kept for a later turn: it goes on and installs nothing until one takes it over
				if (jobs && key != null) { current.leave(); return null; }
				current.stop.abort(); await current.result.catch(() => {}); current.collected = true; return null;
			}
			const label = current.first === seat ? ENDED : ENDED_LATER;
			try { return `${label}\n${JSON.stringify(await collect(current))}`; } catch (error) { return `${label}\n${error?.code ?? "error"}: ${error?.message ?? String(error)}`; }
		},
	};
	return door;
}

const pictures = new Map(); // the user turn's conversation (a task's: its main session) -> the pictures of its last request
const jobs = new Map(); // a plain conversation -> its motion, kept between turns (createMotionDoor key and jobs)
const turns = new Map(); // a plain conversation -> the id of its last user turn

/**
 * The motion tool of one Studio turn, or null: the coordinator of task mode (value.main) gets none, nor does any turn
 * while the old motion engine is on or the motion writer cannot run. A user turn with pictures keeps them for the
 * motion tool of its conversation (a task's run reads its main session's); a later user turn without pictures drops
 * them, so old pictures never go with a later request. The main agent's hidden report turn changes nothing.
 * A plain turn's door runs the motion in the background, and its motion outlives the turn (jobs), unless the user's
 * edit of their last message cut the turn that started it; a task's run waits for it (its dependents wait on the task)
 * and stops it with the run.
 * tools: the turn's Studio tools (their internal.invoke runs the install); transaction: the turn's
 * studioTransaction (mark, rollback); admission: the turn's (its host names the scene the tools act on). deps: runMotion's (tests).
 */
export async function turnMotionDoor({ value, env = process.env, hub, tools, transaction, admission = null, signal, deps = null }) {
	const key = value.task?.parentId ?? value.sessionId;
	if (value.attachments?.length) pictures.set(key, picturesOf(value.attachments));
	else if (!value.task && !value.hidden) pictures.delete(key);
	if (!value.task && !value.hidden) cutWith(jobs, turns, key, value);
	if (value.main || motionEngine(env) !== "lowvis" || !await motionAvailable(env)) return null;
	const invoke = (action, args) => tools.internal.invoke("run_action", { action, args });
	return createMotionDoor({
		// the user's message as typed goes with the agent's request; a task's is the message its coordinator had (studio-task-routes.mjs)
		// the install runs through the turn that holds the motion then (seat): this one, or a later one that took it over
		run: ({ request, images, signal: callSignal, seat, onCompile, onBodies, onScene, changed, exclusive, drafting, onDraft }) => runMotion({ words: value.task ? value.task.words : value.text, wordsOf: value.task ? "task" : "turn", note: request, images, memoryKey: key,
			hub: { command: (name, args) => hub.command(name, args, seat().workspaceHandle) }, invoke: (action, args) => seat().invoke(action, args),
			signal: value.task && callSignal && signal ? AbortSignal.any([callSignal, signal]) : value.task ? callSignal ?? signal : callSignal, env, onCompile, onBodies, onScene, changed, exclusive, drafting, onDraft, deps }),
		refit: () => refitMotion({ hub, workspaceHandle: value.context.host.workspaceHandle, memoryKey: key, invoke, env, ...(deps?.refit ? { deps: deps.refit } : {}) }),
		mark: () => transaction.mark(), rollback: () => transaction.rollback(), images: () => pictures.get(key) ?? [],
		background: !value.task, sceneOf: () => admission?.host?.sceneId ?? null,
		invoke, workspaceHandle: value.context.host.workspaceHandle, ...(value.task ? {} : { key, jobs, turn: value.turnId ?? null, stopped: signal }),
	});
}
