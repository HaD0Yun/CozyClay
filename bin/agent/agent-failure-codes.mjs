// The closed `agent:turn_failed.failure_code` vocabulary, sidecar side. Kept
// self-contained (minimal sidecar installs omit src/); it gives the same answers
// as src/workflow/agent-failure-codes.js, whose header defines each code, and
// test/verify-agent-execution.mjs holds the two tables to that. Only the
// error's name, structured code and HTTP status are read, never a message
// (classifyProviderError below is the runner's message fallback, not this table).
//   upstream  HTTP 5xx, or the runner's overloaded/upstream (and server_error)
//   timeout   the request was taken but its answer did not come in time: the
//             runner's `timeout`, a headers/body timeout code, a TimeoutError
//   truncated the model used its whole output before answering (runner `truncated`)
//   network   no HTTP answer: a fetch TypeError or a socket code (ECONNRESET,
//             ENOTFOUND, a connect ETIMEDOUT, ...) on the error or its `cause`
//   unknown   anything else, including an error whose fields throw
// Rows before the network/unknown split carry `upstream` for all three.
const BY_CODE = {
	unauthorized: "key_refused", auth: "auth", AUTH_REQUIRED: "auth", rate_limit: "rate_limited", RATE_LIMITED: "rate_limited",
	STALE_SCENE: "stale_scene", STALE_TARGET: "stale_scene", STALE_ENVIRONMENT: "stale_scene",
	CAPABILITY_MISSING: "capability_missing", LIVE_HUB_UNAVAILABLE: "capability_missing",
	busy: "busy", TARGET_BUSY: "busy", SCOPE_BUSY: "busy", TARGET_NOT_READY: "busy",
	// A sidecar frame whose code is already this table's fallback answer passes through.
	network: "network",
};
// The runner's provider codes read as upstream, after the status: a 4xx beside one is the request's fault.
const PROVIDER_CODES = new Set(["overloaded", "upstream", "server_error"]);
// Read after the status too; a frame's own `unknown` is not here, so a status beside it still decides (#1370).
const OWN_CODES = { timeout: "timeout", truncated: "truncated" };
// The server took the request and its answer did not arrive in time; a connect timeout stays network.
const TIMEOUT_CODES = new Set(["UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "TimeoutError"]);
const NETWORK_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "EPIPE",
	"ENETUNREACH", "ENETDOWN", "EHOSTUNREACH", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT"]);
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
		if (Object.hasOwn(OWN_CODES, code)) return OWN_CODES[code];
		if (Number.isInteger(status)) return "unknown";
		if (TIMEOUT_CODES.has(code) || TIMEOUT_CODES.has(codeOf(error?.cause)) || error?.name === "TimeoutError") return "timeout";
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

const AUTH_ERROR_PATTERN = /\b(401|403)\b|unauthorized|forbidden/i;
// "usage limit", "quota", "resource exhausted": a provider's quota refusal that names no status, e.g. pi-ai's Codex
// adapter, which turns a 429 into "You have hit your ChatGPT usage limit (plus plan). Try again in ~38 min." (#1043:
// it read as upstream, so the panel never showed the quota card).
const RATE_LIMIT_PATTERN = /\b429\b|rate.?limit|too many requests|usage limit|quota|resource.?exhausted/i;
const OVERLOAD_PATTERN = /\b529\b|overloaded/i;
// The provider's own trouble, said with a 5xx or its words; a 504 "gateway timeout" is the provider's, not ours.
const UPSTREAM_PATTERN = /\b5\d\d\b|server_error|internal server error|bad gateway|service unavailable/i;
// The request's answer did not come in time (the OpenAI SDK's "Request timed out.", a deadline); "connect ETIMEDOUT" stays network.
const TIMEOUT_PATTERN = /\btim(?:ed|ing) out\b|\btimeout\b|deadline exceeded|HEADERS_TIMEOUT|BODY_TIMEOUT/i;
// Checked after those: a request that never got an HTTP answer, when only pi-ai's folded string survives.
const NETWORK_PATTERN = /fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|EAI_AGAIN|socket hang up|network error/i;

/** Classify a failed message into the runner's frozen vocabulary (unauthorized, rate_limit, overloaded, upstream,
 * timeout, network, unknown). pi folds status and code into one string (`formatProviderError`), so the patterns mirror
 * pi's retryability check; `errorCode`, the structure agent-stream.mjs kept from a thrown error (a socket code or
 * "TypeError"), decides first. What none of them names is unknown, not the provider's fault (#1370). Message-only
 * fallback: agent-runner.mjs `classifyError` reads a structured status first. */
export function classifyProviderError(message, errorCode) {
	if (TIMEOUT_CODES.has(errorCode)) return "timeout";
	if (errorCode === "TypeError" || NETWORK_CODES.has(errorCode)) return "network";
	if (AUTH_ERROR_PATTERN.test(message)) return "unauthorized";
	if (RATE_LIMIT_PATTERN.test(message)) return "rate_limit";
	if (OVERLOAD_PATTERN.test(message)) return "overloaded";
	if (UPSTREAM_PATTERN.test(message)) return "upstream";
	if (TIMEOUT_PATTERN.test(message)) return "timeout";
	return NETWORK_PATTERN.test(message) ? "network" : "unknown";
}

// pi resolves the ChatGPT (Codex) token itself before each request; a stored sign-in it cannot refresh, or one that is
// gone, ends the request with one of these setup errors (pi-ai auth/resolve.js, models.js applyAuth, the Codex adapter).
// They are the panel's "sign in again" (`auth`), not the provider's trouble: before #1374 they read as upstream with a
// Retry that could not work (26 failed turns in 4 min on one install, until it signed in again). A refresh that got no
// answer at all (pi's "token refresh error: fetch failed") stays with the runner's own classification: a retry can work.
const CODEX_SIGN_IN_PATTERN = /OAuth refresh failed for openai-codex|Provider is not configured: openai-codex|No API key for provider:? "?openai-codex|Credential store (?:read|modify) failed for openai-codex/;
export const CODEX_SIGN_IN_EXPIRED = "Your ChatGPT sign-in has expired. Sign in with ChatGPT again.";
/** Whether a failed request's message says its ChatGPT (Codex) sign-in could not give a token. */
export const codexSignInLost = (provider, message) => provider === "openai-codex" && CODEX_SIGN_IN_PATTERN.test(String(message ?? "")) && !/token refresh error:/i.test(String(message));
