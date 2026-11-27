// The closed `agent:turn_failed.failure_code` vocabulary, browser side. The
// sidecar keeps an identical table in bin/agent/agent-failure-codes.mjs (it
// cannot import src/); test/verify-agent-execution.mjs holds both to the same
// answers. Only the error's name, structured code and HTTP status are read,
// never a message.
//
//   key_refused         the model provider rejected the credentials (provider
//                       401/403, structured or message-only: runner `unauthorized`)
//   auth                the sidecar itself has no usable sign-in, or refused the
//                       session's ownership (AUTH_REQUIRED, `auth`, refusal 401/403)
//   rate_limited        provider or sidecar 429 (`rate_limit`, RATE_LIMITED)
//   stale_scene         the scene moved under the turn (STALE_SCENE/TARGET/ENVIRONMENT)
//   capability_missing  the sidecar cannot run this turn here (CAPABILITY_MISSING:
//                       Studio runtime absent, live hub port in use;
//                       LIVE_HUB_UNAVAILABLE: no connected editor)
//   busy                a turn is already running, or the target is busy
//   invalid_request     the sidecar rejected the request (400, INVALID_*, other 4xx)
//   upstream            provider trouble: HTTP 5xx, or the runner's `overloaded`,
//                       `upstream` (and the provider's `server_error`)
//   timeout             the request was taken but its answer did not come in
//                       time: the runner's `timeout`, a headers/body timeout code
//                       (UND_ERR_HEADERS_TIMEOUT, ...), a TimeoutError
//   truncated           the model used its whole output before answering
//   network             the request never got an HTTP answer: a fetch TypeError
//                       (offline, refused, DNS) or a socket code (ECONNRESET,
//                       ENOTFOUND, a connect ETIMEDOUT, ...), on the error or its `cause`
//   unknown             anything else, including an error whose fields throw
//   aborted / tool_failed  are assigned by the turn, not by this table
// Rows before the network/unknown split carry `upstream` for all three.
export const AGENT_FAILURE_CODES = new Set(["aborted", "auth", "rate_limited", "tool_failed", "upstream", "network", "unknown",
	"key_refused", "stale_scene", "capability_missing", "busy", "invalid_request", "timeout", "truncated"]);

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

/** `{ name, code, status }` -> failure code. Foreign getters read as unknown. */
export function transportFailureCode(error) {
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

/** A refused turn: the sidecar's `{ error: { code } }` body plus the HTTP status. */
export async function refusalFailureCode(response) {
	let code;
	try { const body = await response.clone().json(); code = typeof body?.error?.code === "string" ? body.error.code : undefined; } catch { /* status alone */ }
	try { return transportFailureCode({ code, status: response?.status }); } catch { return "unknown"; }
}
