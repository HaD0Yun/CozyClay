// The connection test (bin/agent/connect-test.mjs): one small real request on a stored key or server address
// answers ok, key_rejected, unreachable, model_not_found, rate_limited, timeout or other, against a real local HTTP
// server playing each provider's wire format. The key never comes back in the answer.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { CONNECT_TEST_RESULTS, TESTABLE_PROVIDERS, classifyAnswer, pickModel, statusLine, testConnection } from "../bin/agent/connect-test.mjs";
import { TESTABLE_PROVIDERS as PANEL_TESTABLE } from "../src/workflow/connect-check.js";
import { strictPropValidator } from "../src/analytics-strict.js";

const KEY = "sk-test-SECRET-1234567890";
let mode = "ok";
const seen = [];
const server = createServer((req, res) => {
	let body = "";
	req.on("data", (chunk) => { body += chunk; });
	req.on("end", () => {
		seen.push({ url: req.url, auth: req.headers.authorization ?? req.headers["x-api-key"] ?? req.headers["x-goog-api-key"] ?? "", body });
		const send = (status, value) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
		if (mode === "hang") return;
		if (mode === "401") return send(401, { error: { message: `Incorrect API key provided: ${KEY}` } });
		if (mode === "html404" && req.url.endsWith("/models")) { res.writeHead(404, { "content-type": "text/html" }); return res.end("<html>nope</html>"); }
		if (/\/models(\?|$)/.test(req.url)) return req.url.includes("v1beta") ? send(200, { models: [{ name: "models/gemini-2.5-flash" }] }) : send(200, { data: [{ id: "llama3" }, { id: "qwen3" }] });
		if (mode === "429") return send(429, { error: { message: "You exceeded your current quota", type: "insufficient_quota" } });
		if (mode === "region") return send(403, { error: { message: "Country, region, or territory not supported" } });
		if (mode === "nomodel") return send(404, { type: "error", error: { type: "not_found_error", message: "model: claude-x" } });
		if (mode === "500") return send(500, { error: { message: "upstream exploded" } });
		return send(200, { choices: [{ message: { content: "OK" } }] });
	});
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const registry = (providerId, catalog, auth = { auth: { apiKey: KEY } }) => ({
	getAuth: async (id) => (id === providerId ? auth : undefined),
	getModels: (id) => (id === providerId ? catalog : []),
});
const compatible = registry("openai-compatible", [], { auth: { apiKey: KEY }, env: { OPENAI_COMPATIBLE_BASE_URL: base } });
const run = async (next, models, providerId, options = {}) => { mode = next; seen.length = 0; return testConnection(models, providerId, { timeoutMs: 1500, ...options }); };

try {
	let answer = await run("ok", compatible, "openai-compatible");
	assert.deepEqual([answer.result, answer.model], ["ok", "llama3"], "a custom server: listed, then one token on its first model");
	assert.ok(seen.some((call) => call.url === "/v1/chat/completions" && JSON.parse(call.body).max_tokens === 1), "the completion asks for one token");
	assert.ok(seen.every((call) => call.auth === `Bearer ${KEY}`), "the key goes only to the server it belongs to, as a Bearer header");

	answer = await run("ok", compatible, "openai-compatible", { modelId: "gpt-oss" });
	assert.deepEqual([answer.result, answer.models], ["model_not_found", ["llama3", "qwen3"]], "a model the server does not list: what it does serve");
	assert.equal(seen.some((call) => call.url.includes("chat")), false, "no completion is spent on a model that is not there");

	answer = await run("401", compatible, "openai-compatible");
	assert.equal(answer.result, "key_rejected");
	assert.equal(JSON.stringify(answer).includes(KEY), false, "the key the server echoed never comes back");

	answer = await run("html404", compatible, "openai-compatible");
	assert.equal(answer.result, "unreachable", "an address with no /v1/models is the wrong address");

	answer = await run("ok", registry("openai-compatible", [], { auth: { apiKey: "no-key" }, env: { OPENAI_COMPATIBLE_BASE_URL: "http://127.0.0.1:1" } }), "openai-compatible");
	assert.equal(answer.result, "unreachable", "nothing listening");
	assert.equal(seen.length, 0);

	answer = await run("hang", compatible, "openai-compatible");
	assert.equal(answer.result, "timeout", "a server that never answers is a timeout, inside the test's own limit");

	const openrouter = registry("openrouter", [{ id: "~anthropic/claude-haiku-latest", api: "anthropic-messages", baseUrl: base }, { id: "openai/gpt-mini", api: "openai-completions", baseUrl: `${base}/v1` }]);
	answer = await run("429", openrouter, "openrouter");
	assert.deepEqual([answer.result, answer.model], ["rate_limited", "openai/gpt-mini"], "quota; OpenRouter's default is a cheap chat-completions model");
	assert.equal(seen.some((call) => call.url.endsWith("/models")), false, "OpenRouter's public list is not read before the completion");

	const anthropic = registry("anthropic", [{ id: "claude-x", api: "anthropic-messages", baseUrl: base }]);
	answer = await run("nomodel", anthropic, "anthropic", { modelId: "claude-x" });
	assert.deepEqual([answer.result, answer.models], ["model_not_found", ["llama3", "qwen3"]], "anthropic: a refused model, then the list it serves");
	assert.ok(seen[0].auth === KEY && seen[0].url === "/v1/messages", "anthropic gets x-api-key on /v1/messages");

	answer = await run("region", anthropic, "anthropic");
	assert.equal(answer.result, "other", "a region refusal is not a bad key");
	assert.match(answer.detail, /^HTTP 403: Country, region/, "and says the provider's own line");

	const google = registry("google", [{ id: "gemini-2.5-pro", api: "google-generative-ai", baseUrl: `${base}/v1beta` }, { id: "gemini-2.5-flash", api: "google-generative-ai", baseUrl: `${base}/v1beta` }]);
	answer = await run("ok", google, "google");
	assert.deepEqual([answer.result, answer.model], ["ok", "gemini-2.5-flash"], "gemini: listed with x-goog-api-key, the cheap model");
	assert.ok(seen.some((call) => call.url.startsWith("/v1beta/models/gemini-2.5-flash:generateContent")));
	answer = await run("ok", google, "google", { modelId: "gemini-2.5-pro" });
	assert.deepEqual([answer.result, answer.models], ["model_not_found", ["gemini-2.5-flash"]], "a model this key cannot see");

	const openai = registry("openai", [{ id: "gpt-5-mini", api: "openai-responses", baseUrl: `${base}/v1` }]);
	answer = await run("ok", registry("openai", [{ id: "llama3", api: "openai-responses", baseUrl: `${base}/v1` }]), "openai");
	assert.equal(answer.result, "ok");
	assert.equal(JSON.parse(seen.at(-1).body).max_output_tokens, 16, "the Responses API's floor, not more");
	answer = await run("500", openai, "openai");
	assert.equal(answer.result, "model_not_found", "listed models decide first: gpt-5-mini is not on this server");

	answer = await testConnection(registry("google", []), "anthropic");
	assert.equal(answer.result, "key_rejected", "a provider with no stored credential");

	assert.equal(pickModel([{ id: "gemini-2.5-pro" }, { id: "gemini-2.5-flash" }]).id, "gemini-2.5-flash", "gemini is not a mini");

	// the classifier alone
	assert.equal(classifyAnswer({ status: 400, text: '{"error":{"status":"INVALID_ARGUMENT","details":[{"reason":"API_KEY_INVALID"}]}}' }), "key_rejected");
	assert.equal(classifyAnswer({ status: 402, text: "" }), "rate_limited");
	assert.equal(classifyAnswer({ status: 400, text: "The model `gpt-9` does not exist" }), "model_not_found");
	assert.equal(classifyAnswer({ error: Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } }) }), "unreachable");
	assert.equal(classifyAnswer({ status: 500, text: "" }), "other");
	assert.equal(statusLine(500, `{"error":{"message":"bad AIzaSyA1234567890abcdef key"}}`, ""), "HTTP 500: bad [key] key");
	assert.equal(pickModel([{ id: "a" }], "b"), null);

	// the panel and the sidecar agree on which providers are tested, and telemetry takes exactly the results
	assert.deepEqual([...PANEL_TESTABLE], [...TESTABLE_PROVIDERS]);
	const allowed = strictPropValidator("agent:connect_tested");
	for (const result of CONNECT_TEST_RESULTS) assert.ok(allowed("result", result), `agent:connect_tested takes ${result}`);
	assert.equal(allowed("result", "HTTP 401"), false);
	const routes = readFileSync(new URL("../bin/agent/provider-routes.mjs", import.meta.url), "utf8");
	assert.match(routes, /\\\/test\$/, "the sidecar route exists");
	const login = readFileSync(new URL("../src/workflow/LoginPanel.jsx", import.meta.url), "utf8");
	assert.match(login, /flow\.method\?\.type === "api_key" && isTestable\(flow\.provider\?\.id\) && <ConnectCheck/, "a finished key or address login is tested at once");
	console.log("PASS connection test: ok, key_rejected, unreachable, model_not_found (with served models), rate_limited, timeout, other; the key never returns");
} finally {
	server.close();
	server.closeAllConnections?.();
}
