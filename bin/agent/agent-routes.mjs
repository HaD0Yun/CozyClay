import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes, randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import * as defaultAuth from "../codex-auth.mjs";
import { liveHubPort, publishLiveEndpoint, removeLiveEndpoint } from "../live-endpoint.mjs";
import { createCodexClient } from "./codex-client.mjs";
import { createAgentTools, SYSTEM_PROMPT, pickWorkspace } from "./agent-tools.mjs";

import { createVideoAdapters, validateFalVideoRequest } from "./video-adapters.mjs";
import { createSessionStore, transcriptFromHistory } from "./session-store.mjs";
import { createAgentRunner } from "./agent-runner.mjs";
import { createProviderRoutes } from "./provider-routes.mjs";
import { STUDIO_SYSTEM_PROMPT_STORYBOARD } from "./studio-prompt.mjs";
import { studioTransaction } from "./studio-turn-transaction.mjs";
import { agentFailureCode, failureCodeOf, frameCodeOf } from "./agent-failure-codes.mjs";

// Values the codex backend accepts for reasoning.effort (its own 400 lists them).
export const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

const json = (res, status, value) => {
	res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
	res.end(JSON.stringify(value));
};

function allowAgentOrigin(req, port) {
	return [`http://127.0.0.1:${port}`, `http://${"local" + "host"}:${port}`].includes(req.headers.origin)
		|| (req.headers.origin === undefined && req.method === "GET"
			&& [`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host));
}

// Two 1920x1080 PNG data URLs (frame + reference) fit comfortably in this.
const IMAGE_BODY_LIMIT = 24 * 1024 * 1024;
// The sizes gpt-image-2 accepts; omitted means the backend's own choice.
const IMAGE_SIZES = ["auto", "1024x1024", "1536x1024", "1024x1536"];

// Attached scene references (#167): identity sheets and the environment
// reference. Capped because every one of them is another full image the
// backend has to read, and a shot with seven of them is a prompt nobody wrote.
const IMAGE_REFERENCES_MAX = 6;

// Pictures pasted or dropped into the composer (#367) ride in the turn body,
// so the chat routes need room for them. Everything else about the small chat
// limit stays: this is exactly four attachments of the size the turn envelope
// admits, plus the envelope itself.
const ATTACHMENTS_MAX = 4;
const ATTACHMENT_MAX_CHARS = 6_000_000;
const TURN_BODY_LIMIT = ATTACHMENTS_MAX * ATTACHMENT_MAX_CHARS + 64 * 1024;

// How long GET /agent/turn/<id>/supervisor holds a request for a review that
// is still running before it answers 204 (#728).
const SUPERVISOR_WAIT_MS = 180_000;

/** Reject anything that is not a short list of inline {dataUrl, name?} images.
 * The Studio envelope validates its own copy; this is the legacy body's. */
function validAttachments(attachments) {
	if (attachments === undefined) return true;
	if (!Array.isArray(attachments) || !attachments.length || attachments.length > ATTACHMENTS_MAX) return false;
	return attachments.every((entry) => entry && typeof entry === "object" && !Array.isArray(entry)
		&& typeof entry.dataUrl === "string" && entry.dataUrl.length <= ATTACHMENT_MAX_CHARS && /^data:image\/(png|jpeg|webp);base64,/.test(entry.dataUrl)
		&& (entry.name === undefined || (typeof entry.name === "string" && entry.name.length <= 120)));
}

// Keep this local relay self-contained: minimal sidecar installs omit src/.
const advisory = (read, fallback) => { try { return read(); } catch { return fallback; } };
const telemetryId = () => advisory(() => randomBytes(16).toString("hex"), null);
const telemetryNow = () => advisory(() => { const value = performance.now(); return Number.isFinite(value) ? value : NaN; }, NaN);
const bucketMs = (ms) => !Number.isFinite(ms) || ms < 1000 ? "lt1s" : ms < 3000 ? "1-3s" : ms < 10000 ? "3-10s" : ms < 30000 ? "10-30s" : "gte30s";
const agentToolCategory = (name) => {
	// Studio families are authored edits or reads; the analytics vocabulary has
	// no Studio-specific category, so a write says so and everything else does not.
	if (["arrange_objects", "arrange_characters", "patch_elements", "frame_shot", "undo_edit"].includes(name)) return "scene_write";
	if (name === "run_workflow") return "workflow_run";
	if (name === "describe_workflow" || name === "focus_workflow_node") return "workflow_read";
	if (["add_workflow_node", "update_workflow_node", "remove_workflow_node", "connect_workflow_nodes", "disconnect_workflow_nodes", "set_workflow_node_output"].includes(name)) return "workflow_write";
	if (name === "capture_blocking_frame") return "frame_capture";
	if (name === "render_from_frame") return "image_generate";
	if (name === "place_image_in_scene" || name === "add_reference_node") return "scene_write";
	return "other";
};
// These existing canvas commands only return a node/edge after publishing a
// new insertion. Read/focus, generic accepted responses, update no-ops and run
// outputs (which can echo old values) are deliberately not application proof.
const appliedCanvasResult = (name, result) => {
	if (name === "add_workflow_node" || name === "add_reference_node") return typeof result?.node?.id === "string" && result.node.id.length > 0;
	if (name === "connect_workflow_nodes") return typeof result?.edge?.id === "string" && result.edge.id.length > 0;
	return false;
};

/**
 * One execution-telemetry emitter, shared by both surfaces. The turn that owns
 * the correlation id owns its frames: a turn without one stays unobserved
 * rather than emitting frames nothing can correlate.
 */
function createTurnTelemetry(send, turnId) {
	const turnStartedAt = telemetryNow();
	let applied = false;
	const emit = (event, props, toolId) => advisory(() => {
		if (turnId) send({ type: "execution_telemetry", event, props, ...(toolId ? { telemetry_id: toolId } : {}) });
	});
	return {
		/** One tool execution: the started frame now, its outcome when it ends. */
		toolStarted(category) {
			const startedAt = telemetryNow();
			const toolId = telemetryId();
			advisory(() => { if (turnId && toolId) send({ type: "execution_tool_started", turn_id: turnId, telemetry_id: toolId, tool_category: category }); });
			return {
				elapsedMs: () => Math.round(telemetryNow() - startedAt),
				executed: (outcome) => {
					if (toolId) emit("agent:tool_executed", { turn_id: turnId, tool_category: category, outcome, duration_bucket: bucketMs(telemetryNow() - startedAt) }, toolId);
				},
			};
		},
		/** The first proof that the scene actually changed, once per turn. */
		applied: () => advisory(() => { if (!applied) { applied = true; emit("agent:result_applied", { turn_id: turnId }); } }),
		finished: (outcome, failureCode) => emit(`agent:turn_${outcome}`, {
			turn_id: turnId,
			duration_bucket: bucketMs(telemetryNow() - turnStartedAt),
			...(outcome !== "succeeded" ? { failure_code: failureCode } : {}),
		}),
	};
}

/** Reject anything that is not a list of {role, name?, dataUrl} inline images. */
function validReferences(references) {
	if (references === undefined) return true;
	if (!Array.isArray(references) || references.length > IMAGE_REFERENCES_MAX) return false;
	return references.every((entry) => entry && typeof entry === "object" && !Array.isArray(entry)
		&& typeof entry.role === "string" && entry.role
		&& (entry.name === undefined || typeof entry.name === "string")
		&& typeof entry.dataUrl === "string" && entry.dataUrl.startsWith("data:image/"));
}

/**
 * What the attached pictures MEAN, in the order they are attached. Without
 * this the backend sees a pile of images and guesses; with it the clay frame
 * owns the geometry, each character sheet owns one performer's look and the
 * environment reference owns the location.
 */
export const FRAME_COMPOSITION_GUIDANCE = "Use the first image (a clay blocking frame) as the layout: keep its composition and camera angle, and keep the pose but make it look natural. Render it as:";

export function referenceGuidance(references = []) {
	const list = Array.isArray(references) ? references : [];
	if (!list.length) return "";
	const lines = ["Geometry, camera and blocking come from the first image (the clay frame)."];
	for (const entry of list) {
		if (entry.role === "character") {
			lines.push(`Character ${entry.name || "reference"}: match the identity, face, hair and wardrobe from the attached character sheet.`);
		} else if (entry.role === "environment") {
			lines.push("Environment: take the location look, materials, palette and lighting from the attached environment reference.");
		} else if (entry.role === "reference") {
			lines.push(`Reference ${entry.name || "image"}: use it for the look the prompt asks for (subject, wardrobe, style); keep the exact pose, body position and camera framing of the first image.`);
		}
	}
	return `\n${lines.join("\n")}`;
}

async function readBody(req, limit = 64 * 1024) {
	let text = "";
	for await (const chunk of req) {
		text += chunk;
		if (Buffer.byteLength(text) > limit) throw new Error("Request too large.");
	}
	return JSON.parse(text || "{}");
}

function quotaEvent(codex, headers) {
	const quota = codex.parseQuotaHeaders(headers);
	let resetAt = quota.primary.resetAt;
	if (resetAt && /^\d+(\.\d+)?$/.test(String(resetAt))) resetAt = Number(resetAt) * 1000;
	if (!resetAt && quota.primary.resetAfterSeconds !== undefined) resetAt = Date.now() + quota.primary.resetAfterSeconds * 1000;
	return {
		type: "quota", plan: quota.planType ?? null,
		primary: { usedPercent: quota.primary.usedPercent ?? null, windowMinutes: quota.primary.windowMinutes ?? null, resetAt: resetAt ?? null },
		credits: { has: quota.credits.hasCredits },
	};
}

// Backend errors may echo credentials or image inputs, so their bodies are
// never forwarded. Only a structured message survives, redacted and clipped to
// one line — without it neither the log nor the panel can say why a turn died.
const UPSTREAM_DETAIL_MAX = 200;
export function sanitizeUpstreamDetail(body) {
	let message;
	try {
		const parsed = JSON.parse(body);
		const candidate = parsed?.error?.message ?? parsed?.error ?? parsed?.message ?? parsed?.detail;
		message = typeof candidate === "string" ? candidate : null;
	} catch { return null; }
	if (!message) return null;
	const cleaned = message
		.replace(/data:[^\s"']+/gi, "[image]")
		.replace(/\b(?:AIza[\w-]{20,}|(?:sk-or-|sk-ant-|sk-|Bearer\s+|eyJ)[\w.\-+/=]+)/gi, "[redacted]")
		.replace(/\s+/g, " ")
		.trim();
	if (!cleaned) return null;
	return cleaned.length > UPSTREAM_DETAIL_MAX ? `${cleaned.slice(0, UPSTREAM_DETAIL_MAX - 1)}\u2026` : cleaned;
}

function errorInfo(error, quota) {
	const status = Number.isInteger(error?.status) ? error.status : null;
	const detail = typeof error?.detail === "string" && error.detail ? error.detail : null;
	// The status and the backend's own sanitized words are the only things that
	// can tell an author WHY the turn died; a generic sentence cannot.
	const explain = (message) => ({
		message: status === null ? message : `${status} \u2014 ${detail || message}`,
		...(status === null ? {} : { status }),
		...(detail ? { detail } : {}),
	});
	if (error?.status === 401 || error?.code === "unauthorized") return { code: "auth", ...explain("Authentication required. Sign in again.") };
	if (error?.status === 429) return { code: "rate_limit", ...explain("Rate limit exceeded."), resetAt: quota?.primary.resetAt ?? null };
	if (error?.code === "entitlement") return { code: "entitlement", ...explain("This account cannot generate images.") };
	if (error?.code === "overloaded") return { code: "overloaded", ...explain("The model service is overloaded right now. Try again in a moment.") };
	if (error?.code === "server_error") return { code: "overloaded", ...explain("The model service hit an internal error. Try again in a moment.") };
	return { code: frameCodeOf(error), ...explain("The model or live editor could not complete this turn.") };
}

/** Use the existing client and its request queue, retaining failure headers that
 * the client otherwise discards. A 429 belongs to the panel's paused state, not
 * the client's unbounded retry loop (which cannot be interrupted during sleep). */
function defaultClient(auth, requestContext) {
	return createCodexClient({
		getAccessToken: auth.getAccessToken, getAccountId: auth.getAccountId, originator: "cozyclay",
		fetch: async (url, init) => {
			const response = await fetch(url, init);
			requestContext.getStore()?.(response.headers);
			if (response.ok) return response;
			const detail = await response.text();
			const error = Object.assign(new Error("Codex backend request failed."), { status: response.status, headers: response.headers, detail: sanitizeUpstreamDetail(detail) });
			if (url.includes("/images/") && /entitlement|plan/i.test(detail)) error.code = "entitlement";
			throw error;
		},
	});
}

// The launcher and the dev runner both own a hub of their own; the endpoint
// file names which one a controller has reached.
const liveHubOwner = () => process.env.COZYCLAY_LIVE_OWNER
	|| (basename(process.argv[1] ?? "") === "dev-full.mjs" ? "dev-full" : "cozyclay");

/** The two live-tool modules. A source checkout resolves them from the
 * repository, where mcp/ has its own node_modules. The published package
 * ships mcp/ without zod, three or ws, so the launcher passes an `mcpRuntime`
 * whose ensure() installs the staged runtime (bin/mcp-runtime.mjs) once per
 * version and the modules are imported from that root instead (#576). */
async function liveToolsModules(mcpRuntime) {
	if (!mcpRuntime) return Promise.all([import("../../mcp/tool-handlers.mjs"), import("../../mcp/live-hub.mjs")]);
	const root = await mcpRuntime.ensure();
	const staged = (file) => pathToFileURL(join(root, "mcp", file)).href;
	return Promise.all([import(staged("tool-handlers.mjs")), import(staged("live-hub.mjs"))]);
}

/** Start the optional registry/live dependencies without making signed-out
 * startup depend on an MCP dependency install. Failures remain visible on use. */
function liveToolsRuntime(mcpRuntime) {
	return liveToolsModules(mcpRuntime).then(async ([registry, { startLiveHub }]) => {
		const owner = liveHubOwner();
		const token = randomBytes(32).toString("hex");
		const livePort = liveHubPort();
		const liveHub = await startLiveHub(livePort, { token, owner });
		// EADDRINUSE comes back as null: another CozyClay (or its dev server) owns
		// the port, and the Studio page is built to connect to that port, so the
		// pane would answer every turn with a misleading capability error.
		if (!liveHub) console.error(`cozyclay: live hub port ${livePort} is already in use (another CozyClay or its dev server?); the Agent pane cannot drive this Studio until that port is free.`);
		registry.setLiveHub(liveHub);
		const handlers = registry.createToolHandlers().map((tool) => ({
			...tool,
			handler: async (args, { workspaceHandle } = {}) => {
				const parsed = Object.fromEntries(Object.entries(tool.inputSchema).map(([key, schema]) => [key, schema.parse(args[key])]));
				const run = (handle) => registry.liveWorkspace.run(handle, () => tool.handler(parsed));
				return liveHub?.connected ? liveHub.runExclusive(tool.name, workspaceHandle, run) : run(workspaceHandle);
			},
		}));
		if (liveHub) {
			// A controller runs the same per-workspace wrapper the panel's own tools
			// run, so registry state stays serialized across both surfaces.
			liveHub.serveTool = (name, args, workspaceHandle) => {
				const tool = handlers.find((entry) => entry.name === name);
				if (!tool) throw Object.assign(new Error(`Unknown live tool "${name}".`), { code: "UNKNOWN_TOOL" });
				return tool.handler(args ?? {}, { workspaceHandle });
			};
			publishLiveEndpoint({ port: liveHub.port, token, owner });
			liveHub.server?.once("close", () => removeLiveEndpoint(liveHub.port));
		}
		return { liveHub, handlers, hubPortBusy: !liveHub ? livePort : null };
	}).catch((error) => {
		// The pane answers CAPABILITY_MISSING on use; the reason belongs on the
		// launcher's terminal rather than nowhere.
		console.error(`cozyclay: Studio live tools unavailable: ${error?.message ?? error}`);
		for (const line of error?.lines ?? []) console.error(`cozyclay: ${line}`);
		return { error };
	});
}

// `supervisor` (#728) defaults off only under an injected scripted provider:
// a test's script is an exact queue of replies, and a review would take one
// meant for a later turn. The real sidecar never injects one.
export function createAgentHandler({ auth = defaultAuth, codex, models, codexBaseUrl, cliproxyBaseUrl, env, fauxProvider, handlers, liveHub, mcpRuntime, port, studioRuntime, clock = Date.now, setIntervalImpl = setInterval, clearIntervalImpl = clearInterval, sessionStore: injectedSessionStore, supervisor = !fauxProvider, studioTasks = () => process.env.COZYCLAY_STUDIO_TASKS === "on", taskLimits } = {}) {
	const requestContext = new AsyncLocalStorage();
	codex ||= defaultClient(auth, requestContext);
	const runtime = handlers !== undefined || liveHub !== undefined ? Promise.resolve({ handlers: handlers ?? [], liveHub }) : liveToolsRuntime(mcpRuntime);
	const renderGuidance = async (environment) => {
		try {
			const { handlers: tools, liveHub: hub } = await runtime;
			const tool = tools.find((entry) => entry.name === "render_prompt");
			if (!tool || !hub?.connected) return "";
			const workspaceHandle = pickWorkspace(hub);
			const result = await tool.handler({ mode: "image", environment }, { workspaceHandle });
			if (result?.isError) return "";
			const text = typeof result === "string" ? result : (result?.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n");
			return text ? `\n${text}` : "";
		} catch { return ""; }
	};
	const sessions = new Map();
	const workflowRunners = new Map();
	const studioRunners = new Map();
	let workflowModels = models;
	let workflowModelsPromise = models ? Promise.resolve(models) : null;
	const ensureWorkflowModels = async () => {
		const pending = workflowModelsPromise ??= import("./providers.mjs").then(({ createModels }) => createModels({ auth, codexBaseUrl, cliproxyBaseUrl, env }));
		try { return await pending; }
		catch (error) {
			// A retired build must not clear a newer identity's initialization.
			if (workflowModelsPromise === pending) workflowModelsPromise = null;
			throw error;
		}
	};
	const hasAnyCredential = async () => {
		try { if (await auth.getAccessToken()) return true; } catch { /* an unavailable ChatGPT token is not a credential */ }
		const registry = await ensureWorkflowModels();
		if (typeof registry?.getAuth !== "function") return false;
		// the curated providers and any other one a pi login stored a credential for (#pi-login)
		const [{ PROVIDERS }, { readCredentials }] = await Promise.all([import("./providers.mjs"), import("./provider-keys.mjs")]);
		for (const id of new Set([...PROVIDERS.map((provider) => provider.id), ...Object.keys(readCredentials())])) {
			try { if (await registry.getAuth(id)) return true; } catch { /* one broken provider does not break the gate */ }
		}
		return false;
	};
	// Tests hand in a store of their own; only the real sidecar writes the
	// author's config dir (#375).
	const sessionStore = injectedSessionStore ?? createSessionStore();
	const studioSessions = new Map();
	const studioEvents = new Map();
	const studioOwnerTokens = new Map();
	const parseCookies = req => Object.fromEntries(String(req.headers.cookie || "").split(";").map(part => part.trim().split("=")).filter(([key, value]) => key && value).map(([key, value]) => [key, decodeURIComponent(value)]));
	const pruneStudioSessions = () => {
		const now = clock(), idle = session => !(session.activeTurnId && session.controller && !session.controller.signal.aborted); // a running turn keeps its session
		for (const [id, session] of studioSessions) if (idle(session) && now - session.updatedAt > 600_000) { studioSessions.delete(id); studioOwnerTokens.delete(id); for (const turn of session.turns.keys()) studioEvents.delete(turn); }
		const retired = [...studioSessions.entries()].filter(([, session]) => idle(session)).sort((a, b) => a[1].updatedAt - b[1].updatedAt);
		while (studioSessions.size > 256 && retired.length) { const [id, session] = retired.shift(); studioSessions.delete(id); studioOwnerTokens.delete(id); for (const turn of session.turns.keys()) studioEvents.delete(turn); }
	};
	const studioOwner = (req, sessionId, create = false) => {
		pruneStudioSessions();
		const cookies = parseCookies(req), supplied = cookies.studio_owner;
		let owner = studioOwnerTokens.get(sessionId);
		// one owner per browser: a new session adopts the token the browser holds (its cookie, shared by every tab and Studio on the host)
		if (!owner && create) { owner = /^[0-9a-f]{48}$/.test(supplied ?? "") ? supplied : randomBytes(24).toString("hex"); studioOwnerTokens.set(sessionId, owner); return owner; }
		if (!owner || supplied !== owner) throw Object.assign(new Error("Studio session owner mismatch."), { code: "AUTH_REQUIRED" });
		return owner;
	};
	const emitStudioEvent = (turnId, event) => {
		// The supervisor note lands after the turn ended (#728): it joins the turn's
		// record, terminal or not, but never resurrects one that was retired.
		if (event.type === "supervisor" && !studioEvents.has(turnId)) return;
		const record = studioEvents.get(turnId) || { next: 0, events: [], listeners: new Set(), terminal: false };
		// Execution telemetry is advisory and is validated key-by-key in the
		// browser: it carries no replay cursor, is never retained for a resume,
		// and a reconnect simply misses the frames it was not there for.
		if (["execution_telemetry", "execution_tool_started"].includes(event.type)) {
			studioEvents.set(turnId, record);
			for (const listener of [...record.listeners]) listener(event);
			return;
		}
		const value = { ...event, eventSeq: ++record.next };
		record.next = value.eventSeq;
		const previous = record.events.at(-1);
		if (value.type === "job.progress" && previous?.type === "job.progress" && previous.jobId === value.jobId) record.events[record.events.length - 1] = value;
		// The panel's live frames (turn-frames.mjs, a script's nested calls, a call's sculpt sketch) keep one replay slot per run of them.
		else if (value.type === "thinking.delta" && previous?.type === "thinking.delta") record.events[record.events.length - 1] = { ...value, text: previous.text + value.text };
		else if (["tool.progress", "sculpt.sketch"].includes(value.type) && previous?.type === value.type && previous.callId === value.callId) record.events[record.events.length - 1] = value;
		else record.events.push(value);
		if (record.events.length > 256) record.events.splice(0, record.events.length - 256);
		if (["done", "error", "receipt"].includes(value.type)) record.terminal = true;
		studioEvents.set(turnId, record); for (const listener of [...record.listeners]) listener(value);
	};
	// A sign-out, another account, or a provider key or server address that changed: the registry and every runner on it go.
	const resetRegistry = () => {
		for (const session of sessions.values()) session.controller?.abort();
		for (const session of studioSessions.values()) session.controller?.abort();
		for (const runner of [...workflowRunners.values(), ...studioRunners.values()]) void runner.close?.();
		workflowRunners.clear(); studioRunners.clear();
		workflowModels = models;
		workflowModelsPromise = models ? Promise.resolve(models) : null;
		sessions.clear(); studioSessions.clear(); studioEvents.clear(); studioOwnerTokens.clear();
	};
	const unsubscribe = auth.onAuthChange?.(({ kind }) => { if (kind === "signed_out" || kind === "replaced") resetRegistry(); });
	const providerRoutes = createProviderRoutes({ auth, getModels: ensureWorkflowModels, onChange: resetRegistry, json, readBody });

	const studioIdentity = host => Object.fromEntries(["workspaceId", "documentEpoch", "sceneId", "sceneEpoch"].map(key => [key, host[key]]));
	const writeStudioStream = (res, record, after = 0) => {
		res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" }); res.flushHeaders?.();
		let cursor = after; const send = event => {
			if (res.destroyed || res.writableEnded) return;
			if (event.eventSeq === undefined) { res.write(`data: ${JSON.stringify(event)}\n\n`); return; }
			if (event.eventSeq > cursor) { cursor = event.eventSeq; res.write(`data: ${JSON.stringify(event)}\n\n`); }
		};
		const listener = event => { send(event); if (event.type === "done" && !res.writableEnded) res.end(); }; record.listeners.add(listener); for (const event of record.events) send(event);
		if (record.terminal) { record.listeners.delete(listener); res.end(); return () => {}; }
		const heartbeat = setIntervalImpl(() => { clock(); if (!res.writableEnded && !res.destroyed) res.write(": heartbeat\n\n"); }, 15_000);
		const close = () => { clearIntervalImpl(heartbeat); record.listeners.delete(listener); };
		res.once("close", close); return close;
	};
	const authoritativeStudioContext = async (value, hub) => {
		if (!hub?.workspaceId || !hub?.command) throw Object.assign(new Error("A connected editor is required."), { code: "LIVE_HUB_UNAVAILABLE" });
		let actualHandle;
		try { actualHandle = hub.resolveWorkspace("studio context", value.context.host.workspaceHandle); }
		catch { throw Object.assign(new Error("The submitted Studio handle is stale or unknown."), { code: "LIVE_HUB_UNAVAILABLE" }); }
		if (hub.workspaceId(actualHandle) !== value.context.host.workspaceId) throw Object.assign(new Error("Studio handle belongs to a different workspace."), { code: "STALE_SCENE" });
		const result = await hub.command("read_studio_context", { host: studioIdentity(value.context.host) }, actualHandle);
		return result?.context ?? result;
	};
	const handleStudioTurn = async (req, res, value, path) => {
		const { StudioProtocolError, validateStudioContextFreshness } = await import("../../src/studio-agent-protocol.js");
		const [{ createStudioTools }, { encodeStudioContext }, { createScriptTool }, { runSupervisor, shouldSupervise }, { createPlanTool }, { followUpExchange }] = await Promise.all([
			import("./studio-tools.mjs"), import("../../src/studio-agent-context.js"), import("./script-tool.mjs"), import("./supervisor.mjs"), import("./plan-tool.mjs"), import("./supervisor-followup.mjs"),
		]);
		const hubDeps = await runtime; const hub = hubDeps.liveHub || liveHub;
		if (path === "/agent/stop") {
			const session = studioSessions.get(value.sessionId);
			if (!session || session.owner !== parseCookies(req).studio_owner || !session.turns.has(value.turnId)) throw new StudioProtocolError("AUTH_REQUIRED", "Studio stop is not owned by this session.");
			// Studio turns hold no editor jobs since 3.0 (motion.compile answers
			// synchronously), so a Stop names no job: it aborts the turn and the model lane.
			if (value.jobId) throw new StudioProtocolError("STALE_TARGET", "Stop does not own that motion job.");
			session.controller?.abort();
			await session.modelSession?.abort?.("studio stop");
			json(res, 200, { ok: true, status: "detached" }); return true;
		}
		if (!studioRuntime && !hub && hubDeps.hubPortBusy) throw new StudioProtocolError("CAPABILITY_MISSING", `The Studio live hub could not start: port ${hubDeps.hubPortBusy} is in use by another CozyClay or its dev server. Free that port and relaunch.`);
		if (!studioRuntime && (!hub?.command || !hub?.workspaceId)) throw new StudioProtocolError("CAPABILITY_MISSING", "Studio execution is not installed.");
		if (!value.context.host.workspaceHandle) throw new StudioProtocolError("LIVE_HUB_UNAVAILABLE", "A connected editor handle is required.");
		let session = studioSessions.get(value.sessionId);
		const suppliedOwner = parseCookies(req).studio_owner;
		if (session && suppliedOwner && session.owner !== suppliedOwner) throw new StudioProtocolError("AUTH_REQUIRED", "Studio session owner mismatch.");
		const existing = session?.turns.get(value.turnId);
		if (existing) { session.updatedAt = clock(); writeStudioStream(res, existing, 0); return true; }
		let current;
		try { current = studioRuntime?.readContext ? await studioRuntime.readContext(value.context.host) : await authoritativeStudioContext(value, hub); }
		catch (error) { if (error instanceof StudioProtocolError) throw error; if (error?.code) throw new StudioProtocolError(error.code, error.message); throw new StudioProtocolError("CAPABILITY_MISSING", "The connected editor does not expose authoritative Studio context."); }
		// Task mode: other tasks edit the scene all the time, so a main turn or a task's run is admitted on the host alone (a
		// sibling task's edit between the read and here is expected); the bus's scope admission guards every write.
		const tasked = Boolean(value.main || value.task);
		validateStudioContextFreshness(tasked ? { ...value.context, entities: current.entities, entityPage: current.entityPage, entityIndex: current.entityIndex, revision: current.revision } : value.context, current);
		// The session, and the owner token only this turn's response can hand
		// the browser, exist only once the turn is admitted. Minting them before
		// a refusal (the editor still reconnecting after a restart) left a
		// session whose owner the browser never received: its cookie from the
		// previous server then failed every retry with "owner mismatch".
		if (!session) {
			studioOwner(req, value.sessionId, true);
			let persisted = null;
			try { persisted = sessionStore.read(value.sessionId); } catch { /* an unreadable history starts the session fresh */ }
			session = { owner: studioOwnerTokens.get(value.sessionId), history: persisted?.history ?? [], persistedItems: persisted?.history?.length ?? 0, meta: persisted?.meta ?? null, turns: new Map(), controller: null, host: null, updatedAt: clock() };
			studioSessions.set(value.sessionId, session);
		}
		session.updatedAt = clock();
		if (studioRuntime?.handleTurn) { await studioRuntime.handleTurn(value, req, res); return true; }
		const record = { next: 0, events: [], listeners: new Set(), terminal: false }; studioEvents.set(value.turnId, record); session.turns.set(value.turnId, record); session.host = studioIdentity(value.context.host);
		res.setHeader("set-cookie", `studio_owner=${encodeURIComponent(session.owner)}; Path=/agent; HttpOnly; SameSite=Strict`);
		const close = writeStudioStream(res, record, 0);
		// What the supervisor reviews once the turn is over: every frame but text
		// and telemetry, and the last stretch of text the model wrote.
		const turnFrames = [];
		let replySegment = "", lastReply = "";
		const send = event => {
			if (event.type === "text.delta") { replySegment += event.text ?? ""; lastReply = replySegment; }
			else if (!["execution_telemetry", "execution_tool_started", "thinking.delta", "tool.compose", "tool.progress", "sculpt.sketch", "studio.waiting"].includes(event.type)) {
				if (event.type === "tool.start") replySegment = "";
				turnFrames.push(event);
			}
			emitStudioEvent(value.turnId, event); value.observe?.(event);
		};
		// The Studio turn is measured exactly like the Workflow turn, correlated by
		// the turn id the host already owns (the frozen envelope carries no room
		// for a second one).
		const telemetry = createTurnTelemetry(send, value.turnId);
		let turnOutcome = "succeeded", turnFailureCode = null, toolFailed = false;
		const controller = new AbortController(); session.controller = controller; session.activeTurnId = value.turnId;
		// Admission is the document identity plus the exact scene revision each
		// command expects. Per-entity tokens are deliberately absent: the revision
		// already moves whenever any authored content changes, and a turn's second
		// edit to the same entity would otherwise carry a token the first edit retired.
		const admission = {
			commandId: () => randomUUID(), host: studioIdentity(value.context.host), revision: value.context.revision.scene,
			// Read at the admitted host: a scene action may have opened another
			// scene of this workspace during the turn (studio-tools adopts it).
			snapshot: async () => {
				const host = { ...value.context.host, ...admission.host };
				return studioRuntime?.readContext ? await studioRuntime.readContext(host) : await authoritativeStudioContext({ ...value, context: { ...value.context, host } }, hub);
			},
			// Re-admits at the live revision and hands back the context it read, which
			// the tools compare against what the agent last saw (studio-rebase.mjs).
			refresh: async () => {
				const refreshed = await admission.snapshot();
				admission.revision = refreshed.revision.scene;
				return refreshed;
			},
		};
		const tools = createStudioTools({ liveHub: hub, workspaceHandle: value.context.host.workspaceHandle, previsMode: value.context.scene?.previsMode, session: { signal: controller.signal, admission, actionIndex: current?.actionIndex ?? [], baseline: value.context, onGestureWait: waiting => send({ type: "studio.waiting", reason: "gesture", waiting }) }, resolveImage: async (id, correlation) => hub.command("resolve_studio_image", { imageId: id, ...correlation }, value.context.host.workspaceHandle) });
		const modelTools = tools.map(tool => ({
			...tool,
			handler: async (args, call) => {
				const result = await tool.handler(args, call);
				if (!result || !Array.isArray(result.visualRefs) || !result.visualRefs.length) return result;
					const ref = result.visualRefs.find(item => item?.imageId || item?.id);
				if (!ref) return result;
				const visual = await tools.resolveImage(ref.imageId || ref.id, { receiptId: result.receiptId, revision: result.revision });
				return { ...result, visualStatus: visual.visualStatus, imageId: visual.imageId, revision: visual.revision, receiptId: visual.receiptId, ...(visual.dataUrl ? { dataUrl: visual.dataUrl } : {}) };
			},
		}));
		const turnTransaction = studioTransaction({ hub, context: current, turnId: value.turnId, admission, task: value.task, signal: controller.signal, plain: Boolean(value.main), onWait: waiting => send({ type: "studio.waiting", reason: "gesture", waiting }) }); // the user mid-drag (studio-busy-wait.mjs)
		// The turn's step checklist (plan-tool.mjs): the model calls it directly or inside a script, and the panel shows it.
		const plan = createPlanTool({ emit: send }), script = createScriptTool({ tools: [...modelTools, plan.nested], signal: controller.signal, emit: send });
		const scriptTool = {
			...script,
			// A script that fails after it edited the scene rolls back its own edits, so
			// the model retries from the document the script started from, never from
			// half a script; what the turn did before the script stays.
			handler: async (args, options) => {
				await turnTransaction.mark();
				const result = await script.handler(args, options);
				if (result.ok || !result.calls.some(call => call.ok && Number.isSafeInteger(call.revision?.after) && call.revision.after !== call.revision.before)) return result;
				const rollback = await turnTransaction.rollback();
				return rollback ? { ...result, rollback: { status: "rolled_back", receiptId: rollback.receiptId, revision: rollback.revision, affectedIds: rollback.affectedIds.slice(0, 8) } } : result;
			},
		};
		let frameObservation;
		if (value.attachFrame) {
			const captured = await hub.command("capture_framing_png", {}, value.context.host.workspaceHandle);
			if (!captured?.dataUrl?.startsWith("data:image/")) throw new StudioProtocolError("TARGET_NOT_READY", "The current frame has no image bytes.");
			const match = /^data:([^;]+);base64,(.*)$/.exec(captured.dataUrl);
			frameObservation = { data: match[2], mimeType: match[1], revision: captured.revision, receiptId: captured.receiptId };
		} else if (!value.main && (await import("./studio-context-budget.mjs")).wantsPlan({ text: value.text, characterCount: value.context.scene?.characterCount ?? 0, shots: value.context.shots?.length ?? 0, planSeen: session.planSceneId === value.context.host.sceneId })) {
			// A staging or coverage request sees the top-view plan, and so does a staged scene's first turn here (once per scene).
			try {
				const captured = await hub.command("capture_plan_png", {}, value.context.host.workspaceHandle);
				const match = /^data:([^;]+);base64,(.*)$/.exec(captured?.dataUrl ?? "");
				if (!match) throw new Error("The plan capture has no image bytes.");
				frameObservation = { kind: "plan", data: match[2], mimeType: match[1], revision: captured.revision ?? value.context.revision?.scene ?? null, receiptId: captured.receiptId }; session.planSceneId = value.context.host.sceneId;
			} catch (error) {
				console.warn(`[agent] plan observation skipped: ${error.message}`);
			}
		}
		const telemetryTools = new Map();
		const emitFrame = frame => {
			if (frame.type === "tool.start") {
			telemetryTools.set(frame.callId, { execution: telemetry.toolStarted(agentToolCategory(frame.name)), name: frame.name });
			return send(frame);
			}
			if (frame.type === "tool.done") {
			const record = telemetryTools.get(frame.callId);
			if (record && frame.ok && frame.result?.ok && frame.result?.authored) telemetry.applied();
			if (!frame.ok) {
				toolFailed = true;
				if (typeof frame.error === "string" && frame.error.startsWith("Validation failed for tool ")) frame.error = "INVALID_ARGUMENT: Unexpected field.";
			}
			// A command the sidecar re-sent once (stale revision, busy gesture) is
			// marked on the frame itself; the receipt carries autoRebased and a warning.
			if (frame.ok && frame.result?.autoRebased === true) frame.autoRebased = true;
			send(frame);
			if (record) {
				record.execution.executed(frame.ok ? "succeeded" : (controller.signal.aborted ? "cancelled" : "failed"));
				record.finished = true;
			}
			return;
			}
			if (frame.type === "error") {
			turnOutcome = controller.signal.aborted || frame.code === "aborted" ? "cancelled" : "failed";
			turnFailureCode = controller.signal.aborted || frame.code === "aborted" ? "aborted" : failureCodeOf(frame);
			return send(frame);
			}
			if (frame.type === "done") {
			const correction = value.main?.check(lastReply); if (correction) send({ type: "text.delta", text: correction });
			if (turnOutcome === "succeeded" && !toolFailed) telemetry.finished("succeeded", null);
			else telemetry.finished(turnOutcome, turnFailureCode || "tool_failed");
			// Marked before the done frame leaves, so a client that asks for the
			// review the moment its stream ends finds it pending, not absent.
			// Off by default: only a turn sent with value.supervisor === true is reviewed.
			if (supervisor && process.env.COZYCLAY_SUPERVISOR !== "off" && value.supervisor === true && !controller.signal.aborted && shouldSupervise(turnFrames)) record.supervisor = "pending";
			}
			send(frame);
		};
		const persistenceMeta = { sceneName: value.context?.scene?.name ?? value.context?.sceneName ?? null, firstText: value.text, ...(value.task ? { parentId: value.task.parentId, taskId: value.task.taskId } : {}) };
		const modelKey = value.model || (fauxProvider ? `${fauxProvider.provider?.id || fauxProvider.provider || "faux"}/scripted` : "gpt-6-astra");
		let runner = studioRunners.get(value.sessionId);
		if (!runner) {
			runner = createAgentRunner({ models: await ensureWorkflowModels(), fauxProvider, sessionStore, clock, codexBaseUrl, cliproxyBaseUrl, auth, env });
			studioRunners.set(value.sessionId, runner);
		}
		try {
			if (!session.modelSession) session.modelSession = await runner.openSession(value.sessionId, { surface: "studio" });
			for await (const frame of turnTransaction.run(input => session.modelSession.start(input))({
				surface: "studio", sessionId: value.sessionId, model: modelKey, effort: value.effort,
				text: value.text, attachments: value.attachments, contextText: encodeStudioContext(value.context) + (value.main?.contextText() ?? ""), frameObservation,
				reportCost: Boolean(value.task || value.main), context: value.context, tools: value.main ? value.main.tools({ studio: modelTools, hub, admission }) : [...modelTools, plan.track(scriptTool), plan], systemPrompt: value.main?.systemPrompt ?? (value.context.scene?.previsMode === "storyboard" ? STUDIO_SYSTEM_PROMPT_STORYBOARD : undefined), signal: controller.signal, emit: send,
				meta: persistenceMeta,
				quotaEvent: headers => codex?.parseQuotaHeaders ? quotaEvent(codex, headers) : { type: "quota", plan: null, primary: { usedPercent: null, windowMinutes: null, resetAt: null }, credits: { has: null } },
			})) emitFrame(frame);
		} catch (error) {
			const info = errorInfo(error);
			turnOutcome = controller.signal.aborted ? "cancelled" : "failed";
			turnFailureCode = controller.signal.aborted ? "aborted" : agentFailureCode(error, controller.signal, toolFailed);
			send({ type: "error", code: controller.signal.aborted ? "aborted" : frameCodeOf(error), message: info.status === undefined ? error.message : info.message, ...(info.status === undefined ? {} : { status: info.status }) });
			emitFrame({ type: "done" });
		}
		if (controller.signal.aborted) { turnOutcome = "cancelled"; turnFailureCode = "aborted"; }
		if (!record.terminal) emitFrame({ type: "done" });
		// session.host: a scene this turn opened, which a task's coordinator reads next (studio-task-routes.mjs)
		close(); if (!res.writableEnded) res.end(); session.controller = null; session.activeTurnId = null; if (admission.host?.workspaceId === value.context.host.workspaceId) session.host = studioIdentity({ ...value.context.host, ...admission.host });
		// The review starts only now, after the stream has ended, and only ever
		// appends one note to the record: it neither delays nor steers the turn.
		if (record.supervisor === "pending") void (async () => {
			const startedAt = Date.now();
			let frame;
			try {
				frame = await runSupervisor({ registry: await ensureWorkflowModels(), modelKey, effort: process.env.COZYCLAY_SUPERVISOR_EFFORT || "high", turnId: value.turnId, request: value.text, frames: turnFrames, reply: lastReply,
					hub, workspaceHandle: value.context.host.workspaceHandle, admission, baseline: value.context, actions: current?.actionIndex ?? [], previousExchange: followUpExchange(value.text, () => sessionStore.read(value.sessionId)?.history) });
			} catch (error) {
				frame = { type: "supervisor", turnId: value.turnId, verdict: "unavailable", model: modelKey, effort: null, elapsedMs: Date.now() - startedAt, summary: "", items: [], issues: [], fixes: [], droppedFixes: [], counts: { blocker: 0, concern: 0, note: 0, fixes: 0 }, reason: "The supervisor could not start." };
			}
			// COZYCLAY_SUPERVISOR_AUTOFIX=blocker (#743) only marks a note whose
			// blockers carry fixes; turns stay the panel's to start, never the sidecar's.
			if (process.env.COZYCLAY_SUPERVISOR_AUTOFIX === "blocker" && frame.fixes?.some(fix => fix.severity === "blocker")) frame = { ...frame, autofix: { eligible: true, severity: "blocker" } };
			record.supervisor = "done";
			emitStudioEvent(value.turnId, frame);
		})();
		return true;
	};
	// Lazy, like every src/ import here: the minimal legacy-sidecar package omits src/.
	let taskRoutesReady;
	const taskRoutes = async (...args) => (await (taskRoutesReady ??= import("./studio-task-routes.mjs").then(({ createStudioTaskRoutes }) => createStudioTaskRoutes({ enabled: studioTasks, handleStudioTurn, studioSessions, studioOwnerTokens, studioEvents, emitStudioEvent, writeStudioStream, parseCookies, json, readBody: req => readBody(req, TURN_BODY_LIMIT), limits: taskLimits,
		newRecord: () => ({ next: 0, events: [], listeners: new Set(), terminal: false }),
		validateEnvelope: async value => (await import("../../src/studio-agent-protocol.js")).validateStudioTurnEnvelope(value),
		inspect: async (host, args) => ((await runtime).liveHub || liveHub).command("inspect_studio", args, host.workspaceHandle),
		readContext: async host => studioRuntime?.readContext ? studioRuntime.readContext(host) : authoritativeStudioContext({ context: { host } }, (await runtime).liveHub || liveHub) }))))(...args);
	const handle = async (req, res, path = new URL(req.url, "http://127.0.0.1").pathname) => {
		if (!path.startsWith("/agent/")) return false;
		if (port !== undefined && !allowAgentOrigin(req, typeof port === "function" ? port() : port)) {
			json(res, 403, { error: "forbidden origin" }); return true;
		}
		if (path.startsWith("/agent/turn/") && path.endsWith("/events") && req.method === "GET") {
			if (!await hasAnyCredential()) { json(res, 401, { error: { code: "AUTH_REQUIRED", message: "Sign in or configure a provider key." } }); return true; }
			const turnId = decodeURIComponent(path.slice("/agent/turn/".length, -"/events".length));
			const session = [...studioSessions.values()].find(candidate => candidate.turns.has(turnId)); const record = studioEvents.get(turnId);
			if (!record || !session || parseCookies(req).studio_owner !== session.owner) { json(res, 403, { error: { code: "AUTH_REQUIRED", message: "Studio event stream is not owned by this session." } }); return true; }
			const after = Number(new URL(req.url, "http://127.0.0.1").searchParams.get("after") || 0);
			if (!Number.isSafeInteger(after) || after < 0) { json(res, 400, { error: "invalid cursor" }); return true; }
			writeStudioStream(res, record, after); return true;
		}
		// The supervisor note for one Studio turn (#728): 200 with the note once it
		// exists, held up to SUPERVISOR_WAIT_MS while it is pending, 204 when the
		// turn was never reviewed or the wait ran out.
		if (path.startsWith("/agent/turn/") && path.endsWith("/supervisor") && req.method === "GET") {
			if (!await hasAnyCredential()) { json(res, 401, { error: { code: "AUTH_REQUIRED", message: "Sign in or configure a provider key." } }); return true; }
			const turnId = decodeURIComponent(path.slice("/agent/turn/".length, -"/supervisor".length));
			const session = [...studioSessions.values()].find(candidate => candidate.turns.has(turnId)); const record = studioEvents.get(turnId);
			if (!record || !session) { json(res, 404, { error: "turn not found" }); return true; }
			if (parseCookies(req).studio_owner !== session.owner) { json(res, 403, { error: { code: "AUTH_REQUIRED", message: "Studio supervisor note is not owned by this session." } }); return true; }
			const noContent = () => { res.writeHead(204, { "cache-control": "no-store" }); res.end(); };
			const existing = record.events.findLast(event => event.type === "supervisor");
			if (existing) { json(res, 200, existing); return true; }
			if (record.supervisor !== "pending") { noContent(); return true; }
			await new Promise(resolve => {
				let timer;
				const settle = note => {
					clearTimeout(timer); record.listeners.delete(listener); res.off("close", onClose);
					if (note !== undefined && !res.writableEnded && !res.destroyed) { if (note) json(res, 200, note); else noContent(); }
					resolve();
				};
				const listener = event => { if (event.type === "supervisor") settle(event); };
				const onClose = () => settle(undefined);
				record.listeners.add(listener); res.once("close", onClose);
				timer = setTimeout(() => settle(null), SUPERVISOR_WAIT_MS);
			});
			return true;
		}
		if (path.startsWith("/agent/turn/") && path.endsWith("/steer") && req.method === "POST") {
			const turnId = decodeURIComponent(path.slice("/agent/turn/".length, -"/steer".length));
			let value;
			try {
				value = await readBody(req, TURN_BODY_LIMIT);
				if (!value || typeof value.text !== "string" || !value.text.trim() || !validAttachments(value.attachments)) throw new Error("Invalid request.");
			} catch { json(res, 400, { error: "invalid request" }); return true; }
			// Studio turns are keyed in studioSessions, never in the Workflow
			// `sessions` map, so that lookup alone tells them apart. Only the cookie
			// owner of the Studio session may steer its running turn.
			const studio = [...studioSessions.values()].find(candidate => candidate.turns.has(turnId));
			if (studio && parseCookies(req).studio_owner !== studio.owner) { json(res, 403, { error: { code: "AUTH_REQUIRED", message: "Studio turn is not owned by this session." } }); return true; }
			const session = studio ?? [...sessions.values()].find(candidate => candidate.turnId === turnId);
			if (!session) { json(res, 404, { error: "turn not found" }); return true; }
			const active = studio ? studio.activeTurnId === turnId && studio.controller && !studio.controller.signal.aborted : session.running;
			if (!active || !session.modelSession) { json(res, 409, { error: { code: "NO_ACTIVE_TURN", message: "This turn already ended." } }); return true; }
			const images = (Array.isArray(value.attachments) ? value.attachments : []).map(attachment => {
				const match = /^data:([^;]+);base64,(.*)$/.exec(attachment?.dataUrl || "");
				return match ? { type: "image", data: match[2], mimeType: match[1] } : null;
			}).filter(Boolean);
			await session.modelSession.steer(value.text, images);
			json(res, 200, { ok: true, queued: true }); return true;
		}
		if (await providerRoutes(req, res, path)) return true;
		if (path === "/agent/sessions" && req.method === "GET") {
			const surface = new URL(req.url, "http://127.0.0.1").searchParams.get("surface") || undefined;
			try { json(res, 200, { sessions: sessionStore.list({ surface }) }); }
			catch { json(res, 500, { error: "session history unavailable" }); }
			return true;
		}
		if (path.startsWith("/agent/sessions/") && req.method === "GET") {
			const sessionId = decodeURIComponent(path.slice("/agent/sessions/".length));
			try {
				const persisted = sessionStore.read(sessionId);
				if (!persisted) { json(res, 404, { error: "session not found" }); return true; }
				json(res, 200, { sessionId, transcript: transcriptFromHistory(persisted.history), meta: persisted.meta });
			} catch { json(res, 404, { error: "session not found" }); }
			return true;
		}
		if (path === "/agent/models" && req.method === "GET") {
			try {
				const { listAgentModels } = await import("./providers.mjs");
				json(res, 200, await listAgentModels({ auth, codex, models: await ensureWorkflowModels(), env }));
			} catch (error) { json(res, error.status === 401 ? 401 : 502, { error: errorInfo(error) }); }
			return true;
		}
		if (path === "/agent/image" && req.method === "POST") {
			let value;
			try {
				value = await readBody(req, IMAGE_BODY_LIMIT);
				if (typeof value.prompt !== "string" || !value.prompt.trim() || typeof value.imageDataUrl !== "string" || !value.imageDataUrl.startsWith("data:image/") || (value.referenceDataUrl !== undefined && (typeof value.referenceDataUrl !== "string" || !value.referenceDataUrl.startsWith("data:image/"))) || !validReferences(value.references) || (value.composition !== undefined && !["frame", "sheet"].includes(value.composition)) || (value.quality !== undefined && !["auto", "low", "medium", "high"].includes(value.quality)) || (value.size !== undefined && !IMAGE_SIZES.includes(value.size))) throw new Error("Invalid request.");
			} catch { json(res, 400, { error: "invalid request" }); return true; }
			if (!await auth.getAccessToken()) { json(res, 401, { error: { code: "auth", message: "Sign in with ChatGPT in the Agent panel." } }); return true; }
			try {
				// Same composition guidance the agent's render_from_frame appends: the
				// node's prompt is intent only; camera, cast and set come from the scene.
				// Scene references (#167) are appended after the frame/reference pair,
				// and the prompt says what each attachment is for.
				const references = Array.isArray(value.references) ? value.references : [];
				// composition "frame": the attached frame was framed by hand (Pose mode), so the shot
				// camera's description would contradict it; the frame alone owns camera and pose.
				// composition "sheet" (Sculpt blueprint): a model sheet, not a shot, so no scene or
				// camera guidance is added; the prompt is sent as written.
				const prompt = value.composition === "sheet"
					? value.prompt
					: value.composition === "frame"
						? `${FRAME_COMPOSITION_GUIDANCE}\n${value.prompt}${referenceGuidance(references)}`
						: `${value.prompt}${await renderGuidance(value.prompt)}${referenceGuidance(references)}`;
				const { composition: _composition, ...request } = value;
				const result = await codex.editImage({ ...request, prompt, extraImages: references.map((entry) => entry.dataUrl) });
				json(res, 200, { dataUrl: `data:image/png;base64,${result.pngBase64}`, width: result.width, height: result.height });
			} catch (error) { json(res, error.status === 401 ? 401 : 502, { error: errorInfo(error) }); }
			return true;
		}
		if (path === "/agent/video/providers" && req.method === "GET") {
			json(res, 200, { providers: createVideoAdapters().map((adapter) => ({ id: adapter.id, name: adapter.name, configured: adapter.configured(), ...(adapter.model ? { model: adapter.model, resolution: adapter.resolution } : {}) })) });
			return true;
		}
		if (path === "/agent/video" && req.method === "POST") {
			let value;
			try {
				value = await readBody(req, IMAGE_BODY_LIMIT);
				if (!value || typeof value.provider !== "string" || typeof value.prompt !== "string" || !value.prompt.trim() || typeof value.imageDataUrl !== "string" || !value.imageDataUrl.startsWith("data:image/") || (value.lastFrameDataUrl !== undefined && (typeof value.lastFrameDataUrl !== "string" || !value.lastFrameDataUrl.startsWith("data:image/"))) || !Number.isFinite(Number(value.durationSeconds)) || Number(value.durationSeconds) < 1 || Number(value.durationSeconds) > 15 || typeof value.aspect !== "string" || (value.model !== undefined && typeof value.model !== "string")) throw new Error("Invalid request.");
				if (value.provider === "fal") validateFalVideoRequest({ model: process.env.FAL_MODEL || undefined, durationSeconds: Number(value.durationSeconds), aspect: value.aspect });
			} catch (error) { json(res, error?.code === "fal-invalid-request" ? 422 : 400, { error: error?.message || "invalid request" }); return true; }
			const adapter = createVideoAdapters().find((entry) => entry.id === value.provider);
			if (!adapter || !adapter.configured()) { json(res, 409, { error: "video provider is not configured" }); return true; }
			try {
				const result = await adapter.generate({ ...value, durationSeconds: Number(value.durationSeconds) });
				json(res, 200, { ...(result.mp4Base64 ? { dataUrl: `data:video/mp4;base64,${result.mp4Base64}` } : { url: result.url }), width: result.width, height: result.height, fps: result.fps, seconds: result.seconds, ...(result.metadataMeasured !== undefined ? { metadataMeasured: result.metadataMeasured } : {}), ...(result.preservation ? { preservation: result.preservation } : {}) });
			} catch (error) {
				// A generated H3 take that fails the plate check is unsafe to show as
				// a locked shot. Keep the distinction visible to the client so it can
				// ask for a retry instead of silently accepting a drifting set.
				const status = ["h3-preservation-failed", "fal-invalid-request"].includes(error?.code) ? 422 : 502;
				json(res, status, { error: error?.message || "video provider failed", ...(error?.preservation ? { preservation: error.preservation } : {}) });
			}
			return true;
		}
		// Task mode: the COZYCLAY_STUDIO_TASKS flag, or one Studio session that opted in (the panel's Tasks switch, studio-task-routes.mjs).
		if (path === "/agent/main" || path.startsWith("/agent/main/") || path.startsWith("/agent/task/")) return taskRoutes(req, res, path);
		if (req.method !== "POST" || !["/agent/turn", "/agent/stop"].includes(path)) {
			json(res, 404, { error: "not found" }); return true;
		}
		let value;
		try {
			value = await readBody(req, TURN_BODY_LIMIT);
			if (value?.surface === "studio") {
				// Lazy only for the minimal legacy-sidecar fixture, which omits src/.
				// Actual npm packages include src; there is exactly one validator.
				const protocol = await import("../../src/studio-agent-protocol.js");
				value = path === "/agent/stop" ? protocol.validateStudioStopEnvelope(value) : protocol.validateStudioTurnEnvelope(value);
			} else if (!value || (value.surface !== undefined && value.surface !== "workflow")
				|| value.context !== undefined || value.turnId !== undefined || typeof value.sessionId !== "string" || !value.sessionId
				|| (path === "/agent/turn" && (typeof value.text !== "string"
					|| (value.attachFrame !== undefined && typeof value.attachFrame !== "boolean")
					|| !validAttachments(value.attachments)
					|| (value.model !== undefined && typeof value.model !== "string")
					|| (value.effort !== undefined && !REASONING_EFFORTS.includes(value.effort))))) throw new Error("Invalid request.");
		} catch (error) {
			json(res, 400, { error: error?.name === "StudioProtocolError" ? error.toJSON() : "invalid request" }); return true;
		}
		if (value.surface === "studio") {
			try { return await handleStudioTurn(req, res, value, path); }
			catch (error) { if (error instanceof (await import("../../src/studio-agent-protocol.js")).StudioProtocolError) json(res, 409, { error: error.toJSON() }); else throw error; return true; }
		}
		if (path === "/agent/stop") {
			sessions.get(value.sessionId)?.controller?.abort();
			json(res, 200, { ok: true }); return true;
		}

		res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "keep-alive" });
		res.flushHeaders();
		const send = (event) => { if (!res.writableEnded && !res.destroyed) res.write(`data: ${JSON.stringify(event)}\n\n`); };
		let session = sessions.get(value.sessionId);
		if (session?.running) {
			send({ type: "error", code: "busy", message: "busy" }); send({ type: "done" }); res.end(); return true;
		}
		session ||= { images: new Map(), history: [] };
		sessions.set(value.sessionId, session);
		const controller = new AbortController();
		const { signal } = controller;
		Object.assign(session, { running: true, controller, signal, emit: send });
		const disconnect = () => controller.abort();
		res.once("close", disconnect);
		const turnId = typeof value.turn_id === "string" && /^[a-f0-9]{32}$/.test(value.turn_id) ? value.turn_id : null;
		session.turnId = turnId;
		const telemetry = createTurnTelemetry(send, turnId);
		const telemetryTools = new Map();
		let turnOutcome = "succeeded";
		let turnFailureCode = null;
		let toolFailed = false;
		let quota;
		const quotaForResponse = (headers, model) => {
			if (quota) return quota;
			quota = model?.provider === "openai-codex" ? quotaEvent(codex, headers) : {
				type: "quota", plan: null,
				primary: { usedPercent: null, windowMinutes: null, resetAt: null },
				credits: { has: null },
			};
			return quota;
		};
		const emitFrame = (frame) => {
			if (frame.type === "tool.start") {
				telemetryTools.set(frame.callId, { execution: telemetry.toolStarted(agentToolCategory(frame.name)), name: frame.name });
				return send(frame);
			}
			if (frame.type === "tool.done") {
				send(frame);
				const record = telemetryTools.get(frame.callId);
				if (record) {
					if (frame.ok && appliedCanvasResult(record.name, frame.result)) telemetry.applied();
					record.execution.executed(frame.ok ? "succeeded" : (signal.aborted ? "cancelled" : "failed"));
					record.finished = true;
				}
				if (!frame.ok) toolFailed = true;
				return;
			}
			if (frame.type === "error") {
				if (frame.code === "truncated") {
					turnOutcome = "unresolved";
					return;
				}
				turnOutcome = signal.aborted || frame.code === "aborted" ? "cancelled" : "failed";
				turnFailureCode = signal.aborted || frame.code === "aborted" ? "aborted" : failureCodeOf(frame);
				return send(frame);
			}
			if (frame.type === "done") {
				for (const record of telemetryTools.values()) if (!record.finished) {
					record.execution.executed(signal.aborted ? "cancelled" : "failed");
					record.finished = true;
				}
				if (turnOutcome === "unresolved") return send(frame);
				if (turnOutcome === "succeeded" && !toolFailed) telemetry.finished("succeeded", null);
				else telemetry.finished(toolFailed ? "failed" : turnOutcome, toolFailed ? "tool_failed" : turnFailureCode);
			}
			send(frame);
		};
		const turn = async () => {
			if (!await hasAnyCredential()) throw Object.assign(new Error("Authentication required."), { status: 401 });
			workflowModels = await ensureWorkflowModels();
			const dependencies = await runtime;
			session.codex = { editImage: (args) => codex.editImage(args) };
			const workflowTools = createAgentTools({ ...dependencies, session, emit: send });
			let workflowRunner = workflowRunners.get(value.sessionId);
			if (!workflowRunner) {
				workflowRunner = createAgentRunner({ models: workflowModels, tools: workflowTools, systemPrompt: SYSTEM_PROMPT, clock, fauxProvider, sessionStore, codexBaseUrl, cliproxyBaseUrl, auth, env, onQuota: quotaForResponse });
				workflowRunners.set(value.sessionId, workflowRunner);
			}
			if (!session.modelSession) session.modelSession = await workflowRunner.openSession(value.sessionId, { surface: "workflow" });
			const turnInput = { surface: "workflow", sessionId: value.sessionId, text: value.text, model: value.model || "gpt-6-astra", effort: value.effort, attachments: value.attachments, attachFrame: value.attachFrame, signal, emit: send, quotaEvent: quotaForResponse };
			for await (const frame of session.modelSession.start(turnInput)) emitFrame(frame);
		};
		try { await turn(); }
		catch (error) {
			turnOutcome = signal.aborted ? "cancelled" : "failed";
			turnFailureCode = signal.aborted ? "aborted" : agentFailureCode(error, signal, toolFailed);
			if (!signal.aborted) send({ type: "error", ...errorInfo(error, quota) });
			if (!res.writableEnded) emitFrame({ type: "done" });
		}
		finally {
			if (!res.writableEnded) res.end();
			session.running = false;
			res.off("close", disconnect);
		}
		return true;
	};

	handle.close = async () => {
		unsubscribe?.();
		for (const session of sessions.values()) session.controller?.abort();
		for (const session of studioSessions.values()) session.controller?.abort();
		for (const runner of workflowRunners.values()) await runner.close?.();
		for (const runner of studioRunners.values()) await runner.close?.();
		workflowRunners.clear(); studioRunners.clear();
		studioSessions.clear(); studioEvents.clear(); studioOwnerTokens.clear();
		sessions.clear();
		const { liveHub: hub } = await runtime;
		if (hub?.server) {
			for (const socket of hub.server.clients) socket.terminate();
			await new Promise((resolve) => hub.server.close(resolve));
		}
	};
	return handle;
}
