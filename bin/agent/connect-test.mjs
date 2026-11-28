// The connection test (POST /agent/providers/:id/test): right after a key, a server address or a model changes,
// one small real request tells the author whether that connection answers, before the first real prompt does.
// It lists the models where the API can (the key, the address and the model name in one cheap call), then asks for
// one token (two for an anthropic-messages API, sixteen on OpenAI's Responses API, its floor), all inside one
// short timeout. The answer is a closed result plus, for `other`, the provider's own short status line with any
// key-like text removed. Nothing here logs, and the key only ever goes to the provider it belongs to.
import { NETWORK_CODES } from "./agent-failure-codes.mjs";

export const CONNECT_TEST_RESULTS = Object.freeze(["ok", "key_rejected", "unreachable", "model_not_found", "rate_limited", "timeout", "other"]);
// The providers whose key or address the author types; sign-ins (ChatGPT, Claude subscription) are tested by signing in.
export const TESTABLE_PROVIDERS = Object.freeze(["anthropic", "openai", "google", "minimax", "minimax-cn", "openrouter", "cliproxy", "openai-compatible"]);
const CONNECT_TEST_TIMEOUT_MS = 15_000;
const SHOWN_MODELS = 6;
// A model id the test reaches for when the panel names none: small and cheap first, then the catalogue's first.
const CHEAP = /(^|[-_/.])(mini|nano|haiku|flash|highspeed|small|lite)([-_.]|$)/i;
// ids a server lists that do not chat (images, embeddings, speech), never the default to try
const NOT_CHAT = /image|embed|whisper|tts|audio|rerank|moderation|auto-review/i;

const headersFor = (api, providerId, key) => {
	if (api === "google-generative-ai") return { "x-goog-api-key": key };
	if (api === "anthropic-messages") return providerId === "openrouter" ? { Authorization: `Bearer ${key}`, "anthropic-version": "2023-06-01" } : { "x-api-key": key, "anthropic-version": "2023-06-01" };
	return key ? { Authorization: `Bearer ${key}` } : {};
};

/** The list and the one-token request for each wire format pi speaks; `list` is null where no list call is cheap. */
function calls(model, providerId, key) {
	const base = String(model.baseUrl ?? "").replace(/\/+$/, "");
	const headers = { ...headersFor(model.api, providerId, key), "content-type": "application/json" };
	const ask = "Reply with OK.";
	if (model.api === "google-generative-ai") {
		return { list: { url: `${base}/models?pageSize=1000`, headers, ids: (body) => (body?.models ?? []).map((entry) => String(entry?.name ?? "").replace(/^models\//, "")) },
			complete: { url: `${base}/models/${encodeURIComponent(model.id)}:generateContent`, headers, body: { contents: [{ role: "user", parts: [{ text: ask }] }], generationConfig: { maxOutputTokens: 1 } } } };
	}
	if (model.api === "anthropic-messages") {
		return { list: null, listAfter: { url: `${base}/v1/models`, headers, ids: (body) => (body?.data ?? []).map((entry) => entry?.id) },
			complete: { url: `${base}/v1/messages`, headers, body: { model: model.id, max_tokens: 2, messages: [{ role: "user", content: ask }] } } };
	}
	const list = { url: `${base}/models`, headers, ids: (body) => (Array.isArray(body?.data) ? body.data : []).map((entry) => (typeof entry === "string" ? entry : entry?.id)) };
	// OpenRouter's list is public (it proves no key) and leaves out its ~aliases: it only names what is served after a refusal
	if (providerId === "openrouter") return { list: null, listAfter: list, complete: { url: `${base}/chat/completions`, headers, body: { model: model.id, messages: [{ role: "user", content: ask }], max_tokens: 1, stream: false } } };
	if (model.api === "openai-responses") return { list, complete: { url: `${base}/responses`, headers, body: { model: model.id, input: ask, max_output_tokens: 16, store: false } } };
	return { list, complete: { url: `${base}/chat/completions`, headers, body: { model: model.id, messages: [{ role: "user", content: ask }], max_tokens: 1, stream: false } } };
}

/** The provider's own short line for a refusal: its error message, never more than one line, with key-like text cut. */
export function statusLine(status, text, key) {
	let message;
	try {
		const body = JSON.parse(text);
		const error = Array.isArray(body) ? body[0]?.error : body?.error;
		message = typeof error === "string" ? error : error?.message ?? body?.message ?? body?.detail ?? "";
	} catch { message = /<html|<!doctype/i.test(text) ? "" : text; }
	let line = String(message ?? "").replace(/\s+/g, " ").trim();
	if (key && key.length >= 4) line = line.split(key).join("[key]");
	line = line.replace(/\b(sk|rk|pk)-[A-Za-z0-9_-]{6,}/g, "[key]").replace(/AIza[0-9A-Za-z_-]{10,}/g, "[key]").replace(/Bearer\s+\S+/gi, "Bearer [key]");
	if (line.length > 160) line = `${line.slice(0, 157)}...`;
	return line ? `HTTP ${status}: ${line}` : `HTTP ${status}`;
}

/** One HTTP answer (or a thrown fetch) -> a closed result. `step` is "list" or "complete". */
export function classifyAnswer({ status, text = "", error, step }) {
	if (error) {
		if (error.name === "TimeoutError" || error.name === "AbortError") return "timeout";
		const code = typeof error.code === "string" ? error.code : typeof error.cause?.code === "string" ? error.cause.code : "";
		if (NETWORK_CODES.has(code) || error.name === "TypeError") return "unreachable";
		return "other";
	}
	const lower = text.toLowerCase();
	const region = /region|country|location|territor|not available in your|unsupported_country/.test(lower);
	if (status === 401) return "key_rejected";
	if (status === 403) return region ? "other" : "key_rejected";
	if (status === 400 && /api_key_invalid|api key not valid|invalid[ _.-]?api[ _.-]?key|invalid x-api-key|incorrect api key/.test(lower)) return "key_rejected";
	if (status === 402 || status === 429 || (status >= 400 && status < 500 && /insufficient_quota|exceeded your current quota|quota|credit balance|out of credits/.test(lower))) return "rate_limited";
	if (status === 404 && step === "list") return "unreachable";
	if (status === 404 || ((status === 400 || status === 422) && /model[^.]{0,60}(not found|does not exist|not exist|unknown|not supported|invalid)|model_not_found|no such model|invalid model/.test(lower))) return "model_not_found";
	return "other";
}

async function request(fetchImpl, call, signal, method = "GET") {
	try {
		const response = await fetchImpl(call.url, { method, headers: call.headers, signal, ...(method === "POST" ? { body: JSON.stringify(call.body) } : {}) });
		return { status: response.status, ok: response.ok, text: await response.text().catch(() => "") };
	} catch (error) { return { error }; }
}

const parsedIds = (call, text) => { try { return call.ids(JSON.parse(text)).filter((id) => typeof id === "string" && id); } catch { return []; } };

/** The model the test asks: the one named (when this provider has it), else a cheap one from the catalogue or the list. */
export function pickModel(catalog, wanted, listed = []) {
	if (wanted) return catalog.find((model) => model.id === wanted) ?? null;
	const known = listed.length ? catalog.filter((model) => listed.includes(model.id)) : catalog;
	return known.find((model) => CHEAP.test(model.id)) ?? known[0] ?? null;
}

/**
 * Tests one stored connection. `models` is the sidecar's pi registry; `modelId` the model the author picked (bare id).
 * Resolves `{ result, model, models?, detail? }`: `models` (a few the server does serve) with model_not_found, `detail`
 * (a status line, an error code) when it helps; never the key, never the address in telemetry (the panel keeps it).
 */
export async function testConnection(models, providerId, { modelId, timeoutMs = CONNECT_TEST_TIMEOUT_MS, fetchImpl = globalThis.fetch } = {}) {
	const signal = AbortSignal.timeout(timeoutMs);
	const authResult = await models.getAuth(providerId).catch(() => undefined);
	if (!authResult) return { result: "key_rejected", model: modelId ?? null, detail: "not connected" };
	const key = String(authResult.auth?.apiKey ?? "").replace(/^no-key$/, "");
	let catalog = models.getModels(providerId) ?? [];
	// a custom server's model list is its own /v1/models: read it now, so a model loaded a minute ago is there
	if (providerId === "openai-compatible") {
		const base = authResult.env?.OPENAI_COMPATIBLE_BASE_URL;
		if (!base) return { result: "unreachable", model: modelId ?? null, detail: "no server address" };
		const listed = await request(fetchImpl, { url: `${base}/v1/models`, headers: headersFor("openai-completions", providerId, key) }, signal);
		const failed = listed.error || !listed.ok ? classifyAnswer({ ...listed, step: "list" }) : null;
		if (failed) return { result: failed, model: modelId ?? null, detail: listed.error ? (listed.error.cause?.code ?? listed.error.name) : statusLine(listed.status, listed.text, key) };
		const ids = parsedIds({ ids: (body) => (Array.isArray(body?.data) ? body.data : []).map((entry) => (typeof entry === "string" ? entry : entry?.id)) }, listed.text);
		if (modelId && !ids.includes(modelId)) return { result: "model_not_found", model: modelId, models: ids.slice(0, SHOWN_MODELS) };
		// a router's own ids before its namespaced upstreams (vendor/model), which may need upstream-specific headers
		const chat = ids.filter((entry) => !NOT_CHAT.test(entry)).sort((a, b) => Number(a.includes("/")) - Number(b.includes("/")));
		const id = modelId ?? chat.find((entry) => CHEAP.test(entry)) ?? chat[0] ?? ids[0];
		if (!id) return { result: "model_not_found", model: null, models: [] };
		catalog = [{ id, api: "openai-completions", baseUrl: `${base}/v1` }];
		return complete(fetchImpl, catalog[0], providerId, key, signal, ids);
	}
	const pool = !modelId && providerId === "openrouter" ? catalog.filter((entry) => entry.api === "openai-completions") : catalog;
	let model = pickModel(pool, modelId);
	if (!model) return { result: "model_not_found", model: modelId ?? null, models: catalog.slice(0, SHOWN_MODELS).map((entry) => entry.id) };
	let plan = calls(model, providerId, key);
	let ids = [];
	if (plan.list) {
		const listed = await request(fetchImpl, plan.list, signal);
		const failed = listed.error || !listed.ok ? classifyAnswer({ ...listed, step: "list" }) : null;
		if (failed) return { result: failed, model: model.id, detail: listed.error ? (listed.error.cause?.code ?? listed.error.name) : statusLine(listed.status, listed.text, key) };
		ids = parsedIds(plan.list, listed.text);
		// with no model named, a cheap one this key can actually see
		const seen = !modelId && ids.length ? pickModel(pool, undefined, ids) : null;
		if (seen && seen !== model) { model = seen; plan = calls(model, providerId, key); }
		if (ids.length && !ids.includes(model.id)) return { result: "model_not_found", model: model.id, models: ids.slice(0, SHOWN_MODELS) };
	}
	return complete(fetchImpl, model, providerId, key, signal, ids, plan);
}

async function complete(fetchImpl, model, providerId, key, signal, ids, plan = calls(model, providerId, key)) {
	const answer = await request(fetchImpl, plan.complete, signal, "POST");
	if (!answer.error && answer.ok) return { result: "ok", model: model.id };
	const result = classifyAnswer({ ...answer, step: "complete" });
	const detail = answer.error ? (answer.error.cause?.code ?? answer.error.name) : statusLine(answer.status, answer.text, key);
	if (result !== "model_not_found") return { result, model: model.id, detail };
	// what the server does serve, when it says so (an anthropic-messages API lists only after the refusal)
	let served = ids;
	if (!served.length && plan.listAfter) {
		const listed = await request(fetchImpl, plan.listAfter, signal);
		served = listed.ok ? parsedIds(plan.listAfter, listed.text) : [];
	}
	return { result, model: model.id, models: served.filter((id) => id !== model.id).slice(0, SHOWN_MODELS), detail };
}
