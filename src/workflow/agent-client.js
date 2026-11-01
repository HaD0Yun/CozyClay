// Data layer for the workflow Agent panel.
//
// The browser never holds a credential. Sign-in happens in the system browser
// against the local sidecar, which owns the token exchange and storage; this
// module only ever reads a *description* of the session (email/plan/expiry)
// over loopback HTTP and sends turn text. There is deliberately no field,
// parameter or storage key here that could carry a bearer token, and
// test/verify-agent-panel.mjs pins that by grepping this file.
//
// Sidecar contract:
//   GET  /oauth/status  -> { signedIn, email, plan, accountId, expiresAt }
//   POST /oauth/start   -> { ok, authorizeUrl }
//   POST /oauth/logout  -> { ok }
//   POST /agent/turn    -> SSE, lines of `data: {json}`
//   POST /agent/stop    -> { ok }
//   GET  /agent/models  -> { providers: [{ id, label, signedIn, models }], models: [flat], roles: { byMain } }
//   POST /agent/turn/<turnId>/steer -> { ok, queued } while that turn streams
//
// Studio hosts add the frozen task-1 contracts on the same routes:
//   POST /agent/turn                        -> { surface, sessionId, turnId, text, context, ... }
//   GET  /agent/turn/<turnId>/events?after=N -> replay after a dropped stream
//   POST /agent/stop                        -> { surface, sessionId, turnId, jobId? }
//   POST /agent/jobs/<jobId>/accept          -> explicit "Apply with warnings"
//   GET  /agent/turn/<turnId>/supervisor     -> 200 supervisor note | 204 none (#728)

import { track } from "../analytics.js";
import { appendAttachments, ATTACHMENT_MAX_COUNT } from "./attachment-image.js";
import { ko } from "../locale.js";
import { startAgentTurn, trackAgentTurns } from "./agent-turn-telemetry.js";
import { STUDIO_VARIANTS, validateReceipt } from "../studio-agent-protocol.js";
import { refusalFailureCode, transportFailureCode } from "./agent-failure-codes.js";
import { requestAgentImage, sidecarRequest, sidecarUrl } from "../agent-image-client.js"; import { clearSculptSketch, sculptSketchFrame } from "../sculpt-sketch-state.js";
import { actionLabelsOf, changedLine, scriptNow, stepFields, thinkingLine, withCompose, withThinking, withToolStart, withTurnEnd } from "./agent-turn.js";
import { isPlanFrame, restoredPlans, withPlanEnd, withPlanFrame } from "./agent-plan.js";

const AGENT_PANEL_WIDTH_KEY = "cozyclay.workflow.agentPanel.width";
export const AGENT_PANEL_WIDTH_DEFAULT = 360;
export const AGENT_PANEL_WIDTH_MIN = 300;
export const AGENT_PANEL_WIDTH_MAX = 560;
export const AGENT_PANEL_RAIL_WIDTH = 36;
export const AGENT_PANEL_OVERLAY_BREAKPOINT = 1100;
export const STUDIO_SESSION_STORAGE_KEY = "cozyclay.agent.session.studio";

/** Panel states, in the order the issue lists them. Every name is part of the
 * source contract and is also the value of ?state= in mock mode. */
export const AGENT_STATES = [
	"signed-out",
	"signing-in",
	"no-entitlement",
	"ready",
	"streaming",
	"rate-limited",
	"error",
];

/** Studio identities are UUIDs (task 1 `StudioTurn`/`StudioStop`), never the
 * panel's old counter ids and never an analytics identifier. */
export function createStudioSessionId(random = globalThis.crypto) {
	const uuid = random?.randomUUID?.();
	if (typeof uuid === "string") return uuid;
	const bytes = new Uint8Array(16);
	random.getRandomValues(bytes);
	bytes[6] = (bytes[6] & 0x0f) | 0x40;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Motion job presentation. The state names are task 1's `jobStates`; nothing
 * here invents a percentage the runtime did not report. */
export const JOB_STATE_COPY = {
	queued: "Queued",
	generating: "Generating",
	preparing: "Preparing",
	verifying: "Verifying",
	repairing: "Repairing",
	committing: "Installing",
	reconciling: "Reconciling",
	installed: "Installed",
	review_required: "Needs review",
	failed: "Failed",
	cancelled: "Stopped",
	stale_target: "Target changed",
	stale_environment: "Scene changed",
};
const JOB_TERMINAL_STATES = new Set(["installed", "failed", "cancelled", "stale_target", "stale_environment"]);
export const isTerminalJobState = (state) => JOB_TERMINAL_STATES.has(state);
export const jobStateTone = (state) => {
	if (state === "installed") return "ok";
	if (state === "review_required") return "warn";
	if (isTerminalJobState(state)) return "alert";
	return "busy";
};
/** Progress is shown only when the runtime actually reported one. */
export const formatJobProgress = (progress) => Number.isFinite(progress) ? `${Math.round(progress * 100)}%` : "";

/** One line of plain product copy for a validated receipt. */
export function receiptSummary(receipt, context = null) {
	if (receipt?.status === "installed") {
		const { installed, verification } = receipt;
		const coverage = verification.status === "verified"
			? `verified over ${verification.evaluatedFrames} frames`
			: "installed unverified";
		return `Installed ${installed.durationSeconds}s of motion on ${installed.characterId} — ${coverage}`;
	}
	if (receipt?.status === "undone") return `Undid ${receipt.undoneReceiptId}`;
	if (receipt?.status === "noop") return "Nothing to change";
	if (receipt?.status === "transient") return "Changed the view only";
	return context ? changedLine(receipt?.affectedIds ?? [], context) : `Applied to ${receipt?.affectedIds?.join(", ") || "the scene"}`;
}

/** Effort options for a model entry from /agent/models; the backend default comes first. */
export function effortOptions(entry) {
	const efforts = Array.isArray(entry?.efforts) ? entry.efforts : [];
	if (!efforts.length) return [];
	const fallback = entry.defaultEffort && efforts.includes(entry.defaultEffort) ? entry.defaultEffort : efforts[0];
	return [fallback, ...efforts.filter((effort) => effort !== fallback)];
}

// There is deliberately no hardcoded model list. A stale fallback id is sent
// silently and every turn then fails upstream with an opaque message; the panel
// waits for /agent/models instead and says so while it waits.

export const SUGGESTION_CHIPS = [
	"Block a two-shot conversation in this scene",
	"Render this frame as a storyboard panel",
	"Suggest a camera move for the current shot",
];

/** Previs asks, in the Studio's own words: short enough to read at a glance in
 * the Inspector column, and every one of them is something the Studio families
 * can actually do. */
const STUDIO_SUGGESTION_CHIPS = [
	ko("Block a two-shot", "\uD22C\uC0F7 \uBE14\uB85C\uD0B9"),
	ko("Frame the selected character", "\uC120\uD0DD\uD55C \uCE90\uB9AD\uD130 \uAD6C\uB3C4 \uC7A1\uAE30"),
	ko("Light the set warmer", "\uC138\uD2B8 \uC870\uBA85 \uB354 \uB530\uB73B\uD558\uAC8C"),
];

export const IMAGE_COST_HINT = "Image generation uses about 3-5x a normal turn";

// Canvas tools read as actions, never as raw function names; the map takes
// precedence over the server's underscore-to-space label.
const CANVAS_TOOL_LABELS = {
	describe_workflow: "Read canvas",
	add_workflow_node: "Add node",
	update_workflow_node: "Edit node",
	remove_workflow_node: "Remove node",
	connect_workflow_nodes: "Connect nodes",
	disconnect_workflow_nodes: "Disconnect nodes",
	run_workflow: "Run workflow",
	set_workflow_node_output: "Set node output",
	focus_workflow_node: "Focus node",
	add_reference_node: "Add reference image",
};

/** The Studio families, named for what they do to the scene. The Studio
 * is bilingual, so these go through ko() like every other Studio label. */
const STUDIO_TOOL_LABELS = {
	inspect_studio: ko("Read the scene", "\uC7A5\uBA74 \uC77D\uAE30"),
	operate_studio: ko("Selection and view", "\uC120\uD0DD\uACFC \uBDF0"),
	arrange_objects: ko("Arrange objects", "\uC624\uBE0C\uC81D\uD2B8 \uBC30\uCE58"),
	arrange_characters: ko("Arrange characters", "\uCE90\uB9AD\uD130 \uBC30\uCE58"),
	patch_elements: ko("Edit properties", "\uC18D\uC131 \uD3B8\uC9D1"),
	frame_shot: ko("Frame the shot", "\uC0F7 \uAD6C\uB3C4 \uC7A1\uAE30"),
	generate_motion: ko("Generate motion", "\uBAA8\uC158 \uC0DD\uC131"),
	verify_result: ko("Verify the result", "\uACB0\uACFC \uAC80\uC99D"),
	undo_edit: ko("Undo an edit", "\uD3B8\uC9D1 \uB418\uB3CC\uB9AC\uAE30"),
	run_action: ko("Run an editor action", "\uD3B8\uC9D1\uAE30 \uB3D9\uC791 \uC2E4\uD589"),
};

/**
 * One panel, two hosts. The conversation, the transport, the composer and the
 * activity line are identical on both surfaces; everything below is what each
 * host shows AROUND them. A Workflow-only affordance (the image cost hint, the
 * image entitlement gate, the storyboard chips, the History placeholder, the
 * dock's stored width) is absent from the Studio column rather than rendered
 * dead, because the Studio turn cannot produce an image at all.
 */
export const PANEL_PRESENTATIONS = Object.freeze({
	workflow: Object.freeze({
		toolLabels: CANVAS_TOOL_LABELS,
		toolBadge: "Canvas",
		suggestions: SUGGESTION_CHIPS,
		imageHint: IMAGE_COST_HINT,
		// The Workflow turn generates images, so an account without the image
		// entitlement has to be told before it asks for one.
		imageEntitlement: true,
		// Steering nudges a turn that is already running. Only the Workflow turn
		// accepts it: a Studio turn is a frozen envelope the sidecar refuses to
		// steer (409 STEER_UNSUPPORTED), so that surface keeps Stop alone.
		steer: true,
		history: true,
		persistWidth: true,
		emptyTitle: "Direct the scene",
		emptyHint: (sceneName) => `Ask for blocking, a camera move, or a rendered frame from \u201C${sceneName}\u201D.`,
		composerPlaceholder: "Ask the agent to block, frame or render\u2026",
	}),
	studio: Object.freeze({
		toolLabels: STUDIO_TOOL_LABELS,
		toolBadge: ko("Scene", "\uC7A5\uBA74"),
		suggestions: STUDIO_SUGGESTION_CHIPS,
		imageHint: null,
		imageEntitlement: false,
		steer: false,
		history: true,
		persistWidth: false,
		emptyTitle: ko("Direct the scene", "\uC7A5\uBA74\uC744 \uC5F0\uCD9C\uD558\uC138\uC694"),
		emptyHint: (sceneName) => ko(`Ask for blocking, a camera move, or a motion take in \u201C${sceneName}\u201D.`, `\u201C${sceneName}\u201D\uC5D0\uC11C \uBE14\uB85C\uD0B9, \uCE74\uBA54\uB77C \uC6C0\uC9C1\uC784, \uBAA8\uC158 \uD14C\uC774\uD06C\uB97C \uC694\uCCAD\uD558\uC138\uC694.`, `在“${sceneName}”中请求摆位、摄影机运动或动作片段。`),
		composerPlaceholder: ko("Ask the agent to block, frame or animate\u2026", "\uBE14\uB85C\uD0B9\u00B7\uAD6C\uB3C4\u00B7\uBAA8\uC158\uC744 \uC694\uCCAD\uD558\uC138\uC694\u2026"),
	}),
});

/** The presentation a surface owns; an unknown surface is the dock's. */
export function panelPresentation(surface) {
	return Object.hasOwn(PANEL_PRESENTATIONS, surface) ? PANEL_PRESENTATIONS[surface] : PANEL_PRESENTATIONS.workflow;
}

/** The one label a tool call is known by, in a card and in the activity line. */
export function resolveToolLabel(call, labels = CANVAS_TOOL_LABELS) {
	return Object.hasOwn(labels, call?.name) ? labels[call.name] : toolCallLabel(call);
}

export function clampPanelWidth(value) {
	const width = Number(value);
	if (!Number.isFinite(width)) return AGENT_PANEL_WIDTH_DEFAULT;
	return Math.min(AGENT_PANEL_WIDTH_MAX, Math.max(AGENT_PANEL_WIDTH_MIN, Math.round(width)));
}

export function readStoredPanelWidth(storage = globalThis.localStorage) {
	try {
		const raw = storage?.getItem(AGENT_PANEL_WIDTH_KEY);
		if (raw === null || raw === undefined || raw === "") return AGENT_PANEL_WIDTH_DEFAULT;
		return clampPanelWidth(raw);
	} catch {
		return AGENT_PANEL_WIDTH_DEFAULT;
	}
}

export function storePanelWidth(width, storage = globalThis.localStorage) {
	try {
		storage?.setItem(AGENT_PANEL_WIDTH_KEY, String(clampPanelWidth(width)));
	} catch {
		// Private-mode storage denial must never break resizing the panel.
	}
}

/** The model the author last picked, by its `provider/id` key. Remembered
 * because the choice is a working preference, not a per-session decision: a
 * reload that silently drops you back on another provider's model is a
 * surprise the next turn pays for. A key that is no longer advertised is
 * ignored rather than sent. */
export const AGENT_MODEL_KEY = "cozyclay.agent.model";

export function readStoredModel(storage = globalThis.localStorage) {
	try {
		const raw = storage?.getItem(AGENT_MODEL_KEY);
		return typeof raw === "string" && raw ? raw : null;
	} catch {
		return null;
	}
}

export function storeModel(key, storage = globalThis.localStorage) {
	try {
		if (typeof key === "string" && key) storage?.setItem(AGENT_MODEL_KEY, key);
	} catch {
		// Private-mode storage denial must never break picking a model.
	}
}

/** The model to open with: the remembered key when it is still advertised,
 * otherwise the first model the sidecar listed. */
export function preferredModel(models, stored = readStoredModel()) {
	const list = Array.isArray(models) ? models : [];
	return list.some((entry) => entry?.id === stored) ? stored : list[0]?.id ?? "";
}

/** A model the session can actually run: one whose provider holds a
 * credential. Without the grouped payload nothing is known about providers, so
 * every advertised model stays selectable. */
export function modelIsSelectable(providers, key) {
	if (!providers.length) return true;
	const provider = providers.find((entry) => entry.models?.some((model) => model.key === key));
	return provider ? provider.signedIn : true;
}

/** The model a freshly advertised list leaves selected. The current choice
 * survives only while the refreshed catalogue still lists it AND its provider
 * still holds a credential: a key saved (or removed) elsewhere in the panel
 * changes WHICH models can run, and a sign-out takes the models that existed
 * only for that credential away with it. A selection the list no longer
 * carries has no option to be shown by — the dropdown falls back to another
 * one while the panel would go on submitting the retired id. The remembered
 * preference is re-read here rather than rewritten, so it comes back the
 * moment its provider (and its model) does. */
export function nextSelectedModel(providers, models, current) {
	if (current && models.some((entry) => entry.id === current) && modelIsSelectable(providers, current)) return current;
	return preferredModel(models.filter((entry) => modelIsSelectable(providers, entry.id)));
}

/** The roles the sidecar derived for one main model (#717): `{ helper, vision,
 * advisor, fallback }`, each a `provider/id` key. Read-only here — nothing the
 * panel sends depends on it — so a malformed entry is simply not shown. */
export function selectedModelRoles(byMain, key) {
	const entry = byMain && typeof byMain === "object" && typeof key === "string" ? byMain[key] : null;
	return entry && ["helper", "vision", "advisor"].every((role) => typeof entry[role] === "string" && entry[role]) ? entry : null;
}

/** A `provider/id` key without its provider, for a line that has no room for it. */
export function shortModelId(key) {
	const value = String(key ?? "");
	return value.slice(value.indexOf("/") + 1);
}

/** "resets in 42m" / "resets in 1h 05m" for the account strip and the paused
 * card countdown. Returns null when there is nothing to count down to. */
export function formatResetIn(resetAt, now = Date.now()) {
	if (!resetAt) return null;
	const target = typeof resetAt === "number" ? resetAt : Date.parse(resetAt);
	if (!Number.isFinite(target)) return null;
	const remaining = Math.max(0, target - now);
	const totalSeconds = Math.round(remaining / 1000);
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
	if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
	return `${seconds}s`;
}

const TOOL_LABELS = {
	capture_blocking_frame: { verb: "Capture", target: "blocking frame" },
	render_from_frame: { verb: "Render", target: "from frame" },
	place_image_in_scene: { verb: "Place", target: "image in scene" },
};

/** ToolCallCard shows "verb + target", never a raw function name. */
export function toolCallLabel(call) {
	if (call?.label) return call.label;
	const known = TOOL_LABELS[call?.name];
	if (known) return `${known.verb} ${known.target}`;
	const words = String(call?.name || "tool").split(/[_\-\s]+/).filter(Boolean);
	if (!words.length) return "Run tool";
	const verb = words[0][0].toUpperCase() + words[0].slice(1);
	return words.length > 1 ? `${verb} ${words.slice(1).join(" ")}` : verb;
}

export function formatElapsed(ms) {
	if (!Number.isFinite(ms) || ms < 0) return "";
	if (ms < 1000) return `${Math.round(ms)}ms`;
	return `${(ms / 1000).toFixed(1)}s`;
}

/** Why a steer was refused, by the code the sidecar answers 409 with. The
 * draft stays in the composer either way: the author's words are never eaten
 * by a turn that ended a moment earlier. */
export const STEER_ERROR_COPY = {
	STEER_UNSUPPORTED: "This surface cannot steer a running turn.",
	NO_ACTIVE_TURN: "That turn already ended — send it as a new message.",
};

/** Codes a Studio refusal carries: a turn that met one is reviewed by the
 * supervisor even when it authored nothing (#728). */
const SUPERVISOR_REFUSAL = /^(TARGET_NOT_READY|CAPABILITY_MISSING|CONFIRMATION_REQUIRED):/;

/** The next prompt a supervisor note suggests: its blocker and concern issues,
 * or null when it raised none. A note with validated fixes (#743) asks for
 * exactly those run_action calls, in order, in one script; the blockers and
 * concerns without a fix follow under their own header. */
export function supervisorFollowUp(note) {
	const all = Array.isArray(note?.issues) ? note.issues : [];
	const fixes = (Array.isArray(note?.fixes) ? note.fixes : []).filter((fix) => typeof fix?.action === "string" && fix.args && typeof fix.args === "object");
	const fixed = new Set(fixes.map((fix) => fix.issueIndex));
	const issues = all.filter((issue, index) => (issue?.severity === "blocker" || issue?.severity === "concern") && !fixed.has(index));
	const line = (issue) => `- [${issue.severity}] ${issue.text}${issue.evidence ? ` (${issue.evidence})` : ""}`;
	if (!fixes.length) return issues.length ? [ko("Supervisor review — please address:", "감독 검토 — 다음을 고쳐 주세요:"), ...issues.map(line)].join("\n") : null;
	return [
		ko("Supervisor review — apply these fixes exactly, in order, in ONE script call, then verify_result; do not re-derive them:", "감독 검토 — 아래 수정을 유추 없이 순서대로 script 1회로 실행하고 verify_result로 확인해 주세요:"),
		...fixes.map((fix) => `- [${fix.severity}] ${all[fix.issueIndex]?.text ?? ""} -> run_action ${JSON.stringify({ action: fix.action, args: fix.args })}`),
		...(issues.length ? [ko("Also check:", "추가 확인:"), ...issues.map(line)] : []),
	].join("\n");
}

export const ERROR_COPY = {
	auth: "Your session expired. Sign in again to continue.",
	entitlement: "This account cannot generate images.",
	rate_limit: "You have hit the usage limit for this window.",
	upstream: "The model service failed to answer.",
	overloaded: "The model service is overloaded right now. Try again in a moment.",
};

// Silence is the failure mode this replaces: a live turn says what it is doing
// and a finished turn says how it ended, in the same line, so "nothing on
// screen" can never mean "nobody knows".

/** How long a finished turn keeps explaining itself before the line goes quiet. */
export const ACTIVITY_TERMINAL_MS = 6000;
const ACTIVITY_IDLE_TEXT = "Ready";

/** Short, line-sized reasons; a transport message ("turn responded 429") is
 * already short enough and is preferred over inventing copy for it. */
const FAILURE_REASON = {
	auth: "session expired",
	entitlement: "not on this plan",
	rate_limit: "usage limit reached",
	rate_limited: "usage limit reached",
	overloaded: "service overloaded",
	no_output: "no response",
};

function shortFailureReason(failure) {
	if (!failure) return "unknown error";
	const known = FAILURE_REASON[failure.code];
	if (known) return known;
	const message = String(failure.message ?? "").trim();
	if (!message) return String(failure.code || "unknown error");
	return message.length > 64 ? `${message.slice(0, 63)}…` : message;
}

/** Elapsed clock for the activity line: "3 s", "1 m 05 s". */
export function formatTurnClock(ms) {
	const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
	if (total < 60) return `${total} s`;
	return `${Math.floor(total / 60)} m ${String(total % 60).padStart(2, "0")} s`;
}

// `detail`: what the step is about (a spec's label, the script's current call, the latest line of reasoning).
const liveActivity = (phase, label, elapsedMs, detail = "") => ({
	phase,
	kind: "live",
	tone: "busy",
	text: `${label} · ${formatTurnClock(elapsedMs)}`,
	ticking: true,
	...(detail ? { detail } : {}),
});

/** What the panel says it is doing, in plain words. Pure: the component only
 * supplies the clock, so every phase and every terminal state is testable. */
export function describeActivity(state, { now = Date.now(), toolLabel = toolCallLabel } = {}) {
	const items = state?.items ?? [];
	// A dispatched editor action outlives the turn that produced the image, so it
	// is the most specific thing the panel can be waiting for.
	const dispatched = items.find((item) => item.kind === "image" && item.apply?.status === "applying");
	if (dispatched) return liveActivity("editor", "Waiting for the editor…", now - (dispatched.apply.startedAt ?? now));
	if (state?.streaming) {
		const elapsed = now - (state.turnStartedAt ?? now);
		const job = items.findLast((item) => item.kind === "job" && !isTerminalJobState(item.state));
		if (job) {
			const percent = formatJobProgress(job.progress);
			return liveActivity("job", `${JOB_STATE_COPY[job.state] || job.state} motion${percent ? ` ${percent}` : ""}`, elapsed);
		}
		const tool = items.findLast((item) => item.kind === "tool" && item.status === "running");
		if (tool) return liveActivity("tool", `Running ${toolLabel(tool)}…`, elapsed, tool.progress ? scriptNow(tool) : tool.subject);
		// The newest frame says what the model is doing now: writing a call, its reply, or reasoning.
		const latest = items.at(-1);
		if (latest?.kind === "compose") return liveActivity("compose", `Preparing ${toolLabel(latest)}…`, elapsed, latest.subject);
		if (latest?.kind === "thinking") return liveActivity("thinking", "Thinking…", elapsed, thinkingLine(latest.text));
		if (latest?.kind === "assistant") return liveActivity("reply", "Writing the reply…", elapsed);
		// Nothing has come back yet: the request, then the model's first token, is all that is happening.
		return latest?.kind === "user"
			? liveActivity("sending", elapsed < 2000 ? "Sending…" : "Waiting for the model…", elapsed)
			: liveActivity("thinking", "Thinking…", elapsed);
	}
	const last = state?.lastTurn;
	if (last && now - last.endedAt < ACTIVITY_TERMINAL_MS) {
		if (last.status === "stopped") return { phase: "stopped", kind: "terminal", tone: "warn", text: "Stopped", ticking: true };
		if (last.status === "failed") return { phase: "failed", kind: "terminal", tone: "alert", text: `Failed: ${shortFailureReason(last.failure)}`, ticking: true };
		return { phase: "done", kind: "terminal", tone: "ok", text: `Done · ${formatTurnClock(last.durationMs)}`, ticking: true };
	}
	return { phase: "idle", kind: "idle", tone: "", text: ACTIVITY_IDLE_TEXT, ticking: false };
}

/** Split an SSE body into `data:` payload objects. Exported so the reader can
 * be unit-tested without a socket. */
export function parseSseChunk(buffer) {
	const events = [];
	const lines = buffer.split("\n");
	const tail = lines.pop() ?? "";
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("data:")) continue;
		const payload = trimmed.slice(5).trim();
		if (!payload) continue;
		try {
			events.push(JSON.parse(payload));
		} catch {
			// A partial or malformed frame is dropped rather than killing the turn.
		}
	}
	return { events, tail };
}

const advisory = (read, fallback) => { try { return read(); } catch { return fallback; } };

const UI_ERROR_CODES = new Set(["auth", "entitlement", "rate_limit", "overloaded", "upstream"]);

/** The UI error for a refused turn. The sidecar answers `{ error: { code,
 * message, status } }` with an already-sanitized message; a refusal without a
 * readable body still reports its HTTP status rather than a blank panel. */
export async function refusalEvent(response) {
	const status = Number.isFinite(response?.status) ? response.status : null;
	let detail = null;
	try {
		const body = await response.clone().json();
		detail = typeof body?.error === "string" ? { message: body.error } : body?.error && typeof body.error === "object" ? body.error : null;
	} catch { /* a refusal with no JSON body is still a reportable status */ }
	const reported = typeof detail?.message === "string" ? detail.message.trim() : "";
	// The sidecar already leads with the status on every route that answers JSON;
	// repeating it ("502 — 502 — …") reads as a bug in the panel.
	const message = !reported ? `The turn was refused with HTTP ${status ?? "error"}.`
		: status !== null && reported.startsWith(`${status} `) ? reported
			: `${status ?? "Upstream"} — ${reported}`;
	return {
		code: UI_ERROR_CODES.has(detail?.code) ? detail.code : status === 429 ? "rate_limit" : status === 401 ? "auth" : "upstream",
		message,
		...(status === null ? {} : { status }),
		...(detail?.resetAt ? { resetAt: detail.resetAt } : {}),
	};
}

const RESUME_ATTEMPTS = 3;

/** The environment variables the sidecar reads a provider key from (the `env`
 * column of `bin/agent/providers.mjs` PROVIDERS). The panel never reads a key
 * — it only needs the variable's NAME, so an env-backed provider can say which
 * variable is already holding one instead of offering an input that would be
 * ignored. */
const PROVIDER_ENV_VARS = {
	anthropic: ["ANTHROPIC_API_KEY"],
	openai: ["OPENAI_API_KEY"],
	google: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
	openrouter: ["OPENROUTER_API_KEY"],
	cliproxy: ["CLIPROXY_API_KEY"],
};

/** "set by <ENV_VAR>" for a provider whose key comes from the environment. */
export function providerEnvLabel(id) {
	const names = PROVIDER_ENV_VARS[id];
	return names?.length ? names.join(" or ") : "an environment variable";
}

/** The failure a provider's 401/403 turns into: the refusal, plus the provider's own reason when the raw
 * error carries one ("invalid x-api-key"), instead of the raw status and JSON body. */
export function keyRefusedMessage(raw) {
	const reason = /"message"\s*:\s*"([^"]{1,160})"/.exec(String(raw || ""))?.[1];
	const status = /\b(401|403)\b/.exec(String(raw || ""))?.[1];
	// What to do next is the failure card's recovery line, said once there.
	return `The model provider refused the credentials${status || reason ? ` (${[status, reason].filter(Boolean).join(": ")})` : ""}.`;
}

/** True when the agent server itself did not answer: plain `vite` without the sidecar (503/502/404), a dead
 * port (network error, no status), or an HTML fallback where JSON was expected. Any other status is the server's own answer. */
export const agentServerUnavailable = (error) => !Number.isFinite(error?.status) || [404, 502, 503].includes(error.status);

export function createHttpTransport({ fetchImpl = globalThis.fetch?.bind(globalThis), surface, capture = track, now = () => performance.now() } = {}) {
	const activeTurns = new Map();
	const request = (path, init) => sidecarRequest(fetchImpl, path, init);
	return {
		mock: false,
		async status() {
			return request("/oauth/status");
		},
		async signIn() {
			// The sidecar owns the code exchange and opens the sign-in page itself; opening it here
			// too showed the page twice. The waiting card links the page from /oauth/status.
			return request("/oauth/start", { method: "POST", body: "{}" });
		},
		async signOut() {
			return request("/oauth/logout", { method: "POST", body: "{}" });
		},
		/** `{ providers, models }` (#379). The flat `models` is key-addressed
		 * (`provider/id`) and carries each model's efforts; `providers` is the same
		 * list grouped, with the sign-in state the dropdown disables its options
		 * by. A sidecar that answers with the flat list alone still fills the
		 * dropdown — ungrouped rather than empty. */
		async models() {
			const result = await request("/agent/models");
			const models = Array.isArray(result?.models) ? result.models : [];
			const providers = Array.isArray(result?.providers)
				? result.providers.filter((provider) => provider?.id && Array.isArray(provider.models))
				: [];
			// The derived model roles (#717) ride along untouched; a sidecar without
			// them simply leaves the roles line hidden.
			const byMain = result?.roles?.byMain;
			if (byMain && typeof byMain === "object" && !Array.isArray(byMain)) return { providers, models, roles: { byMain } };
			return { providers, models };
		},
		/** Steering a turn that is STILL streaming. The id is the one this browser
		 * minted for that turn; the sidecar answers 409 for a Studio envelope
		 * (STEER_UNSUPPORTED) and for a turn that already ended (NO_ACTIVE_TURN). */
		async steer(turnId, body) {
			return request(`/agent/turn/${encodeURIComponent(turnId)}/steer`, { method: "POST", body: JSON.stringify(body) });
		},
		// Provider credentials live in the sidecar's 0600 store. The browser sends
		// a key once and never reads one back: the status route answers with the
		// source of a key, never with key material.
		async providers() { const result = await request("/agent/providers"); return Array.isArray(result?.providers) ? result.providers : []; },
		async setProviderKey(id, key) { return request(`/agent/providers/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify({ key }) }); },
		async removeProviderKey(id) { return request(`/agent/providers/${encodeURIComponent(id)}`, { method: "DELETE" }); },
		async listSessions() {
			const result = await request(`/agent/sessions?surface=${encodeURIComponent(surface || "studio")}`);
			return Array.isArray(result?.sessions) ? result.sessions : [];
		},
		async loadSession(sessionId) {
			return request(`/agent/sessions/${encodeURIComponent(sessionId)}`);
		},
		// Legacy callers pass a session id; a Studio host passes the frozen stop
		// envelope so the sidecar can cancel one turn and one owned job.
		async stop(target) {
			const envelope = typeof target === "string" || !target
				? { sessionId: target }
				: { surface: "studio", sessionId: target.sessionId, turnId: target.turnId, ...(target.jobId ? { jobId: target.jobId } : {}) };
			activeTurns.get(envelope.sessionId)?.cancel();
			return request("/agent/stop", { method: "POST", body: JSON.stringify(envelope) });
		},
		/** Trusted "Apply with warnings": a user action, never a model bypass. */
		async acceptJob({ jobId, sessionId, turnId }) {
			return request(`/agent/jobs/${encodeURIComponent(jobId)}/accept`, {
				method: "POST",
				body: JSON.stringify({ surface: "studio", sessionId, turnId, explicitUnverifiedAcceptance: true }),
			});
		},
		// `references` are the scene's identity / environment slots (#167): extra
		// attached pictures with a role, passed through untouched so the sidecar
		// decides how they are described to the model.
		async image(payload, signal) {
			return requestAgentImage(payload, { fetchImpl, signal });
		},
		async video(payload, signal) {
			return request("/agent/video", { method: "POST", body: JSON.stringify(payload), signal });
		},
		async videoProviders() {
			return request("/agent/video/providers");
		},
		/** The supervisor note for a finished Studio turn (#728): one long-poll
		 * the sidecar holds while the review runs. A 200 is the note; a 204, a
		 * failure or anything unreadable is no note. */
		async supervisor(turnId, signal) {
			const response = await fetchImpl(sidecarUrl(`/agent/turn/${encodeURIComponent(turnId)}/supervisor`), { headers: { accept: "application/json" }, credentials: "same-origin", signal });
			if (response?.status !== 200) return null;
			const note = await response.json();
			return note?.type === "supervisor" && ["reviewed", "unavailable"].includes(note.verdict) ? note : null;
		},
		/** Streams sidecar events to `onEvent`. Resolves when the turn ends. */
		async turn(turnRequest, onEvent, signal) {
			const { sessionId, text, attachFrame, model, effort, attachments, supervisor, tasks } = turnRequest;
			const attached = Array.isArray(attachments) && attachments.length ? { attachments } : {};
			const studio = turnRequest.surface === "studio";
			const turnId = studio ? turnRequest.turnId : null;
			// The host's own surface wins over the URL (an embedded Studio panel on a /workflow path is still Studio).
			const hostSurface = advisory(() => ["studio", "workflow"].includes(surface) ? surface
				: /^\/workflow(?:\/|$)/.test(globalThis.location?.pathname || "") ? "workflow" : "studio", "studio");
			const telemetry = startAgentTurn({ surface: hostSurface, capture, now, correlationId: turnId });
			// The steer route is keyed by the id THIS request is known by upstream:
			// the Studio envelope's turnId, or the hex id the dock mints for its own
			// turn. The caller cannot know it any other way.
			turnRequest.onTurnId?.(studio ? turnId : telemetry.turnId);
			activeTurns.set(sessionId, telemetry);
			const onAbort = () => { if (signal.reason === "agent-stop") telemetry.cancel(); };
			signal?.addEventListener("abort", onAbort, { once: true });
			if (signal?.aborted) onAbort();
			let opened = false;
			let failureCode;
			// Studio events are sequenced so a reconnect can replay without applying
			// anything twice. A replayed event is dropped here, before the UI sees it.
			let cursor = 0;
			let terminal = false;
			const receive = (event) => {
				if (event?.type === "execution_telemetry" || event?.type === "execution_tool_started") { telemetry.frame(event); return; }
				if (studio && Number.isFinite(event?.eventSeq)) {
					if (event.eventSeq <= cursor) return;
					cursor = event.eventSeq;
				}
				if (event?.type === "error") failureCode = transportFailureCode(event);
				if (event?.type === "done") terminal = true;
				if (event?.type === "tool.start" || event?.type === "tool.done") telemetry.tool(event);
				onEvent(event);
			};
			const readStream = async (response) => {
				const reader = response.body.getReader();
				opened = true;
				try {
					const decoder = new TextDecoder();
					let buffer = "";
					while (true) {
						const { value, done } = await reader.read();
						if (done) break;
						buffer += decoder.decode(value, { stream: true });
						const parsed = parseSseChunk(buffer);
						buffer = parsed.tail;
						for (const event of parsed.events) receive(event);
					}
					// Preserve legacy UI tail delivery, but never complete a telemetry
					// frame synthetically. Bare done/EOF is not completion evidence.
					for (const event of parseSseChunk(`${buffer}\n`).events) {
						if (event?.type !== "execution_telemetry" && event?.type !== "execution_tool_started") receive(event);
					}
				} finally {
					reader.releaseLock();
				}
			};
			const body = studio
				? JSON.stringify({
					surface: "studio", sessionId, turnId, text, context: turnRequest.context,
					...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(attachFrame === undefined ? {} : { attachFrame: Boolean(attachFrame) }), ...(typeof supervisor === "boolean" ? { supervisor } : {}), ...attached,
				})
				: JSON.stringify({ sessionId, text, attachFrame, model, ...(effort ? { effort } : {}), ...attached, ...(telemetry.turnId ? { turn_id: telemetry.turnId } : {}) });
			try {
				// Task mode (the panel's Tasks switch): the turn goes to the main agent, which answers at once and runs tasks.
				const response = await fetchImpl(sidecarUrl(studio && tasks ? "/agent/main" : "/agent/turn"), {
					method: "POST",
					headers: { "content-type": "application/json", accept: "text/event-stream", ...(studio && tasks ? { "x-cozyclay-tasks": "on" } : {}) },
					body,
					signal,
				});
				if (!response.ok || !response.body) {
					telemetry.fail(await refusalFailureCode(response));
					// A refused turn carries the only explanation there is. Forward the
					// status and whatever short detail the sidecar sanitized for us
					// instead of the panel inventing "something went wrong".
					onEvent({ type: "error", ...(await refusalEvent(response)) });
					onEvent({ type: "done" });
					return;
				}
				let streamError = null;
				try { await readStream(response); } catch (error) { streamError = error; }
				// A lost observer is not a lost turn: resume from the cursor instead of
				// re-sending the turn, which would authorize a second generation.
				for (let attempt = 0; studio && turnId && !terminal && !signal?.aborted && attempt < RESUME_ATTEMPTS; attempt += 1) {
					let resumed;
					try {
						resumed = await fetchImpl(sidecarUrl(`/agent/turn/${encodeURIComponent(turnId)}/events?after=${cursor}`), {
							headers: { accept: "text/event-stream" },
							signal,
						});
					} catch { break; }
					if (!resumed?.ok || !resumed.body) break;
					streamError = null;
					try { await readStream(resumed); } catch (error) { streamError = error; }
				}
				if (streamError) throw streamError;
				if (failureCode) telemetry.fail(failureCode);
			} catch (error) {
				// Refusal before the stream opens is a known failed request. Losing
				// an open stream without an outcome leaves execution unobserved.
				if (!signal?.aborted && (!opened || failureCode)) telemetry.fail(failureCode || transportFailureCode(error));
				throw error;
			} finally {
				signal?.removeEventListener("abort", onAbort);
				if (activeTurns.get(sessionId) === telemetry) activeTurns.delete(sessionId);
			}
		},
	};
}

// --- mock transport (QA) ---
/** ?agent=mock turns the panel onto a scripted transport so every state in the
 * issue can be reached and screenshotted before the sidecar exists. */
export function mockConfigFromSearch(search = globalThis.location?.search || "") {
	const params = new URLSearchParams(search);
	if (params.get("agent") !== "mock") return null;
	const requested = params.get("state");
	const state = AGENT_STATES.includes(requested) ? requested : "ready";
	return { state, speed: Number(params.get("speed")) || 1 };
}

const MOCK_ACCOUNT = {
	signedIn: true,
	email: "director@cozyclay.org",
	plan: "Plus",
	accountId: "acct_mock_126",
	expiresAt: null,
};

const MOCK_IMAGE =
	"data:image/svg+xml;utf8," +
	encodeURIComponent(
		`<svg xmlns="http://www.w3.org/2000/svg" width="512" height="288" viewBox="0 0 512 288">` +
			`<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
			`<stop offset="0" stop-color="#2a2f52"/><stop offset="1" stop-color="#5b3550"/></linearGradient></defs>` +
			`<rect width="512" height="288" fill="url(#g)"/>` +
			`<circle cx="150" cy="150" r="52" fill="#ef759d" opacity="0.85"/>` +
			`<rect x="250" y="112" width="180" height="112" rx="10" fill="#8994ff" opacity="0.8"/>` +
			`<rect y="240" width="512" height="48" fill="#101116" opacity="0.55"/>` +
			`<text x="24" y="272" font-family="Inter,sans-serif" font-size="18" fill="#edf0fb">mock render · wide two-shot</text>` +
			`</svg>`,
	);

const MOCK_SCRIPT = [
	{ delay: 40, event: { type: "text.delta", text: "Framing a wide two-shot from the current blocking. " } },
	{ delay: 120, event: { type: "text.delta", text: "Capturing the viewport first." } },
	{ delay: 120, event: { type: "tool.start", callId: "call-1", name: "capture_blocking_frame", label: "Capture blocking frame", args: { shot: "current" } } },
	{ delay: 260, event: { type: "tool.done", callId: "call-1", ok: true, elapsedMs: 268, result: { width: 1280, height: 720 } } }, { delay: 0, event: { type: "context", tokens: 41_200, window: 1_000_000 } },
	{ delay: 90, event: { type: "tool.start", callId: "call-2", name: "render_from_frame", label: "Render from frame", args: { style: "storyboard", strength: 0.6 } } },
	{ delay: 420, event: { type: "tool.done", callId: "call-2", ok: true, elapsedMs: 1412, result: { imageId: "img-1" } } },
	{ delay: 80, event: { type: "image", imageId: "img-1", dataUrl: MOCK_IMAGE, width: 512, height: 288, prompt: "wide two-shot, storyboard ink" } },
	{ delay: 60, event: { type: "quota", plan: "Plus", primary: { usedPercent: 46, windowMinutes: 300, resetAt: null }, credits: { has: true } } }, { delay: 0, event: { type: "context", tokens: 95_900, window: 1_000_000 } },
	{ delay: 40, event: { type: "done" } },
];

// The Studio turn authors the scene instead of generating pictures, so its
// scripted turn ends in a receipt the panel validates and the host can act on
// — the same shape a real Studio command returns.
const MOCK_STUDIO_HOST = { workspaceId: "tab-mock", documentEpoch: "doc-mock", sceneId: "scene-mock", sceneEpoch: "scene-open-mock" };
const MOCK_STUDIO_RECEIPT = {
	ok: true, commandId: "cmd-mock-1", receiptId: "receipt-mock-1", host: MOCK_STUDIO_HOST, status: "applied",
	authored: true, revision: { before: 41, after: 42 }, affectedIds: ["char-a"],
	delta: [{ id: "char-a", after: { position: { x: -0.8, y: 0, z: 0.4 } } }],
	checks: { coverage: "affected-targets" }, undo: { historyEntryId: "history-mock-1", entries: 1, canUndoDirect: true }, warnings: [],
};

const MOCK_STUDIO_SCRIPT = [
	{ delay: 40, event: { type: "text.delta", text: "Reading the scene before I move anyone. " } },
	{ delay: 120, event: { type: "tool.start", callId: "studio-1", name: "inspect_studio", label: "inspect studio", args: { scope: "selection" } } },
	{ delay: 220, event: { type: "tool.done", callId: "studio-1", ok: true, elapsedMs: 214, result: { entities: 2 } } }, { delay: 0, event: { type: "context", tokens: 41_200, window: 1_000_000 } },
	{ delay: 90, event: { type: "text.delta", text: "Blocking the two-shot now." } },
	{ delay: 120, event: { type: "tool.start", callId: "studio-2", name: "arrange_characters", label: "arrange characters", args: { ops: [{ op: "update", characterId: "char-a", position: { world: { x: -0.8, y: 0, z: 0.4 } } }] } } },
	{ delay: 320, event: { type: "tool.done", callId: "studio-2", ok: true, elapsedMs: 332, result: { ok: true, receiptId: MOCK_STUDIO_RECEIPT.receiptId } } },
	{ delay: 60, event: { type: "receipt", receipt: MOCK_STUDIO_RECEIPT } }, { delay: 0, event: { type: "context", tokens: 95_900, window: 1_000_000 } },
	{ delay: 40, event: { type: "done" } },
];

// The scripted provider table: the sidecar's own shape ({id,label,authSource,
// signedIn}) with one provider pinned to the environment so the disabled,
// env-backed row is reachable in QA. The mock stores the SOURCE of a key and
// never the key itself — there is nothing here for a screenshot to leak.
const MOCK_PROVIDER_LABELS = [
	["openai-codex", "ChatGPT (OpenAI Codex)"],
	["anthropic", "Anthropic"],
	["openai", "OpenAI"],
	["google", "Google Gemini"],
	["openrouter", "OpenRouter"],
	["cliproxy", "CLIProxyAPI"],
];
const MOCK_ENV_PROVIDER = "google";
/** The scripted `/agent/models` catalogue: every provider carries its own
 * models, effort levels and backend default, signed in or not, so the grouped
 * dropdown — its optgroups, its disabled "add key" options and the effort list
 * that follows the chosen model — is fully drivable from ?agent=mock. */
const MOCK_PROVIDER_MODELS = {
	"openai-codex": [
		{ id: "gpt-6-astra", label: "gpt-6-astra", efforts: ["none", "low", "medium", "high", "xhigh"], defaultEffort: "medium" },
		{ id: "gpt-5.1-codex", label: "gpt-5.1-codex", efforts: ["low", "medium", "high"], defaultEffort: "medium" },
	],
	anthropic: [{ id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5", efforts: ["none", "low", "medium", "high"], defaultEffort: "medium" }],
	openai: [{ id: "gpt-5.1", label: "GPT-5.1", efforts: ["none", "low", "medium", "high", "xhigh"], defaultEffort: "medium" }],
	google: [{ id: "gemini-3-pro", label: "Gemini 3 Pro", efforts: ["none", "low", "medium", "high"], defaultEffort: "medium" }],
	openrouter: [{ id: "deepseek-v3", label: "DeepSeek V3", efforts: ["none"], defaultEffort: "none" }],
	cliproxy: [{ id: "claude-sonnet-5", label: "Claude Sonnet 5", efforts: ["none", "low", "medium", "high"], defaultEffort: "medium" }],
};
/** A ChatGPT model the sidecar learns about from the live catalogue, which it
 * can only read with the credential: signing out does not merely draw it
 * disabled, it stops being advertised at all. That is the transition browser
 * QA drives to prove the panel never submits a model the dropdown is no
 * longer showing (#379). */
const MOCK_LIVE_ONLY_CODEX_MODEL = { id: "gpt-6-live-preview", label: "gpt-6 live preview", efforts: ["none", "low", "medium", "high"], defaultEffort: "high" };
/** The shortest key the scripted sidecar will store, so QA can drive the
 * refusal path (PUT → 400) without a real provider. */
const MOCK_PROVIDER_KEY_MIN = 8;
/** How many times the scripted sidecar answered /oauth/status. The panel reads
 * the session once per credential write and never on a timer (#379), and this
 * is how browser QA proves it without reaching inside the component. */
export const MOCK_STATUS_CALLS_KEY = "cozyclay.mock.agent.status-calls";
/** How many times the scripted sidecar answered /agent/models. A ChatGPT
 * sign-in changes WHICH models the session may run, so the panel re-reads the
 * catalogue at that transition; this is how browser QA proves it reads it once
 * and never on a timer (#379). */
export const MOCK_MODEL_CALLS_KEY = "cozyclay.mock.agent.model-calls";
const countMockCall = (key) => {
	try { globalThis.localStorage?.setItem(key, String(Number(globalThis.localStorage.getItem(key) || 0) + 1)); } catch { /* mock proof state is best effort */ }
};

export function createMockTransport(config = { state: "ready" }) {
	const state = config?.state || "ready";
	const studio = config?.surface === "studio";
	const speed = config?.speed > 0 ? config.speed : 1;
	const wait = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms / speed)));
	const storedProviders = new Set();
	// The ChatGPT session is something the panel can MOVE, not a fixed property
	// of the scripted state: signIn() and signOut() flip it, so QA drives the
	// authentication transition itself (#379) rather than two separate pages.
	// "pending" is the scripted OAuth window that has not come back yet.
	let session = state === "signed-out" ? "out" : state === "signing-in" ? "pending" : "in";
	// Which providers hold a credential right now, in the sidecar's own shape.
	const providerStatus = () => MOCK_PROVIDER_LABELS.map(([id, label]) => {
		const authSource = id === "openai-codex" ? (session === "in" ? "chatgpt" : null)
			: id === MOCK_ENV_PROVIDER ? "env"
				: storedProviders.has(id) ? "file" : null;
		return { id, label, authSource, signedIn: Boolean(authSource) };
	});
	// The turn a steer may still reach. It is cleared at the last scripted frame,
	// while the stream is still open, exactly like the sidecar's own turn record.
	let liveTurn = null;
	let turns = 0;
	return {
		mock: true,
		state,
		async status() {
			countMockCall(MOCK_STATUS_CALLS_KEY);
			// `providersConfigured` is the second way in (#379): a session with a
			// provider key can talk to a model without a ChatGPT sign-in. A session
			// that never signed in owns nothing until a key is saved through the
			// panel — the env-pinned row is a QA fixture for the disabled control,
			// so only the keys this session stored count there. Saving the first one
			// opens the readiness gate; removing the last one closes it again.
			const providersConfigured = providerStatus().filter((provider) => provider.id !== "openai-codex" && provider.signedIn).length;
			if (session === "pending") return { signedIn: false, pending: true, email: null, plan: null, accountId: null, expiresAt: null, providersConfigured: storedProviders.size };
			if (session === "out") return { signedIn: false, email: null, plan: null, accountId: null, expiresAt: null, providersConfigured: storedProviders.size };
			if (state === "no-entitlement") return { ...MOCK_ACCOUNT, plan: "Free", entitlements: { image: false }, providersConfigured };
			return { ...MOCK_ACCOUNT, entitlements: { image: true }, providersConfigured };
		},
		// The scripted OAuth completes in place: the session this transport answers
		// with is signed in from here on, exactly as the sidecar's is once the code
		// exchange lands.
		async signIn() {
			session = "in";
			return { ok: true, authorizeUrl: "https://auth.example.invalid/mock" };
		},
		async signOut() {
			session = "out";
			return { ok: true };
		},
		async models() {
			countMockCall(MOCK_MODEL_CALLS_KEY);
			const providers = providerStatus().map((provider) => {
				const listed = MOCK_PROVIDER_MODELS[provider.id] ?? [];
				// The live-only entry exists only while the ChatGPT session does.
				const catalogue = provider.id === "openai-codex" && session === "in" ? [...listed, MOCK_LIVE_ONLY_CODEX_MODEL] : listed;
				return { ...provider, models: catalogue.map((model) => ({ ...model, key: `${provider.id}/${model.id}`, input: ["text", "image"] })) };
			});
			return { providers, models: providers.flatMap((provider) => provider.models.map((model) => ({ ...model, id: model.key }))) };
		},
		async providers() { return providerStatus(); },
		async setProviderKey(id, key) {
			if (id === "openai-codex") throw Object.assign(new Error("Use ChatGPT sign-in for OpenAI Codex."), { status: 400 });
			if (typeof key !== "string" || key.trim().length < MOCK_PROVIDER_KEY_MIN) {
				// The refusal names the rule, never the value it refused.
				throw Object.assign(new Error("That key was refused: it is too short."), { status: 400 });
			}
			storedProviders.add(id);
			return { ok: true };
		},
		async removeProviderKey(id) { storedProviders.delete(id); return { ok: true }; },
		async stop() {
			liveTurn = null;
			return { ok: true };
		},
		/** The scripted steer route. A message only reaches a turn that is still
		 * running; anything else is the 409 the sidecar answers. QA reads the
		 * accepted message back out of storage, because a scripted transport has
		 * no request for it to inspect. */
		async steer(turnId, body) {
			if (studio) throw Object.assign(new Error("409 — Steering a Studio turn is not supported."), { status: 409, code: "STEER_UNSUPPORTED" });
			if (!liveTurn || turnId !== liveTurn) throw Object.assign(new Error("409 — This turn already ended."), { status: 409, code: "NO_ACTIVE_TURN" });
			try { globalThis.localStorage?.setItem("cozyclay.mock.agent.last-steer", JSON.stringify({ turnId, text: body?.text ?? null, attachments: body?.attachments?.length ?? 0 })); } catch { /* mock proof state is best effort */ }
			return { ok: true, queued: true };
		},
		async acceptJob() {
			return { ok: true };
		},
		async listSessions() {
			if (!studio) return [];
			const sessions = [];
			try {
				for (let index = 0; index < globalThis.localStorage.length; index += 1) {
					const key = globalThis.localStorage.key(index);
					if (!key?.startsWith("cozyclay.mock.agent.session.")) continue;
					const value = JSON.parse(globalThis.localStorage.getItem(key));
					if (value?.meta) sessions.push(value.meta);
				}
			} catch { /* mock history is best effort */ }
			return sessions.sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0)).slice(0, 50);
		},
		async loadSession(sessionId) {
			try {
				const value = JSON.parse(globalThis.localStorage.getItem(`cozyclay.mock.agent.session.${sessionId}`));
				if (value?.transcript) return value;
			} catch { /* fall through to the same restore path as a missing sidecar record */ }
			throw new Error("Mock session not found.");
		},
		// In mock mode the scripted transport also stands in for the host that
		// would accept an image, so ?agent=mock keeps showing the placed state.
		async applyImage({ requestId }) {
			return { ok: true, receiptId: `mock-${requestId}` };
		},
		async turn(request, onEvent, signal) {
			// A scripted turn is addressable while it runs: the composer needs an id
			// to steer it with, and QA needs to read back what the turn was asked for.
			const turnId = `mock-turn-${++turns}`;
			liveTurn = turnId;
			request?.onTurnId?.(turnId);
			try { globalThis.localStorage?.setItem("cozyclay.mock.agent.last-turn", JSON.stringify({ turnId, model: request?.model ?? null, effort: request?.effort ?? null, text: request?.text ?? null })); } catch { /* mock proof state is best effort */ }
			try { if (studio && request?.sessionId) globalThis.localStorage?.setItem("cozyclay.mock.agent.last-turn-session", request.sessionId); } catch { /* mock proof state is best effort */ }
			let transcript = [];
			const sessionKey = studio && request?.sessionId ? `cozyclay.mock.agent.session.${request.sessionId}` : null;
			if (sessionKey) {
				try { transcript = JSON.parse(globalThis.localStorage.getItem(sessionKey))?.transcript || []; } catch { transcript = []; }
				transcript.push({ kind: "user", text: request.text });
			}
			const emit = (event) => {
				if (sessionKey) {
					if (event.type === "text.delta") {
						const last = transcript.at(-1);
						if (last?.kind === "assistant") last.text += event.text; else transcript.push({ kind: "assistant", text: event.text });
					} else if (event.type === "tool.start") transcript.push({ kind: "tool", name: event.name, label: event.label, ok: true, elapsedMs: null, callId: event.callId });
					else if (event.type === "tool.done") { const tool = [...transcript].reverse().find((item) => item.kind === "tool" && item.callId === event.callId); if (tool) Object.assign(tool, { ok: event.ok, elapsedMs: event.elapsedMs }); }
					else if (event.type === "receipt") transcript.push({ kind: "receipt", receiptId: event.receipt?.receiptId, summary: event.receipt?.status === "applied" ? "Applied to the scene" : "Receipt" });
					try { globalThis.localStorage.setItem(sessionKey, JSON.stringify({ sessionId: request.sessionId, transcript, meta: { sessionId: request.sessionId, surface: "studio", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), sceneName: "Mock scene", firstText: transcript.find((item) => item.kind === "user")?.text || "" } })); } catch { /* mock history is best effort */ }
				}
				onEvent(event);
			};
			if (state === "rate-limited") {
				emit({ type: "text.delta", text: "Framing a wide two-shot from the current blocking." });
				emit({
					type: "quota",
					plan: "Plus",
					primary: { usedPercent: 100, windowMinutes: 300, resetAt: new Date(Date.now() + 42 * 60000).toISOString() },
					credits: { has: false },
				});
				emit({ type: "error", code: "rate_limit", message: ERROR_COPY.rate_limit, resetAt: new Date(Date.now() + 42 * 60000).toISOString() });
				emit({ type: "done" });
				liveTurn = null;
				return;
			}
			if (state === "error") {
				emit({ type: "text.delta", text: studio ? "Reading the scene first." : "Capturing the viewport first." });
				emit(studio
					? { type: "tool.start", callId: "call-1", name: "inspect_studio", label: "inspect studio", args: { scope: "selection" } }
					: { type: "tool.start", callId: "call-1", name: "capture_blocking_frame", label: "Capture blocking frame", args: { shot: "current" } });
				emit({ type: "tool.done", callId: "call-1", ok: false, elapsedMs: 812, error: studio ? "The scene is not ready" : "Viewport is not ready" });
				emit({ type: "error", code: "upstream", message: ERROR_COPY.upstream });
				emit({ type: "done" });
				liveTurn = null;
				return;
			}
			for (const step of studio ? MOCK_STUDIO_SCRIPT : MOCK_SCRIPT) {
				if (signal?.aborted) break;
				await wait(step.delay);
				if (signal?.aborted) break;
				emit(step.event);
			}
			// The model is done at the last frame, but the stream stays open while the
			// sidecar closes the turn out. Steering inside that window is exactly the
			// 409 the real route answers, so the scripted turn reproduces it.
			liveTurn = null;
			await wait(240);
			if (signal?.aborted) emit({ type: "done" });
		},
	};
}

export function createAgentTransport(options = {}) {
	const config = options.mockConfig !== undefined ? options.mockConfig : mockConfigFromSearch();
	// The surface is the host's own prop, never a guess from the URL: an
	// embedded Studio panel is a Studio panel wherever it is mounted.
	return trackAgentTurns(config ? createMockTransport({ surface: options.surface, ...config }) : createHttpTransport(options));
}

// One conversation: session identity, transcript, motion jobs, receipts and
// acknowledged image actions. It lives here rather than inside the component so
// the dock, an embedded Studio host and the test runner drive the SAME state
// machine over the SAME transport events. It is not a second analytics emitter:
// telemetry stays in the transport, unchanged.

/** What an acknowledged Stop actually established. An installation the runtime
 * already committed belongs to its receipt, not here; anything short of an
 * explicit not-applied answer stays unknown, because the alternative is telling
 * an author the scene is clean when nobody checked. */
function stopOutcome(result) {
	const outcome = result?.outcome;
	if (outcome?.status === "already_applied") return null;
	if (outcome && outcome.mutated === false) return { status: "not_applied", code: outcome.code ?? "CANCELLED", mutated: false };
	return { status: "unknown", code: outcome?.code ?? null, mutated: "unknown" };
}

/** A host claims a placement by calling preventDefault() on the dispatched
 * event, then answers with `cozyclay:agent-image-result`. An unclaimed action
 * fails immediately: nothing applied it. */
export function requestHostImageAction(request) {
	return new Promise((resolve) => {
		const onResult = (event) => {
			if (event.detail?.requestId !== request.requestId) return;
			globalThis.removeEventListener("cozyclay:agent-image-result", onResult);
			resolve({ ok: Boolean(event.detail.ok), error: event.detail.error, receiptId: event.detail.receiptId });
		};
		globalThis.addEventListener?.("cozyclay:agent-image-result", onResult);
		const claimed = globalThis.dispatchEvent
			? !globalThis.dispatchEvent(new CustomEvent("cozyclay:agent-image", { cancelable: true, detail: request }))
			: false;
		if (claimed) return;
		globalThis.removeEventListener?.("cozyclay:agent-image-result", onResult);
		resolve({ ok: false, error: "No editor accepted the image. Open the scene that should receive it." });
	});
}

export function createAgentChatStore({
	transport,
	surface = "workflow",
	buildContext = null,
	requestImageAction = null,
	onAuthLost = null,
	// A receipt names the targets it changed. The host is told once per receipt
	// so it can show the change where the author is looking — on the element
	// itself — instead of only as another card at the bottom of the chat.
	onReceipt = null,
	newId = createStudioSessionId,
	clock = () => Date.now(),
} = {}) {
	const studio = surface === "studio";
	const listeners = new Set();
	const seenReceipts = new Set();
	const settledActions = new Set();
	let controller = null;
	// What the running turn has actually produced, so a turn that ends with
	// nothing on screen can be reported as the failure it is.
	let activeTurn = null;
	// The id the SIDECAR knows the running turn by — the Studio envelope's
	// turnId, or the hex id the dock's transport mints. It is what the steer
	// route is keyed by, and only the transport can tell us which it is.
	let wireTurnId = null;
	// Supervisor note requests still waiting on the sidecar; a cleared or
	// replaced conversation abandons them.
	const supervisorRequests = new Set();
	// The running turn's action labels (its context's actionIndex), for the step list (agent-turn.js).
	let actionLabels = new Map();
	let state = {
		sessionId: newId(),
		turnId: null,
		draft: "",
		// Pictures the author pasted or dropped, waiting for the turn they belong
		// to. They live beside the draft because that is what they are: part of
		// the message being written, cleared by the same Send.
		pendingAttachments: [],
		items: [],
		streaming: false,
		quota: null, context: null,
		rateLimit: null,
		lastPrompt: "",
		turnStartedAt: null,
		lastTurn: null,
	};
	const set = (patch) => {
		state = { ...state, ...patch };
		for (const listener of [...listeners]) listener(state);
	};
	const setItems = (update) => set({ items: update(state.items) });
	const patchItem = (predicate, patch) => setItems((items) => items.map((item) => predicate(item) ? { ...item, ...patch } : item));
	const findJob = (jobId) => state.items.find((item) => item.kind === "job" && item.jobId === jobId);

	function applyJobEvent(event) {
		if (!event?.jobId || !STUDIO_VARIANTS.jobStates.includes(event.state)) return;
		const reported = typeof event.progress === "number" && Number.isFinite(event.progress)
			? Math.min(1, Math.max(0, event.progress))
			: null;
		setItems((items) => {
			const existing = items.find((item) => item.kind === "job" && item.jobId === event.jobId);
			const next = {
				kind: "job",
				id: existing?.id ?? `job:${event.jobId}`,
				jobId: event.jobId,
				commandId: event.commandId ?? existing?.commandId ?? null,
				state: event.state,
				phase: typeof event.phase === "string" ? event.phase : existing?.phase ?? null,
				progress: reported ?? existing?.progress ?? null,
				verification: existing?.verification ?? null,
				receiptId: existing?.receiptId ?? null,
				// A settled outcome survives later frames, exactly like a receipt: a
				// buffered event arriving after an acknowledged Stop must not quietly
				// erase the panel's "nothing was applied" claim.
				outcome: existing?.outcome ?? null,
				acceptance: event.state === "review_required" ? existing?.acceptance ?? { status: "required" } : existing?.acceptance ?? null,
			};
			return existing ? items.map((item) => item === existing ? next : item) : [...items, next];
		});
	}

	function applyReceiptEvent(raw) {
		let receipt;
		try {
			receipt = validateReceipt(raw);
		} catch (error) {
			// An unreadable receipt is never rendered as a success.
			setItems((items) => [...items, { kind: "failure", id: newId(), failure: { code: error?.code || "INVALID_RECEIPT", message: error?.message || "The host returned an unreadable receipt.", preserved: { authoredState: "unknown" }, recovery: { action: "inspect" } } }]);
			return;
		}
		if (receipt.ok === false) {
			const key = `failure:${receipt.commandId}:${receipt.code}`;
			if (seenReceipts.has(key)) return;
			seenReceipts.add(key);
			setItems((items) => [
				...items.map((item) => item.kind === "job" && item.commandId === receipt.commandId && !isTerminalJobState(item.state)
					? { ...item, state: "failed", phase: receipt.phase, acceptance: null }
					: item),
				{ kind: "failure", id: key, failure: receipt },
			]);
			return;
		}
		if (seenReceipts.has(receipt.receiptId)) return;
		seenReceipts.add(receipt.receiptId);
		setItems((items) => [
			...items.map((item) => item.kind === "job" && item.jobId === receipt.jobId
				? {
					...item,
					state: receipt.status === "installed" ? "installed" : item.state,
					verification: receipt.verification ?? null,
					receiptId: receipt.receiptId,
					acceptance: receipt.explicitUnverifiedAcceptance ? { status: "accepted" } : null,
				}
				: item),
			{ kind: "receipt", id: `receipt:${receipt.receiptId}`, receiptId: receipt.receiptId, receipt, summary: receiptSummary(receipt, studio ? advisory(() => buildContext?.() ?? null, null) : null) },
		]);
		// A host that throws (or has nowhere to put the highlight) cannot cost the
		// author the receipt they already earned.
		try { onReceipt?.(receipt); } catch { /* host presentation is advisory */ }
	}

	// One request per reviewable Studio turn, after its stream ended: the note
	// joins the transcript whenever it arrives, and nothing waits for it.
	function requestSupervisorNote(turnId) {
		if (typeof transport.supervisor !== "function") return;
		const request = new AbortController();
		supervisorRequests.add(request);
		Promise.resolve()
			.then(() => transport.supervisor(turnId, request.signal))
			.then((note) => {
				if (!note || request.signal.aborted) return;
				setItems((items) => [...items, { ...note, kind: "supervisor", id: `supervisor:${turnId}` }]);
			})
			.catch(() => { /* a missing note is no note */ })
			.finally(() => supervisorRequests.delete(request));
	}
	const abandonSupervisorNotes = () => { for (const request of supervisorRequests) request.abort(); supervisorRequests.clear(); };

	function applyEvent(event) {
		if (activeTurn && ["text.delta", "tool.start", "tool.done", "image", "job.state", "job.progress", "receipt", "error"].includes(event?.type)) activeTurn.produced = true;
		// The supervisor's own trigger, read from the same frames: an authored
		// result or a refusal makes the turn reviewable.
		if (activeTurn && ((event?.type === "tool.done" && (event.ok ? event.result?.authored === true : SUPERVISOR_REFUSAL.test(String(event.error ?? ""))))
			|| (event?.type === "receipt" && event.receipt?.authored === true))) activeTurn.reviewable = true;
		if (event?.type === "text.delta") {
			setItems((items) => {
				const last = items[items.length - 1];
				if (last?.kind === "assistant") return [...items.slice(0, -1), { ...last, text: last.text + event.text }];
				return [...items, { kind: "assistant", id: newId(), text: event.text }];
			});
			return;
		}
		// The turn's step checklist (bin/agent/plan-tool.mjs): one card under the prompt; the plan call itself is no step.
		if (isPlanFrame(event)) { setItems((items) => withPlanFrame(items, event, newId)); return; }
		if (event?.type === "tool.start") {
			setItems((items) => withToolStart(items, { kind: "tool", id: event.callId || newId(), callId: event.callId, name: event.name, label: event.label, args: event.args, status: "running", startedAt: clock(), ...stepFields(event.name, event.args, actionLabels) }));
			return;
		}
		// What the model does between calls and what a script runs inside one (bin/agent/turn-frames.mjs, script-tool.mjs).
		if (event?.type === "thinking.delta") { setItems((items) => withThinking(items, String(event.text ?? ""), clock(), newId)); return; }
		if (event?.type === "tool.compose") { setItems((items) => withCompose(items, event, clock(), newId, actionLabels)); return; }
		if (event?.type === "tool.progress") { patchItem((item) => item.kind === "tool" && item.callId === event.callId && item.status === "running", { progress: { index: event.index, name: event.name, label: actionLabels.get(event.action), action: event.action, status: event.status, summary: event.summary } }); return; }
		if (event?.type === "tool.done") {
			patchItem((item) => item.kind === "tool" && item.callId === event.callId, { status: event.ok ? "done" : "failed", elapsedMs: event.elapsedMs, result: event.result, error: event.error });
			// Synchronous Studio families (arrange_*, frame_shot, patch_elements,
			// undo_edit) hand their receipt back as the tool result rather than as a
			// `receipt` frame. The tool card already shows it; the host still needs
			// it to point at the rows it changed (#362).
			const result = event.result;
			if (event.ok && result && typeof result === "object" && result.ok === true && typeof result.receiptId === "string" && Array.isArray(result.affectedIds)) {
				try { onReceipt?.(result); } catch { /* host presentation is advisory */ }
			}
			return;
		}
		if (event?.type === "image") {
			setItems((items) => [...items, { kind: "image", id: event.imageId || newId(), imageId: event.imageId, dataUrl: event.dataUrl, width: event.width, height: event.height, prompt: event.prompt, placed: false, apply: null }]);
			return;
		}
		if (event?.type === "job.state" || event?.type === "job.progress") { applyJobEvent(event); return; }
		if (event?.type === "receipt") { applyReceiptEvent(event.receipt); return; }
		if (event?.type === "quota") { set({ quota: { plan: event.plan, usedPercent: event.primary?.usedPercent, windowMinutes: event.primary?.windowMinutes, resetAt: event.primary?.resetAt, credits: event.credits } }); return; }
		// The latest model request's prompt against the model's window (bin/agent/agent-runner.mjs countAttempt, agent-context-meter.js).
		if (event?.type === "context") { set({ context: { tokens: event.tokens, window: event.window ?? null } }); return; }
		if (event?.type !== "error") return;
		const failure = { code: event.code || "upstream", message: event.code === "unauthorized" ? keyRefusedMessage(event.message) : event.message || ERROR_COPY[event.code] || "The turn failed.", ...(Number.isFinite(event.status) ? { status: event.status } : {}) };
		if (activeTurn) activeTurn.failure = failure;
		if (event.code === "rate_limit") { set({ rateLimit: { resetAt: event.resetAt || null, message: event.message || ERROR_COPY.rate_limit } }); return; }
		if (event.code === "auth") { onAuthLost?.(); return; }
		setItems((items) => {
			// Only THIS turn's failed tool call can carry the failure. Attaching it to
			// an older card would hide the new failure inside finished history.
			const prompt = items.findLastIndex((item) => item.kind === "user");
			const position = items.findLastIndex((item, at) => at > prompt && item.kind === "tool" && item.status === "failed");
			if (position === -1) return [...items, { kind: "failure", id: newId(), failure: { ...failure, recovery: { action: failure.code === "unauthorized" ? "fix_key" : "retry", retryAllowed: true } } }];
			return items.map((item, at) => at === position ? { ...item, failure } : item);
		});
	}

	function settleImageAction(requestId, result, intent) {
		// One acknowledgement per request: a duplicate receipt cannot place an
		// image twice, and a late answer cannot flip a settled card.
		if (!requestId || settledActions.has(requestId)) return;
		settledActions.add(requestId);
		const ok = Boolean(result?.ok);
		const patch = { apply: { requestId, status: ok ? "settled" : "failed", error: ok ? null : result?.error || "The editor did not apply the image.", receiptId: result?.receiptId ?? null } };
		// Only an acknowledged action changes what the card claims happened.
		if (ok) patch.placed = intent === "place";
		patchItem((item) => item.kind === "image" && item.apply?.requestId === requestId, patch);
	}

	async function runImageAction(itemId, intent) {
		const item = state.items.find((entry) => entry.kind === "image" && entry.id === itemId);
		if (!item || item.apply?.status === "applying") return;
		if (intent === "place" ? item.placed : !item.placed) return;
		const requestId = newId();
		patchItem((entry) => entry.kind === "image" && entry.id === itemId, { apply: { requestId, status: "applying", error: null, receiptId: null, startedAt: clock() } });
		const request = { action: intent, requestId, imageId: item.imageId, dataUrl: item.dataUrl, width: item.width, height: item.height, prompt: item.prompt };
		try {
			const result = await (requestImageAction ?? requestHostImageAction)(request);
			settleImageAction(requestId, result, intent);
		} catch (error) {
			settleImageAction(requestId, { ok: false, error: String(error?.message || error) }, intent);
		}
	}

	const resetSession = () => {
		abandonSupervisorNotes();
		seenReceipts.clear();
		settledActions.clear();
		// Clearing the transcript also retires the server session: a cleared chat
		// the model still remembers is the divergence this replaces.
		set({ sessionId: newId(), turnId: null, items: [], pendingAttachments: [], rateLimit: null, context: null, lastPrompt: "", turnStartedAt: null, lastTurn: null });
	};
	const restore = (transcript, sessionId = state.sessionId) => {
		abandonSupervisorNotes(); seenReceipts.clear(); settledActions.clear();
		const restoredReceiptIds = new Set();
		// Each turn's plan card comes back under its prompt, settled by how the turn ended (agent-plan.js).
		const restored = restoredPlans((Array.isArray(transcript) ? transcript : []).flatMap((item) => {
			if (item?.kind === "user" || item?.kind === "assistant") {
				const attachments = Array.isArray(item.attachments) ? item.attachments.filter((entry) => typeof entry?.dataUrl === "string") : [];
				return [{ kind: item.kind, id: newId(), text: String(item.text ?? ""), ...(attachments.length ? { attachments } : {}) }];
			}
			if (item?.kind === "tool") return [{ kind: "tool", id: newId(), callId: newId(), name: item.name || "tool", label: item.label, ok: item.ok, elapsedMs: item.elapsedMs, status: item.ok === false ? "failed" : "done" }];
			if (item?.kind === "receipt") {
				if (item.receiptId && restoredReceiptIds.has(item.receiptId)) return [];
				if (item.receiptId) {
					restoredReceiptIds.add(item.receiptId);
					seenReceipts.add(item.receiptId);
				}
				return [{ kind: "receipt", id: `receipt:${item.receiptId || newId()}`, receiptId: item.receiptId, summary: item.summary || "Receipt", receipt: { status: "applied", warnings: [], verification: { status: "verified" } } }];
			}
			if (item?.kind === "failure") return [{ kind: "failure", id: newId(), failure: { code: item.code || "upstream", message: String(item.message || "The turn failed."), recovery: { action: "retry", retryAllowed: true } } }];
			return item?.kind === "plan" ? [{ kind: "plan", id: newId(), steps: item.steps }] : [];
		}));
		const lastPrompt = [...restored].reverse().find((item) => item.kind === "user")?.text || "";
		set({ sessionId, turnId: null, items: restored, rateLimit: null, context: null, lastPrompt, turnStartedAt: null, lastTurn: null, streaming: false });
		return restored;
	};
	return {
		getState: () => state,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		setDraft: (draft) => set({ draft: String(draft ?? "") }),
		/** A reply the main agent made on its own (task mode: a task ended while nobody was talking to it). */
		note: (text) => { if (String(text ?? "").trim()) set({ items: [...state.items, { kind: "assistant", id: newId(), text: String(text) }] }); },
		/** Pictures pasted or dropped into the composer. Returns what was taken and
		 * what had to be refused, so the composer can say so instead of a picture
		 * vanishing on its way in. */
		addAttachments(list) {
			const incoming = (Array.isArray(list) ? list : [])
				.filter((entry) => typeof entry?.dataUrl === "string" && entry.dataUrl.startsWith("data:image/"))
				.map((entry) => ({ id: newId(), dataUrl: entry.dataUrl, ...(entry.name ? { name: String(entry.name).slice(0, 120) } : {}) }));
			const { attachments, rejected } = appendAttachments(state.pendingAttachments, incoming, ATTACHMENT_MAX_COUNT);
			const added = attachments.length - state.pendingAttachments.length;
			set({ pendingAttachments: attachments });
			return { added, rejected };
		},
		removeAttachment: (id) => set({ pendingAttachments: state.pendingAttachments.filter((entry) => entry.id !== id) }),
		clearAttachments: () => set({ pendingAttachments: [] }),
		async send(text, options = {}) {
			const trimmed = String(text ?? "").trim();
			if (!trimmed || state.streaming) return;
			const turnId = newId();
			// Context is read at Send, from the host's current authoritative refs.
			const context = studio ? buildContext?.() ?? null : null;
			actionLabels = actionLabelsOf(context);
			if (studio && !context) {
				applyEvent({ type: "error", code: "upstream", message: "The editor is not ready to describe the scene yet." });
				return;
			}
			const startedAt = clock();
			const turn = { produced: false, failure: null, reviewable: false };
			activeTurn = turn;
			// What the author attached to THIS message: an explicit list wins, the
			// composer's pending pictures otherwise. Either way the composer is
			// emptied with the draft, so the next turn cannot re-send them.
			const attachments = (Array.isArray(options.attachments) ? options.attachments : state.pendingAttachments)
				.slice(0, ATTACHMENT_MAX_COUNT)
				.map(({ dataUrl, name }) => ({ dataUrl, ...(name ? { name } : {}) }));
			set({
				lastPrompt: trimmed,
				rateLimit: null,
				turnId,
				streaming: true,
				draft: "",
				pendingAttachments: [],
				turnStartedAt: startedAt,
				lastTurn: null,
				items: [...state.items, { kind: "user", id: newId(), text: trimmed, attachFrame: Boolean(options.attachFrame), attachments }],
			});
			controller = new AbortController();
			const signal = controller.signal;
			try {
				await transport.turn({
					onTurnId: (id) => { wireTurnId = id; },
					...(studio ? { surface: "studio", turnId, context } : {}),
					sessionId: state.sessionId,
					text: trimmed,
					...(attachments.length ? { attachments } : {}),
					attachFrame: Boolean(options.attachFrame),
					model: options.model,
					effort: options.effort ?? undefined,
					...(typeof options.supervisor === "boolean" ? { supervisor: options.supervisor } : {}), ...(options.tasks ? { tasks: true } : {}),
				}, (event) => { sculptSketchFrame(event); applyEvent(event); }, signal);
			} catch (error) {
				if (!signal.aborted) applyEvent({ type: "error", code: "upstream", message: String(error?.message || error) });
			} finally {
				if (controller?.signal === signal) controller = null;
				// A turn the author already replaced owns none of this state. Its live sculpt sketch
				// (the ghost clay of a call still being written) ends with it, whatever ended it.
				if (activeTurn === turn) {
					wireTurnId = null; clearSculptSketch();
					// Ending with nothing on screen is a failure, not a result.
					if (!turn.produced && !turn.failure && !signal.aborted) {
						turn.failure = { code: "no_output", message: "The turn ended without a response.", recovery: { action: "retry", retryAllowed: true } };
						setItems((items) => [...items, { kind: "failure", id: newId(), failure: turn.failure }]);
					}
					const endedAt = clock();
					activeTurn = null;
					// The end state stays in the transcript with the turn's steps (agent-turn.js withTurnEnd).
					const lastTurn = { status: signal.aborted ? "stopped" : turn.failure ? "failed" : "done", endedAt, durationMs: endedAt - startedAt, failure: turn.failure };
					set({ streaming: false, turnStartedAt: null, lastTurn, items: withPlanEnd(withTurnEnd(state.items, lastTurn, newId), lastTurn.status) });
					if (studio && turn.reviewable && options.supervisor === true && !signal.aborted) requestSupervisorNote(turnId);
				}
			}
		},
		/** Steering the turn that is ALREADY running (#379). `send()` deliberately
		 * returns early while streaming — a second turn would authorize a second
		 * generation — so the composer's text goes to the running turn instead, as
		 * a message the model sees before its next step. A refused steer leaves the
		 * draft exactly where it is and reports the code it was refused with: the
		 * author's words are never eaten by a turn that ended a moment earlier. */
		async steer(text, options = {}) {
			const trimmed = String(text ?? "").trim();
			if (!trimmed) return { ok: false, code: "EMPTY", message: "" };
			if (!state.streaming || !wireTurnId || typeof transport.steer !== "function") {
				return { ok: false, code: "NO_ACTIVE_TURN", message: STEER_ERROR_COPY.NO_ACTIVE_TURN };
			}
			const attachments = (Array.isArray(options.attachments) ? options.attachments : state.pendingAttachments)
				.slice(0, ATTACHMENT_MAX_COUNT)
				.map(({ dataUrl, name }) => ({ dataUrl, ...(name ? { name } : {}) }));
			try {
				await transport.steer(wireTurnId, { text: trimmed, ...(attachments.length ? { attachments } : {}) });
			} catch (error) {
				const code = typeof error?.code === "string" ? error.code : "upstream";
				return { ok: false, code, message: STEER_ERROR_COPY[code] || String(error?.message || error) };
			}
			// An accepted steer is part of the conversation: it is shown in the
			// transcript like any other thing the author said, and it empties the
			// composer like any other send.
			set({
				draft: "",
				pendingAttachments: [],
				items: [...state.items, { kind: "user", id: newId(), text: trimmed, steered: true, attachments }],
			});
			return { ok: true, code: null, message: "" };
		},
		stop() {
			const running = [...state.items].reverse().find((item) => item.kind === "job" && !isTerminalJobState(item.state));
			controller?.abort("agent-stop");
			controller = null;
			const target = studio
				? { sessionId: state.sessionId, turnId: state.turnId, ...(running ? { jobId: running.jobId } : {}) }
				: state.sessionId;
			Promise.resolve(transport.stop?.(target))
				.then((result) => {
					// Only an acknowledged Stop marks the job stopped; an aborted stream
					// on its own proves nothing about the runtime. Nor does a 200: the
					// host answers every owned Stop, so "scene unchanged" may only be
					// claimed when the runtime actually reported it was not applied.
					if (!running) return;
					const outcome = stopOutcome(result);
					if (!outcome) return;
					patchItem((item) => item.kind === "job" && item.jobId === running.jobId && !isTerminalJobState(item.state), {
						state: outcome.status === "not_applied" ? "cancelled" : "reconciling",
						phase: null,
						outcome,
						acceptance: null,
					});
					patchItem((item) => item.kind === "tool" && item.status === "running", {
						status: "cancelled",
						result: outcome,
						elapsedMs: null,
					});
				})
				.catch(() => {});
			// Stop is an answer too: the line says "Stopped" now, not when the aborted
			// request finally settles.
			if (!state.streaming) { set({ streaming: false }); return; }
			const endedAt = clock();
			set({
				streaming: false,
				turnStartedAt: null,
				lastTurn: { status: "stopped", endedAt, durationMs: endedAt - (state.turnStartedAt ?? endedAt), failure: null },
			});
		},
		async acceptJob(jobId) {
			const job = findJob(jobId);
			if (!job || job.acceptance?.status !== "required") return;
			patchItem((item) => item.kind === "job" && item.jobId === jobId, { acceptance: { status: "accepting" } });
			try {
				const result = await transport.acceptJob?.({ jobId, sessionId: state.sessionId, turnId: state.turnId });
				if (result?.receipt) applyReceiptEvent(result.receipt);
				else patchItem((item) => item.kind === "job" && item.jobId === jobId, { acceptance: { status: "required", error: "The host did not acknowledge the acceptance." } });
			} catch (error) {
				patchItem((item) => item.kind === "job" && item.jobId === jobId, { acceptance: { status: "required", error: String(error?.message || error) } });
			}
		},
		applyImage: (itemId) => runImageAction(itemId, "place"),
		undoImage: (itemId) => runImageAction(itemId, "remove"),
		acknowledgeImageAction: ({ requestId, ok, error, receiptId }) => {
			const item = state.items.find((entry) => entry.kind === "image" && entry.apply?.requestId === requestId);
			settleImageAction(requestId, { ok, error, receiptId }, item?.placed ? "remove" : "place");
		},
		clearRateLimit: () => set({ rateLimit: null }),
		clearContext: resetSession,
		newSession: resetSession,
		restore,
	};
}
