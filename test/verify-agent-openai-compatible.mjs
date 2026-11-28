#!/usr/bin/env node
// A custom OpenAI-compatible endpoint (#885), against a local fake server that speaks LM Studio's / Ollama's
// OpenAI surface (GET /v1/models, POST /v1/chat/completions with SSE), through the routes the panel uses:
// 1. Connect a model lists the lane; its login takes an address (a pasted /v1 is fine) and no key, checks the
//    server, and stores the address in auth.json; /agent/models then lists the server's own models;
// 2. a turn on one of them streams through pi-ai's openai-completions API to the fake server;
// 3. a server that wants a key refuses the keyless login with a readable reason, and takes the key;
// 4. an unreachable address fails the login, and a server gone after connecting shows as the provider's error;
// 5. (#947) a generic model's request keeps its exact shape; a Kimi K3 model on Moonshot's host takes pi-ai's kimi-k3
//    template (reasoning_effort, a 131072 output limit, reasoning_content sent back, efforts low/high/max); a turn that
//    used its whole output limit before any answer is a truncated error; a 400 body stays readable.
// 6. (#1388) a server that takes the request and never answers fails as a timeout with a plain message after one more
//    try, not after Node's 300 s headers timeout five times; an answer that streams slowly past the deadline is not cut.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const rootDir = mkdtempSync(join(tmpdir(), "cozyclay-openai-compatible-"));
process.env.COZYCLAY_CONFIG_DIR = join(rootDir, "config");
process.env.COZYCLAY_CODEX_AUTH_FILE = join(rootDir, "config", "codex-auth.json");
process.env.COZYCLAY_AGENT_SESSIONS_DIR = join(rootDir, "sessions");

const [{ createAgentHandler }, keys, providers, { createAgentRunner }, { moonshotModel, isMoonshotBase }] = await Promise.all([
	import("../bin/agent/agent-routes.mjs"),
	import("../bin/agent/provider-keys.mjs"),
	import("../bin/agent/providers.mjs"),
	import("../bin/agent/agent-runner.mjs"),
	import("../bin/agent/openai-compatible-provider.mjs"),
]);

let failures = 0;
const check = async (name, fn) => {
	try { await fn(); console.log(`PASS ${name}`); } catch (error) { failures += 1; console.log(`FAIL ${name} — ${error.stack || error.message}`); }
};
const listen = async (server) => { server.listen(0, "127.0.0.1"); await once(server, "listening"); return `http://127.0.0.1:${server.address().port}`; };
const close = async (server) => { const closed = once(server, "close"); server.close(); server.closeAllConnections(); await closed; };
const readAuthFile = () => { try { return JSON.parse(readFileSync(join(process.env.COZYCLAY_CONFIG_DIR, "auth.json"), "utf8")); } catch { return {}; } };

/** A fake OpenAI-compatible server; `key` makes it refuse requests without that bearer key. `fake.ids` is its model
 * list and `fake.mode` how it answers a chat request (#947): "reply", "kimi" (a reasoning tool call, then a reasoning
 * answer), "length-empty" (reasoning only, then the output limit), "length-partial" (some text, then the limit), "400",
 * "silent" (takes the request and never answers), "slow" (answers at once, then streams its words over ~1 s). */
function fakeServer({ key } = {}) {
	const seen = [];
	const fake = { server: null, seen, ids: ["fake-llama", "fake-qwen"], mode: "reply" };
	const kimiCall = { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "lookup", arguments: "{}" } }] };
	const chunk = (delta, finish = null) => `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 0, model: "fake-llama", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
	const server = createServer(async (req, res) => {
		let body = "";
		for await (const part of req) body += part;
		seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body: body ? JSON.parse(body) : null });
		if (key && req.headers.authorization !== `Bearer ${key}`) { res.writeHead(401, { "content-type": "application/json" }); res.end('{"error":{"message":"invalid api key"}}'); return; }
		if (req.method === "GET" && req.url === "/v1/models") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ object: "list", data: fake.ids.map((id) => ({ id, object: "model", owned_by: "library" })) }));
			return;
		}
		if (req.method === "POST" && req.url === "/v1/chat/completions") {
			if (fake.mode === "silent") return;
			if (fake.mode === "slow") {
				res.writeHead(200, { "content-type": "text/event-stream" });
				res.write(chunk({ role: "assistant" }));
				for (const word of ["Slow ", "but ", "steady"]) { await new Promise((resolve) => setTimeout(resolve, 350)); res.write(chunk({ content: word })); }
				res.write(chunk({}, "stop"));
				res.end("data: [DONE]\n\n");
				return;
			}
			if (fake.mode === "400") {
				res.writeHead(400, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: { message: "Invalid request: tools.function.parameters is not a valid moonshot flavored json schema, details: <At path 'properties.x': type is not defined>", type: "invalid_request_error" } }));
				return;
			}
			const followUp = seen.at(-1).body.messages.some((message) => message.role === "tool");
			const deltas = fake.mode === "kimi" ? (followUp ? [[{ reasoning_content: "Done." }], [{ content: "All set" }], [{}, "stop"]] : [[{ reasoning_content: "Look it up." }], [kimiCall], [{}, "tool_calls"]])
				: fake.mode === "length-empty" ? [[{ reasoning_content: "Thinking for a long time" }], [{}, "length"]]
					: fake.mode === "length-partial" ? [[{ content: "partial" }], [{}, "length"]]
						: [[{ content: "Hello " }], [{ content: "from fake" }], [{}, "stop"]];
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.write(chunk({ role: "assistant" }));
			for (const [delta, finish] of deltas) res.write(chunk(delta, finish));
			res.end("data: [DONE]\n\n");
			return;
		}
		res.writeHead(404); res.end();
	});
	fake.server = server;
	return fake;
}

const auth = { readStored() {}, writeStored() {}, logout() {}, status() { return { signedIn: false }; }, getAccessToken: async () => null };
const models = await providers.createModels({ auth, keys, env: {} });
const handler = createAgentHandler({ auth, models, liveHub: {}, port: () => sidecar.address().port, env: {} });
const sidecar = createServer((req, res) => handler(req, res).catch((error) => { res.writeHead(500); res.end(error.message); }));
const origin = await listen(sidecar);
const request = async (path, init = {}) => {
	const response = await fetch(`${origin}${path}`, { ...init, headers: { origin, ...(init.body ? { "content-type": "application/json" } : {}) } });
	return { status: response.status, body: await response.json().catch(() => null) };
};
/** Runs the lane's login over the panel's routes, answering its two prompts; returns pi's done entry. */
async function connect(address, key) {
	const answers = [address, key];
	const { body: started } = await request("/agent/logins", { method: "POST", body: JSON.stringify({ providerId: "openai-compatible", type: "api_key" }) });
	let after = 0;
	for (;;) {
		const { body } = await request(`/agent/logins/${started.flowId}?after=${after}`);
		for (const entry of body.events) {
			if (entry.type === "done") return entry;
			if (entry.type === "prompt") await request(`/agent/logins/${started.flowId}/answer`, { method: "POST", body: JSON.stringify({ promptId: entry.promptId, value: answers.shift() }) });
		}
		after = body.next;
	}
}
const lane = async () => (await request("/agent/models")).body.providers.find((entry) => entry.id === "openai-compatible");

const open = fakeServer();
const openBase = await listen(open.server);

await check("Connect a model lists the lane; a keyless login stores the address and /agent/models lists the server's models", async () => {
	const listed = (await request("/agent/logins")).body.providers.find((entry) => entry.id === "openai-compatible");
	assert.deepEqual(listed.methods.map((method) => method.type), ["api_key"]);
	assert.equal(listed.connected, false);
	assert.equal((await lane()).signedIn, false);
	const done = await connect(`${openBase}/v1/`, "");
	assert.equal(done.ok, true, done.message);
	assert.deepEqual(readAuthFile()["openai-compatible"], { type: "api_key", key: "", env: { OPENAI_COMPATIBLE_BASE_URL: openBase } });
	assert.equal(open.seen.at(-1).authorization, undefined, "no key, no Authorization header on the check");
	const entry = await lane();
	assert.equal(entry.signedIn, true);
	assert.equal(entry.error, undefined);
	assert.deepEqual(entry.models.map((model) => model.key).sort(), ["openai-compatible/fake-llama", "openai-compatible/fake-qwen"]);
	assert.equal((await request("/agent/providers/openai-compatible", { method: "PUT", body: JSON.stringify({ key: "k" }) })).status, 400, "a bare key without an address is refused");
});

await check("a turn on a listed model streams through openai-completions to the server", async () => {
	// a fresh registry has not read /v1/models yet: the turn's model lookup reads it
	const runner = createAgentRunner({ models: await providers.createModels({ auth, keys, env: {} }), tools: [] });
	const session = await runner.openSession("openai-compatible-turn", { surface: "workflow" });
	const frames = [];
	for await (const frame of session.start({ text: "hi", model: "openai-compatible/fake-llama" })) frames.push(frame);
	await runner.close();
	assert.ok(frames.some((frame) => frame.type === "done"), JSON.stringify(frames));
	assert.ok(!frames.some((frame) => frame.type === "error"), JSON.stringify(frames));
	assert.equal(frames.filter((frame) => frame.type === "text.delta").map((frame) => frame.text).join(""), "Hello from fake");
	const call = open.seen.find((entry) => entry.url === "/v1/chat/completions");
	assert.equal(call.body.model, "fake-llama");
	assert.equal(call.body.stream, true);
	assert.equal(call.authorization, "Bearer no-key");
	// #947: every other server's model keeps exactly this request shape
	assert.deepEqual(Object.keys(call.body).sort(), ["max_tokens", "messages", "model", "stream", "stream_options"]);
	assert.equal(call.body.max_tokens, 8192);
	for (const field of ["reasoning_effort", "thinking", "temperature"]) assert.equal(field in call.body, false, field);
});

const lookupTool = { name: "lookup", label: "Lookup", description: "Looks something up.", parameters: { type: "object", properties: {}, additionalProperties: false }, handler: async () => ({ found: true }) };
/** One turn through the runner (a fresh registry unless one is given); returns its frames. */
async function turn(model, { registry, effort, tools = [], answerDeadlineMs } = {}) {
	const runner = createAgentRunner({ models: registry ?? await providers.createModels({ auth, keys, env: {} }), tools, answerDeadlineMs });
	const session = await runner.openSession(`openai-compatible-${Math.random()}`, { surface: "workflow" });
	const frames = [];
	for await (const frame of session.start({ text: "hi", model, ...(effort ? { effort } : {}) })) frames.push(frame);
	await runner.close();
	return frames;
}
/** The real registry, except that this server's Kimi K3 models get the shape they get on Moonshot's own host: the fake
 * server cannot be api.moonshot.ai, so the host check is the one thing given (moonshotModel's third argument). */
async function asMoonshot(registry) {
	const kimi = new Map();
	for (const id of open.ids) { const model = await moonshotModel(id, openBase, true); if (model) kimi.set(id, model); }
	const swap = (model) => (model?.provider === "openai-compatible" && kimi.get(model.id)) || model;
	return new Proxy(registry, { get(target, prop) {
		if (prop === "getModel") return (provider, id) => swap(target.getModel(provider, id));
		if (prop === "getModels") return (provider) => target.getModels(provider).map(swap);
		const value = Reflect.get(target, prop, target);
		return typeof value === "function" ? value.bind(target) : value;
	} });
}

await check("#947: a Kimi K3 model on Moonshot's host takes pi-ai's kimi-k3 template; any other model or host does not", async () => {
	for (const base of ["https://api.moonshot.ai", "https://api.moonshot.cn/"]) assert.equal(isMoonshotBase(base), true, base);
	for (const base of [openBase, "https://api.moonshot.ai.example.com", "https://moonshot.ai", "not a url"]) assert.equal(isMoonshotBase(base), false, base);
	const model = await moonshotModel("kimi-k3.1-pro", "https://api.moonshot.ai");
	assert.equal(model.id, "kimi-k3.1-pro"); assert.equal(model.name, "kimi-k3.1-pro");
	assert.equal(model.provider, "openai-compatible"); assert.equal(model.api, "openai-completions");
	assert.equal(model.baseUrl, "https://api.moonshot.ai/v1");
	assert.equal(model.reasoning, true);
	assert.equal(model.maxTokens, 131072);
	assert.equal(model.compat.requiresReasoningContentOnAssistantMessages, true);
	assert.equal(model.compat.supportsReasoningEffort, true);
	assert.equal(model.compat.maxTokensField, "max_tokens");
	assert.equal(model.thinkingLevelMap.off, null);
	assert.equal((await moonshotModel("kimi-k3", "https://api.moonshot.cn")).baseUrl, "https://api.moonshot.cn/v1");
	for (const [id, base] of [["moonshot-v1-8k", "https://api.moonshot.ai"], ["kimi-latest", "https://api.moonshot.ai"], ["kimi-k3.1-pro", openBase]]) assert.equal(await moonshotModel(id, base), null, `${id} on ${base}`);
});

await check("#947: a Kimi K3 turn sends reasoning_effort and 131072, and sends reasoning_content back after a tool call", async () => {
	open.ids = ["fake-llama", "fake-qwen", "kimi-k3.1-pro"];
	open.mode = "kimi";
	const before = open.seen.length;
	const registry = await asMoonshot(await providers.createModels({ auth, keys, env: {} }));
	const frames = await turn("openai-compatible/kimi-k3.1-pro", { registry, effort: "high", tools: [lookupTool] });
	open.mode = "reply";
	assert.ok(!frames.some((frame) => frame.type === "error"), JSON.stringify(frames));
	assert.equal(frames.filter((frame) => frame.type === "text.delta").map((frame) => frame.text).join(""), "All set");
	assert.ok(frames.some((frame) => frame.type === "tool.done" && frame.ok), JSON.stringify(frames));
	const [first, second] = open.seen.slice(before).filter((entry) => entry.url === "/v1/chat/completions").map((entry) => entry.body);
	assert.deepEqual(Object.keys(first).sort(), ["max_tokens", "messages", "model", "reasoning_effort", "stream", "stream_options", "tools"]);
	assert.equal(first.model, "kimi-k3.1-pro");
	assert.equal(first.reasoning_effort, "high");
	assert.equal(first.max_tokens, 131072);
	assert.deepEqual(Object.keys(first.tools[0].function).sort(), ["description", "name", "parameters"], "the tool schema goes out untouched");
	const assistant = second.messages.find((message) => message.role === "assistant");
	assert.equal(assistant.reasoning_content, "Look it up.");
	assert.equal(assistant.tool_calls[0].id, "call_1");
});

await check("#947: /agent/models offers a Kimi K3 model low/high/max (no none); every other model keeps none", async () => {
	open.ids = ["fake-llama", "fake-qwen", "kimi-k3.1-pro"];
	const registry = await asMoonshot(await providers.createModels({ auth, keys, env: {} }));
	const moonshotHandler = createAgentHandler({ auth, models: registry, liveHub: {}, port: () => server.address().port, env: {} });
	const server = createServer((req, res) => moonshotHandler(req, res).catch((error) => { res.writeHead(500); res.end(error.message); }));
	const base = await listen(server);
	const listed = await (await fetch(`${base}/agent/models`, { headers: { origin: base } })).json();
	await close(server);
	const byId = Object.fromEntries(listed.providers.find((entry) => entry.id === "openai-compatible").models.map((model) => [model.id, model]));
	assert.deepEqual(byId["kimi-k3.1-pro"].efforts, ["low", "high", "max"]);
	assert.equal(byId["kimi-k3.1-pro"].defaultEffort, "low");
	assert.deepEqual(byId["fake-llama"].efforts, ["none"]);
	// the same id from any other host is the generic shape
	assert.deepEqual((await lane()).models.find((model) => model.id === "kimi-k3.1-pro").efforts, ["none"]);
	open.ids = ["fake-llama", "fake-qwen"];
});

await check("#947: a turn that used its whole output limit before any answer is a truncated error; with some text it completes", async () => {
	open.mode = "length-empty";
	const empty = await turn("openai-compatible/fake-llama");
	open.mode = "length-partial";
	const partial = await turn("openai-compatible/fake-llama");
	open.mode = "reply";
	const error = empty.find((frame) => frame.type === "error");
	assert.equal(error?.code, "truncated", JSON.stringify(empty));
	assert.equal(error.message, "The model used all 8192 output tokens before answering. Lower the reasoning effort or raise the output limit.");
	assert.ok(empty.some((frame) => frame.type === "done"));
	assert.ok(!partial.some((frame) => frame.type === "error"), JSON.stringify(partial));
	assert.equal(partial.filter((frame) => frame.type === "text.delta").map((frame) => frame.text).join(""), "partial");
});

await check("#947: a 400 from the server shows its body in the error frame", async () => {
	open.mode = "400";
	const frames = await turn("openai-compatible/fake-llama");
	open.mode = "reply";
	const error = frames.find((frame) => frame.type === "error");
	assert.ok(error, JSON.stringify(frames));
	assert.match(error.message, /moonshot flavored json schema/);
	assert.match(error.message, /At path 'properties\.x'/);
});

await check("#1388: a server that never answers fails as timeout with a plain message after one more try; a slow stream is not cut", async () => {
	const { ANSWER_DEADLINE_MS, TIMEOUT_MESSAGE } = await import("../bin/agent/agent-stream.mjs");
	assert.ok(ANSWER_DEADLINE_MS * 2 <= 130_000, "about 2 minutes in all for a server that never answers");
	open.mode = "silent";
	const before = open.seen.filter((entry) => entry.url === "/v1/chat/completions").length;
	const started = Date.now();
	const silent = await turn("openai-compatible/fake-llama", { answerDeadlineMs: 300 });
	const took = Date.now() - started;
	const tries = open.seen.filter((entry) => entry.url === "/v1/chat/completions").length - before;
	open.mode = "slow";
	const slow = await turn("openai-compatible/fake-llama", { answerDeadlineMs: 300 });
	open.mode = "reply";
	const error = silent.find((frame) => frame.type === "error");
	assert.equal(error?.code, "timeout", JSON.stringify(silent));
	assert.equal(error.message, TIMEOUT_MESSAGE);
	assert.doesNotMatch(error.message, /undici|fetch failed|Headers Timeout|Connection error/i);
	assert.ok(silent.some((frame) => frame.type === "done"));
	assert.equal(tries, 2, "the request was sent twice: the first try and one more");
	assert.ok(took < 5000, `gave up in ${took} ms`);
	assert.ok(!slow.some((frame) => frame.type === "error"), JSON.stringify(slow));
	assert.equal(slow.filter((frame) => frame.type === "text.delta").map((frame) => frame.text).join(""), "Slow but steady");
});

const locked = fakeServer({ key: "secret-1" });
const lockedBase = await listen(locked.server);

await check("a server that wants a key refuses the keyless login with a reason, then connects with the key", async () => {
	const refused = await connect(lockedBase, "");
	assert.equal(refused.ok, false);
	assert.match(refused.message, /refused a request without a key \(401\)/);
	const done = await connect(lockedBase, "secret-1");
	assert.equal(done.ok, true, done.message);
	assert.equal(readAuthFile()["openai-compatible"].key, "secret-1");
	const entry = await lane();
	assert.equal(entry.error, undefined);
	assert.equal(entry.models.length, 2);
	assert.equal(locked.seen.at(-1).authorization, "Bearer secret-1");
});

await check("an unreachable address fails the login; a server gone after connecting is the provider's error", async () => {
	const gone = createServer();
	const goneBase = await listen(gone);
	await close(gone);
	const refused = await connect(goneBase, "");
	assert.equal(refused.ok, false);
	assert.match(refused.message, /Could not reach .*\/v1\/models \(ECONNREFUSED\)/);
	await close(locked.server);
	const entry = await lane();
	assert.equal(entry.signedIn, true);
	assert.match(entry.error, /Could not reach .*\/v1\/models/);
	assert.equal((await request("/agent/logout/openai-compatible", { method: "POST" })).status, 200);
	assert.equal(readAuthFile()["openai-compatible"], undefined);
	assert.equal((await lane()).signedIn, false);
});

await close(open.server);
await close(sidecar);
rmSync(rootDir, { recursive: true, force: true });
if (failures) { console.error(`${failures} OpenAI-compatible endpoint check(s) failed`); process.exit(1); }
console.log("verify-agent-openai-compatible: all checks passed");
