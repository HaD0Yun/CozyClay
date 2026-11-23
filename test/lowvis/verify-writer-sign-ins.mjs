#!/usr/bin/env node
// The motion writer on each kind of sign-in the model picker has (bin/agent/providers.mjs PROVIDERS), with nothing else
// set: an API key (the motion model's own provider, and providers of other model families), an OAuth sign-in (ChatGPT;
// the Claude subscription, whose requests the Claude Code binary sends), a server sign-in that carries its address
// (CLIProxyAPI, an OpenAI-compatible server). Each run goes through the harness (src/lowvis/pi/harness.mjs) on the
// route bin/agent/motion-writer.mjs chose, against a local server in that provider's wire format (the subscription: the
// SDK boundary faked, as test/verify-anthropic-subscription.mjs does): the request reaches the provider with the stored
// credential, the model the answer names, the writer's manual and its one tool, and the effort where that provider's
// layer puts it. Then what a failing provider leaves: the answer names the writer, and no key or address is kept.
//   node test/lowvis/verify-writer-sign-ins.mjs
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";

for (const name of Object.keys(process.env)) if (/_API_KEY$|^CLIPROXY_|^COZYCLAY_MOTION_/.test(name)) delete process.env[name];
const TMP = mkdtempSync(join(tmpdir(), "writer-sign-ins-"));
process.env.COZYCLAY_CONFIG_DIR = join(TMP, "config-0");
const [{ createModels }, keys, { writerRoute }, { runMotion }, { runScene }, { createSubscriptionStream }, { createProvider }] = await Promise.all([
	import("../../bin/agent/providers.mjs"), import("../../bin/agent/provider-keys.mjs"), import("../../bin/agent/motion-writer.mjs"), import("../../bin/agent/motion-run.mjs"),
	import("../../src/lowvis/pi/harness.mjs"), import("../../bin/agent/anthropic-subscription-stream.mjs"), import("@earendil-works/pi-ai"),
]);

const REPORT = "Nothing was made.\nMissing: everything";
const events = list => list.map(event => `${event.type ? `event: ${event.type}\n` : ""}data: ${JSON.stringify(event)}\n\n`).join("");
/**
 * A provider's server in every wire format the picker's providers use: its model list, and a scripted writer (one
 * motion call, then a report). served: the model ids it lists; servedAs: the name its answers give the model;
 * refuse: { at, status, body }, the model request (1-based) it refuses.
 */
async function provider({ served = [], servedAs = null, refuse = null } = {}) {
	const requests = [];
	const server = createServer(async (req, res) => {
		const chunks = [];
		for await (const chunk of req) chunks.push(Buffer.from(chunk));
		const path = new URL(req.url, "http://local").pathname, raw = Buffer.concat(chunks);
		if (req.method === "GET") { res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: served.map(id => ({ id, owned_by: id.startsWith("claude") ? "anthropic" : "openai" })) })); return; }
		const text = (req.headers["content-encoding"] === "zstd" ? zstdDecompressSync(raw) : raw).toString("utf8"), body = JSON.parse(text);
		requests.push({ path, text, body, key: req.headers["x-api-key"] ?? req.headers["x-goog-api-key"] ?? String(req.headers.authorization ?? "").replace(/^Bearer /, "") });
		if (refuse && requests.length === refuse.at) { res.writeHead(refuse.status, { "content-type": "application/json" }).end(JSON.stringify(refuse.body)); return; }
		res.writeHead(200, { "content-type": "text/event-stream" });
		if (path.endsWith("/messages")) {
			const step = body.messages.filter(message => message.role === "assistant").length;
			res.end(events([
				{ type: "message_start", message: { id: `msg-${step}`, type: "message", role: "assistant", content: [], model: servedAs ?? body.model, stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0, cache_read_input_tokens: step ? 80 : 0, cache_creation_input_tokens: step ? 5 : 80 } } },
				{ type: "content_block_start", index: 0, content_block: step ? { type: "text", text: "" } : { type: "tool_use", id: "w-1", name: "motion", input: {} } },
				{ type: "content_block_delta", index: 0, delta: step ? { type: "text_delta", text: REPORT } : { type: "input_json_delta", partial_json: "{}" } },
				{ type: "content_block_stop", index: 0 },
				{ type: "message_delta", delta: { stop_reason: step ? "end_turn" : "tool_use", stop_sequence: null }, usage: { output_tokens: 5 } },
				{ type: "message_stop" },
			]));
		} else if (path.endsWith("/responses")) {
			const after = (body.input ?? []).some(item => item.type === "function_call_output");
			const item = after ? { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: REPORT, annotations: [] }] } : { type: "function_call", id: "fc_1", call_id: "call_1", name: "motion", arguments: "{}", status: "completed" };
			res.end(events([
				{ type: "response.output_item.added", output_index: 0, item: after ? { ...item, content: [] } : { ...item, arguments: "" } },
				...(after ? [{ type: "response.content_part.added", output_index: 0, content_index: 0, item_id: "msg_1", part: { type: "output_text", text: "", annotations: [] } }, { type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: "msg_1", delta: REPORT }] : [{ type: "response.function_call_arguments.delta", output_index: 0, item_id: "fc_1", delta: "{}" }]),
				{ type: "response.output_item.done", output_index: 0, item },
				{ type: "response.completed", response: { id: "resp_1", status: "completed", model: body.model, output: [item], usage: { input_tokens: 100, output_tokens: 5, total_tokens: 105, input_tokens_details: { cached_tokens: after ? 80 : 0 } } } },
			]).replace(/^event: .*\n/gm, ""));
		} else if (path.endsWith("/chat/completions")) {
			const after = body.messages.some(message => message.role === "tool");
			const chunk = (delta, finish = null) => ({ id: "c1", object: "chat.completion.chunk", created: 0, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }], ...(finish ? { usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 } } : {}) });
			res.end(`${[chunk({ role: "assistant" }), chunk(after ? { content: REPORT } : { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "motion", arguments: "{}" } }] }), chunk({}, after ? "stop" : "tool_calls")].map(part => `data: ${JSON.stringify(part)}\n\n`).join("")}data: [DONE]\n\n`);
		} else {
			const after = (body.contents ?? []).some(content => (content.parts ?? []).some(part => part.functionResponse));
			res.end(`data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: after ? [{ text: REPORT }] : [{ functionCall: { name: "motion", args: {} } }] }, finishReason: "STOP", index: 0 }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 5, totalTokenCount: 105 } })}\n\n`);
		}
	});
	server.listen(0, "127.0.0.1"); await once(server, "listening");
	return { requests, base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}

let folders = 0;
/** A new config folder holding what a sign-in of the model picker stores: a bare key (providers.json) or a credential (auth.json). */
function signedIn({ key = null, credential = null } = {}) {
	process.env.COZYCLAY_CONFIG_DIR = join(TMP, `config-${++folders}`);
	if (key) keys.setKey(...key);
	if (credential) keys.setCredential(...credential);
}
const noChatGpt = { readStored: () => undefined, status: () => ({ signedIn: false }), getAccessToken: async () => null };
const registry = options => createModels({ auth: noChatGpt, env: {}, ...options });
/** Points a provider's models at the local server (what providers.mjs loadProvider does with a base address). */
function at(models, id, baseOf) {
	const entry = models.getProvider(id), listed = entry.getModels.bind(entry);
	entry.getModels = () => listed().map(model => ({ ...model, baseUrl: baseOf(model) }));
	models.setProvider(entry);
}
const outDir = () => join(TMP, `run-${++folders}`);
const written = folder => readdirSync(folder).map(file => readFileSync(join(folder, file), "utf8")).join("\n");
/** One writer run on a route, as bin/agent/motion-run.mjs hands it to the harness. */
const write = (route, folder = outDir()) => runScene({ name: "sign-ins", request: "c1 waves.", variant: "studio", model: route.model, effort: route.effort, env: {}, outDir: folder, writer: { models: route.models, model: route.piModel, provider: route.provider, via: route.via, secrets: route.secrets } });
/** One motion request on a route through runMotion, with an empty Studio scene and the real harness. */
const motion = (route, folder) => runMotion({ words: "c1 waves.", hub: { command: async () => ({}) }, workspaceHandle: "ws", invoke: async () => ({}), env: {}, writer: route, deps: {
	studioScene: () => ({ scene: { characters: [], props: [], others: [] }, ids: { characters: {}, props: {}, switch: [] } }),
	runScene: options => runScene({ ...options, outDir: folder }), readClip: () => null, installClip: async () => ({ ok: true }),
} });
/** What every request of a run must hold: the stored credential, the model, the writer's manual, its one tool. */
function reached(server, run, { key, model, count = 2 }) {
	assert.equal(run.infraError, null, JSON.stringify(run.infraError));
	assert.equal(run.report, REPORT);
	assert.equal(server.requests.length, count);
	for (const request of server.requests) {
		assert.equal(request.key, key, "the stored credential goes with the request");
		assert.ok(`${request.path} ${request.text}`.includes(model), "the request names the model (in its address or its body)");
		assert.ok(request.text.includes("You block previs motion"), "the writer's manual");
		assert.ok(request.text.includes("Compiles the scene and the motion spec"), "the motion tool");
	}
	assert.equal(run.tokens.inputFresh + run.tokens.cacheRead + run.tokens.cacheWrite > 0, true, "the record counts the writer's tokens");
}

// 1. an Anthropic API key: the motion model on its own provider, whose layer carries the effort in the conversation
{
	const server = await provider();
	signedIn({ key: ["anthropic", "stored-anthropic-key"] });
	const models = await registry();
	at(models, "anthropic", () => server.base);
	const route = await writerRoute({ env: {}, models, picked: null });
	assert.deepEqual([route.via, route.provider, route.model, route.effort], ["sign-in", "anthropic", "claude-opus-5-5", "medium"]);
	const run = await write(route);
	reached(server, run, { key: "stored-anthropic-key", model: "claude-opus-5-5" });
	assert.ok(server.requests.every(request => request.text.includes("\"effort\":\"medium\"")), "the motion effort is in the request, where that provider takes it");
	assert.ok(server.requests[1].text.includes("\"cache_control\":{\"type\":\"ephemeral\"}"), "the cache mark");
	assert.deepEqual([run.tokens.cacheRead, run.tokens.cacheWrite], [80, 85]);
	assert.deepEqual(run.writer, { provider: "anthropic", via: "sign-in" });
	await server.close();
	console.log("PASS an Anthropic API key: the motion model through that sign-in, its effort where the provider layer puts it");
}

// 2. the Claude subscription: the Claude Code binary sends the request (no request body passes the harness)
{
	signedIn({ credential: ["anthropic-subscription", { type: "oauth", access: "subscription-access-token", refresh: "subscription-refresh-token", expires: Date.now() + 3_600_000 }] });
	const models = await registry(), queries = [];
	const turn = step => [
		{ type: "stream_event", event: { type: "message_start", message: { id: `msg_${step}`, usage: { input_tokens: 100, output_tokens: 1 } } } },
		{ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: step ? { type: "text", text: "" } : { type: "tool_use", id: "toolu_1", name: "mcp__cozyclay-tools__motion", input: {} } } },
		{ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: step ? { type: "text_delta", text: REPORT } : { type: "input_json_delta", partial_json: "{}" } } },
		{ type: "stream_event", event: { type: "content_block_stop", index: 0 } },
		{ type: "stream_event", event: { type: "message_delta", delta: { stop_reason: step ? "end_turn" : "tool_use" }, usage: { output_tokens: 5 } } },
		{ type: "result", subtype: "success", stop_reason: step ? "end_turn" : "tool_use", usage: { input_tokens: 100, output_tokens: 5 } },
	];
	const sdk = {
		query: input => { queries.push(input); const messages = turn(queries.length - 1); return { interrupt: async () => {}, close: () => {}, [Symbol.asyncIterator]: () => (async function* () { for (const message of messages) yield message; })() }; },
		tool: (name, description, schema) => ({ name, description, schema }), createSdkMcpServer: config => ({ type: "sdk", ...config }),
	};
	const stream = createSubscriptionStream({ loadSdk: async () => sdk, resolveExecutable: () => "/fake/claude", env: {} }), real = models.getProvider("anthropic-subscription");
	models.setProvider(createProvider({ id: real.id, name: real.name, auth: real.auth, models: real.getModels(), api: { stream, streamSimple: stream } }));
	const route = await writerRoute({ env: {}, models, picked: null });
	assert.deepEqual([route.via, route.provider, route.model], ["sign-in", "anthropic-subscription", "claude-opus-5-5"]);
	const folder = outDir(), run = await write(route, folder);
	assert.equal(run.infraError, null, JSON.stringify(run.infraError));
	assert.equal(run.report, REPORT);
	assert.equal(queries.length, 2);
	for (const { options } of queries) {
		assert.equal(options.env.CLAUDE_CODE_OAUTH_TOKEN, "subscription-access-token", "the stored sign-in's token");
		assert.deepEqual([options.model, options.effort, options.thinking?.type], ["claude-opus-5-5", "medium", "adaptive"]);
		assert.ok(options.systemPrompt.append.includes("You block previs motion"), "the writer's manual");
		assert.deepEqual(options.mcpServers["cozyclay-tools"].tools.map(tool => tool.name), ["motion"]);
	}
	assert.equal(run.served.sent, null, "no request body passed the harness");
	assert.ok(!written(folder).includes("subscription-access-token"), "the record holds no token");
	console.log("PASS the Claude subscription: the motion model, its effort and the manual reach the Claude Code binary with the sign-in's token");
}

// 3. sign-ins without the motion model: the session's model of another family writes, in its provider's wire format
{
	const token = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "writer-account" } })).toString("base64url")}.e30`;
	const chatGpt = { getAccessToken: async () => token, readStored: () => ({ access_token: token, refresh_token: "chatgpt-refresh-token", expires_at: Date.now() + 3_600_000 }), status: () => ({ signedIn: true }) };
	const families = [
		{ name: "ChatGPT sign-in", picked: null, id: "gpt-6-astra", key: token, effort: "medium", open: async server => { signedIn(); return createModels({ auth: chatGpt, env: {}, codexBaseUrl: server.base }); } },
		{ name: "an OpenAI API key", provider: "openai", key: "stored-openai-key", effort: "medium", open: async server => { signedIn({ key: ["openai", "stored-openai-key"] }); const models = await registry(); at(models, "openai", () => `${server.base}/v1`); return models; } },
		{ name: "a Google Gemini API key", provider: "google", key: "stored-google-key", effort: "medium", open: async server => { signedIn({ key: ["google", "stored-google-key"] }); const models = await registry(); at(models, "google", () => `${server.base}/v1beta`); return models; } },
		{ name: "an OpenAI-compatible server", picked: "openai-compatible/fake-llama", id: "fake-llama", key: "no-key", effort: "off", served: ["fake-llama"], open: async server => { signedIn({ credential: ["openai-compatible", { type: "api_key", key: "", env: { OPENAI_COMPATIBLE_BASE_URL: server.base } }] }); return registry(); } },
		{ name: "a CLIProxyAPI sign-in whose proxy lacks the motion model", picked: "cliproxy/gpt-6-astra", id: "gpt-6-astra", key: "stored-proxy-key", effort: "medium", served: ["gpt-6-astra"], open: async server => { signedIn({ credential: ["cliproxy", { type: "api_key", key: "stored-proxy-key", env: { CLIPROXY_BASE_URL: server.base } }] }); return registry(); } },
	];
	const wires = new Set();
	for (const family of families) {
		const server = await provider({ served: family.served }), models = await family.open(server);
		const id = family.id ?? models.getModels(family.provider).find(model => model.reasoning).id, picked = family.picked === undefined ? `${family.provider}/${id}` : family.picked;
		const route = await writerRoute({ env: {}, models, picked });
		assert.deepEqual([route.via, route.model, route.effort], ["session model", id, family.effort], family.name);
		assert.ok(route.label.startsWith(`${route.provider}/${id} at ${family.effort}, the model of this session`), route.label);
		assert.equal(await writerRoute({ env: {}, models, picked, session: false }), null, "the direct key takes the motion model only");
		const folder = outDir(), run = await write(route, folder);
		reached(server, run, { key: family.key, model: id });
		assert.deepEqual(run.asked, { model: id, effort: family.effort });
		assert.ok(!written(folder).includes(family.key), "the record holds no key");
		wires.add(route.piModel.api);
		await server.close();
		console.log(`PASS ${family.name}: ${route.label} (${route.piModel.api})`);
	}
	assert.deepEqual([...wires].sort(), ["google-generative-ai", "openai-codex-responses", "openai-completions", "openai-responses"]);
}

// 4. the answer names the model that wrote: the route's label, and the provider's own name for what it served
{
	const server = await provider({ servedAs: "another-name-of-the-model" });
	signedIn({ key: ["anthropic", "stored-anthropic-key"] });
	const models = await registry();
	at(models, "anthropic", () => server.base);
	const answer = await motion(await writerRoute({ env: {}, models, picked: "anthropic/claude-sonnet-5" }), outDir());
	assert.equal(answer.writer, "anthropic/claude-opus-5-5 at medium, through the Studio's sign-in; the provider names what it served another-name-of-the-model");
	assert.equal(answer.installed, false);
	await server.close();
	console.log("PASS the answer's writer: the route, and the name the provider gave what it served when it is another one");
}

// 5. a sign-in that fails: the failure names the writer; no key and no address in the message or the run's files
{
	for (const [status, type, message] of [[401, "authentication_error", "invalid x-api-key"], [429, "rate_limit_error", "This request would exceed the rate limit."], [404, "not_found_error", "model: claude-opus-5-5"]]) {
		const server = await provider({ served: ["claude-opus-5-5"], refuse: { at: 1, status, body: { type: "error", error: { type, message } } } });
		signedIn({ credential: ["cliproxy", { type: "api_key", key: "stored-proxy-key", env: { CLIPROXY_BASE_URL: server.base } }] });
		const models = await registry(), folder = outDir();
		const failed = await motion(await writerRoute({ env: {}, models, picked: "cliproxy/claude-opus-5-5" }), folder).then(() => null, error => error);
		assert.equal(failed?.code, "upstream");
		assert.ok(failed.message.startsWith(`The model or the proxy failed: ${status} `) && failed.message.includes(message), failed.message);
		assert.ok(failed.message.endsWith("(the motion writer: cliproxy/claude-opus-5-5 at medium, through the Studio's sign-in)"), failed.message);
		for (const text of [failed.message, written(folder)]) for (const secret of ["stored-proxy-key", server.base, new URL(server.base).host]) assert.ok(!text.includes(secret), `no ${secret} in what the failure leaves`);
		await server.close();
	}
	// a server that is gone: the address a sign-in stored with its credential stays out too
	const server = await provider({ served: ["fake-llama"] });
	signedIn({ credential: ["openai-compatible", { type: "api_key", key: "", env: { OPENAI_COMPATIBLE_BASE_URL: server.base } }] });
	const models = await registry(), route = await writerRoute({ env: {}, models, picked: "openai-compatible/fake-llama" });
	assert.ok(route.secrets.includes(server.base) && route.secrets.includes(new URL(server.base).host), "the record scrubs the server's address and its host");
	await server.close();
	const folder = outDir(), failed = await motion(route, folder).then(() => null, error => error);
	assert.equal(failed?.code, "upstream");
	assert.ok(failed.message.endsWith("(the motion writer: openai-compatible/fake-llama at off, the model of this session (the sign-ins offer no claude-opus-5-5))"), failed.message);
	for (const text of [failed.message, written(folder)]) assert.ok(!text.includes(new URL(server.base).host), "no address in what the failure leaves");
	console.log("PASS a refusing provider (401, 429, 404) and a server that is gone: the failure names the writer, and keeps no key or address");
}

// 6. no sign-in at all, and environment variables that name no address: no route, and no error out of the turn
{
	signedIn();
	const models = await registry();
	assert.equal(await writerRoute({ env: {}, models, picked: null }), null);
	assert.equal(await writerRoute({ env: {}, models, picked: "anthropic/claude-opus-5-5" }), null, "a picked model of a provider without a sign-in");
	assert.equal(await writerRoute({ env: { CLIPROXY_BASE_URL: "not an address", CLIPROXY_API_KEY: "some-key" }, models, picked: null }), null);
	console.log("PASS no sign-in, and an environment value that is no address: no route (the session has no motion tool)");
}
