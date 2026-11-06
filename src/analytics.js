import { appVersion } from "./app-version.js";
import { FIRST_EDIT_KINDS, FIRST_EDIT_VERSION } from "./semantic-edit.js";
import { ERROR_TYPE_VALUES, EXPORT_FAILURE_CODES, UI_LOCALE_VALUES, exportPropAllowed, uiLocale } from "./analytics-values.js";
import { bump as bumpFriction, observeLongTasks, snapshot as frictionSnapshot } from "./analytics-friction.js";
import { STRICT_EVENT_KEYS, strictPropValidator, turnOriginAllowed } from "./analytics-strict.js";
export const MCP_TOOL_CATEGORIES = Object.freeze(["read", "camera", "scene_write", "prompt_authoring", "frame_capture", "motion_generate", "motion_apply", "project_io", "other"]);
// The live MCP tools (mcp/tool-handlers.mjs liveWorkspaceTools) plus "other".
// Any other name is sent as "other"; test/verify-analytics.mjs holds the two lists equal.
export const MCP_TOOL_NAMES = Object.freeze([
	"describe_scene", "describe_shot", "render_prompt", "mark_camera_move", "describe_camera_move", "save_project", "set_camera",
	"frame_shot", "add_character", "place_character", "remove_character", "focus_character", "place_object", "import_mesh",
	"sculpt_object", "compare_sculpt", "group_objects", "update_object", "remove_object", "apply_batch", "add_scene",
	"switch_scene", "open_project", "capture_frame", "studio_commands", "studio_run", "other",
]);
export const AGENT_TOOL_CATEGORIES = Object.freeze([
	"workflow_read",
	"workflow_write",
	"workflow_run",
	"frame_capture",
	"image_generate",
	"scene_write",
	"other",
]);

export const EXECUTION_TELEMETRY_EVENTS = Object.freeze([
	"workflow:run_requested",
	"workflow:run_succeeded",
	"workflow:run_failed",
	"workflow:run_cancelled",
	"workflow:result_applied",
	"agent:turn_requested",
	"agent:tool_executed",
	"agent:turn_succeeded",
	"agent:turn_failed",
	"agent:turn_cancelled",
	"agent:result_applied",
	"mcp:tool_requested",
	"mcp:tool_executed",
	"mcp:result_applied",
]);

export const EXECUTION_TELEMETRY_PROPERTY_KEYS = Object.freeze({
	"workflow:run_requested": ["surface", "run_id", "node_count_bucket"],
	"workflow:run_succeeded": ["run_id", "duration_bucket"],
	"workflow:run_failed": ["run_id", "duration_bucket", "failure_code"],
	"workflow:run_cancelled": ["run_id", "duration_bucket", "failure_code"],
	"workflow:result_applied": ["run_id"],
	"agent:turn_requested": ["surface", "turn_id"],
	"agent:tool_executed": ["turn_id", "tool_category", "outcome", "duration_bucket"],
	"agent:turn_succeeded": ["turn_id", "duration_bucket"],
	"agent:turn_failed": ["turn_id", "duration_bucket", "failure_code", "provider", "endpoint"],
	"agent:turn_cancelled": ["turn_id", "duration_bucket", "failure_code"],
	"agent:result_applied": ["turn_id"],
	"mcp:tool_requested": ["tool_category", "tool_name", "request_id"],
	"mcp:tool_executed": ["tool_category", "tool_name", "outcome", "duration_bucket", "request_id"],
	"mcp:result_applied": ["request_id"],
});

export const EXECUTION_TELEMETRY_VALUES = Object.freeze({
	surface: new Set(["studio", "workflow"]),
	node_count_bucket: new Set(["0", "1-3", "4-10", "gte11"]),
	duration_bucket: new Set(["lt1s", "1-3s", "3-10s", "10-30s", "gte30s"]),
	tool_category: new Set([...MCP_TOOL_CATEGORIES, ...AGENT_TOOL_CATEGORIES]),
	tool_name: new Set(MCP_TOOL_NAMES),
	outcome: new Set(["succeeded", "failed", "uncertain", "cancelled"]),
});

// Closed values for the storyboard and capsule-figure events. Counts only: no
// caption, name, prompt or id ever rides along.
const PREVIS_PROPERTY_VALUES = Object.freeze({
	source: new Set(["agent", "manual"]),
	outcome: new Set(["ok", "error"]),
	surface: new Set(["assets", "agent", "mcp"]),
});

const OPT_OUT_KEY = "cozyclay.analyticsOptOut";
const INTERNAL_QA_KEY = "cozyclay.internalQa";
const ACTIVATION_KEY = "cozyclay.analyticsActivation";
const USE_CASE_ASKED_KEY = "cozyclay.useCaseAsked";

// Authored edits are reported as per-session counts of five closed groups,
// never as individual edits: the kind vocabulary is FIRST_EDIT_KINDS.
export const EDIT_GROUPS = Object.freeze({
	pose: Object.freeze(["pose_edit"]),
	camera: Object.freeze(["camera_key_record", "rail_edit"]),
	object: Object.freeze(["object_insert", "cutout_insert", "object_transform"]),
	shot: Object.freeze(["shot_add", "shot_edit"]),
	prompt: Object.freeze(["prompt_block_add", "prompt_block_edit"]),
});
export const EDIT_BUCKET_KEYS = Object.freeze(Object.keys(EDIT_GROUPS).map((group) => `${group}_edit_bucket`));
export const USE_CASE_VALUES = Object.freeze(["animation", "film", "game", "ad_mv", "personal", "other", "skip"]);
export const TEAM_VALUES = Object.freeze(["team", "solo", "skip"]);
// Mirror PREVIS_MODES and CAST_STYLES in project.js; kept local so analytics stays import-light.
export const PREVIS_MODE_VALUES = new Set(["storyboard", "animation"]), CAST_STYLE_VALUES = new Set(["rig", "capsule", "hybrid"]);
export const UPDATE_STATUS_VALUES = Object.freeze(["latest", "outdated", "unknown"]);
const DEFAULT_ALLOWED_ORIGINS = Object.freeze([
	"https://cozyclay.org",
	"https://www.cozyclay.org",
]);
const EXPORT_ATTEMPT_KEYS = ["attempt_id", "export_kind", "format", "surface", "is_retry", "retry_of", "objects"];
const EVENT_PROPERTIES = Object.freeze({
	"install:first_launch": ["heard_from"],
	"app:session_started": [],
	"app:session_ended": ["duration_bucket", "action_count_bucket", "scenes_touched", ...EDIT_BUCKET_KEYS, "session_id"],
	...STRICT_EVENT_KEYS,
	"app:error": ["error_kind", "error_type", "error_source", "error_file", "error_line", "error_col", "locale"],
	"device:profile": ["gpu_vendor", "gpu_class", "webgl", "cpu_bucket", "memory_bucket", "frame_rate_bucket"],
	"survey:use_case": ["use_case", "team"],
	"feature:used": ["name"],
	"hosted:composer_viewed": [],
	"hosted:login_started": [],
	"hosted:ticket_created": [],
	"hosted:result_opened": [],
	"hosted:opened_in_studio": [],
	"scene:created": ["scene_source", "previs_mode", "cast_style"],
	"storyboard:panel_created": ["source"],
	"storyboard:panel_stylized": ["outcome"],
	"cast:proxy_added": ["surface"],
	"scene:loaded": ["scene_source"],
	"project:saved": ["object_count_bucket", "shot_count_bucket"],
	"project:opened": ["age_bucket"],
	"craft:first_action": ["action_kind"],
	"craft:first_edit": ["edit_kind", "definition_version"],
	"export:blocking_frame_succeeded": ["format"],
	"export:video_succeeded": ["format"],
	"export:keyframe_pack": ["entries", "source"],
	"export:attempt_started": EXPORT_ATTEMPT_KEYS,
	"export:attempt_succeeded": [...EXPORT_ATTEMPT_KEYS, "duration_bucket"],
	"export:attempt_failed": [...EXPORT_ATTEMPT_KEYS, "duration_bucket", "failure_code", "stage", "progress"],
	"export:attempt_cancelled": [...EXPORT_ATTEMPT_KEYS, "duration_bucket", "failure_code", "stage", "progress"],
	"export:saved": ["method", "reason"],
	"playground:opened": [],
	"playground:first_action": ["action_kind"],
	"playground:first_edit": ["edit_kind", "definition_version"],
	"activation:completed": ["activation_path"],
	"sculpt_run": ["outcome", "rounds", "final_iou", "duration_ms", "had_target"],
	...EXECUTION_TELEMETRY_PROPERTY_KEYS,
});
const FEATURE_NAMES = new Set([
	"pose_edit", "pose_save", "camera_fly", "orbit", "dolly_rail", "crane_graph", "timeline_scrub",
	"export_frame", "export_video",
	"export_depth_video", "export_keyframe_pack", "export_render_pass", "export_storyboard",
	"auto_color",
]);
// `site` and `playground` arrive through `npx cozyclay --via <source>` from the
// landing page's copy commands; the others are the first-launch prompt answers.
export const HEARD_FROM_SOURCES = Object.freeze(["x", "hn", "reddit", "github", "friend", "other", "site", "playground"]);
const HEARD_FROM_VALUES = new Set(HEARD_FROM_SOURCES);
const DENIED_PROPERTY_KEYS = new Set(["prompt", "text", "url", "path", "file"]);
// Sculpt mode (#739): one sculpt_run per finished run. Numbers only: no
// reference image, recipe, part name or sculpt id ever rides along.
export const SCULPT_RUN_OUTCOMES = Object.freeze(["done", "cancelled", "failed"]);
const SCULPT_RUN_MAX_ROUNDS = 10;
const SCULPT_RUN_MAX_DURATION_MS = 86_400_000;
const EXECUTION_FAILURE_CODES = Object.freeze({
	workflow: new Set(["aborted", "capture_failed", "generation_failed", "unknown"]),
	agent: new Set(["aborted", "auth", "rate_limited", "tool_failed", "upstream", "network", "unknown", "key_refused", "stale_scene", "capability_missing", "busy", "invalid_request"]),
});
// Only a type label and a same-origin script location cross the boundary; the
// error message, stack text, URLs and anything a user typed never do.
const ERROR_PROPERTY_VALUES = Object.freeze({
	error_kind: new Set(["error", "unhandled_rejection"]),
	error_type: ERROR_TYPE_VALUES,
	error_source: new Set(["app", "extension", "external", "unknown"]), locale: UI_LOCALE_VALUES,
});
const ERROR_FILE_PATTERN = /^[A-Za-z0-9_.-]{1,80}\.(?:m?js|jsx|ts|tsx)$/;
const DEVICE_PROPERTY_VALUES = Object.freeze({
	gpu_vendor: new Set(["nvidia", "amd", "intel", "apple", "qualcomm", "arm", "software", "other", "unknown"]),
	gpu_class: new Set(["discrete", "integrated", "software", "unknown"]),
	webgl: new Set(["webgl2", "webgl1", "none"]),
	cpu_bucket: new Set(["1-4", "5-8", "9-16", "gte17", "unknown"]),
	memory_bucket: new Set(["lt4", "4-7", "gte8", "unknown"]),
	frame_rate_bucket: new Set(["lt20", "20-40", "40-55", "gte55", "unknown"]),
});

let posthog = null;
let initialized = false;
let enabled = false;
let optOutPending = false;
let initPromise = null;
let activationFired = false;
let disabledLogged = false;
let sessionStartedAt = 0;
let sessionActionCount = 0;
let sessionScenesTouched = 0;
let sessionEnded = false;
let sessionEndListenersInstalled = false;
const featureNamesSeen = new Set();
const EDIT_GROUP_BY_KIND = new Map(Object.entries(EDIT_GROUPS).flatMap(([group, kinds]) => kinds.map((kind) => [kind, group])));
// A bone drag or gizmo move reaches the semantic boundary many times; edits of
// one group closer together than this count as one gesture.
const EDIT_GESTURE_GAP_MS = 1000;
const sessionEditCounts = Object.fromEntries(Object.keys(EDIT_GROUPS).map((group) => [group, 0]));
let lastEditGroup = null;
let lastEditAt = -Infinity;
const ERROR_SIGNATURE_LIMIT = 10;
const errorSignaturesSeen = new Set();
let errorListenersInstalled = false;
let deviceProfileStarted = false;
// Passive signals describe the session; they are not user actions and never
// move action_count_bucket.
const PASSIVE_EVENTS = new Set([
	"app:session_started", "app:session_ended", "install:first_launch", ...Object.keys(STRICT_EVENT_KEYS),
	"app:error", "device:profile", "app:render_crash", "app:gl_lost",
]);

function storage() {
	try {
		return globalThis.localStorage ?? null;
	} catch {
		return null;
	}
}

function readStorage(key) {
	try {
		return storage()?.getItem(key) ?? null;
	} catch {
		return null;
	}
}

function writeStorage(key, value) {
	try {
		storage()?.setItem(key, value);
	} catch {
		// Analytics persistence is best effort and must never affect the app.
	}
}

export function normalizeOrigin(value) {
	if (typeof value !== "string") return "";
	return value.trim().toLowerCase().replace(/[/.]+$/g, "");
}

export function parseAllowlist(value) {
	if (value === undefined) return [...DEFAULT_ALLOWED_ORIGINS];
	return value
		.split(",")
		.map(normalizeOrigin)
		.filter(Boolean);
}

export function isOriginAllowed(origin, allowlist) {
	const normalizedOrigin = normalizeOrigin(origin);
	return Array.isArray(allowlist)
		&& allowlist.some((allowed) => normalizedOrigin === normalizeOrigin(allowed));
}

const isSafePropertyValue = (value) => {
	if (typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	return typeof value === "string" && value.length <= 32 && !/\s/.test(value);
};

export function sanitizeProps(event, props) {
	const allowedKeys = EVENT_PROPERTIES[event] ?? [];
	if (!props || typeof props !== "object" || Array.isArray(props)) return {};
	const sanitized = {}, strict = strictPropValidator(event);
	for (const key of allowedKeys) {
		if (DENIED_PROPERTY_KEYS.has(key) || !Object.hasOwn(props, key)) continue;
		if (event === "feature:used" && (key !== "name" || !FEATURE_NAMES.has(props[key]))) continue;
		if (event === "install:first_launch" && (key !== "heard_from" || !HEARD_FROM_VALUES.has(props[key]))) continue;
		if ((event.startsWith("export:attempt_") || event === "export:saved") && !exportPropAllowed(key, props[key])) continue;
		if (strict) { if (strict(key, props[key])) sanitized[key] = props[key]; continue; }
		if (event === "export:keyframe_pack") {
			if (key === "source" && props[key] !== "workflow") continue;
			if (key === "entries" && (!Number.isFinite(props[key]) || props[key] < 0)) continue;
		}
		if (event === "craft:first_edit" || event === "playground:first_edit") {
			if (key === "edit_kind" && !FIRST_EDIT_KINDS.includes(props[key])) continue;
			if (key === "definition_version" && props[key] !== FIRST_EDIT_VERSION) continue;
		}
		if (event.startsWith("workflow:") || event.startsWith("agent:") || event.startsWith("mcp:")) {
			if (key === "run_id" || key === "turn_id" || key === "request_id") {
				if (typeof props[key] !== "string" || !/^[a-f0-9]{32}$/.test(props[key])) continue;
			} else if (key === "surface") {
				if (!EXECUTION_TELEMETRY_VALUES.surface.has(props[key]) || (event.startsWith("workflow:") && props[key] !== "workflow")) continue;
			}
			else if (key === "node_count_bucket" && !EXECUTION_TELEMETRY_VALUES.node_count_bucket.has(props[key])) continue;
			else if (key === "duration_bucket" && !EXECUTION_TELEMETRY_VALUES.duration_bucket.has(props[key])) continue;
			else if (key === "tool_category") {
				const categories = event.startsWith("agent:") ? AGENT_TOOL_CATEGORIES : MCP_TOOL_CATEGORIES;
				if (!categories.includes(props[key])) continue;
			} else if (key === "tool_name") {
				if (!event.startsWith("mcp:") || !EXECUTION_TELEMETRY_VALUES.tool_name.has(props[key])) continue;
			} else if (key === "outcome") {
				const outcomes = event === "mcp:tool_executed" ? ["succeeded", "failed", "uncertain", "cancelled"] : ["succeeded", "failed", "cancelled"];
				if (!outcomes.includes(props[key])) continue;
			} else if (key === "failure_code" && !EXECUTION_FAILURE_CODES[event.startsWith("agent:") ? "agent" : "workflow"].has(props[key])) continue;
			else if ((key === "provider" || key === "endpoint") && !turnOriginAllowed(key, props[key])) continue;
		}
		if (event === "app:error") {
			if (key === "error_file") {
				if (typeof props[key] === "string" && ERROR_FILE_PATTERN.test(props[key])) sanitized[key] = props[key];
				continue;
			}
			if (key === "error_line" || key === "error_col") {
				if (Number.isInteger(props[key]) && props[key] >= 0 && props[key] <= 10_000_000) sanitized[key] = props[key];
				continue;
			}
			if (!ERROR_PROPERTY_VALUES[key]?.has(props[key])) continue;
		}
		if (event === "device:profile" && !DEVICE_PROPERTY_VALUES[key]?.has(props[key])) continue;
		if (event === "sculpt_run") {
			const value = props[key];
			if (key === "outcome" && SCULPT_RUN_OUTCOMES.includes(value)) sanitized[key] = value;
			else if (key === "rounds" && Number.isInteger(value) && value >= 0 && value <= SCULPT_RUN_MAX_ROUNDS) sanitized[key] = value;
			else if (key === "final_iou" && typeof value === "number" && value >= 0 && value <= 1) sanitized[key] = Math.round(value * 100) / 100;
			else if (key === "duration_ms" && typeof value === "number" && value >= 0 && value <= SCULPT_RUN_MAX_DURATION_MS) sanitized[key] = Math.round(value);
			else if (key === "had_target" && typeof value === "boolean") sanitized[key] = value;
			continue;
		}
		if ((key === "previs_mode" && !PREVIS_MODE_VALUES.has(props[key])) || (key === "cast_style" && !CAST_STYLE_VALUES.has(props[key]))) continue;
		if ((event.startsWith("storyboard:") || event.startsWith("cast:")) && !PREVIS_PROPERTY_VALUES[key]?.has(props[key])) continue;
		if (event === "survey:use_case") {
			if (key === "use_case" && !USE_CASE_VALUES.includes(props[key])) continue;
			if (key === "team" && !TEAM_VALUES.includes(props[key])) continue;
		}
		if (isSafePropertyValue(props[key])) sanitized[key] = props[key];
	}
	return sanitized;
}

export const FEATURE_USAGE_NAMES = Object.freeze([...FEATURE_NAMES]);

export function bucketCount(value) {
	const count = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
	if (count === 0) return "0";
	if (count <= 3) return "1-3";
	if (count <= 10) return "4-10";
	return "gte11";
}

export function bucketSessionDuration(ms) {
	if (!Number.isFinite(ms) || ms < 60_000) return "lt1m";
	if (ms < 5 * 60_000) return "1-5m";
	if (ms < 15 * 60_000) return "5-15m";
	if (ms < 30 * 60_000) return "15-30m";
	return "gte30m";
}

export function bucketProjectAge(ms) {
	if (!Number.isFinite(ms) || ms < 0 || ms < 60 * 60_000) return "lt1h";
	if (ms < 24 * 60 * 60_000) return "1-24h";
	if (ms < 7 * 24 * 60 * 60_000) return "1-7d";
	if (ms < 30 * 24 * 60 * 60_000) return "7-30d";
	return "gte30d";
}

function detectOs() {
	const platform = String(globalThis.navigator?.userAgentData?.platform || globalThis.navigator?.platform || "").toLowerCase();
	if (platform.includes("mac")) return "macos";
	if (platform.includes("win")) return "windows";
	if (platform.includes("linux")) return "linux";
	if (platform.includes("android")) return "android";
	if (platform.includes("iphone") || platform.includes("ipad") || platform.includes("ios")) return "ios";
	return "unknown";
}

export function bucketMs(ms) {
	if (!Number.isFinite(ms) || ms < 1000) return "lt1s";
	if (ms < 3000) return "1-3s";
	if (ms < 10000) return "3-10s";
	if (ms < 30000) return "10-30s";
	return "gte30s";
}

export function bucketCpu(cores) {
	if (!Number.isFinite(cores) || cores <= 0) return "unknown";
	if (cores <= 4) return "1-4";
	if (cores <= 8) return "5-8";
	if (cores <= 16) return "9-16";
	return "gte17";
}

/** navigator.deviceMemory is Chromium-only and already rounded (max 8). */
export function bucketMemory(gigabytes) {
	if (!Number.isFinite(gigabytes) || gigabytes <= 0) return "unknown";
	if (gigabytes < 4) return "lt4";
	if (gigabytes < 8) return "4-7";
	return "gte8";
}

export function bucketFrameRate(fps) {
	if (!Number.isFinite(fps) || fps <= 0) return "unknown";
	if (fps < 20) return "lt20";
	if (fps < 40) return "20-40";
	if (fps < 55) return "40-55";
	return "gte55";
}

/**
 * Reduce a WebGL renderer string to a vendor and a class. The raw string (driver
 * versions, exact model) is a fingerprint and never leaves the browser.
 */
export function classifyGpu(renderer) {
	const text = String(renderer ?? "").toLowerCase();
	if (!text.trim()) return { gpu_vendor: "unknown", gpu_class: "unknown" };
	if (/swiftshader|llvmpipe|softpipe|software|basic render driver/.test(text)) return { gpu_vendor: "software", gpu_class: "software" };
	if (/nvidia|geforce|quadro|\brtx\b|\bgtx\b|tesla/.test(text)) return { gpu_vendor: "nvidia", gpu_class: "discrete" };
	if (/\bamd\b|radeon|\bati\b/.test(text)) {
		const integrated = /radeon\(tm\) graphics|radeon graphics|vega \d+ graphics|\b(?:610|660|680|740|760|780|880|890)m\b/.test(text);
		return { gpu_vendor: "amd", gpu_class: integrated ? "integrated" : "discrete" };
	}
	if (/intel|iris|uhd graphics|hd graphics/.test(text)) {
		return { gpu_vendor: "intel", gpu_class: /arc(?:\(tm\))? [ab]\d{3}/.test(text) ? "discrete" : "integrated" };
	}
	if (/apple|\bm[1-9](?: pro| max| ultra)?\b/.test(text)) return { gpu_vendor: "apple", gpu_class: "integrated" };
	if (/adreno|qualcomm/.test(text)) return { gpu_vendor: "qualcomm", gpu_class: "integrated" };
	if (/\bmali\b|\barm\b|powervr/.test(text)) return { gpu_vendor: "arm", gpu_class: "integrated" };
	return { gpu_vendor: "other", gpu_class: "unknown" };
}

const STACK_LOCATION = /((?:https?|chrome-extension|moz-extension|safari-extension|safari-web-extension):\/\/[^\s()]+?):(\d+):(\d+)/g;

function errorSource(url, origin) {
	if (typeof url !== "string" || !url) return "unknown";
	if (/^(?:chrome|moz|safari|safari-web)-extension:/.test(url)) return "extension";
	try {
		return origin && new URL(url).origin === origin ? "app" : "external";
	} catch {
		return "unknown";
	}
}

function scriptBasename(url) {
	try {
		const name = new URL(url).pathname.split("/").pop() ?? "";
		return ERROR_FILE_PATTERN.test(name) ? name : null;
	} catch {
		return null;
	}
}

function errorType(error) {
	try {
		if (error === null || (typeof error !== "object" && typeof error !== "function")) return "non_error";
		const name = typeof error.name === "string" ? error.name : "";
		if (name && name !== "non_error" && name !== "other" && ERROR_PROPERTY_VALUES.error_type.has(name)) return name;
		if (typeof DOMException !== "undefined" && error instanceof DOMException) return "DOMException";
		// A custom subclass name is authored text; keep only that it was an Error.
		return error instanceof Error ? "other" : "non_error";
	} catch {
		return "other";
	}
}

/**
 * The closed app:error payload for one thrown value: a type label, whether the
 * failing script was ours, and for our own bundle only its file name plus a
 * line and column (enough to map through the release's build). Messages, stack
 * text, URLs, query strings and paths stay local.
 */
export function describeError({ error, filename, lineno, colno, kind = "error" } = {}, origin = globalThis.location?.origin ?? "") {
	const props = {
		error_kind: kind === "unhandled_rejection" ? "unhandled_rejection" : "error",
		error_type: errorType(error),
		error_source: "unknown",
	};
	let location = typeof filename === "string" && filename ? { url: filename, line: lineno, col: colno } : null;
	if (!location || errorSource(location.url, origin) !== "app") {
		let stack = "";
		try {
			stack = typeof error?.stack === "string" ? error.stack.slice(0, 4000) : "";
		} catch {
			stack = "";
		}
		const frames = [...stack.matchAll(STACK_LOCATION)].map((match) => ({ url: match[1], line: Number(match[2]), col: Number(match[3]) }));
		location = frames.find((frame) => errorSource(frame.url, origin) === "app") ?? location ?? frames[0] ?? null;
	}
	if (!location) return props;
	props.error_source = errorSource(location.url, origin);
	if (props.error_source !== "app") return props;
	const file = scriptBasename(location.url);
	if (file) props.error_file = file;
	if (Number.isInteger(location.line) && location.line >= 0) props.error_line = location.line;
	if (Number.isInteger(location.col) && location.col >= 0) props.error_col = location.col;
	return props;
}

/**
 * Count one authored edit by its closed semantic kind (FIRST_EDIT_KINDS). Edits
 * of the same group closer than EDIT_GESTURE_GAP_MS count as one gesture. The
 * first real pose edit of a session is also the `pose_edit` feature signal;
 * saving a pose to the library is `pose_save`.
 */
export function recordSemanticEdit(kind, now = Date.now()) {
	const group = EDIT_GROUP_BY_KIND.get(kind);
	if (!group) return false;
	const continuing = group === lastEditGroup && now - lastEditAt < EDIT_GESTURE_GAP_MS;
	lastEditGroup = group;
	lastEditAt = now;
	if (!continuing) sessionEditCounts[group] += 1;
	if (kind === "pose_edit") trackFeature("pose_edit");
	return !continuing;
}

/** Per-group edit gesture counts for app:session_ended, bucketed like actions. */
export function sessionEditBuckets() {
	return Object.fromEntries(Object.entries(sessionEditCounts).map(([group, count]) => [`${group}_edit_bucket`, bucketCount(count)]));
}

/** Only structured error codes cross the analytics boundary, never messages. */
export function exportFailureCode(error, fallbackCode = "unknown") {
	try {
		if (error?.name === "AbortError") return "aborted";
		if (EXPORT_FAILURE_CODES.has(error?.exportFailureCode)) return error.exportFailureCode;
	} catch {
		// Error objects can cross realms or expose throwing getters.
	}
	return EXPORT_FAILURE_CODES.has(fallbackCode) ? fallbackCode : "unknown";
}

const URL_PROPERTY_KEYS = [
	"$current_url",
	"$initial_current_url",
	"$referrer",
	"$initial_referrer",
];
const CAMPAIGN_PROPERTY_KEYS = [
	"utm_source",
	"utm_medium",
	"utm_campaign",
	"utm_content",
	"utm_term",
	"gad_source",
	"mc_cid",
	"gclid",
	"gclsrc",
	"dclid",
	"gbraid",
	"wbraid",
	"fbclid",
	"msclkid",
	"twclid",
	"li_fat_id",
	"igshid",
	"ttclid",
	"rdt_cid",
	"epik",
	"qclid",
	"sccid",
	"irclid",
	"_kx",
	"ph_keyword",
];

function stripUrlTail(value) {
	if (typeof value !== "string") return value;
	return value.split("#")[0].split("?")[0];
}

// SDK-standard pageview properties carry location.href/document.referrer;
// strip query strings and fragments so tokens or future URL state never
// leave the browser. Runs as posthog's before_send hook.
export function scrubEventUrls(event) {
	if (!event || typeof event !== "object" || !event.properties) return event;
	const containers = [
		event.properties,
		event.properties.$set,
		event.properties.$set_once,
		event.$set,
		event.$set_once,
	].filter((value) => value && typeof value === "object" && !Array.isArray(value));
	for (const properties of containers) {
		for (const key of URL_PROPERTY_KEYS) {
			if (typeof properties[key] === "string") {
				properties[key] = stripUrlTail(properties[key]);
			}
		}
		for (const key of CAMPAIGN_PROPERTY_KEYS) {
			delete properties[key];
			delete properties[`$initial_${key}`];
		}
		for (const key of Object.keys(properties)) {
			if (key.startsWith("$session_entry_")) delete properties[key];
		}
	}
	return event;
}

export function shouldFireActivation(state) {
	return state?.activationTracked !== true;
}

export function getAnalyticsOptOut() {
	if (optOutPending) return true;
	return runtimeConfig()?.distribution === "npm"
		? runtimeConfig()?.telemetryEnabled !== true
		: readStorage(OPT_OUT_KEY) === "1";
}

function clearAnalyticsStorage() {
	try {
		const store = storage();
		if (!store) return;
		const doomed = [];
		for (let i = 0; i < store.length; i += 1) {
			const key = store.key(i);
			if (key && key.startsWith("ph_") && key.endsWith("_posthog")) doomed.push(key);
		}
		for (const key of doomed) store.removeItem(key);
	} catch {
		// Best effort; never let cleanup break the app.
	}
}

async function syncPackageTelemetry(enabled) {
	if (runtimeConfig()?.distribution !== "npm") return { ok: true, enabled };
	try {
		const response = await fetch("/__cozyclay/telemetry", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ enabled }),
		});
		if (!response.ok) return { ok: false, enabled: !enabled };
		const next = await response.json();
		globalThis.__COZYCLAY_RUNTIME__ = next;
		return { ok: true, enabled: next.telemetryEnabled === true };
	} catch {
		return { ok: false, enabled: !enabled };
	}
}

export async function setAnalyticsOptOut(optOut) {
	const requestedOptOut = optOut === true;
	const packageRuntime = runtimeConfig()?.distribution === "npm";
	optOutPending = requestedOptOut;
	const syncResult = await syncPackageTelemetry(!requestedOptOut);
	optOutPending = false;
	if (!syncResult.ok) return getAnalyticsOptOut();
	const telemetryEnabled = syncResult.enabled;
	const value = !telemetryEnabled;
	writeStorage(OPT_OUT_KEY, value ? "1" : "0");
	if (value) clearAnalyticsStorage();
	if (packageRuntime && !value) {
		globalThis.location?.reload();
		return false;
	}
	if (!posthog && !value) await initAnalytics();
	if (!posthog) return value;
	try {
		if (value) {
			enabled = false;
			posthog.opt_out_capturing();
		} else {
			posthog.opt_in_capturing();
			enabled = initialized;
		}
	} catch {
		enabled = false;
		// SDK opt-in/out is best effort.
	}
	return value;
}

function environment() {
	return import.meta.env ?? {};
}

function runtimeConfig() {
	const value = globalThis.__COZYCLAY_RUNTIME__;
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	return value;
}

function isLoopbackOrigin(origin) {
	try {
		const parsed = new URL(origin);
		if (parsed.protocol !== "http:") return false;
		// Loopback and LAN hosts both mean the studio is self-served, not hosted.
		if (["127.0.0.1", "localhost"].includes(parsed.hostname)) return true;
		return /^(10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(parsed.hostname);
	} catch {
		return false;
	}
}

export function resolveAnalyticsRuntime({
	env = environment(),
	origin = globalThis.location?.origin ?? "",
	runtime = runtimeConfig(),
} = {}) {
	if (!env.PROD) return { kind: "disabled", reason: "not production" };
	if (runtime?.distribution === "npm") {
		if (runtime.telemetryEnabled !== true) return { kind: "disabled", reason: "opted out" };
		if (!isLoopbackOrigin(origin)) return { kind: "disabled", reason: "unapproved origin" };
		if (typeof runtime.apiKey !== "string" || runtime.apiKey.length === 0) {
			return { kind: "disabled", reason: "no key" };
		}
		if (typeof runtime.installationId !== "string"
			|| !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(runtime.installationId)) {
			return { kind: "disabled", reason: "invalid anonymous identity" };
		}
		return {
			kind: "enabled",
			distribution: "npm",
			apiKey: runtime.apiKey,
			apiHost: runtime.apiHost || "https://t.cozyclay.org",
			appVersion: runtime.appVersion || null,
			installationId: runtime.installationId,
			firstLaunch: runtime.firstLaunch === true,
			firstLaunchHeardFrom: HEARD_FROM_VALUES.has(runtime.firstLaunchHeardFrom) ? runtime.firstLaunchHeardFrom : null,
			installKind: ["npx", "global", "clone"].includes(runtime.installKind) ? runtime.installKind : "npx",
			originKind: "local",
			internalQa: runtime.internalQa === true,
			// From the CLI's existing registry check; offline or opted-out is unknown.
			updateStatus: UPDATE_STATUS_VALUES.includes(runtime.updateStatus) ? runtime.updateStatus : "unknown",
		};
	}
	if (!env.VITE_POSTHOG_KEY) return { kind: "disabled", reason: "no key" };
	if (!isOriginAllowed(origin, parseAllowlist(env.VITE_POSTHOG_ALLOWED_ORIGINS))) {
		return { kind: "disabled", reason: "unapproved origin" };
	}
	return {
		kind: "enabled",
		distribution: "hosted",
		apiKey: env.VITE_POSTHOG_KEY,
		apiHost: env.VITE_POSTHOG_HOST || "https://us.i.posthog.com",
		// The deploy sets no VITE_APP_VERSION, so the bundled package version stands in.
		appVersion: env.VITE_APP_VERSION || appVersion(),
		installationId: null,
		firstLaunch: false,
		firstLaunchHeardFrom: null,
		installKind: null,
		originKind: "hosted",
		internalQa: readStorage(INTERNAL_QA_KEY) === "1",
		updateStatus: null,
	};
}

function analyticsGlobalProperties(resolved) {
	return {
		distribution: resolved.distribution,
		...(resolved.appVersion ? { app_version: resolved.appVersion } : {}),
		origin_kind: resolved.originKind,
		os: detectOs(),
		...(resolved.installKind ? { install_kind: resolved.installKind } : {}),
		...(resolved.updateStatus ? { update_status: resolved.updateStatus } : {}),
		internal_qa: resolved.internalQa,
	};
}

function disabledReason(env) {
	const runtime = resolveAnalyticsRuntime({ env });
	return runtime.kind === "disabled" ? runtime.reason : getAnalyticsOptOut() ? "opted out" : null;
}

/** `lite` (the landing page): $pageview and explicit events only; no session, error, long-task or device signals. */
export async function initAnalytics({ lite = false } = {}) {
	if (initialized || initPromise) return initPromise;
	// Explicit hosted opt-in only. This flag never changes consent or build
	// policy; npm installations use the CLI-owned state instead.
	if (runtimeConfig()?.distribution !== "npm") {
		const values = new URLSearchParams(globalThis.location?.search ?? "").getAll("internal_qa");
		if (values.length === 1 && (values[0] === "1" || values[0] === "0")) {
			writeStorage(INTERNAL_QA_KEY, values[0]);
		}
	}
	const env = environment();
	const reason = disabledReason(env);
	if (reason) {
		if (!disabledLogged) {
			console.info("[analytics] disabled: " + reason);
			disabledLogged = true;
		}
		return undefined;
	}

	initPromise = (async () => {
		try {
			const module = await import("posthog-js");
			if (getAnalyticsOptOut()) return;
			const resolved = resolveAnalyticsRuntime({ env });
			if (resolved.kind === "disabled") return;
			posthog = module.default ?? module;
			posthog.init(resolved.apiKey, {
				api_host: resolved.apiHost,
				defaults: "2025-05-24",
				autocapture: false,
				capture_pageview: false,
				// Keep the wire contract at the disclosed events: no $pageleave.
				capture_pageleave: false,
				person_profiles: "never",
				// Hosted visits persist in the browser. Official npm sessions
				// bootstrap from the CLI-owned installation id instead.
				persistence: resolved.distribution === "npm" ? "memory" : "localStorage",
				// Browser DNT is set by extensions and OS defaults, not by a deliberate
				// per-site choice; the preference toggle remains the explicit signal.
				respect_dnt: false,
				disable_session_recording: true,
				capture_dead_clicks: false,
				capture_performance: false,
				disable_capture_url_hashes: true,
				save_campaign_params: false,
				save_referrer: false,
				mask_personal_data_properties: true,
				request_batching: false,
				advanced_disable_feature_flags: true,
				disable_external_dependency_loading: true,
				disable_surveys: true,
				// Needed once api_host points at a first-party proxy; harmless otherwise.
				ui_host: "https://us.posthog.com",
				bootstrap: resolved.installationId
					? { distinctID: resolved.installationId, isIdentifiedID: false }
					: undefined,
				before_send: scrubEventUrls,
			});
			initialized = true;
			enabled = true;
			const globalProperties = analyticsGlobalProperties(resolved);
			posthog.register(globalProperties);
			// Test hook, mirroring the window.__cozyclay convention: lets QA
			// drivers inspect the live SDK without shipping a real global API.
			globalThis.__cozyclayAnalytics = { instance: posthog };
			posthog.capture("$pageview");
			sessionStartedAt = Date.now();
			if (!lite) { installSessionEndListeners(resolved, globalProperties); installErrorListeners(); observeLongTasks(); void recordDeviceProfile(); }
			if (resolved.distribution === "npm" && !lite) {
				track("app:session_started");
				if (resolved.firstLaunch) {
					const heardFrom = resolved.firstLaunchHeardFrom;
					track("install:first_launch", heardFrom ? { heard_from: heardFrom } : {});
				}
			}
		} catch {
			console.info("[analytics] initialization failed");
		}
	})();
	await initPromise;
}

export function track(event, props = {}) {
	// The allowlist is the gate: an event it does not name is never sent.
	if (!initialized || !enabled || !posthog || !Object.hasOwn(EVENT_PROPERTIES, event)) return;
	try {
		if (getAnalyticsOptOut()) return;
		const sanitized = sanitizeProps(event, props);
		if (!PASSIVE_EVENTS.has(event)) {
			sessionActionCount += 1;
			if (event === "scene:created" || event === "scene:loaded") sessionScenesTouched += 1;
		}
		posthog.capture(event, sanitized);
	} catch {
		// Analytics must never affect app behavior.
	}
}

/** The sculpt_run payload for a sculpt-run state (src/sculpt-run.js), or null
 * while the run has not ended. `hadTarget`: the run re-sculpted an existing
 * sculpt rather than creating one. An unscored run omits final_iou. */
export function sculptRunTelemetry(state, { hadTarget = false } = {}) {
	if (!SCULPT_RUN_OUTCOMES.includes(state?.stage)) return null;
	return {
		outcome: state.stage,
		rounds: state.round,
		...(Number.isFinite(state.iou) ? { final_iou: Math.round(state.iou * 100) / 100 } : {}),
		duration_ms: Math.round(state.elapsedMs),
		had_target: Boolean(hadTarget),
	};
}

export function trackFeature(name) {
	if (!initialized || !enabled || !posthog || !FEATURE_NAMES.has(name) || featureNamesSeen.has(name)) return false;
	featureNamesSeen.add(name);
	track("feature:used", { name });
	return true;
}

/** True while events would actually be sent. Callers use it to skip work that
 * only exists for telemetry, such as classifying every authored edit. */
export function analyticsActive() {
	try {
		return initialized && enabled && Boolean(posthog) && !getAnalyticsOptOut();
	} catch {
		return false;
	}
}

/** The optional one-question use-case card: only while telemetry is on, and at
 * most once per browser profile and origin, answered or dismissed. */
export function shouldAskUseCase() {
	return analyticsActive() && readStorage(USE_CASE_ASKED_KEY) !== "1";
}

export function recordUseCase(useCase, team) {
	writeStorage(USE_CASE_ASKED_KEY, "1");
	track("survey:use_case", {
		use_case: USE_CASE_VALUES.includes(useCase) ? useCase : "skip",
		team: TEAM_VALUES.includes(team) ? team : "skip",
	});
}

function installErrorListeners() {
	if (errorListenersInstalled || typeof window === "undefined" || typeof window.addEventListener !== "function") return;
	errorListenersInstalled = true;
	const report = (payload) => {
		try {
			const props = describeError(payload); bumpFriction("errors");
			const signature = [props.error_kind, props.error_type, props.error_source, props.error_file, props.error_line, props.error_col].join("|");
			if (errorSignaturesSeen.has(signature) || errorSignaturesSeen.size >= ERROR_SIGNATURE_LIMIT) return;
			errorSignaturesSeen.add(signature);
			track("app:error", { ...props, locale: uiLocale() });
		} catch {
			// Error telemetry must never throw from inside an error handler.
		}
	};
	window.addEventListener("error", (event) => {
		try {
			// The message is read locally only to drop a benign browser warning.
			if (typeof event?.message === "string" && event.message.startsWith("ResizeObserver loop")) return;
			// A muted cross-origin "Script error." has neither an error nor a script:
			// nothing to fix, so it is not reported.
			if (!event?.error && !event?.filename) return;
			report({ error: event?.error, filename: event?.filename, lineno: event?.lineno, colno: event?.colno, kind: "error" });
		} catch {
			// Never interfere with the page's own error handling.
		}
	});
	window.addEventListener("unhandledrejection", (event) => {
		report({ error: event?.reason, kind: "unhandled_rejection" });
	});
}

function probeWebGl() {
	try {
		const canvas = globalThis.document?.createElement?.("canvas");
		if (!canvas?.getContext) return { webgl: "none", renderer: "" };
		let gl = canvas.getContext("webgl2");
		let webgl = gl ? "webgl2" : "none";
		if (!gl) {
			gl = canvas.getContext("webgl");
			if (gl) webgl = "webgl1";
		}
		if (!gl) return { webgl, renderer: "" };
		let renderer = "";
		try {
			const info = gl.getExtension("WEBGL_debug_renderer_info");
			renderer = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER) ?? "");
		} catch {
			renderer = "";
		}
		try {
			gl.getExtension("WEBGL_lose_context")?.loseContext();
		} catch {
			// The probe context is garbage either way.
		}
		return { webgl, renderer };
	} catch {
		return { webgl: "none", renderer: "" };
	}
}

const FRAME_SAMPLE_DELAY_MS = 8000;
const FRAME_SAMPLE_WINDOW_MS = 3000;
const FRAME_SAMPLE_GIVE_UP_MS = 60_000;

/** Frames the browser delivered during one 3 s visible window after startup:
 * a smoothness proxy for the studio's render loop, not a GPU benchmark. */
function measureFrameRate() {
	return new Promise((resolve) => {
		const raf = globalThis.requestAnimationFrame;
		if (typeof raf !== "function") {
			resolve(null);
			return;
		}
		const hidden = () => globalThis.document?.visibilityState === "hidden";
		const beganAt = Date.now();
		const attempt = () => {
			if (Date.now() - beganAt > FRAME_SAMPLE_GIVE_UP_MS) {
				resolve(null);
				return;
			}
			if (hidden()) {
				setTimeout(attempt, 2000);
				return;
			}
			let frames = 0;
			let first = 0;
			const step = (time) => {
				if (hidden()) {
					setTimeout(attempt, 2000);
					return;
				}
				if (!first) first = time;
				frames += 1;
				if (time - first >= FRAME_SAMPLE_WINDOW_MS) {
					resolve(((frames - 1) * 1000) / (time - first));
					return;
				}
				raf(step);
			};
			raf(step);
		};
		setTimeout(attempt, FRAME_SAMPLE_DELAY_MS);
	});
}

async function recordDeviceProfile() {
	// Only a real rendering document has a GPU and a frame clock to describe.
	if (deviceProfileStarted || typeof globalThis.document === "undefined" || typeof globalThis.requestAnimationFrame !== "function") return;
	deviceProfileStarted = true;
	try {
		const { webgl, renderer } = probeWebGl();
		const gpu = classifyGpu(renderer);
		const fps = await measureFrameRate();
		track("device:profile", {
			...gpu,
			webgl,
			cpu_bucket: bucketCpu(globalThis.navigator?.hardwareConcurrency),
			memory_bucket: bucketMemory(globalThis.navigator?.deviceMemory),
			frame_rate_bucket: bucketFrameRate(fps),
		});
	} catch {
		// Device capability is best effort and must never affect the studio.
	}
}

function installSessionEndListeners(resolved, globalProperties) {
	if (sessionEndListenersInstalled || typeof window === "undefined") return;
	sessionEndListenersInstalled = true;
	const finish = () => {
		if (sessionEnded || !sessionStartedAt) return;
		sessionEnded = true;
		try {
			// This transport bypasses the SDK, so explicitly apply the same
			// current opt-out and browser DNT policy before serializing an ID.
			if (!enabled || !posthog || getAnalyticsOptOut() || posthog.has_opted_out_capturing()) return;
			const endpoint = `${resolved.apiHost.replace(/\/$/, "")}/e/`;
			const identity = { ...globalProperties, distinct_id: posthog.get_distinct_id() };
			// The same validator as every SDK event, one request per event.
			const send = (event, props) => {
				const body = JSON.stringify({ api_key: resolved.apiKey, event, properties: { ...identity, ...sanitizeProps(event, props) } });
				if (typeof globalThis.navigator?.sendBeacon === "function") globalThis.navigator.sendBeacon(endpoint, new Blob([body], { type: "application/json" }));
				else void fetch(endpoint, { method: "POST", body, keepalive: true, headers: { "content-type": "application/json" } });
			};
			const duration = bucketSessionDuration(Date.now() - sessionStartedAt);
			// session_id joins the last events of the session.
			send("app:session_ended", { session_id: posthog.get_session_id?.(), duration_bucket: duration, action_count_bucket: bucketCount(sessionActionCount),
				scenes_touched: Math.min(20, sessionScenesTouched), ...sessionEditBuckets() });
			send("app:friction_summary", { active_time: duration, ...frictionSnapshot() });
		} catch {
			// Unload telemetry is best effort.
		}
	};
	window.addEventListener("pagehide", finish, { once: true });
	window.addEventListener("beforeunload", finish, { once: true });
}

export function trackActivation(path) {
	if (!initialized || !enabled || activationFired) return;
	const tracked = readStorage(ACTIVATION_KEY) === "1";
	if (!shouldFireActivation({ activationTracked: tracked })) {
		activationFired = true;
		return;
	}
	activationFired = true;
	writeStorage(ACTIVATION_KEY, "1");
	track("activation:completed", { activation_path: path });
}
