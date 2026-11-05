// The provider call behind every model request of the agent runner (agent-runner.mjs). pi-agent-core 1.x's Agent does
// not retry a failed request (the removed AgentHarness did), so one request is retried here, in place:
//   - a transient failure, by pi-ai's own isRetryableAssistantError (429, 5xx, overload, dropped connections) or a
//     408 / 5xx status pi-ai's word list leaves out (521, 522, 523, 530, ...), up to RETRY_POLICY.maxRetries times with
//     pi-ai's backoff (1 s, 2 s, 4 s, 8 s: 15 s in all, #1043; three tries gave 7 s against overloads that clear in
//     ~10 s, #975; a rate limit keeps three), or as long as the provider asks (a Retry-After / retry-after-ms header, "retry after 8 s", "try
//     again in 2.5s"), capped at RETRY_HINT_CAP_MS, or at QUOTA_WAIT_MAX_MS for a rate limit, a wait that long once per
//     request; a rate limit whose provider asks for more than QUOTA_WAIT_MAX_MS is final at once, so the panel can
//     show that wait and offer another provider instead of a minute of retries the provider already refused;
//   - a Gemini request that ended on a finish reason a fresh sample usually clears (MALFORMED_FUNCTION_CALL, ...):
//     pi-ai reads it as a final error, so it ended the turn as "upstream" (#1043);
//   - a quota refusal pi-ai will not retry (its "quota exceeded" / "billing" words) that names a short wait, e.g.
//     Gemini's per-minute free tier ("Please retry in 37s"): once, after that wait (#1043);
//   - an expired Codex sign-in (401), once per turn, after a forced credential refresh (refreshAuth, the runner's).
// An attempt is retried only while no answer of it reached the Agent: its events are held until its first content
// event, so the transcript and the panel only ever see the attempt that answered. Reasoning is forwarded as it streams
// and does not commit the attempt (#1043: a stream that dropped after its reasoning ended the turn); the retried
// attempt's own start event is then dropped, its partial message replaces the failed one. A retried request carries
// the same context, so no failed assistant message is stored and no completed tool runs again.

const RETRY_POLICY = Object.freeze({ maxRetries: 4, baseDelayMs: 1000 });
// A rate limit that named no wait keeps the three tries it had (7 s): the extra one is for overloads, and a quota's
// card should not wait longer to say so.
const RATE_LIMIT_RETRIES = 3;
const RETRY_HINT_CAP_MS = 20_000;
const QUOTA_WAIT_MAX_MS = 60_000;
// "retry in 37.5s", "try again in 750ms", and the ChatGPT usage limit's "Try again in ~38 min." (pi-ai's Codex adapter).
const RETRY_HINT = /(?:retry|try again)\D{0,12}?(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?)\b/i;
const UNIT_MS = (unit) => (/^ms|^milli/i.test(unit) ? 1 : /^s/i.test(unit) ? 1000 : /^m/i.test(unit) ? 60_000 : 3_600_000);
// google.rpc.RetryInfo in a Gemini error body: "retryDelay": "37s".
const RETRY_DELAY_FIELD = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/;
const RATE_LIMITED = /(?<![a-z0-9])429(?![a-z0-9])|rate.?limit|too many requests|resource.?exhausted|quota|usage limit/i;
// The HTTP status a failed message leads with, as pi-ai and the SDKs fold it: "503 ...", "522: <body>",
// "OpenAI API error (522): ...", Gemini's "got status: 503 ...". A number elsewhere in a body is never read.
// The bracketed form must be "(NNN):", so "Image too large (523 KB)" or "(512 tokens over)" is no status.
const LEADING_STATUS = /^(?:got status: )?([1-5]\d\d)(?=[\s:)]|$)|^[^\n(:]{0,80}\(([1-5]\d\d)\):/;
// The statuses the OpenAI and Anthropic SDKs retry (pi-ai's provider-retry.js) that its message word list can miss: a
// request timeout and any 5xx but 501 (not implemented) and 505 (HTTP version). 429 stays with pi-ai, which tells
// a billing refusal from a throttle.
const TRANSIENT_STATUS = (status) => status === 408 || (status >= 500 && status <= 599 && status !== 501 && status !== 505);
const leadingStatus = (text) => { const match = LEADING_STATUS.exec(text); return Number(match?.[1] ?? match?.[2]); };
// The wait a failed HTTP answer asked for in its headers, per the SDKs' order: retry-after-ms, then Retry-After as
// seconds or an HTTP date. Undefined when it named none.
export function headerRetryAfterMs(headers) {
	try {
		const ms = Number.parseFloat(headers?.get?.("retry-after-ms") ?? "");
		if (Number.isFinite(ms) && ms >= 0) return Math.ceil(ms);
		const value = headers?.get?.("retry-after");
		if (!value) return undefined;
		const seconds = Number(value);
		const wait = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
		return Number.isFinite(wait) ? Math.max(0, Math.ceil(wait)) : undefined;
	} catch { return undefined; }
}
// pi-ai drops a failed response's headers, so the request's fetch is wrapped to keep a failed answer's wait. Only the
// adapters that take a caller's fetch get it: the Google ones refuse one.
const FETCH_APIS = new Set(["openai-completions", "openai-responses", "openai-codex-responses", "azure-openai-responses", "anthropic-messages", "mistral-conversations"]);
// Gemini finish reasons pi-ai turns into "Provider stopped with: <reason>" that a new sample usually answers.
// SAFETY, RECITATION, BLOCKLIST and the like are the content's, and stay final.
const RESAMPLE_STOP = /Provider stopped with: (?:MALFORMED_FUNCTION_CALL|UNEXPECTED_TOOL_CALL|FINISH_REASON_UNSPECIFIED|OTHER)\b/;

/** The wait a failed message names, in ms, uncapped: its response's Retry-After header (`serverRetryAfterMs`), else its
 * text ("retry in 37.5s", "Try again in ~38 min", Gemini's retryDelay); 0 when it names none. */
export function retryAfterMs(message) {
	const header = message?.serverRetryAfterMs;
	if (Number.isFinite(header) && header > 0) return Math.ceil(header);
	const text = String(message?.errorMessage ?? "");
	const match = RETRY_HINT.exec(text);
	const field = RETRY_DELAY_FIELD.exec(text);
	const ms = match ? Number(match[1]) * UNIT_MS(match[2]) : field ? Number(field[1]) * 1000 : 0;
	return Number.isFinite(ms) && ms > 0 ? Math.ceil(ms) : 0;
}

/** The wait a failed message asks for, in ms (capped), or 0 when it names none. */
export function retryHintMs(message) {
	return Math.min(retryAfterMs(message), RETRY_HINT_CAP_MS);
}

/** Why a failed attempt may be tried again: "transient", "resample", "quota_wait", or null (final). */
export function retryKind(ai, message) {
	if (message?.stopReason !== "error") return null;
	const text = String(message.errorMessage ?? "");
	const wait = retryAfterMs(message);
	// A rate limit whose provider asked for more than a minute: retrying sooner is refused again.
	if (RATE_LIMITED.test(text) && wait > QUOTA_WAIT_MAX_MS) return null;
	if (ai.isRetryableAssistantError(message) || TRANSIENT_STATUS(leadingStatus(text))) return "transient";
	if (RESAMPLE_STOP.test(text)) return "resample";
	return RATE_LIMITED.test(text) && wait > 0 ? "quota_wait" : null;
}

/** How long to wait before retry `retries + 1` of a `kind` failure. */
function retryWaitMs(ai, kind, message, retries) {
	const asked = retryAfterMs(message);
	if (kind === "quota_wait") return asked;
	const cap = RATE_LIMITED.test(String(message?.errorMessage ?? "")) ? QUOTA_WAIT_MAX_MS : RETRY_HINT_CAP_MS;
	return Math.max(ai.retryDelayMs(RETRY_POLICY, retries + 1), Math.min(asked, cap));
}

const CONTENT_EVENT = /^(text|thinking|toolcall)_/;
// The events that commit an attempt: an answer or a tool call the Agent will act on. Reasoning alone does not.
const ANSWER_EVENT = /^(text|toolcall)_/;
const EMPTY_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

/** Resolves after `ms`, or as soon as `signal` aborts. */
function pause(ms, signal) {
	return new Promise((resolve) => {
		if (signal?.aborted) { resolve(); return; }
		const timer = setTimeout(done, ms);
		function done() { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); }
		signal?.addEventListener("abort", done, { once: true });
	});
}

/** The thrown error's structure a string would lose: its own code, its cause's, or a fetch TypeError. Never the message. */
function structuredCode(error) {
	try {
		if (typeof error?.code === "string" && error.code) return error.code;
		if (typeof error?.cause?.code === "string" && error.cause.code) return error.cause.code;
		return error?.name === "TypeError" ? "TypeError" : undefined;
	} catch { return undefined; }
}

/** An assistant message for a request that never produced one (pi-ai throws when a request has no credential). */
function failedMessage(model, error, signal) {
	const errorCode = structuredCode(error);
	return {
		role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: EMPTY_USAGE,
		stopReason: signal?.aborted ? "aborted" : "error",
		errorMessage: error instanceof Error ? error.message : String(error),
		...(errorCode ? { errorCode } : {}),
		timestamp: Date.now(),
	};
}

/**
 * The Agent's streamFn. `ai` is @earendil-works/pi-ai, `models` the registry the request runs on. `refreshAuth(model,
 * message)` decides whether a failed attempt earns a credential refresh and one more try (it refreshes before answering
 * true); `onAttempt(message)` sees every attempt's final message, failed ones included.
 */
export function createRetryingStream({ ai, models, refreshAuth = async () => false, onAttempt = () => {} }) {
	return (model, context, options = {}) => {
		const { signal } = options;
		const out = ai.createAssistantMessageEventStream();
		// A quota wait, or any wait longer than RETRY_HINT_CAP_MS (a rate limit's own), is taken once per request: a second
		// refusal is the quota's answer.
		let longWaited = false;
		const shouldRetry = async (message, retries) => {
			const limit = RATE_LIMITED.test(String(message?.errorMessage ?? "")) ? RATE_LIMIT_RETRIES : RETRY_POLICY.maxRetries;
			if (retries >= limit || signal?.aborted) return false;
			const kind = retryKind(ai, message);
			if (kind) {
				const wait = retryWaitMs(ai, kind, message, retries);
				if (kind === "quota_wait" || wait > RETRY_HINT_CAP_MS) { if (longWaited) return false; longWaited = true; }
				await pause(wait, signal);
				return !signal?.aborted;
			}
			return refreshAuth(model, message);
		};
		// The Agent opens one partial message per request: a retried attempt's own start is not sent again.
		let started = false;
		const forward = (event) => {
			if (event.type === "start") { if (started) return; started = true; }
			out.push(event);
		};
		const finish = (message, held = []) => {
			for (const early of held) forward(early);
			const failed = message.stopReason === "error" || message.stopReason === "aborted";
			out.push(failed ? { type: "error", reason: message.stopReason, error: message } : { type: "done", reason: message.stopReason, message });
			out.end();
		};
		void (async () => {
			for (let retries = 0; ; retries += 1) {
				// The Agent asks for the next request even after a cancelled tool: an aborted run makes no further model call.
				if (signal?.aborted) { finish(failedMessage(model, new Error("Request was aborted"), signal)); return; }
				const held = [];
				let forwarding = false;
				let answered = false;
				let message;
				let serverWait;
				// globalThis.fetch is read per call: the Codex response observer (providers.mjs) wraps it.
				const fetch = async (input, init) => {
					const response = await globalThis.fetch(input, init);
					if (!response.ok) serverWait = headerRetryAfterMs(response.headers);
					return response;
				};
				try {
					const response = await models.streamSimple(model, context, FETCH_APIS.has(model?.api) && !options.fetch ? { ...options, fetch } : options);
					for await (const event of response) {
						if (event.type === "done" || event.type === "error") break;
						if (ANSWER_EVENT.test(event.type)) answered = true;
						if (forwarding) { forward(event); continue; }
						held.push(event);
						if (CONTENT_EVENT.test(event.type)) { forwarding = true; for (const early of held.splice(0)) forward(early); }
					}
					message = await response.result();
				} catch (error) {
					message = failedMessage(model, error, signal);
				}
				if (message.stopReason === "error" && serverWait !== undefined) message = { ...message, serverRetryAfterMs: serverWait };
				onAttempt(message);
				if (!answered && message.stopReason === "error" && await shouldRetry(message, retries)) continue;
				// An abort that landed during a backoff ends the request as aborted, like any other cancellation.
				finish(message.stopReason === "error" && signal?.aborted ? { ...message, stopReason: "aborted" } : message, held);
				return;
			}
		})();
		return out;
	};
}
