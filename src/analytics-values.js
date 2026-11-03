// Closed property values for the export lifecycle and the session-end beacon.
// Kept out of analytics.js so these vocabularies can grow without growing the
// core sanitizer; nothing here imports, so analytics.js can depend on it.

export const EXPORT_FAILURE_CODES = new Set(["unsupported_codec", "encode_failed", "render_failed", "aborted", "unknown"]);
const COUNT_BUCKETS = new Set(["0", "1-3", "4-10", "gte11"]);
const EXPORT_PROPERTY_VALUES = Object.freeze({
	export_kind: new Set(["video", "depth_video", "frame", "keyframe_pack", "workflow_send", "animation_project", "contact_sheet", "panel_pack", "animatic", "storyboard", "render_pass", "otio"]),
	format: new Set(["mp4", "png", "zip", "cclayproject", "otio"]),
	surface: new Set(["studio", "workflow", "embed"]),
	duration_bucket: new Set(["lt1s", "1-3s", "3-10s", "10-30s", "gte30s"]),
	failure_code: EXPORT_FAILURE_CODES,
	objects: COUNT_BUCKETS,
	// Where a failed or cancelled export stood: the step and its frame share.
	stage: new Set(["preparing", "encoding", "finalizing", "handoff"]),
	progress: new Set(["0", "1-25", "26-50", "51-75", "76-99"]),
	// export:saved: where the file went, and why it fell back to a download.
	method: new Set(["workspace", "download"]),
	reason: new Set(["none", "unsupported", "no_workspace", "permission", "write_failed"]),
});
const ATTEMPT_ID_PATTERN = /^[a-f0-9]{32}$/;

/** One export:attempt_* or export:saved property, checked against its closed set. */
export function exportPropAllowed(key, value) {
	if (key === "attempt_id" || key === "retry_of") return typeof value === "string" && ATTEMPT_ID_PATTERN.test(value);
	if (key === "is_retry") return typeof value === "boolean";
	return EXPORT_PROPERTY_VALUES[key]?.has(value) ?? false;
}

// The thrown-value type labels app:error and app:render_crash share (analytics.js
// errorType): built-in Error and DOMException names, else "non_error" or "other".
export const ERROR_TYPE_VALUES = new Set([
	"Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError", "EvalError", "URIError",
	"AggregateError", "AbortError", "TimeoutError", "NotAllowedError", "NotSupportedError", "NotFoundError",
	"NotReadableError", "InvalidStateError", "QuotaExceededError", "SecurityError", "NetworkError",
	"DataCloneError", "OperationError", "EncodingError", "UnknownError", "DOMException", "non_error", "other",
]);
// The studio UI language (locale.js) app:error and app:render_crash carry, so a
// crash can be told apart by in-app language rather than browser language (#1046).
// Read here, not imported from locale.js, to keep the analytics modules light.
export const UI_LOCALE_VALUES = new Set(["en", "ko", "zh", "other"]);
const UI_LOCALE_KEY = "cozyclay.locale";

/** The UI locale label: the stored choice, "en" when none (locale.js's default), "other" for an unknown value. */
export function uiLocale() {
	let value;
	try {
		value = globalThis.localStorage?.getItem(UI_LOCALE_KEY) ?? "en";
	} catch {
		return "en";
	}
	return value === "en" || value === "ko" || value === "zh" ? value : "other";
}
export const SESSION_DURATION_BUCKETS = new Set(["lt1m", "1-5m", "5-15m", "15-30m", "gte30m"]);
// The SDK's session id is a random UUID; nothing else may ride in that slot.
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCENES_TOUCHED_MAX = 20;

/** One app:session_ended property: code-made buckets, a capped count, the SDK session id. */
export function sessionEndedPropAllowed(key, value) {
	if (key === "duration_bucket") return SESSION_DURATION_BUCKETS.has(value);
	if (key === "scenes_touched") return Number.isInteger(value) && value >= 0 && value <= SCENES_TOUCHED_MAX;
	if (key === "session_id") return typeof value === "string" && SESSION_ID_PATTERN.test(value);
	return key.endsWith("_bucket") && COUNT_BUCKETS.has(value);
}
