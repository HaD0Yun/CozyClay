// One Studio turn on the lowvis motion engine through the direct key: the whole request goes to the motion writer
// (motion-run.mjs runMotion: the Studio's scene, the motion writer, the install), with no Studio agent around it.
// The key "lowvis/claude-opus-5-5" is listed in the Agent box's model picker while CLIProxyAPI is signed in; the
// route sends that key here and every other key on (agent-routes.mjs). The default agent reaches the same flow
// through its motion tool (motion-door.mjs).
import { runMotion } from "./motion-run.mjs";

export const LOWVIS_MODEL_KEY = "lowvis/claude-opus-5-5";
const MODEL = { id: "claude-opus-5-5", key: LOWVIS_MODEL_KEY, label: "Opus 5.5 (lowvis motion)", efforts: ["medium", "high", "low"], defaultEffort: "medium", input: ["text"] };

/** True for the model key the lowvis engine runs. */
export const isLowvisModel = key => key === LOWVIS_MODEL_KEY;

/** /agent/models with the lowvis entry added, while CLIProxyAPI is signed in and lists the model it runs on. */
export function withLowvisModels(listing) {
	const cliproxy = Array.isArray(listing?.providers) ? listing.providers.find(provider => provider?.id === "cliproxy") : null;
	if (!cliproxy?.signedIn || !cliproxy.models?.some(model => model?.id === MODEL.id)) return listing;
	const provider = { id: "lowvis", label: "CozyClay lowvis motion", signedIn: cliproxy.signedIn, authSource: cliproxy.authSource ?? null, models: [{ ...MODEL }] };
	return { ...listing, providers: [...listing.providers, provider], models: [...(Array.isArray(listing.models) ? listing.models : []), { ...MODEL, id: LOWVIS_MODEL_KEY }] };
}

/**
 * runLowvisTurn({ value, session, send, close, res, controller, studioTools, hub, studioRunners, env, studioIdentity,
 *                 admission }) -> true when the lowvis engine ran the turn, false for any other model key.
 * Ends the record with a done frame, then closes the stream and clears the session's running turn the way
 * agent-routes.mjs does.
 */
export async function runLowvisTurn({ value, session, send, close, res, controller, studioTools, hub, studioRunners, env = process.env, studioIdentity, admission }) {
	if (!isLowvisModel(value.model)) return false;
	// a conversation that ran on another engine: its pi runner keeps that engine's prompt, so it is closed (v4/dispatch.mjs)
	if (session.modelSession && (session.turnEngine ?? "studio") !== "lowvis") {
		await studioRunners?.get(value.sessionId)?.close?.();
		studioRunners?.delete(value.sessionId);
		session.modelSession = null;
	}
	session.turnEngine = "lowvis";
	const signal = controller.signal;
	try {
		try {
			let compiles = 0;
			const done = await runMotion({ text: value.text, memoryKey: value.sessionId, hub, workspaceHandle: value.context.host.workspaceHandle, invoke: (action, args) => studioTools.internal.invoke("run_action", { action, args }), signal, env, onCompile: ({ n, ok, line }) => {
				// one tool row per compile, as the panel shows any tool call
				const callId = `lowvis-motion-${value.turnId}-${++compiles}`;
				send({ type: "tool.start", callId, name: "motion", label: "compile the motion", args: { n } });
				send(ok ? { type: "tool.done", callId, ok: true, elapsedMs: 0, result: { n } } : { type: "tool.done", callId, ok: false, elapsedMs: 0, error: line });
			} });
			send({ type: "text.delta", text: `${done.report ?? "The motion is installed."}\n\n(${done.frames} frames, ${done.characterIds.length} character(s), ${done.objectIds.length} object(s), ${done.seconds} s, ${done.compiles} compile(s))` });
		} catch (error) {
			if (!signal.aborted) send({ type: "error", code: typeof error?.code === "string" && error.code ? error.code : "upstream", message: String(error?.message ?? error) });
		}
		if (signal.aborted) send({ type: "error", code: "aborted", message: "The turn was stopped." });
		send({ type: "done" });
	} finally {
		close?.();
		if (res && !res.writableEnded) res.end();
		session.controller = null;
		session.activeTurnId = null;
		if (admission?.host?.workspaceId === value.context.host.workspaceId) session.host = studioIdentity({ ...value.context.host, ...admission.host });
	}
	return true;
}
