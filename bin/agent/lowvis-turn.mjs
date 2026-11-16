// One Studio turn on the lowvis motion engine through the direct key: the whole request goes to the motion writer
// (motion-run.mjs runMotion: the Studio's scene, the motion writer, the install), with no Studio agent around it.
// The key "lowvis/claude-opus-5-5" is listed in the Agent box's model picker while CLIProxyAPI is signed in; the
// route sends that key here and every other key on (agent-routes.mjs). The default agent reaches the same flow
// through its motion tool (motion-door.mjs). motion-run.mjs is loaded on a turn only: it reads src/.

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
 * /agent/models with the motion engines' entries for the engine that is on (motion-engine.mjs): under the old engine the
 * v4 entries and the direct key as before; under the lowvis engine no v4 entry, and the direct key only with
 * COZYCLAY_MOTION_DIRECT=on (the default agent reaches the motion writer through its motion tool).
 */
export async function withMotionModels(listing, env = process.env) {
	const { motionEngine, motionDirect } = await import("./motion-engine.mjs");
	if (motionEngine(env) === "old") return withLowvisModels((await import("./v4/models.mjs")).withV4Models(listing));
	return motionDirect(env) ? withLowvisModels(listing) : listing;
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
			const { runMotion } = await import("./motion-run.mjs");
			const done = await runMotion({ words: value.text, memoryKey: value.sessionId, hub, workspaceHandle: value.context.host.workspaceHandle, invoke: (action, args) => studioTools.internal.invoke("run_action", { action, args }), signal, env, onCompile: ({ n, ok, line }) => {
				// one tool row per compile, as the panel shows any tool call
				const callId = `lowvis-motion-${value.turnId}-${++compiles}`;
				send({ type: "tool.start", callId, name: "motion", label: "compile the motion", args: { n } });
				send(ok ? { type: "tool.done", callId, ok: true, elapsedMs: 0, result: { n } } : { type: "tool.done", callId, ok: false, elapsedMs: 0, error: line });
			} });
			send({ type: "text.delta", text: `${done.report ?? "The motion is installed."}\n\n(${done.frames} frames = ${done.clipSeconds} s of motion, ${done.characterIds.length} character(s), ${done.objectIds.length} object(s), made in ${done.tookSeconds} s, ${done.compiles} compile(s))` });
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
