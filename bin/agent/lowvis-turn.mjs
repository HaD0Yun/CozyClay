// One Studio turn on the lowvis motion engine (prototype). The request goes to the lowvis authoring loop
// (src/lowvis/pi/harness.mjs: Opus 5.5 on CLIProxyAPI with one tool, shot), and the clip it ends with is installed
// in the Studio as scene content (src/lowvis/studio/install.js): its props as objects, its characters as X Bot cast
// members with the clip's motion as their take.
// The key "lowvis/claude-opus-5-5" is listed in the Agent box's model picker while CLIProxyAPI is signed in; the
// route sends that key here and every other key on (agent-routes.mjs).
// What the last lowvis turn of a conversation made is taken out by the next one. The model does not see the objects
// the Studio already has: it writes a scene of its own.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const LOWVIS_MODEL_KEY = "lowvis/claude-opus-5-5";
const MODEL = { id: "claude-opus-5-5", key: LOWVIS_MODEL_KEY, label: "Opus 5.5 (lowvis motion)", efforts: ["medium", "high", "low"], defaultEffort: "medium", input: ["text"] };
const ROOT = resolve(import.meta.dirname, "../.."), VARIANT = "tilt";
const made = new Map(); // Studio sessionId -> { characterIds, objectIds } of that conversation's last install

/** True for the model key the lowvis engine runs. */
export const isLowvisModel = key => key === LOWVIS_MODEL_KEY;

/** /agent/models with the lowvis entry added, while CLIProxyAPI is signed in and lists the model it runs on. */
export function withLowvisModels(listing) {
	const cliproxy = Array.isArray(listing?.providers) ? listing.providers.find(provider => provider?.id === "cliproxy") : null;
	if (!cliproxy?.signedIn || !cliproxy.models?.some(model => model?.id === MODEL.id)) return listing;
	const provider = { id: "lowvis", label: "CozyClay lowvis motion", signedIn: cliproxy.signedIn, authSource: cliproxy.authSource ?? null, models: [{ ...MODEL }] };
	return { ...listing, providers: [...listing.providers, provider], models: [...(Array.isArray(listing.models) ? listing.models : []), { ...MODEL, id: LOWVIS_MODEL_KEY }] };
}

const stamp = () => { const d = new Date(), p = n => String(n).padStart(2, "0"); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; };

/**
 * runLowvisTurn({ value, session, send, close, res, controller, studioTools, studioRunners, env, studioIdentity,
 *                 admission }) -> true when the lowvis engine ran the turn, false for any other model key.
 * Ends the record with a done frame, then closes the stream and clears the session's running turn the way
 * agent-routes.mjs does.
 */
export async function runLowvisTurn({ value, session, send, close, res, controller, studioTools, studioRunners, env = process.env, studioIdentity, admission }) {
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
			const [{ runScene }, { installClip }] = await Promise.all([import("../../src/lowvis/pi/harness.mjs"), import("../../src/lowvis/studio/install.js")]);
			const name = `agent-${stamp()}`;
			let shots = 0;
			const record = await runScene({ name, request: value.text, model: MODEL.id, effort: value.effort ?? MODEL.defaultEffort, variant: VARIANT, env, signal, log: line => {
				// one tool row per compile, as the panel shows any tool call
				const shot = /^\s*shot (\d+): (\w+)/.exec(line);
				if (!shot) return;
				const callId = `${name}-shot-${++shots}`, ok = shot[2] === "ok";
				send({ type: "tool.start", callId, name: "shot", label: "compile the motion", args: { n: Number(shot[1]) } });
				send(ok ? { type: "tool.done", callId, ok: true, elapsedMs: 0, result: { n: Number(shot[1]) } } : { type: "tool.done", callId, ok: false, elapsedMs: 0, error: line.trim() });
			} });
			if (signal.aborted) throw new Error("aborted");
			if (record.infraError) throw Object.assign(new Error(`The model or the proxy failed: ${record.infraError.message}`), { code: "upstream" });
			if (!record.final) throw new Error(`The motion engine ended without a scene (${record.endedBy}).`);
			const clip = JSON.parse(readFileSync(join(ROOT, "public/lowvis/clips/pi", `${name}.json`), "utf8"));
			let refused = null;
			const run = async (action, args) => { try { return await studioTools.internal.invoke("run_action", { action, args }); } catch (error) { refused = error; return null; } };
			const result = await installClip(clip, run, { label: value.text, remove: made.get(value.sessionId) });
			made.set(value.sessionId, { characterIds: result.characterIds, objectIds: result.objectIds });
			if (!result.ok) throw Object.assign(new Error(`The motion was made (${name}) but the Studio refused to install it: ${refused?.message ?? "unknown reason"}`), { code: refused?.code ?? "studio" });
			send({ type: "text.delta", text: `${record.report ?? "The motion is installed."}\n\n(${clip.frameCount} frames, ${clip.characters.length} character(s), ${(clip.props ?? []).length} prop(s), ${Math.round(record.wallMs / 1000)} s, ${record.compiles} compile(s))` });
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
