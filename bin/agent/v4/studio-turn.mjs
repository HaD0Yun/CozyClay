// One Studio turn on the v4 engine: one Claude Code agent (sdk.query) with the CozyClay v4 tools on an
// in-process MCP server, one SDK session per Studio conversation (later turns resume it). No coordinator,
// task board, review, plan capture or supervisor. agent-routes.mjs hands a v4 turn here right after it
// created the turn's studio tools; everything before that (owner, freshness, session, record) is shared.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { bindTurn, createV4Context, subjectOf } from "./context.mjs";
import { createFrameMapper, historyMessages } from "./frames.mjs";
import { createV4McpServer } from "./mcp-server.mjs";
import { sceneBrief } from "./prompt.mjs";
import { childEnv, proxyAuth, queryOptions } from "./runner.mjs";

const MODEL = "claude-opus-5-5";
const IDLE_MS = 60 * 60_000;
const STOP_GRACE_MS = 5000;
const MISSING = /no conversation found/i;
const RESTARTED = "Note: the CozyClay tools restarted since the last turn. The js session and the track store are empty (rig and the host functions are back); the installed take is still on the character.";

// Studio sessionId -> { ctx, toolSet, turns, idle }
const conversations = new Map();

const defaultLoadToolSet = ctx => import("./tool-set.mjs").then(module => module.createV4ToolSet(ctx));
const defaultLoadSdk = () => import("@anthropic-ai/claude-agent-sdk");

function retire(sessionId) {
	const conversation = conversations.get(sessionId);
	if (!conversation) return;
	conversations.delete(sessionId);
	clearTimeout(conversation.idle);
	try { void Promise.resolve(conversation.toolSet?.close?.()).catch(() => {}); } catch { /* a tool set that fails to close is gone anyway */ }
}

const sameSubject = (a, b) => a.id === b.id && a.model === b.model && a.yaw === b.yaw && a.scale === b.scale && a.position.every((value, i) => value === b.position[i]);

/** The conversation's context and tool set: reused while the subject stays the same, else built again. */
async function conversationFor(sessionId, turn, loadToolSet) {
	const existing = conversations.get(sessionId);
	if (existing && sameSubject(existing.ctx.character, subjectOf(turn.describe))) {
		clearTimeout(existing.idle);
		bindTurn(existing.ctx, turn);
		return { conversation: existing, fresh: false };
	}
	retire(sessionId);
	const ctx = createV4Context(turn);
	const conversation = { ctx, toolSet: await loadToolSet(ctx), turns: 0, idle: null };
	conversations.set(sessionId, conversation);
	return { conversation, fresh: true };
}

const v4Root = sessionStore => (typeof sessionStore?.dir === "string" ? join(dirname(sessionStore.dir), "v4") : join(tmpdir(), "cozyclay-v4"));
const markerPath = (root, id) => join(root, "sessions", `${id}.json`);
function readMarker(root, id) {
	try { return JSON.parse(readFileSync(markerPath(root, id), "utf8")); } catch { return null; }
}

function installedOf(describe, id) {
	const doc = describe?.document;
	const scene = Array.isArray(doc?.scenes) ? doc.scenes.find(entry => entry?.id === doc.activeSceneId) : null;
	const staged = Array.isArray(scene?.stage?.characters) ? scene.stage.characters.find(entry => entry?.id === id) : null;
	const spec = (staged ?? describe?.characters?.find?.(entry => entry?.id === id))?.motionTake?.spec;
	return Number.isFinite(spec?.frames) ? { frames: spec.frames, raw: Boolean(spec.raw) } : null;
}

function trackLine(ctx) {
	let info;
	try { info = ctx.track?.info?.() ?? null; } catch { info = null; }
	if (!info?.revision) return "Track: none yet in this session.";
	const installed = Number.isInteger(info.committed) && info.committed > 0 ? `installed r${info.committed}` : info.committed === true ? "installed" : "not installed yet";
	return info.dirty ? `Track: r${info.revision}, ${info.frames} frames (changed since ${installed}).` : `Track: installed r${info.revision}, ${info.frames} frames.`;
}

const imagesOf = attachments => (Array.isArray(attachments) ? attachments : []).map(entry => /^data:([^;]+);base64,(.*)$/.exec(entry?.dataUrl ?? "")).filter(Boolean).map(match => ({ mimeType: match[1], data: match[2] }));

/** What the model reads this turn (`text`) and what the session store keeps (`stored`). */
function promptOf({ value, ctx, describe, first, restarted }) {
	if (first) {
		const brief = sceneBrief({ character: ctx.character, sk: ctx.sk, records: Array.isArray(describe?.objects) ? describe.objects : [], installed: installedOf(describe, ctx.character.id), frameCount: value.context?.scene?.frameCount });
		return { text: `${brief}\n\n${value.text}`, stored: `<studio-context>\n${brief}\n</studio-context>\n${value.text}` };
	}
	const state = [trackLine(ctx), ...(restarted ? [RESTARTED] : [])].join("\n");
	return { text: `${value.text}\n\n${state}`, stored: `<studio-context>\n${state}\n</studio-context>\n${value.text}` };
}

/** pi-shaped history, appended as messages complete; the SDK's one-block assistant messages of one response are merged. */
function createHistory({ sessionStore, value, clock, toolName }) {
	const meta = { surface: "studio", sceneName: value.context?.scene?.name ?? null, firstText: value.text };
	const append = messages => { try { if (messages.length) sessionStore?.append?.(value.sessionId, messages, meta); } catch { /* the history mirror never fails a turn */ } };
	let pending = null;
	const flush = () => { if (pending) append([pending]); pending = null; };
	return {
		flush,
		user: (text, images) => append([{ role: "user", content: [{ type: "text", text }, ...images.map(image => ({ type: "image", data: image.data, mimeType: image.mimeType }))], timestamp: clock() }]),
		add(sdkMessage) {
			if (sdkMessage?.type === "stream_event" && sdkMessage.event?.type === "message_stop") return flush();
			const results = [];
			for (const message of historyMessages(sdkMessage, { clock, toolName })) {
				if (message.role !== "assistant") { results.push(message); continue; }
				if (pending?.responseId && pending.responseId === message.responseId) Object.assign(pending, { content: [...pending.content, ...message.content], usage: message.usage, stopReason: message.stopReason });
				else { flush(); pending = message; }
			}
			if (results.length) { flush(); append(results); }
		},
	};
}

/** The model a top-level message came from when it is not claude-opus-5-5 (a refusal fallback), else null. */
function fallbackOf(message) {
	if (message?.type === "system" && message.subtype === "model_refusal_fallback") return message.fallback_model || "another model";
	const model = message?.type === "assistant" && !message.parent_tool_use_id ? message.message?.model : null;
	return typeof model === "string" && model && model !== MODEL && model !== "<synthetic>" ? model : null;
}

async function runQuery({ sdk, options, content, frames, history, signal, report, recordFallback }) {
	const query = sdk.query({ prompt: (async function* () { yield { type: "user", message: { role: "user", content }, parent_tool_use_id: null, session_id: "" }; })(), options });
	let stopped = false, fellBack = false, missing = false, answered = false, grace = null;
	const close = () => { try { query.close?.(); } catch { /* already closed */ } };
	const stop = () => {
		if (stopped) return;
		stopped = true;
		grace = setTimeout(() => options.abortController?.abort(), STOP_GRACE_MS);
		grace.unref?.();
		void Promise.resolve().then(() => query.interrupt?.()).catch(() => {}).finally(close);
	};
	if (signal.aborted) stop(); else signal.addEventListener("abort", stop, { once: true });
	try {
		for await (const message of query) {
			if (fellBack) continue;
			const fallback = fallbackOf(message);
			if (fallback) {
				fellBack = true;
				const text = `The answer came from ${fallback}, not ${MODEL}, so the v4 turn stopped.`;
				report("model_fallback", text);
				recordFallback(text);
				stop();
				continue;
			}
			if (message?.type === "result" && !answered && MISSING.test(`${(message.errors ?? []).join(" ")} ${message.result ?? ""}`)) { missing = true; continue; }
			if (message?.type === "assistant" || message?.type === "stream_event") answered = true;
			if (message?.type === "result" && stopped) continue;
			frames.onMessage(message);
			history.add(message);
		}
	} catch (error) {
		if (!answered && MISSING.test(String(error?.message ?? ""))) missing = true;
		else if (!stopped) throw error;
	} finally {
		signal.removeEventListener("abort", stop);
		clearTimeout(grace);
		history.flush();
		close();
	}
	return { missing };
}

/**
 * runV4StudioTurn({ value, session, send, close, res, controller, studioTools, hub, sessionStore, models, env, clock,
 *                   studioIdentity, admission, loadToolSet, loadSdk }) -> true
 * Runs one turn, ends the record with a done frame, then closes the stream and clears the session's
 * running turn the way agent-routes.mjs does after its own turns.
 */
export async function runV4StudioTurn({ value, session, send, close, res, controller, studioTools, hub, sessionStore, models, env = process.env, clock = Date.now, studioIdentity, admission, loadToolSet = defaultLoadToolSet, loadSdk = defaultLoadSdk }) {
	const frames = createFrameMapper({ push: send, clock });
	let reported = false;
	const report = (code, message) => { if (!reported) { reported = true; send({ type: "error", code, message }); } };
	const signal = controller.signal;
	try {
		const workspaceHandle = value.context.host.workspaceHandle;
		// models: the pi registry, or the route's function that builds it (a failure there is this turn's error frame).
		const auth = await proxyAuth(typeof models === "function" ? await models() : models, { env });
		const describe = await hub.command("describe", {}, workspaceHandle);
		const { conversation, fresh } = await conversationFor(value.sessionId, { describe, studioTools, hub, workspaceHandle, signal }, loadToolSet);
		const root = v4Root(sessionStore), marker = readMarker(root, value.sessionId);
		for (const dir of ["claude", "work", "sessions"]) mkdirSync(join(root, dir), { recursive: true });
		const sdk = await loadSdk();
		const history = createHistory({ sessionStore, value, clock, toolName: frames.toolName });
		const images = imagesOf(value.attachments);
		const env4 = childEnv(env, auth, { configDir: join(root, "claude") });
		const ctx = conversation.ctx;
		let resume = typeof marker?.sdkSessionId === "string" ? marker.sdkSessionId : null;
		let saved = resume ? { turns: Number.isInteger(marker.turns) ? marker.turns : 0, createdAt: marker.createdAt ?? new Date(clock()).toISOString() } : null;
		const writeMarker = (sdkSessionId, turns) => writeFileSync(markerPath(root, value.sessionId), `${JSON.stringify({ sdkSessionId, turns, createdAt: saved.createdAt })}\n`, { mode: 0o600 });
		for (let attempt = 0; attempt < 2 && !signal.aborted; attempt += 1) {
			const sdkSessionId = resume ?? (attempt ? randomUUID() : value.sessionId);
			const prompt = promptOf({ value, ctx, describe, first: !resume, restarted: fresh && Boolean(resume) });
			if (attempt === 0) history.user(prompt.stored, images);
			// A new SDK session is marked before it starts, so a turn that dies half way is resumed next time.
			if (!resume) { saved = { turns: 0, createdAt: new Date(clock()).toISOString() }; writeMarker(sdkSessionId, 0); }
			const server = createV4McpServer(sdk, conversation.toolSet.tools, { signal, onCall: call => ctx.log?.({ type: "tool", ...call }) });
			const options = queryOptions({ server, effort: value.effort, ...(resume ? { resume } : { sessionId: sdkSessionId }), cwd: join(root, "work"), env: env4, abortController: new AbortController() });
			const content = [{ type: "text", text: prompt.text }, ...images.map(image => ({ type: "image", source: { type: "base64", media_type: image.mimeType, data: image.data } }))];
			const recordFallback = message => { try { sessionStore?.appendTurnError?.(value.sessionId, { code: "model_fallback", message }, { surface: "studio" }); } catch { /* advisory */ } };
			const { missing } = await runQuery({ sdk, options, content, frames, history, signal, report, recordFallback });
			if (missing && resume && attempt === 0) {
				send({ type: "text.delta", text: "The saved v4 conversation could not be resumed, so this turn starts a new one.\n\n" });
				resume = null;
				continue;
			}
			conversation.turns += 1;
			writeMarker(sdkSessionId, saved.turns + 1);
			break;
		}
	} catch (error) {
		if (!signal.aborted) report(typeof error?.code === "string" && error.code ? error.code : "upstream", String(error?.message ?? error));
	}
	// An idle conversation closes its tool set (the js session's worker) after IDLE_MS.
	const conversation = conversations.get(value.sessionId);
	if (conversation) {
		clearTimeout(conversation.idle);
		conversation.idle = setTimeout(() => retire(value.sessionId), IDLE_MS);
		conversation.idle.unref?.();
	}
	if (signal.aborted) report("aborted", "The turn was stopped.");
	frames.finish();
	close?.();
	if (res && !res.writableEnded) res.end();
	session.controller = null;
	session.activeTurnId = null;
	if (admission?.host?.workspaceId === value.context.host.workspaceId) session.host = studioIdentity({ ...value.context.host, ...admission.host });
	return true;
}
