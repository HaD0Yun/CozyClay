// Events whose every property is checked against its own closed set, never the
// generic "short string" rule. analytics.js asks strictPropValidator(event) once
// per event; a property its validator refuses is dropped.
import { STUDIO_ERROR_CODES } from "./studio-error-codes.js";
import { ERROR_TYPE_VALUES, sessionEndedPropAllowed } from "./analytics-values.js";
import { FRICTION_SUMMARY_KEYS, frictionPropAllowed } from "./analytics-friction.js";
import { AREA_IDS, CONTROL_IDS } from "./analytics-controls.js";

const TURN_ID_PATTERN = /^[a-f0-9]{32}$/;
// The friction count vocabulary (analytics-friction.js bucketFrictionCount).
const COUNT_BUCKETS = new Set(["0", "1", "2", "3", "4-5", "6-10", "gte11"]);
const LONG_BUCKETS = new Set(["lt10s", "10-30s", "30-60s", "1-2m", "2-5m", "gte5m"]);
const AGE_BUCKETS = new Set(["lt2s", "2-10s", "10-60s", "gte60s"]);
const SHORT_MS_BUCKETS = new Set(["lt50", "50-150", "150-500", "500-2000", "gte2000"]);
const REFUSAL_CODES = new Set([...STUDIO_ERROR_CODES, "other"]);
// The providers CozyClay configures itself (bin/agent/providers.mjs PROVIDERS); the
// connect funnel reports any other id the login list offers as "other".
export const CONNECT_PROVIDERS = Object.freeze(["openai-codex", "anthropic", "anthropic-subscription", "openai", "google",
	"minimax", "minimax-cn", "openrouter", "cliproxy", "openai-compatible"]);

/** landing:cta_clicked targets: the landing page's links out and copy buttons. */
export const LANDING_CTA_TARGETS = Object.freeze(["app", "github", "discord", "npm", "copy_npx", "copy_clone", "copy_mcp", "copy_terminal", "agent_install_doc"]);

/** A Studio refusal code as sent: one of STUDIO_ERROR_CODES, else "other". */
export const refusalCodeOf = (code) => (STUDIO_ERROR_CODES.includes(code) ? code : "other");

/** lt10s, 10-30s, 30-60s, 1-2m, 2-5m, gte5m: agent turns and edit windows outlast bucketMs. */
export function bucketLong(ms) {
	if (!Number.isFinite(ms) || ms < 10_000) return "lt10s";
	if (ms < 30_000) return "10-30s";
	if (ms < 60_000) return "30-60s";
	if (ms < 120_000) return "1-2m";
	if (ms < 300_000) return "2-5m";
	return "gte5m";
}

/** lt2s, 2-10s, 10-60s, gte60s: how old an edit was when it was undone. */
export function bucketAge(ms) {
	if (!Number.isFinite(ms) || ms < 2000) return "lt2s";
	if (ms < 10_000) return "2-10s";
	if (ms < 60_000) return "10-60s";
	return "gte60s";
}

const oneOf = (...values) => (value) => values.includes(value);
const inSet = (set) => (value) => set.has(value);
const turnId = (value) => typeof value === "string" && TURN_ID_PATTERN.test(value);
const bool = (value) => typeof value === "boolean";
const count = inSet(COUNT_BUCKETS);
const long = inSet(LONG_BUCKETS);

// One closed check per property. The keys are the allowlist (EVENT_PROPERTIES).
const SCHEMAS = Object.freeze({
	"studio:refused": {
		code: inSet(REFUSAL_CODES), origin: oneOf("ui", "agent"), phase: oneOf("admission", "commit"),
		group: oneOf("object", "shot", "cast", "scene", "motion", "edit", "task", "agent", "other"),
		// A registered Studio action id (command-bus-telemetry.js sends only those): code-defined, never args (#975).
		command: (value) => typeof value === "string" && value.length <= 48 && /^[a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9]+){1,3}$/.test(value),
	},
	// error_type: the app:error label set (analytics.js describeError); never a message or stack.
	"app:render_crash": { error_type: inSet(ERROR_TYPE_VALUES) },
	"app:gl_lost": { kind: oneOf("unavailable", "context_lost") },
	"studio:ready": { boot: oneOf("lt2s", "2-5s", "5-15s", "gte15s") },
	// late_ticks (the late_tick_ratio set) is an estimate: timer ticks that caught up more than one frame,
	// not measured render drops. measured_fps is device:profile's frame_rate_bucket set (bucketFrameRate).
	"playback:summary": {
		duration: long, late_ticks: oneOf("0", "lt5", "5-20", "20-50", "gte50"), max_catchup: oneOf("1", "2", "3-5", "gte6"),
		fps: oneOf("12", "24", "30", "60", "other"), speed: oneOf("0.5", "1", "2", "other"),
		measured_fps: oneOf("lt20", "20-40", "40-55", "gte55", "unknown"),
	},
	// mode and step: first-success-guide.jsx's STEPS_BY_MODE keys and its 4 steps per mode.
	"guide:opened": { mode: oneOf("animation", "storyboard") },
	"guide:step": { mode: oneOf("animation", "storyboard"), step: oneOf("1", "2", "3", "4"), step_ms: long },
	"guide:dismissed": { mode: oneOf("animation", "storyboard"), reached: oneOf("1", "2", "3", "4") },
	"guide:completed": { mode: oneOf("animation", "storyboard") },
	"agent:panel_toggled": { open: bool, via: oneOf("key", "button") },
	// The Export flyout opening (export-menu-telemetry.js); shots is analytics.js bucketCount.
	"export:menu_opened": {
		surface: oneOf("studio", "embed"), mode: oneOf("animation", "storyboard"), webcodecs: bool, shots: oneOf("0", "1-3", "4-10", "gte11"),
	},
	"object:deleted_soon": { age: inSet(AGE_BUCKETS) },
	"object:delete_undone": { age: inSet(AGE_BUCKETS) },
	"edit:undone": {
		age: inSet(AGE_BUCKETS), kind: oneOf("pose", "camera", "object", "shot", "prompt", "agent_turn", "ik_preview", "other"),
		via: oneOf("key", "menu", "button"), result: oneOf("done", "noop", "refused"),
	},
	"agent:turn_summary": {
		turn_id: turnId, outcome: oneOf("succeeded", "failed", "cancelled"), wall: long, first_tool: long,
		tool_calls: count, tool_failed: count, refused: count, refusal_top: (value) => value === "none" || REFUSAL_CODES.has(value),
		stale_retry: count, authored: bool, drafts: count, qa_first: oneOf("clean", "problems"), qa_last: oneOf("clean", "problems"),
		qa_trend: oneOf("improved", "flat", "worse", "na"), stuck: bool, cancel_phase: oneOf("before_tool", "during_tool", "after_tool", "na"),
	},
	"motion:draft_compiled": {
		draft_index: count, qa_clean: bool, qa_problems: count, qa_frames: oneOf("0", "1-10", "11-50", "51-200", "gte201"),
		compile: inSet(SHORT_MS_BUCKETS), installed: bool, stuck: bool, repaired: bool, searched: bool, adjusted: bool,
		frames: oneOf("lt30", "30-120", "121-480", "gte481"),
	},
	// Shortcut, search and thrash friction (shortcut-friction.js, search-friction.js, thrash-friction.js).
	// A key class or combo name, never the key character; a query length bucket, never the query.
	"shortcut:ignored": {
		key_class: oneOf("undo", "redo", "mode", "transform", "frame", "duplicate", "delete"),
		reason: oneOf("no_selection", "wrong_mode", "workflow_mode", "busy", "empty_history"),
	},
	"shortcut:unbound": { combo: oneOf("copy", "paste", "cut", "select_all", "group", "find", "rename", "help") },
	"help:shortcuts_opened": {},
	// The landing page (src/site/landing-analytics.js): which call to action was pressed, never a URL or copied text.
	"landing:cta_clicked": { target: oneOf(...LANDING_CTA_TARGETS) },
	"search:no_results": { surface: oneOf("assets", "outliner"), query_len: oneOf("1", "2-3", "4-8", "gte9") },
	"nav:thrash": { surface: oneOf("dock_tab", "mode", "agent_panel"), switches: oneOf("4-5", "6-10", "gte11"), window_s: oneOf(10) },
	"camera:thrash": { gestures: oneOf("6-10", "gte11"), kind_mix: oneOf("orbit", "fly", "pan", "mixed"), window_s: oneOf(20) },
	"agent:connect_opened": { entry: oneOf("first_run", "failure_card", "signed_out", "menu", "other") },
	"agent:connect_started": { provider: oneOf(...CONNECT_PROVIDERS, "other"), method: oneOf("oauth", "api_key", "chatgpt") },
	"agent:connect_finished": {
		provider: oneOf(...CONNECT_PROVIDERS, "other"), method: oneOf("oauth", "api_key", "chatgpt"),
		outcome: oneOf("ok", "failed", "cancelled", "abandoned"), step: oneOf("list", "prompt", "waiting", "done"), duration: long,
		// An attempt that did not connect: why, when known (#1044; connect-telemetry.js CONNECT_FAILURE_REASONS).
		reason: oneOf("timeout", "callback_error", "port_busy", "user_closed", "other"),
	},
	"agent:model_changed": { provider: oneOf(...CONNECT_PROVIDERS, "other"), after_failure: bool },
	"agent:prompt_sent": {
		turn_id: turnId, provider: oneOf(...CONNECT_PROVIDERS, "other"), via: oneOf("typed", "retry_button", "regenerate", "chip", "supervisor"),
		prompt_len: oneOf("1-20", "21-80", "81-240", "gte241"), compose_ms: long, similarity: oneOf("first", "same", "near", "different"),
		gap: (value) => value === "first" || long(value), prev_outcome: oneOf("succeeded", "failed", "cancelled", "none"), turn_index: count,
		attached: bool, task_mode: bool,
		// openai-compatible only: the server address's class, never the address (#1043).
		endpoint: oneOf("local", "lan", "hosted", "unknown"),
	},
	"ui:rage_click": { control: oneOf(...CONTROL_IDS, ...AREA_IDS, "other"), clicks: oneOf("3", "4-5", "gte6"), changed: bool },
	"ui:dead_click": { control: oneOf(...CONTROL_IDS, ...AREA_IDS, "other"), reason: oneOf("aria_disabled", "refused", "no_effect") },
	// The update notice (src/update/update-telemetry.js): an install kind and buckets, never a version string or npm output.
	"update:notice_shown": { kind: oneOf("global", "npx"), behind: oneOf("patch", "minor", "major") },
	"update:clicked": { action: oneOf("update_now", "copy_command", "later", "dismiss", "release_notes", "restart"), kind: oneOf("global", "npx") },
	"update:restarted": { outcome: oneOf("ok", "timeout") },
	"update:finished": {
		outcome: oneOf("ok", "failed"), error_class: oneOf("none", "permission", "network", "node_version", "npm_missing", "other"), duration: long,
	},
	"agent:post_turn_edit": {
		// prompt_block, not prompt: "prompt" is a denied property key (analytics.js), whatever its value.
		turn_id: turnId, edited: bool, pose: count, camera: count, object: count, shot: count, prompt_block: count, first_delay: long,
	},
});

/** EVENT_PROPERTIES rows for the strict events defined here (app:session_ended keeps its own row). */
export const STRICT_EVENT_KEYS = Object.freeze({
	"app:friction_summary": FRICTION_SUMMARY_KEYS,
	...Object.fromEntries(Object.entries(SCHEMAS).map(([event, schema]) => [event, Object.keys(schema)])),
});

/** (key, value) => allowed, for an event with a closed schema; null for every other event. */
export function strictPropValidator(event) {
	if (event === "app:session_ended") return sessionEndedPropAllowed;
	if (event === "app:friction_summary") return frictionPropAllowed;
	const schema = SCHEMAS[event];
	return schema ? (key, value) => Object.hasOwn(schema, key) && schema[key](value) : null;
}
