// The motion tool of the Studio agent: the user's message of the turn, as typed, and the agent's note go to the motion
// environment (motion-run.mjs runMotion) and a report comes back. The route builds one door per turn
// (agent-routes.mjs) and adds it to the agent's tools while the lowvis engine is the motion engine and the motion
// writer's model is reachable (motionAvailable). In a plain turn the motion is written while the agent goes on, and its
// result reaches the agent before the turn can end (createMotionDoor background).
import { cliproxyBase, fetchModelList } from "./cliproxy-provider.mjs";
import { motionEngine } from "./motion-engine.mjs";
import { motionWriter } from "./motion-engine.mjs";
import { runMotion } from "./motion-run.mjs";

const DESCRIPTION = "Makes the body motion of rig characters. The user's message of this turn reaches it by itself, as typed; request is your note: which body and objects, what to keep or change. It reads the scene, uses the characters and objects there, adds the characters and the objects the body touches, stands on, sits on, holds or moves that the scene lacks (each a plain box or ball at the place and size the motion needs), installs the motion and moves the objects it handles. used names the objects the motion uses as boxes and the floor the bodies cross. A body is as large as its character's scale and has its character's tint: the motion is written for the scale a character has, and sets the scale and the tint the request gives a body; bodies names each animated character's scale and tint when one has another scale than 1 or a tint, bodiesSet the scale and tint this motion set. Its report ends with a Missing line. images: true sends the user's pictures.";
// A plain turn's motion runs while the agent works (createMotionDoor background): the facts the agent reads of it.
const STARTED = " In this turn it answers started once it has read the scene; the motion is then written and installed while you go on (minutes). Its result is what it answers otherwise: the report and its Missing line, frames, the characters and objects, used. motion_result answers that result, waiting only for what is left of the motion. Until the motion is installed, a call that changes a character or object it is written against is undone and refused: until the motion writer's first compile every character and solid object of the scene, then the ones its compiled scenes name and the characters it adds. Any other call goes through, so work that does not depend on where the body goes can be done meanwhile; the result's motionFit names an object changed or added meanwhile that differs from the box the motion used or stands on floor the feet use. The turn does not end before the result has reached you: if you end first, it comes to you as a message.";
const RESULT_DESCRIPTION = "Answers the result of the motion that motion started in this turn (the report and its Missing line, frames, the characters and objects, used), waiting for what is left of it. A motion that failed answers its error.";
// labelled as the editor's own message (session-store.mjs OBSERVATION_LABEL): a restored transcript does not show it as the user's words
const ENDED = "Studio motion observation: the motion started in this turn has ended. Its result, as motion_result answers it:";
const PARAMETERS = {
	type: "object",
	properties: { request: { type: "string", minLength: 1, maxLength: 4000 }, images: { type: "boolean" } },
	required: ["request"], additionalProperties: false,
};
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
const answerOf = done => ({ ok: true, report: done.report, missing: done.missing, frames: done.frames, clipSeconds: done.clipSeconds, tookSeconds: done.tookSeconds, compiles: done.compiles, characters: done.characterIds, objects: done.objectIds, switched: done.switched, used: done.used ?? null, ...(done.motionFit ? { motionFit: done.motionFit } : {}), ...(done.bodies ? { bodies: done.bodies } : {}), ...(done.bodiesSet ? { bodiesSet: done.bodiesSet } : {}) });
// The ids a tool call changed: its own, and those of each call of a script (script-tool.mjs calls).
const touched = result => [...(Array.isArray(result?.affectedIds) ? result.affectedIds : []), ...(Array.isArray(result?.calls) ? result.calls.flatMap(call => (Array.isArray(call?.affectedIds) ? call.affectedIds : [])) : [])];

/**
 * createMotionDoor({ run, mark, rollback, images, background, sceneOf }) -> the model-facing `motion` tool
 * (bin/agent/pi-tools.mjs toAgentTools shape), plus with(list) (the turn's tools and the motion's) and unfinished.
 * run({ request, images, signal, onCompile, onBodies, onScene, exclusive }) -> runMotion's answer (the route binds the rest).
 * mark() / rollback(): the turn transaction's (studio-turn-transaction.mjs); both answer null when the turn is not wrapped.
 * images(): the pictures the user attached to this request ([{ data, mimeType }]).
 * background false: the call waits for the motion (a task's run). background true: the call answers started once the
 * scene is read and motion_result collects the result. Until the install, with(list)'s tools and the install hold the
 * scene one at a time, and a call that changed an id the motion is written against is rolled back and refused: every
 * id of the scene it read (onScene) until the writer's first compile, then the ids its compiled scenes name (onNamed,
 * which grows). changed(): the ids the calls that went through changed meanwhile (motion-run.mjs checks them after the
 * install). sceneOf(): the scene the turn's tools act on; the install is refused once it is another than at the start.
 * unfinished({ failed }) -> null, or the text of a result the agent has not collected, which the runner hands to the
 * model before the turn may end (agent-runner.mjs); failed (the turn ended on an error or a stop) stops the motion instead.
 */
export function createMotionDoor({ run, mark, rollback, images = () => [], background = false, sceneOf = () => null }) {
	const progress = (toolCallId, emit) => {
		let steps = 0; // one progress frame per compile (the shape of script-tool.mjs progressFrame); a failing view never fails the call
		const frame = (ok, summary) => { if (toolCallId && typeof emit === "function") try { emit({ type: "tool.progress", callId: toolCallId, index: ++steps, name: "motion", status: ok ? "done" : "failed", summary: summary.slice(0, 160) }); } catch { /* advisory */ } };
		// and one, "bodiesSet ...", when the install set a character's scale or tint (motion-run.mjs onBodies)
		return { onCompile: ({ n, ok, line }) => frame(ok, ok ? `compile ${n}` : line), onBodies: list => frame(true, `bodiesSet ${list.map(body => `${body.id}${body.scale === undefined ? "" : ` scale ${body.scale}`}${body.tint ? ` tint ${body.tint}` : ""}`).join(", ")}`) };
	};
	const waiting = async (args, { signal, toolCallId, emit } = {}) => {
		await mark();
		try {
			return answerOf(await run({ request: args.request, images: args.images ? images() : [], signal, ...progress(toolCallId, emit) }));
		} catch (error) {
			if (error?.code === "studio") await rollback();
			throw error;
		}
	};
	let job = null; // this turn's motion: { result, stop, held, installed, collected, scene }
	let tail = Promise.resolve(); // the scene's holder: one guarded call or the install at a time
	const hold = step => { const next = tail.then(step); tail = next.catch(() => {}); return next; };
	const collect = async current => { try { return answerOf(await current.result); } finally { current.collected = true; } };
	const starting = async (args, { signal, toolCallId, emit } = {}) => {
		if (job && !job.collected) throw coded("MOTION_RUNNING", "A motion of this turn is still being written: motion_result answers it; a change to it is another motion call after that.");
		const current = { stop: new AbortController(), held: null, named: null, changed: new Set(), installed: false, collected: false, scene: sceneOf() };
		let read;
		const scene = new Promise(resolve => { read = resolve; });
		// the install holds the scene alone, under its own mark, and is rolled back when the Studio refused it
		const exclusive = install => hold(async () => {
			try {
				if (sceneOf() !== current.scene) throw coded("studio", "Another scene was opened while the motion was written, so it was not installed. Call motion again in the scene it belongs to.");
				await mark();
				try { return await install(); } catch (error) { if (error?.code === "studio") await rollback(); throw error; }
			} finally { current.installed = true; }
		});
		const onScene = ids => { current.held = new Set([...Object.values(ids?.characters ?? {}), ...Object.values(ids?.props ?? {}).map(prop => prop?.id)]); read(); };
		const onNamed = list => { current.named = new Set([...(current.named ?? []), ...list]); current.held = current.named; };
		current.result = run({ request: args.request, images: args.images ? images() : [], signal: signal ? AbortSignal.any([signal, current.stop.signal]) : current.stop.signal, ...progress(toolCallId, emit), onScene, onNamed, changed: () => [...current.changed], exclusive });
		current.result.catch(() => {}).finally(() => { current.installed = true; read(); });
		job = current;
		await scene;
		// a motion that ended before it read the scene: its answer or its error is this call's
		return current.held ? { ok: true, started: true } : collect(current);
	};
	let seen = null; // the full ids the nested calls of the guarded call changed (nested): a script's summary keeps 8 per call
	const guard = tool => ({ ...tool, handler: async (args, call) => {
		const current = job;
		if (!current || current.installed) return tool.handler(args, call);
		return hold(async () => {
			if (current.installed) return tool.handler(args, call);
			const guarded = current.held?.size > 0;
			if (guarded) await mark();
			const ids = seen = new Set();
			let result;
			try { result = await tool.handler(args, call); } finally { seen = null; }
			const all = [...new Set([...touched(result), ...ids])], hit = guarded ? all.filter(id => current.held.has(id)) : [];
			if (!hit.length) {
				if (result?.ok !== false) for (const id of all) current.changed.add(id);
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
		const result = await tool.handler(args, call);
		if (seen && Array.isArray(result?.affectedIds)) for (const id of result.affectedIds) seen.add(id);
		return result;
	} })) : list);
	const resultTool = {
		name: "motion_result", label: "Motion result", description: RESULT_DESCRIPTION, parameters: { type: "object", properties: {}, additionalProperties: false },
		handler: async () => {
			if (!job) throw coded("NO_MOTION", "No motion was started in this turn.");
			return collect(job);
		},
	};
	const door = {
		name: "motion",
		label: "Make the motion",
		description: background ? `${DESCRIPTION}${STARTED}` : DESCRIPTION,
		parameters: PARAMETERS,
		handler: background ? starting : waiting,
		with: list => (background ? [...list.map(guard), door, resultTool] : [...list, door]),
		nested,
		unfinished: async ({ failed = false } = {}) => {
			const current = job;
			if (!current || current.collected) return null;
			if (failed) { current.stop.abort(); await current.result.catch(() => {}); current.collected = true; return null; }
			try { return `${ENDED}\n${JSON.stringify(await collect(current))}`; } catch (error) { return `${ENDED}\n${error?.code ?? "error"}: ${error?.message ?? String(error)}`; }
		},
	};
	return door;
}

const pictures = new Map(); // the user turn's conversation (a task's: its main session) -> the pictures of its last request

/**
 * The motion tool of one Studio turn, or null: the coordinator of task mode (value.main) gets none, nor does any turn
 * while the old motion engine is on or the motion writer cannot run. A user turn with pictures keeps them for the
 * motion tool of its conversation (a task's run reads its main session's); a later user turn without pictures drops
 * them, so old pictures never go with a later request. The main agent's hidden report turn changes nothing.
 * A plain turn's door runs the motion in the background; a task's run waits for it (its dependents wait on the task).
 * tools: the turn's Studio tools (their internal.invoke runs the install); transaction: the turn's
 * studioTransaction (mark, rollback); admission: the turn's (its host names the scene the tools act on). deps: runMotion's (tests).
 */
export async function turnMotionDoor({ value, env = process.env, hub, tools, transaction, admission = null, signal, deps = null }) {
	const key = value.task?.parentId ?? value.sessionId;
	if (value.attachments?.length) pictures.set(key, picturesOf(value.attachments));
	else if (!value.task && !value.hidden) pictures.delete(key);
	if (value.main || motionEngine(env) !== "lowvis" || !await motionAvailable(env)) return null;
	return createMotionDoor({
		// the user's message as typed goes with the agent's request; a task's is the message its coordinator had (studio-task-routes.mjs)
		run: ({ request, images, signal: callSignal, onCompile, onBodies, onScene, onNamed, changed, exclusive }) => runMotion({ words: value.task ? value.task.words : value.text, wordsOf: value.task ? "task" : "turn", note: request, images, memoryKey: key, hub, workspaceHandle: value.context.host.workspaceHandle,
			invoke: (action, args) => tools.internal.invoke("run_action", { action, args }), signal: callSignal && signal ? AbortSignal.any([callSignal, signal]) : callSignal ?? signal, env, onCompile, onBodies, onScene, onNamed, changed, exclusive, deps }),
		mark: () => transaction.mark(), rollback: () => transaction.rollback(), images: () => pictures.get(key) ?? [],
		background: !value.task, sceneOf: () => admission?.host?.sceneId ?? null,
	});
}
