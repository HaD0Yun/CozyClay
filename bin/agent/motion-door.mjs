// The motion tool of the Studio agent: the user's message of the turn, as typed, and the agent's note go to the motion
// environment (motion-run.mjs runMotion) and a report comes back. The route builds one door per turn
// (agent-routes.mjs) and adds it to the agent's tools while the lowvis engine is the motion engine and the motion
// writer's model is reachable (motionAvailable).
import { cliproxyBase, fetchModelList } from "./cliproxy-provider.mjs";
import { motionEngine } from "./motion-engine.mjs";
import { MOTION_MODEL, runMotion } from "./motion-run.mjs";

const DESCRIPTION = "Makes the body motion of rig characters. The user's message of this turn reaches it by itself, as typed; request is your note: which body and objects, what to keep or change. It reads the scene, uses the characters and objects there, adds the characters and the objects the body touches, stands on, sits on, holds or moves that the scene lacks (each a plain box or ball at the place and size the motion needs), installs the motion and moves the objects it handles. used names the objects the motion uses as boxes and the floor the bodies cross. Its report ends with a Missing line. images: true sends the user's pictures.";
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
		if (env?.CLIPROXY_BASE_URL && env?.CLIPROXY_API_KEY) ok = (await fetchModelList(`${cliproxyBase({ env })}/v1`, env.CLIPROXY_API_KEY, "CLIProxyAPI")).some(entry => (typeof entry === "string" ? entry : entry?.id) === MOTION_MODEL);
	} catch { ok = false; }
	known = { at: Date.now(), ok };
	return ok;
}

/**
 * createMotionDoor({ run, mark, rollback, images }) -> the model-facing `motion` tool (bin/agent/pi-tools.mjs
 * toAgentTools shape).
 * run({ request, images, signal, onCompile }) -> runMotion's answer (the route binds the rest of runMotion's arguments).
 * mark() / rollback(): the turn transaction's (studio-turn-transaction.mjs); both answer null when the turn is not wrapped.
 * images(): the pictures the user attached to this request ([{ data, mimeType }]).
 */
export function createMotionDoor({ run, mark, rollback, images = () => [] }) {
	return {
		name: "motion",
		label: "Make the motion",
		description: DESCRIPTION,
		parameters: PARAMETERS,
		handler: async (args, { signal, toolCallId, emit } = {}) => {
			await mark();
			let compiles = 0;
			// one progress frame per compile (the shape of script-tool.mjs progressFrame); a failing view never fails the call
			const onCompile = ({ n, ok, line }) => {
				if (toolCallId && typeof emit === "function") try { emit({ type: "tool.progress", callId: toolCallId, index: ++compiles, name: "motion", status: ok ? "done" : "failed", summary: (ok ? `compile ${n}` : line).slice(0, 160) }); } catch { /* advisory */ }
			};
			let done;
			try {
				done = await run({ request: args.request, images: args.images ? images() : [], signal, onCompile });
			} catch (error) {
				if (error?.code === "studio") await rollback();
				throw error;
			}
			return { ok: true, report: done.report, missing: done.missing, frames: done.frames, clipSeconds: done.clipSeconds, tookSeconds: done.tookSeconds, compiles: done.compiles, characters: done.characterIds, objects: done.objectIds, switched: done.switched, used: done.used ?? null };
		},
	};
}

const pictures = new Map(); // the user turn's conversation (a task's: its main session) -> the pictures of its last request

/**
 * The motion tool of one Studio turn, or null: the coordinator of task mode (value.main) gets none, nor does any turn
 * while the old motion engine is on or the motion writer cannot run. A user turn with pictures keeps them for the
 * motion tool of its conversation (a task's run reads its main session's); a later user turn without pictures drops
 * them, so old pictures never go with a later request. The main agent's hidden report turn changes nothing.
 * tools: the turn's Studio tools (their internal.invoke runs the install); transaction: the turn's
 * studioTransaction (mark, rollback). deps: runMotion's (tests).
 */
export async function turnMotionDoor({ value, env = process.env, hub, tools, transaction, signal, deps = null }) {
	const key = value.task?.parentId ?? value.sessionId;
	if (value.attachments?.length) pictures.set(key, picturesOf(value.attachments));
	else if (!value.task && !value.hidden) pictures.delete(key);
	if (value.main || motionEngine(env) !== "lowvis" || !await motionAvailable(env)) return null;
	return createMotionDoor({
		// the user's message as typed goes with the agent's request; a task's is the message its coordinator had (studio-task-routes.mjs)
		run: ({ request, images, signal: callSignal, onCompile }) => runMotion({ words: value.task ? value.task.words : value.text, wordsOf: value.task ? "task" : "turn", note: request, images, memoryKey: key, hub, workspaceHandle: value.context.host.workspaceHandle,
			invoke: (action, args) => tools.internal.invoke("run_action", { action, args }), signal: callSignal && signal ? AbortSignal.any([callSignal, signal]) : callSignal ?? signal, env, onCompile, deps }),
		mark: () => transaction.mark(), rollback: () => transaction.rollback(), images: () => pictures.get(key) ?? [],
	});
}
