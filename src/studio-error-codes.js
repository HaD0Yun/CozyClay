// The error codes a Studio receipt or failure may carry. Shared by the browser
// and sidecar; no imports.
export const STUDIO_ERROR_CODES = Object.freeze([
	"INVALID_ARGUMENT", "INVALID_CONTEXT", "INVALID_IDENTITY", "INVALID_TURN_ID", "INVALID_SESSION_ID", "INVALID_RECEIPT", "INVALID_RANGE", "INVALID_REQUEST",
	"UNKNOWN_TOOL", "DUPLICATE_NAME", "CONTEXT_LIMIT", "CONTEXT_TOO_LARGE", "AMBIGUOUS_TARGET", "AMBIGUOUS_BASIS", "TARGET_NOT_READY", "TARGET_BUSY",
	"STALE_TARGET", "STALE_SCENE", "STALE_ENVIRONMENT", "STALE_CURSOR", "CAPABILITY_MISSING", "LIVE_HUB_UNAVAILABLE", "AUTH_REQUIRED", "RATE_LIMITED", "BACKEND_UNAVAILABLE",
	"VERIFICATION_FAILED", "CANCELLED", "UNCERTAIN_APPLY", "UNDO_CONFLICT", "CONFIRMATION_REQUIRED", "TIMEOUT", "UNDO_EXPIRED", "INTERNAL_ERROR", "SCOPE_DENIED", "SCOPE_BUSY",
]);
/**
 * A refusal's code. A protocol error carries its own; a JavaScript runtime error (TypeError, ReferenceError, RangeError,
 * SyntaxError) is a fault in the editor, never the caller's input, so it reads INTERNAL_ERROR; any other plain Error is
 * the validation message of a command and stays INVALID_ARGUMENT.
 */
export const refusalCode = error => error?.code
	?? (["TypeError", "ReferenceError", "RangeError", "SyntaxError"].includes(error?.name) ? "INTERNAL_ERROR" : "INVALID_ARGUMENT");
/**
 * What kind of check an INVALID_ARGUMENT refusal failed (a protocol error's details.rule), for studio:refused.
 * The schema validator (studio-agent-protocol.js validateStudioSchema) sets type, unknown_field, missing, items,
 * unique, format, enum, range and variant; unknown_action is an action id the registry does not declare; spec is a
 * motion spec the compiler refused, recipe a sculpt recipe; check is any other refusal a command raised itself, and
 * unclassified a plain Error that reached the bus without a code.
 */
export const STUDIO_REFUSAL_RULES = Object.freeze(["type", "unknown_field", "missing", "items", "unique", "format", "enum", "range", "variant",
	"unknown_action", "spec", "recipe", "check", "unclassified"]);
