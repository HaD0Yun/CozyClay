#!/usr/bin/env node
// The motion writer on each kind of sign-in the model picker has (bin/agent/providers.mjs PROVIDERS), with nothing else
// set: an API key (the motion model's own provider, and providers of other model families), an OAuth sign-in (ChatGPT;
// the Claude subscription, whose requests the Claude Code binary sends), a server sign-in that carries its address
// (CLIProxyAPI, an OpenAI-compatible server). Each run goes through the harness (src/lowvis/pi/harness.mjs) on the
// route bin/agent/motion-writer.mjs chose, against a local server in that provider's wire format (the subscription: the
// SDK boundary faked, as test/verify-anthropic-subscription.mjs does): the request reaches the provider with the stored
// credential, the model the answer names, the writer's manual and its one tool, and the effort where that provider's
// layer puts it. Then what a failing provider leaves: the answer names the writer, and no key or address is kept.
// And a sign-in that lists the motion model but refuses it for the account: one refused call, then the session's model
// writes in the same call and the answer names both; a rate limit, a refused credential, a server error do not do that.
// Last, a run stopped during a motion call: the calls the loop then skips are not calls of the record.
//   node test/lowvis/verify-writer-sign-ins.mjs
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { createFakeModel } from "../fixtures/fake-model.mjs";

for (const name of Object.keys(process.env)) if (/_API_KEY$|^CLIPROXY_|^COZYCLAY_MOTION_/.test(name)) delete process.env[name];
const TMP = mkdtempSync(join(tmpdir(), "writer-sign-ins-"));
process.env.COZYCLAY_CONFIG_DIR = join(TMP, "config-0");
const [{ createModels, resolveModel }, keys, { writerRoute, modelRefused }, { runMotion }, { runScene }, { createSubscriptionStream }, { createProvider, clampThinkingLevel }] = await Promise.all([
	import("../../bin/agent/providers.mjs"), import("../../bin/agent/provider-keys.mjs"), import("../../bin/agent/motion-writer.mjs"), import("../../bin/agent/motion-run.mjs"),
	import("../../src/lowvis/pi/harness.mjs"), import("../../bin/agent/anthropic-subscription-stream.mjs"), import("@earendil-works/pi-ai"),
]);

const REPORT = "Nothing was made.\nMissing: everything";
const events = list => list.map(event => `${event.type ? `event: ${event.type}\n` : ""}data: ${JSON.stringify(event)}\n\n`).join("");
/**
 * A provider's server in every wire format the picker's providers use: its model list, and a scripted writer (one
 * motion call, then a report). served: the model ids it lists; servedAs: the name its answers give the model;
 * refuse: { at | model, status, body }: it refuses the model request of that position (1-based), or every request for that model.
 */
async function provider({ served = [], servedAs = null, refuse = null } = {}) {
	const requests = [];
	const server = createServer(async (req, res) => {
		const chunks = [];
		for await (const chunk of req) chunks.push(Buffer.from(chunk));
		const path = new URL(req.url, "http://local").pathname, raw = Buffer.concat(chunks);
		if (req.method === "GET") { res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: served.map(id => ({ id, owned_by: id.startsWith("claude") ? "anthropic" : "openai" })) })); return; }
		const text = (req.headers["content-encoding"] === "zstd" ? zstdDecompressSync(raw) : raw).toString("utf8"), body = JSON.parse(text);
		const named = body.model ?? decodeURIComponent(path).split("/models/")[1]?.split(":")[0];
		requests.push({ path, text, body, model: named, key: req.headers["x-api-key"] ?? req.headers["x-goog-api-key"] ?? String(req.headers.authorization ?? "").replace(/^Bearer /, "") });
		if (refuse && (refuse.model ? named === refuse.model : requests.length === refuse.at)) { res.writeHead(refuse.status, { "content-type": "application/json" }).end(JSON.stringify(refuse.body)); return; }
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
	return { requests, base: `http://127.0.0.1:${server.address().port}`, refuse: value => { refuse = value; }, close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
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
const motion = (route, folder, env = {}) => runMotion({ words: "c1 waves.", hub: { command: async () => ({}) }, workspaceHandle: "ws", invoke: async () => ({}), env, writer: route, deps: {
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
		{ name: "a MiniMax API key", provider: "minimax", key: "stored-minimax-key", effort: "medium", open: async server => { signedIn({ key: ["minimax", "stored-minimax-key"] }); const models = await registry(); at(models, "minimax", () => server.base); return models; } },
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
		assert.match(run.served.effortNote, /unchecked here$/, "the record does not claim an effort it did not check");
		assert.ok(!written(folder).includes(family.key), "the record holds no key");
		wires.add(route.piModel.api);
		await server.close();
		console.log(`PASS ${family.name}: ${route.label} (${route.piModel.api})`);
	}
	assert.deepEqual([...wires].sort(), ["anthropic-messages", "google-generative-ai", "openai-codex-responses", "openai-completions", "openai-responses"]);
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
		assert.equal(server.requests.length, 1, "one call: the session's model is the refused one itself, so there is no other to write on");
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

// 6. a sign-in that lists the motion model and refuses it for the account: one refused call, then the session's model
//    writes in the same call; the answer and the record name both; the conversation does not ask the refused model again
{
	const kept = folder => readdirSync(folder).map(file => [file, JSON.parse(readFileSync(join(folder, file), "utf8"))]);
	const notFound = model => ({ status: 404, body: { type: "error", error: { type: "not_found_error", message: `model: ${model}` } } });
	// the motion model and the session's model: two models of one provider that take the motion effort
	const two = (models, id) => models.getModels(id).filter(model => clampThinkingLevel(model, "medium") === "medium").slice(0, 2).map(model => model.id);
	const token = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "writer-account" } })).toString("base64url")}.e30`;
	const chatGpt = { getAccessToken: async () => token, readStored: () => ({ access_token: token, refresh_token: "chatgpt-refresh-token", expires_at: Date.now() + 3_600_000 }), status: () => ({ signedIn: true }) };
	const anthropic = async server => { signedIn({ key: ["anthropic", "stored-anthropic-key"] }); const models = await registry(); at(models, "anthropic", () => server.base); return models; };
	const families = [
		{ name: "an Anthropic API key (404, not found)", provider: "anthropic", ids: () => ["claude-opus-5-5", "claude-sonnet-5"], refusal: notFound, open: anthropic },
		{ name: "an Anthropic API key (403, not permitted)", provider: "anthropic", ids: () => ["claude-opus-5-5", "claude-sonnet-5"], open: anthropic,
			refusal: () => ({ status: 403, body: { type: "error", error: { type: "permission_error", message: "Your API key does not have permission to use the specified resource." } } }) },
		{ name: "a CLIProxyAPI sign-in whose proxy lists the model", provider: "cliproxy", ids: () => ["claude-opus-5-5", "gpt-6-astra"], served: ["claude-opus-5-5", "gpt-6-astra"], refusal: notFound,
			open: async server => { signedIn({ credential: ["cliproxy", { type: "api_key", key: "stored-proxy-key", env: { CLIPROXY_BASE_URL: server.base } }] }); return registry(); } },
		{ name: "an OpenAI API key (404, model_not_found)", provider: "openai", ids: models => two(models, "openai"),
			refusal: model => ({ status: 404, body: { error: { message: `The model \`${model}\` does not exist or you do not have access to it.`, type: "invalid_request_error", param: null, code: "model_not_found" } } }),
			open: async server => { signedIn({ key: ["openai", "stored-openai-key"] }); const models = await registry(); at(models, "openai", () => `${server.base}/v1`); return models; } },
		{ name: "a Google Gemini API key (404, NOT_FOUND)", provider: "google", ids: models => two(models, "google"),
			refusal: model => ({ status: 404, body: { error: { code: 404, message: `models/${model} is not found for API version v1beta, or is not supported for generateContent.`, status: "NOT_FOUND" } } }),
			open: async server => { signedIn({ key: ["google", "stored-google-key"] }); const models = await registry(); at(models, "google", () => `${server.base}/v1beta`); return models; } },
		{ name: "ChatGPT sign-in (400, not on this plan)", provider: "openai-codex", ids: models => two(models, "openai-codex"),
			refusal: model => ({ status: 400, body: { detail: `The '${model}' model is not supported when using Codex with a ChatGPT account.` } }),
			open: async server => { signedIn(); return createModels({ auth: chatGpt, env: {}, codexBaseUrl: server.base }); } },
		{ name: "an OpenAI-compatible server (404, not found)", provider: "openai-compatible", effort: "off", ids: () => ["fake-llama", "fake-qwen"], served: ["fake-llama", "fake-qwen"],
			refusal: model => ({ status: 404, body: { error: { message: `model '${model}' not found`, type: "not_found_error" } } }),
			// the server's models are its live list, read when the picker lists them or a turn names one (providers.mjs resolveModel)
			open: async server => { signedIn({ credential: ["openai-compatible", { type: "api_key", key: "", env: { OPENAI_COMPATIBLE_BASE_URL: server.base } }] }); const models = await registry(); await resolveModel("openai-compatible/fake-qwen", { models }); return models; } },
	];
	let conversations = 0;
	for (const family of families) {
		const server = await provider({ served: family.served }), models = await family.open(server), [asked, session] = family.ids(models), effort = family.effort ?? "medium";
		assert.ok(asked && session && asked !== session, family.name);
		server.refuse({ model: asked, ...family.refusal(asked) });
		const { provider: id } = family, env = { COZYCLAY_MOTION_MODEL: asked, COZYCLAY_MOTION_EFFORT: effort }, picked = `${id}/${session}`, conversation = `conversation-${++conversations}`;
		const label = `${id}/${session} at ${effort}, the model of this session (the ${id} sign-in refused ${asked})`;
		const route = await writerRoute({ env, models, picked, conversation });
		assert.deepEqual([route.via, route.provider, route.model], ["sign-in", id, asked], family.name);
		const folder = outDir(), answer = await motion(route, folder, env);
		assert.equal(answer.writer, label, "the answer names the model asked, the sign-in that refused it and the model that wrote");
		assert.deepEqual(server.requests.map(request => request.model), [asked, session, session], "one refused call, then the session's model writes");
		const files = kept(folder), run = files.find(([file]) => file === "run.json")[1], refused = files.find(([file]) => file.startsWith("infra-error-"))[1];
		assert.deepEqual(run.writer, { provider: id, via: "session model", refused: { provider: id, model: asked } });
		assert.deepEqual([run.asked.model, run.infraError, run.report], [session, null, REPORT]);
		assert.deepEqual([refused.asked.model, refused.infraError.at, refused.modelCalls], [asked, "model call 1", 1], "the refused run stays on file");
		// the rest of the conversation: this turn's route and a later turn's go to the session's model at once
		server.requests.length = 0;
		assert.equal((await motion(route, outDir(), env)).writer, label);
		const later = await writerRoute({ env, models, picked, conversation });
		assert.deepEqual([later.via, later.model, later.label], ["session model", session, label]);
		assert.equal((await motion(later, outDir(), env)).writer, label);
		assert.deepEqual(server.requests.map(request => request.model), [session, session, session, session], "no call to the refused model");
		assert.equal((await writerRoute({ env, models, picked, conversation: "another conversation" })).via, "sign-in", "remembered for its conversation only");
		await server.close();
		console.log(`PASS refused by ${family.name}: one refused call, then ${label}`);
	}
	// the Claude subscription: the binary's failure carries the provider's refusal (the SDK boundary faked)
	signedIn({ credential: ["anthropic-subscription", { type: "oauth", access: "subscription-access-token", refresh: "subscription-refresh-token", expires: Date.now() + 3_600_000 }] });
	const models = await registry(), asked = [];
	const turn = step => [
		{ type: "stream_event", event: { type: "message_start", message: { id: `msg_${step}`, usage: { input_tokens: 100, output_tokens: 1 } } } },
		{ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: step ? { type: "text", text: "" } : { type: "tool_use", id: "toolu_1", name: "mcp__cozyclay-tools__motion", input: {} } } },
		{ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: step ? { type: "text_delta", text: REPORT } : { type: "input_json_delta", partial_json: "{}" } } },
		{ type: "stream_event", event: { type: "content_block_stop", index: 0 } },
		{ type: "stream_event", event: { type: "message_delta", delta: { stop_reason: step ? "end_turn" : "tool_use" }, usage: { output_tokens: 5 } } },
		{ type: "result", subtype: "success", stop_reason: step ? "end_turn" : "tool_use", usage: { input_tokens: 100, output_tokens: 5 } },
	];
	const sdk = {
		query: ({ options }) => {
			asked.push(options.model);
			const messages = options.model === "claude-opus-5-5" ? [{ type: "result", subtype: "error_during_execution", error: "API Error: 404 {\"type\":\"error\",\"error\":{\"type\":\"not_found_error\",\"message\":\"model: claude-opus-5-5\"}}" }] : turn((asked.filter(model => model === options.model).length - 1) % 2);
			return { interrupt: async () => {}, close: () => {}, [Symbol.asyncIterator]: () => (async function* () { for (const message of messages) yield message; })() };
		},
		tool: (name, description, schema) => ({ name, description, schema }), createSdkMcpServer: config => ({ type: "sdk", ...config }),
	};
	const stream = createSubscriptionStream({ loadSdk: async () => sdk, resolveExecutable: () => "/fake/claude", env: {} }), real = models.getProvider("anthropic-subscription");
	models.setProvider(createProvider({ id: real.id, name: real.name, auth: real.auth, models: real.getModels(), api: { stream, streamSimple: stream } }));
	const picked = "anthropic-subscription/claude-sonnet-5", label = "anthropic-subscription/claude-sonnet-5 at medium, the model of this session (the anthropic-subscription sign-in refused claude-opus-5-5)";
	const route = await writerRoute({ env: {}, models, picked, conversation: "subscription" });
	assert.deepEqual([route.via, route.provider, route.model], ["sign-in", "anthropic-subscription", "claude-opus-5-5"]);
	assert.equal((await motion(route, outDir())).writer, label);
	assert.equal((await motion(await writerRoute({ env: {}, models, picked, conversation: "subscription" }), outDir())).writer, label);
	assert.deepEqual(asked, ["claude-opus-5-5", "claude-sonnet-5", "claude-sonnet-5", "claude-sonnet-5", "claude-sonnet-5"], "one refused call, and none in the next motion");
	console.log(`PASS refused by the Claude subscription: one refused call, then ${label}`);
}

// 7. what is no refusal of the model falls back to nothing: a rate limit, a refused credential, a server error and a
//    server that is gone are told as they are; and a refusal with no other model to write on is told as the failure it is
{
	const open = async (status, type) => {
		const server = await provider({ refuse: { model: "claude-opus-5-5", status, body: { type: "error", error: { type, message: `${type} of the stand-in provider` } } } });
		signedIn({ key: ["anthropic", "stored-anthropic-key"] });
		const models = await registry();
		at(models, "anthropic", () => server.base);
		return { server, models };
	};
	const sameWriter = "(the motion writer: anthropic/claude-opus-5-5 at medium, through the Studio's sign-in)";
	for (const [status, type] of [[429, "rate_limit_error"], [401, "authentication_error"], [500, "api_error"], [0, "gone"]]) {
		const { server, models } = await open(status || 404, type), ask = { env: {}, models, picked: "anthropic/claude-sonnet-5", conversation: `told-${status}` };
		const route = await writerRoute(ask);
		if (!status) await server.close();
		const failed = await motion(route, outDir()).then(() => null, error => error);
		assert.equal(failed?.code, "upstream");
		assert.ok(failed.message.startsWith(status ? `The model or the proxy failed: ${status} ` : "The model or the proxy failed: ") && failed.message.endsWith(sameWriter), failed.message);
		assert.ok(server.requests.every(request => request.model === "claude-opus-5-5"), "the session's model is not asked");
		assert.equal(await route.instead(), null, "nothing is remembered");
		assert.equal((await writerRoute(ask)).via, "sign-in");
		if (status) await server.close();
	}
	// refused, and the session's model cannot write (ChatGPT's default model without its sign-in): the provider's refusal, as it is
	const { server, models } = await open(404, "not_found_error");
	const failed = await motion(await writerRoute({ env: {}, models, picked: null, conversation: "no other model" }), outDir()).then(() => null, error => error);
	assert.equal(failed?.code, "upstream");
	assert.ok(failed.message.startsWith("The model or the proxy failed: 404 ") && failed.message.includes("not_found_error") && failed.message.endsWith(sameWriter), failed.message);
	assert.equal(server.requests.length, 1);
	await server.close();
	// the one place that tells a refusal of the model from the other failures (motion-writer.mjs modelRefused)
	for (const [message, refused] of [
		["There's an issue with the selected model (claude-opus-5-5). It may not exist or you may not have access to it.", true],
		["403 {\"error\":{\"code\":403,\"message\":\"The caller does not have permission\",\"status\":\"PERMISSION_DENIED\"}}", true],
		["403 {\"error\":{\"message\":\"Your authentication token has expired. Please sign in again.\"}}", false],
		["400 {\"type\":\"error\",\"error\":{\"type\":\"invalid_request_error\",\"message\":\"tools.0.custom.input_schema: JSON schema is invalid\"}}", false],
		["You have hit your ChatGPT usage limit (plus plan).", false], ["529 {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"Overloaded\"}}", false],
		["Connection error.", false], ["fetch failed", false], ["Operation aborted", false],
	]) assert.equal(await modelRefused({ message }), refused, message);
	console.log("PASS a rate limit, a refused credential, a server error, a server that is gone: no other model is asked; a refusal with no other model to write on is the failure it is");
}

// 8. the environment's proxy with a motion model of another wire format: it runs, and the record says what was checked
{
	const server = await provider({ served: ["gpt-6-astra"] }), folder = outDir();
	Object.assign(process.env, { CLIPROXY_BASE_URL: server.base, CLIPROXY_API_KEY: "environment-key" }); // its provider reads the process's environment
	const run = await runScene({ name: "sign-ins", request: "c1 waves.", variant: "studio", model: "gpt-6-astra", effort: "medium", env: process.env, outDir: folder });
	delete process.env.CLIPROXY_BASE_URL; delete process.env.CLIPROXY_API_KEY;
	reached(server, run, { key: "environment-key", model: "gpt-6-astra" });
	assert.deepEqual(run.served.sent, { model: "gpt-6-astra" });
	assert.match(run.served.effortNote, /unchecked here$/);
	assert.ok(!written(folder).includes("environment-key") && !written(folder).includes(server.base), "the record holds no key and no address");
	await server.close();
	console.log("PASS the environment's proxy, a model of another wire format: the model id is checked, the effort is the provider layer's");
	// and it never falls back: the named model or a failure, with a sign-in that could write at hand
	const proxy = await provider({ served: ["claude-opus-5-5"], refuse: { model: "claude-opus-5-5", status: 404, body: { type: "error", error: { type: "not_found_error", message: "model: claude-opus-5-5" } } } });
	signedIn({ key: ["anthropic", "stored-anthropic-key"] });
	Object.assign(process.env, { CLIPROXY_BASE_URL: proxy.base, CLIPROXY_API_KEY: "environment-key" });
	const route = await writerRoute({ env: process.env, models: await registry(), picked: "anthropic/claude-sonnet-5", conversation: "environment" });
	assert.deepEqual([route.via, route.refuse, route.instead], ["environment", undefined, undefined]);
	const failed = await motion(route, outDir(), process.env).then(() => null, error => error);
	delete process.env.CLIPROXY_BASE_URL; delete process.env.CLIPROXY_API_KEY;
	assert.ok(failed?.message.startsWith("The model or the proxy failed: 404 ") && failed.message.endsWith("(the motion writer: cliproxy/claude-opus-5-5 at medium, through CLIPROXY_BASE_URL)"), failed?.message);
	assert.deepEqual(proxy.requests.map(request => request.model), ["claude-opus-5-5"]);
	await proxy.close();
	console.log("PASS the environment's proxy refusing its model: the failure, and no other model is asked");
}

// 9. no sign-in at all, and environment variables that name no address: no route, and no error out of the turn
{
	signedIn();
	const models = await registry();
	assert.equal(await writerRoute({ env: {}, models, picked: null }), null);
	assert.equal(await writerRoute({ env: {}, models, picked: "anthropic/claude-opus-5-5" }), null, "a picked model of a provider without a sign-in");
	assert.equal(await writerRoute({ env: { CLIPROXY_BASE_URL: "not an address", CLIPROXY_API_KEY: "some-key" }, models, picked: null }), null);
	console.log("PASS no sign-in, and an environment value that is no address: no route (the session has no motion tool)");
}

// 10. a run stopped while a motion call runs, the message naming a second call: pi ends the second as "Operation
// aborted" without running it. The record keeps the call that ran; the unrun one is no refused call (no mistake of the model).
{
	const fake = createFakeModel(), controller = new AbortController();
	fake.script([[{ type: "toolCall", id: "ran", name: "motion", arguments: {} }, { type: "toolCall", id: "unrun", name: "motion", arguments: {} }], [{ type: "text", text: REPORT }]]);
	const run = await runScene({ name: "sign-ins", request: "c1 waves.", variant: "studio", model: "scripted", effort: "medium", env: {}, outDir: outDir(), signal: controller.signal,
		writer: { models: fake.models, model: fake.models.getModel("faux", "scripted"), provider: "faux", via: "sign-in", secrets: [] },
		// the Studio is asked for its shapes at the start of a motion call: the Stop lands there, inside the first call
		shapes: {}, reshape: async () => { controller.abort(); return {}; } });
	assert.deepEqual(run.transcript[0].shots.map(shot => shot.toolCallId), ["ran", "unrun"], "the model asked for two calls");
	assert.deepEqual(run.calls.shots.map(shot => shot.toolCallId), ["ran"], "only the call that ran is a call of the record");
	assert.equal(fake.calls.length, 1, "the model is not asked again after the Stop");
	console.log("PASS a run stopped during a motion call: the call the loop skipped is not in the record");
}
