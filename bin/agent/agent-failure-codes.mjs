// The closed `agent:turn_failed.failure_code` vocabulary, sidecar side. Kept
// self-contained (minimal sidecar installs omit src/); it gives the same answers
// as src/workflow/agent-failure-codes.js, whose header defines each code, and
// test/verify-agent-execution.mjs holds the two tables to that. Only the
// error's name, structured code and HTTP status are read, never a message.
//   upstream  HTTP 5xx, or the runner's overloaded/upstream/truncated (and server_error)
//   network   no HTTP answer: a fetch TypeError or a socket code (ECONNRESET,
//             ENOTFOUND, ...) on the error or its `cause`
//   unknown   anything else, including an error whose fields throw
// Rows before the network/unknown split carry `upstream` for all three.
const BY_CODE = {
	unauthorized: "key_refused", auth: "auth", AUTH_REQUIRED: "auth", rate_limit: "rate_limited", RATE_LIMITED: "rate_limited",
	STALE_SCENE: "stale_scene", STALE_TARGET: "stale_scene", STALE_ENVIRONMENT: "stale_scene",
	CAPABILITY_MISSING: "capability_missing", LIVE_HUB_UNAVAILABLE: "capability_missing",
	busy: "busy", TARGET_BUSY: "busy", SCOPE_BUSY: "busy", TARGET_NOT_READY: "busy",
	// A sidecar frame whose code is already this table's fallback answer passes through.
	network: "network", unknown: "unknown",
};
// The runner's provider codes read as upstream, after the status: a 4xx beside one is the request's fault.
const PROVIDER_CODES = new Set(["overloaded", "upstream", "truncated", "server_error"]);
export const NETWORK_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "EPIPE",
	"ENETUNREACH", "ENETDOWN", "EHOSTUNREACH", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]);
const codeOf = (value) => (typeof value?.code === "string" ? value.code : "");

/** `{ name, code, status }` (a thrown error or a runner `error` frame) -> failure code. */
export function failureCodeOf(error) {
	try {
		const code = codeOf(error);
		const status = error?.status;
		if (Object.hasOwn(BY_CODE, code)) return BY_CODE[code];
		if (code.startsWith("INVALID_")) return "invalid_request";
		if (status === 401 || status === 403) return "auth";
		if (status === 429) return "rate_limited";
		if (Number.isInteger(status) && status >= 400 && status < 500) return "invalid_request";
		if (Number.isInteger(status) && status >= 500 && status < 600) return "upstream";
		if (PROVIDER_CODES.has(code)) return "upstream";
		if (Number.isInteger(status)) return "unknown";
		if (NETWORK_CODES.has(code) || NETWORK_CODES.has(codeOf(error?.cause)) || error?.name === "TypeError") return "network";
		return "unknown";
	} catch { return "unknown"; }
}

/** The `code` a sidecar error frame carries: the error's own code, else failureCodeOf (never a literal fallback). */
export function frameCodeOf(error) {
	try { if (typeof error?.code === "string" && error.code) return error.code; } catch { /* foreign getter */ }
	return failureCodeOf(error);
}

// After a tool failed, a turn that dies without a more specific code is the tool's failure.
const TOOL_FALLBACK = new Set(["upstream", "network", "unknown"]);

/** A turn that threw: an abort wins, then the error's own code, then a tool failure. */
export const agentFailureCode = (error, signal, tool = false) => {
	try { if (signal.aborted || error?.name === "AbortError") return "aborted"; } catch { /* foreign getter */ }
	const code = failureCodeOf(error);
	return tool && TOOL_FALLBACK.has(code) ? "tool_failed" : code;
};

// pi resolves the ChatGPT (Codex) token itself before each request; a stored sign-in it cannot refresh, or one that is
// gone, ends the request with one of these setup errors (pi-ai auth/resolve.js, models.js applyAuth, the Codex adapter).
// They are the panel's "sign in again" (`auth`), not the provider's trouble: before #1374 they read as upstream with a
// Retry that could not work (26 failed turns in 4 min on one install, until it signed in again). A refresh that got no
// answer at all (pi's "token refresh error: fetch failed") stays with the runner's own classification: a retry can work.
const CODEX_SIGN_IN_PATTERN = /OAuth refresh failed for openai-codex|Provider is not configured: openai-codex|No API key for provider:? "?openai-codex|Credential store (?:read|modify) failed for openai-codex/;
export const CODEX_SIGN_IN_EXPIRED = "Your ChatGPT sign-in has expired. Sign in with ChatGPT again.";
/** Whether a failed request's message says its ChatGPT (Codex) sign-in could not give a token. */
export const codexSignInLost = (provider, message) => provider === "openai-codex" && CODEX_SIGN_IN_PATTERN.test(String(message ?? "")) && !/token refresh error:/i.test(String(message));
