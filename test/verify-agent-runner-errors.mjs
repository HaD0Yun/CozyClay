// Retry, abort and error mapping on the pi runner (#379): a scripted faux
// provider throws provider-shaped errors (`errorMessage` text pi's own
// `isRetryableAssistantError` classifies) so the harness's `retry` policy —
// not any code in this test — does the actual retrying. A real Codex HTTP
// fixture also verifies effort mapping through the harness to the wire.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import { zstdDecompressSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { fauxProvider, fauxAssistantMessage, fauxText, fauxThinking } from "@earendil-works/pi-ai/providers/faux";
import { fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createAgentRunner, classifyError, classifyProviderError } from "../bin/agent/agent-runner.mjs";
import { retryAfterMs, retryHintMs, retryKind } from "../bin/agent/agent-stream.mjs";
import { failureCodeOf } from "../bin/agent/agent-failure-codes.mjs";
import * as piAi from "@earendil-works/pi-ai";
import { createSessionStore, transcriptFromHistory } from "../bin/agent/session-store.mjs";
import { createModels as createAgentModels, loadProvider } from "../bin/agent/providers.mjs";

process.env.COZYCLAY_AGENT_SESSIONS_DIR = mkdtempSync(join(tmpdir(), "cozyclay-agent-runner-errors-"));

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
}

async function collect(session, input) {
	const frames = [];
	for await (const frame of session.start(input)) frames.push(frame);
	return frames;
}

// A verification result echoes the receipt id already emitted by the arrange
// tool result; restoration must keep one row for that receipt.
{
	const history = [
		{ role: "toolResult", toolCallId: "arrange", details: { receiptId: "R1", status: "applied" } },
		{ role: "toolResult", toolCallId: "verify", details: { receiptId: "R1", status: "verified" } },
	];
	const receipts = transcriptFromHistory(history).filter((item) => item.kind === "receipt" && item.receiptId === "R1");
	expect("restored pi history keeps one receipt row per receiptId", receipts.length === 1, JSON.stringify(receipts));
}

/** Queues `steps` (each either an assistant message or a factory) on `faux`
 * and returns the array of contexts pi actually sent it, one per attempt. */
function installScripts(faux, steps) {
	const calls = [];
	faux.setResponses(steps.map((step) => async (context) => {
		calls.push(context);
		return typeof step === "function" ? step() : step;
	}));
	return calls;
}

function errorMessage(text) {
	return fauxAssistantMessage([], { stopReason: "error", errorMessage: text });
}

// --- Wire efforts use the real runner, harness, auth and Codex API module.
// Astra does not advertise off, but an explicit none must still omit reasoning.
// gpt-5.5 supports off, and pi sends a model's off mapping, so its no-reasoning
// reaches Codex as its own "none" instead of being omitted.
{
	const received = [];
	const fixture = createServer(async (req, res) => {
		const chunks = []; for await (const chunk of req) chunks.push(chunk);
		const encoded = Buffer.concat(chunks);
		const body = JSON.parse((req.headers["content-encoding"] === "zstd" ? zstdDecompressSync(encoded) : encoded).toString());
		received.push({ path: req.url, body });
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.end(`data: ${JSON.stringify({ type: "response.completed", response: { status: "completed" } })}\n\n`);
	});
	const listening = once(fixture, "listening", { signal: AbortSignal.timeout(5000) });
	fixture.listen(0, "127.0.0.1"); await listening;
	const codexBaseUrl = `http://127.0.0.1:${fixture.address().port}`;
	const token = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "runner-effort-fixture" } })).toString("base64url")}.e30`;
	const auth = { readStored: () => ({ access_token: token, refresh_token: "fixture-refresh", expires_at: Date.now() + 3600000 }) };
	let runner;
	try {
		const models = await createAgentModels({ auth, keys: { readKeys: () => ({}) }, env: {}, codexBaseUrl });
		// gpt-5.5 left pi's Codex catalogue in 1.4.0, and no model left there supports off without max. Keep its case
		// with a Codex model shaped like it (off supported, max not), served by the same fixture.
		const codex = models.getProvider("openai-codex");
		const catalogue = codex.getModels.bind(codex);
		codex.getModels = () => [...catalogue(), { ...catalogue().find((model) => model.id === "gpt-6-luna"), id: "gpt-5.5", name: "GPT-5.5", thinkingLevelMap: { xhigh: "xhigh", minimal: "low" } }];
		models.setProvider(codex);
		const metadata = structuredClone(models.getModels("openai-codex"));
		assert.equal(models.getModel("openai-codex", "gpt-6-astra").thinkingLevelMap.off, null, "Astra must exercise the unsupported-off case");
		runner = createAgentRunner({ models, codexBaseUrl });
		const check = async (session, model, effort, expectedEffort, label) => {
			const before = received.length;
			const frames = await collect(session, { text: "hello", model: `openai-codex/${model}`, ...(effort === undefined ? {} : { effort }), signal: AbortSignal.timeout(8000) });
			assert.deepEqual(frames.filter((frame) => frame.type === "error"), [], label);
			assert.equal(frames.filter((frame) => frame.type === "done").length, 1, label);
			assert.equal(frames.at(-1)?.type, "done", label);
			assert.equal(received.length, before + 1, `${label}: exactly one provider request`);
			const request = received.at(-1);
			assert.equal(request.path, "/codex/responses");
			assert.equal(request.body.model, model);
			console.log("runner-effort-wire", JSON.stringify({ label, model, effort, reasoning: request.body.reasoning ?? null }));
			expect(label, expectedEffort === undefined ? !Object.hasOwn(request.body, "reasoning") : request.body.reasoning?.effort === expectedEffort, JSON.stringify(request.body.reasoning));
		};
		const freshCases = [
			["gpt-6-astra", "none", undefined],
			["gpt-5.5", "none", "none"],
			["gpt-6-astra", "high", "high"],
			["gpt-6-astra", "ultra", "max"],
			["gpt-5.5", "ultra", "xhigh"],
			// With no initial effort the harness default is off, not medium.
			["gpt-6-astra", undefined, undefined],
			["gpt-5.5", undefined, "none"],
		];
		for (const [index, [model, effort, expected]] of freshCases.entries()) {
			const session = await runner.openSession(`effort-fresh-${index}`);
			await check(session, model, effort, expected, `fresh ${model} ${effort ?? "omitted"} preserves wire effort`);
		}
		const reused = await runner.openSession("effort-reused");
		for (const [model, effort, expected] of [
			["gpt-6-astra", "high", "high"],
			["gpt-6-astra", "none", undefined],
			["gpt-6-astra", undefined, undefined],
			["gpt-5.5", "ultra", "xhigh"],
			["gpt-5.5", undefined, "xhigh"],
			["gpt-6-astra", "none", undefined],
		]) await check(reused, model, effort, expected, `reused ${model} ${effort ?? "omitted"} preserves wire effort`);
		assert.deepEqual(models.getModels("openai-codex"), metadata, "turn effort must not mutate advertised model metadata");
	} finally {
		await runner?.close();
		const closed = once(fixture, "close", { signal: AbortSignal.timeout(5000) });
		fixture.close(); fixture.closeAllConnections(); await closed;
	}
}

// --- 429 twice then success: pi's own retry (maxRetries:2) absorbs both, one turn ---
{
	const models = createModels();
	const faux = fauxProvider({ provider: "faux", models: [{ id: "scripted", name: "Scripted", input: ["text", "image"] }] });
	models.setProvider(faux.provider);
	const calls = installScripts(faux, [errorMessage("429 Too Many Requests"), errorMessage("429 Too Many Requests"), fauxAssistantMessage([fauxText("done")])]);
	const runner = createAgentRunner({ models, tools: [] });
	const session = await runner.openSession("errors-429", { surface: "workflow" });
	const frames = await collect(session, { text: "hi", model: "faux/scripted" });
	await runner.close();
	expect("429 twice then success completes with one done frame and no error frame", frames.filter((f) => f.type === "done").length === 1 && frames.every((f) => f.type !== "error"), JSON.stringify(frames));
	expect("the model was called exactly 3 times (1 initial + 2 retries)", calls.length === 3, `calls.length=${calls.length}`);
	expect("the surviving text reached the panel", frames.some((f) => f.type === "text.delta" && f.text) || frames.some((f) => f.type === "text.delta"), JSON.stringify(frames));
}

// --- a provider's own wait hint sets the backoff, capped at 20 s (#975) ---
{
	const hint = (text) => retryHintMs({ errorMessage: text });
	assert.equal(hint("429 Too Many Requests. Please retry after 8 seconds."), 8000);
	assert.equal(hint("Rate limit reached. Please try again in 2.5s."), 2500);
	assert.equal(hint("overloaded, retry in 750ms"), 750);
	assert.equal(hint("try again in 600 seconds"), 20_000, "a long hint is capped");
	assert.equal(hint("500 overloaded"), 0, "no hint: pi-ai's backoff alone");
	assert.equal(hint("request 429 failed after 3 retries"), 0, "a count is not a wait");
	assert.equal(retryHintMs(undefined), 0);
	console.log("PASS retry hint: seconds and milliseconds, capped, none without a unit");
}

// --- #1043: what is retried, and how a final provider failure is labelled ---
{
	const failed = (text) => ({ stopReason: "error", errorMessage: text });
	const kind = (text) => retryKind(piAi, failed(text));
	const gemini429 = 'got status: 429 Too Many Requests. {"error":{"code":429,"message":"You exceeded your current quota, please check your plan and billing details. Please retry in 37.5s.","status":"RESOURCE_EXHAUSTED","details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"37s"}]}}';
	assert.equal(kind("503 Service Unavailable"), "transient");
	assert.equal(kind("Provider stopped with: MALFORMED_FUNCTION_CALL"), "resample", "a Gemini malformed call is sampled again");
	assert.equal(kind("Provider stopped with: UNEXPECTED_TOOL_CALL"), "resample");
	assert.equal(kind("Provider stopped with: SAFETY"), null, "a content block stays final");
	assert.equal(kind(gemini429), "quota_wait", "a per-minute quota that names its wait is waited out once");
	assert.equal(kind("429 You exceeded your current quota, please check your plan and billing details."), null, "a quota without a wait is final");
	assert.equal(kind("429 quota exceeded. Please retry in 3600s."), null, "a wait past a minute is final");
	assert.equal(kind("400 INVALID_ARGUMENT"), null);
	assert.equal(retryKind(piAi, { stopReason: "stop" }), null);
	assert.equal(retryAfterMs(failed(gemini429)), 37_500, "the message's own wait, uncapped");
	assert.equal(retryAfterMs(failed('{"retryDelay":"12s"}')), 12_000, "Gemini's RetryInfo alone");
	assert.equal(retryHintMs(failed(gemini429)), 20_000, "the backoff hint stays capped");
	console.log("PASS retry classification: transient, Gemini resample, short quota wait, final");

	// A 4xx folded into the message rides on the frame, so the turn reads as invalid_request, not upstream.
	for (const [text, expected] of [
		['{"error":{"code":400,"message":"Invalid JSON payload","status":"INVALID_ARGUMENT"}}', "invalid_request"],
		["404 model not found", "invalid_request"],
		["413 Request Entity Too Large", "invalid_request"],
		["502 Bad Gateway", "upstream"],
		["Provider stopped with: SAFETY", "upstream"],
		["429 Too Many Requests", "rate_limited"],
	]) {
		const { code, status } = classifyError({ message: text });
		expect(`"${text.slice(0, 32)}" -> ${expected}`, failureCodeOf({ code, ...(status ? { status } : {}) }) === expected, JSON.stringify({ code, status }));
	}
}

async function scriptedTurn(name, steps) {
	const models = createModels();
	const faux = fauxProvider({ provider: "faux", models: [{ id: "scripted", name: "Scripted", input: ["text", "image"] }] });
	models.setProvider(faux.provider);
	const calls = installScripts(faux, steps);
	const runner = createAgentRunner({ models, tools: [] });
	const session = await runner.openSession(name, { surface: "workflow" });
	const frames = await collect(session, { text: "hi", model: "faux/scripted" });
	await runner.close();
	return { frames, calls };
}

// --- a Gemini MALFORMED_FUNCTION_CALL is sampled again instead of ending the turn as upstream (#1043) ---
{
	const { frames, calls } = await scriptedTurn("errors-resample", [errorMessage("Provider stopped with: MALFORMED_FUNCTION_CALL"), fauxAssistantMessage([fauxText("resampled")])]);
	expect("a malformed Gemini call is retried and the turn completes", calls.length === 2 && frames.every((f) => f.type !== "error"), JSON.stringify(frames));
}

// --- a stream that drops after its reasoning only is retried; the answer arrives once (#1043) ---
{
	const { frames, calls } = await scriptedTurn("errors-midstream-thinking", [
		fauxAssistantMessage([fauxThinking("planning the shot")], { stopReason: "error", errorMessage: "terminated" }),
		fauxAssistantMessage([fauxText("after the drop")]),
	]);
	const text = frames.filter((f) => f.type === "text.delta").map((f) => f.text).join("");
	expect("a drop after reasoning alone is retried", calls.length === 2 && frames.every((f) => f.type !== "error") && text === "after the drop", JSON.stringify({ calls: calls.length, frames }));
}

// --- a drop after the answer started is not retried: the panel never sees an answer twice ---
{
	const { frames, calls } = await scriptedTurn("errors-midstream-text", [
		fauxAssistantMessage([fauxText("half an answer")], { stopReason: "error", errorMessage: "terminated" }),
		fauxAssistantMessage([fauxText("second answer")]),
	]);
	expect("a drop after answer text ends the turn", calls.length === 1 && frames.some((f) => f.type === "error"), JSON.stringify({ calls: calls.length }));
}

// --- a final rate limit names its provider and the provider's wait (#1043) ---
{
	const quota = "429 You exceeded your current quota, please check your plan and billing details. Please retry in 0.05s.";
	const started = Date.now();
	const { frames, calls } = await scriptedTurn("errors-quota", [errorMessage(quota), errorMessage(quota), fauxAssistantMessage([fauxText("never")])]);
	const error = frames.find((f) => f.type === "error");
	expect("a short quota wait is taken once, then the turn fails as rate_limit", calls.length === 2 && error?.code === "rate_limit", JSON.stringify({ calls: calls.length, error }));
	expect("the rate_limit frame names the provider and when to retry", error?.provider === "faux" && error?.retryAfterMs === 50 && Date.parse(error?.resetAt) >= started, JSON.stringify(error));
	const plain = (await scriptedTurn("errors-quota-plain", [errorMessage("429 quota exceeded, check billing"), fauxAssistantMessage([fauxText("never")])])).frames.find((f) => f.type === "error");
	expect("a rate limit without a wait carries no reset time", plain?.code === "rate_limit" && plain.provider === "faux" && !("resetAt" in plain), JSON.stringify(plain));
}

// --- one session whose tool set changes between turns (the Studio Tasks switch) still runs ---
{
	const models = createModels();
	const faux = fauxProvider({ provider: "faux", models: [{ id: "scripted", name: "Scripted", input: ["text", "image"] }] });
	models.setProvider(faux.provider);
	installScripts(faux, [fauxAssistantMessage([fauxText("one")]), fauxAssistantMessage([fauxText("two")])]);
	const toolNamed = (name) => ({ name, parameters: { type: "object", properties: {}, additionalProperties: false }, handler: async () => ({ ok: true }) });
	const runner = createAgentRunner({ models, tools: [] });
	const session = await runner.openSession("errors-tool-swap", { surface: "workflow" });
	const first = await collect(session, { text: "hi", model: "faux/scripted", tools: [toolNamed("inspect_studio")] });
	const second = await collect(session, { text: "again", model: "faux/scripted", tools: [toolNamed("dispatch_task")] });
	await runner.close();
	expect("a turn with a different tool set in the same session is not refused", first.every((f) => f.type !== "error") && second.every((f) => f.type !== "error") && second.some((f) => f.type === "done"), JSON.stringify(second));
}

// --- provider-shaped key material in an upstream error is never exposed ---
for (const token of ["AIza-secret-0123456789abcdefghijk", "sk-or-secret", "sk-ant-secret", "sk-secret", "Bearer secret", "eyJsecret"]) {
	const models = createModels();
	const faux = fauxProvider({ provider: "faux", models: [{ id: "scripted", name: "Scripted", input: ["text", "image"] }] });
	models.setProvider(faux.provider);
	installScripts(faux, [() => { throw new Error(`provider key ${token}`); }]);
	const runner = createAgentRunner({ models, tools: [] });
	const session = await runner.openSession("errors-sanitized-key", { surface: "workflow" });
	const frames = await collect(session, { text: "hi", model: "faux/scripted" });
	await runner.close();
	const error = frames.find((frame) => frame.type === "error");
	expect(`provider key material (${token.split("secret")[0]}) is redacted from the runner error frame`, !!error && !error.message.includes("AIza") && !error.message.includes("secret"), JSON.stringify(error));
}

// --- 529 four times: retries exhausted (maxRetries:3 = 4 attempts total, #975) -> error{code:'overloaded'} ---
{
	const sessionsDir = mkdtempSync(join(tmpdir(), "cozyclay-agent-runner-errors-overloaded-store-"));
	const sessionStore = createSessionStore(sessionsDir);
	const models = createModels();
	const faux = fauxProvider({ provider: "faux", models: [{ id: "scripted", name: "Scripted", input: ["text", "image"] }] });
	models.setProvider(faux.provider);
	const calls = installScripts(faux, [errorMessage("500 overloaded"), errorMessage("500 overloaded"), errorMessage("500 overloaded"), errorMessage("500 overloaded"), fauxAssistantMessage([fauxText("recovered after overload")])]);
	const runner = createAgentRunner({ models, tools: [], sessionStore });
	const session = await runner.openSession("errors-529", { surface: "workflow" });
	const frames = await collect(session, { text: "hi", model: "faux/scripted" });
	const firstHistory = sessionStore.read("errors-529")?.history || [];
	console.log("16a-overloaded-store-roles", JSON.stringify(firstHistory.map((message) => message.role)));
	const error = frames.find((f) => f.type === "error");
	expect("529 four times exhausts retries with one error frame", !!error, JSON.stringify(frames));
	expect("the error frame carries code:'overloaded'", error?.code === "overloaded", JSON.stringify(error));
	expect("a done frame follows the error frame", frames.at(-1)?.type === "done", JSON.stringify(frames));
	expect("the model was called exactly 4 times", calls.length === 4, `calls.length=${calls.length}`);
	expect("overloaded failures keep model history limited to the user message", JSON.stringify(firstHistory.map((message) => message.role)) === "[\"user\"]", JSON.stringify(firstHistory));
	const firstSession = sessionStore.read("errors-529");
	expect("overloaded failure is persisted separately with code and message", firstSession?.turnErrors?.length === 1 && firstSession.turnErrors[0].code === error.code && firstSession.turnErrors[0].message === error.message, JSON.stringify(firstSession?.turnErrors));
	expect("the failure appears at the end of the restored transcript", JSON.stringify((await import("../bin/agent/session-store.mjs")).transcriptFromHistory(firstSession?.history || [])) === JSON.stringify([{ kind: "user", text: "hi" }, { kind: "failure", code: error.code, message: error.message }]), JSON.stringify((await import("../bin/agent/session-store.mjs")).transcriptFromHistory(firstSession?.history || [])));
	await collect(session, { text: "recover", model: "faux/scripted" });
	const finalHistory = sessionStore.read("errors-529")?.history || [];
	expect("a successful turn after overload persists [user,user,assistant]", JSON.stringify(finalHistory.map((message) => message.role)) === "[\"user\",\"user\",\"assistant\"]", JSON.stringify(finalHistory));
	expect("the successful post-overload assistant is recovered", finalHistory.at(-1)?.content?.[0]?.text === "recovered after overload", JSON.stringify(finalHistory.at(-1)));
	await runner.close();
	console.log("16a-overloaded-final-roles", JSON.stringify(finalHistory.map((message) => message.role)));
}

// --- truncated provider stream: failed assistant entries never reach JSONL ---
{
	const sessionsDir = mkdtempSync(join(tmpdir(), "cozyclay-agent-runner-errors-truncated-store-"));
	const sessionStore = createSessionStore(sessionsDir);
	const models = createModels();
	const faux = fauxProvider({ provider: "faux", models: [{ id: "scripted", name: "Scripted", input: ["text", "image"] }] });
	models.setProvider(faux.provider);
	const calls = installScripts(faux, [errorMessage("response ended before a terminal response event"), fauxAssistantMessage([fauxText("recovered after truncation")])]);
	const runner = createAgentRunner({ models, tools: [], sessionStore });
	const session = await runner.openSession("errors-truncated", { surface: "workflow" });
	const frames = await collect(session, { text: "truncated", model: "faux/scripted" });
	const firstHistory = sessionStore.read("errors-truncated")?.history || [];
	console.log("16a-truncated-store-roles", JSON.stringify(firstHistory.map((message) => message.role)));
	const error = frames.find((f) => f.type === "error");
	assert.equal(error?.code, "truncated");
	assert.equal(frames.at(-1)?.type, "done");
	expect("truncated failures persist only the user message", JSON.stringify(firstHistory.map((message) => message.role)) === "[\"user\"]", JSON.stringify(firstHistory));
	await collect(session, { text: "recover truncation", model: "faux/scripted" });
	const finalHistory = sessionStore.read("errors-truncated")?.history || [];
	expect("a successful turn after truncation persists [user,user,assistant]", JSON.stringify(finalHistory.map((message) => message.role)) === "[\"user\",\"user\",\"assistant\"]", JSON.stringify(finalHistory));
	expect("the successful post-truncation assistant is recovered", finalHistory.at(-1)?.content?.[0]?.text === "recovered after truncation", JSON.stringify(finalHistory.at(-1)));
	expect("truncated scenario uses one initial and one successful provider call", calls.length === 2, `calls.length=${calls.length}`);
	await runner.close();
	console.log("16a-truncated-final-roles", JSON.stringify(finalHistory.map((message) => message.role)));
}

// --- 401 on openai-codex: the credential-store refresh path runs once, then one retry ---
{
	const models = createModels();
	const faux = fauxProvider({ provider: "openai-codex", models: [{ id: "gpt-6-astra", name: "Astra", input: ["text", "image"] }] });
	models.setProvider(faux.provider);
	const calls = installScripts(faux, [errorMessage("401 Unauthorized"), fauxAssistantMessage([fauxText("recovered")])]);
	const authCalls = [];
	const originalGetAuth = models.getAuth.bind(models);
	models.getAuth = async (...args) => {
		if (args[1]?.minOAuthValidityMs !== undefined) authCalls.push(args);
		return originalGetAuth(...args);
	};
	const runner = createAgentRunner({ models, tools: [] });
	const session = await runner.openSession("errors-401", { surface: "workflow" });
	const frames = await collect(session, { text: "hi" }); // default model resolves to openai-codex/gpt-6-astra
	await runner.close();
	expect("the credential-store refresh path (Models.getAuth forced-expiry) runs exactly once", authCalls.length === 1, `authCalls.length=${authCalls.length}`);
	expect("the turn is retried exactly once and recovers", calls.length === 2 && frames.every((f) => f.type !== "error") && frames.at(-1)?.type === "done", JSON.stringify(frames));
}

// --- 401 retry continues the existing transcript, preserving one attachment ---
{
	const models = createModels();
	const faux = fauxProvider({ provider: "openai-codex", models: [{ id: "gpt-6-astra", name: "Astra", input: ["text", "image"] }] });
	models.setProvider(faux.provider);
	const calls = installScripts(faux, [errorMessage("401 Unauthorized"), fauxAssistantMessage([fauxText("recovered with the original image")])]);
	const runner = createAgentRunner({ models, tools: [] });
	const session = await runner.openSession("errors-401-attachment", { surface: "workflow" });
	const frames = await collect(session, {
		text: "describe this image",
		attachments: [{ dataUrl: "data:image/png;base64,AA==", name: "probe.png" }],
	});
	await runner.close();
	const counts = calls.map((context) => context.messages.length);
	const imageCounts = calls.map((context) => context.messages.filter((message) => message.role === "user" && message.content?.some((part) => part.type === "image")).length);
	expect("401 retry resumes the same transcript with one attachment (message counts [2,2])", JSON.stringify(counts) === "[2,2]", JSON.stringify(counts));
	expect("401 retry preserves exactly one image-bearing user message", JSON.stringify(imageCounts) === "[1,1]", JSON.stringify(imageCounts));
	// The original roles, text and image bytes survive the in-place retry.
	const content = (context) => JSON.stringify(context.messages.map(({ role, content: parts }) => ({ role, content: parts })));
	expect("401 retry keeps the original user messages and image bytes unchanged", content(calls[0]) === content(calls[1]), JSON.stringify(calls.map(content)));
	expect("401 attachment retry still completes without an error frame", frames.every((frame) => frame.type !== "error") && frames.at(-1)?.type === "done", JSON.stringify(frames));
}

// --- auth retry after a completed tool must not execute that tool again ---
{
	const sessionsDir = mkdtempSync(join(tmpdir(), "cozyclay-agent-runner-errors-post-tool-auth-"));
	const sessionStore = createSessionStore(sessionsDir);
	const models = createModels();
	const faux = fauxProvider({ provider: "openai-codex", models: [{ id: "gpt-6-astra", name: "Astra", input: ["text", "image"] }] });
	models.setProvider(faux.provider);
	let mutations = 0, refreshes = 0;
	const originalGetAuth = models.getAuth.bind(models);
	models.getAuth = async (...args) => {
		if (args[1]?.minOAuthValidityMs !== undefined) refreshes++;
		return originalGetAuth(...args);
	};
	const calls = [];
	const mutate = (id) => fauxAssistantMessage([fauxToolCall("mutate", {}, { id })], { stopReason: "toolUse" });
	faux.setResponses([
		() => mutate("first-mutation"),
		() => errorMessage("401 Unauthorized"),
		(context) => context.messages.some((message) => message.role === "toolResult")
			? fauxAssistantMessage([fauxText("already applied")]) : mutate("replayed-mutation"),
		() => fauxAssistantMessage([fauxText("done")]),
	].map((respond) => (context) => { calls.push(structuredClone(context)); return respond(context); }));
	const runner = createAgentRunner({ models, sessionStore, tools: [{ name: "mutate", parameters: { type: "object", properties: {}, additionalProperties: false }, handler: async () => ({ applied: ++mutations }) }] });
	let frames;
	try {
		const session = await runner.openSession("errors-post-tool-auth", { surface: "workflow" });
		frames = await collect(session, { text: "apply this change once" });
	} finally { await runner.close(); }
	const history = sessionStore.read("errors-post-tool-auth")?.history || [];
	console.log("post-tool-auth", JSON.stringify({ mutations, refreshes, contexts: calls.map((context) => context.messages.map((message) => message.role)), roles: history.map((message) => message.role), frames }));
	assert.equal(mutations, 1, "auth recovery must not execute an already completed mutation again");
	assert.equal(refreshes, 1);
	// the conversation part of each request; pi's leading system message carries the prompt and tools
	assert.deepEqual(calls.map((context) => context.messages.filter((message) => message.role !== "system").map((message) => message.role)), [["user"], ["user", "assistant", "toolResult"], ["user", "assistant", "toolResult"]]);
	assert.deepEqual(calls[2].messages, calls[1].messages, "the pending model call retries with the exact completed transcript");
	assert.deepEqual(history.map((message) => message.role), ["user", "assistant", "toolResult", "assistant"]);
	assert.equal(history[2].toolCallId, "first-mutation");
	assert.equal(history[2].details.applied, 1);
	assert.equal(history.at(-1).content[0].text, "already applied");
	assert.deepEqual(frames.filter((frame) => frame.type === "tool.start" || frame.type === "tool.done").map((frame) => [frame.type, frame.callId]), [["tool.start", "first-mutation"], ["tool.done", "first-mutation"]]);
	assert.equal(frames.find((frame) => frame.type === "tool.done").ok, true);
	assert.equal(frames.some((frame) => frame.type === "error"), false);
	assert.equal(frames.filter((frame) => frame.type === "done").length, 1);
	assert.equal(frames.at(-1).type, "done");
	console.log("PASS post-tool auth retry preserves the completed mutation, transcript, persistence and tool frames");
}

// --- auth retry persistence stores the completed transcript once ---
{
	const sessionsDir = mkdtempSync(join(tmpdir(), "cozyclay-agent-runner-errors-retry-store-"));
	const sessionStore = createSessionStore(sessionsDir);
	const models = createModels();
	const faux = fauxProvider({ provider: "openai-codex", models: [{ id: "gpt-6-astra", name: "Astra", input: ["text", "image"] }] });
	models.setProvider(faux.provider);
	installScripts(faux, [errorMessage("401 Unauthorized"), fauxAssistantMessage([fauxText("recovered")])]);
	const runner = createAgentRunner({ models, tools: [], sessionStore });
	const session = await runner.openSession("errors-401-persist", { surface: "workflow" });
	await collect(session, { text: "describe this image", attachments: [{ dataUrl: "data:image/png;base64,AA==", name: "probe.png" }] });
	await runner.close();
	const history = sessionStore.read("errors-401-persist")?.history || [];
	assert.deepEqual(history.map((message) => message.role), ["user", "user", "assistant"]);
	assert.equal(history.at(-1).content?.[0]?.text, "recovered");
	assert.equal(history.some((message) => message.errorMessage === "401 Unauthorized"), false);
	console.log("retry-store-roles", JSON.stringify(history.map((message) => message.role)));
	console.log("retry-store-history", JSON.stringify(history));
	console.log("PASS auth retry persistence stores the final branch once, including the recovered assistant");
}

// --- ordinary two-turn persistence remains user/assistant per turn ---
{
	const sessionsDir = mkdtempSync(join(tmpdir(), "cozyclay-agent-runner-errors-two-turn-store-"));
	const sessionStore = createSessionStore(sessionsDir);
	const models = createModels();
	const faux = fauxProvider({ provider: "faux", models: [{ id: "scripted", name: "Scripted", input: ["text", "image"] }] });
	models.setProvider(faux.provider);
	installScripts(faux, [fauxAssistantMessage([fauxText("first")]), fauxAssistantMessage([fauxText("second")])]);
	const runner = createAgentRunner({ models, tools: [], sessionStore });
	const session = await runner.openSession("errors-two-turn-persist", { surface: "workflow" });
	await collect(session, { text: "one", model: "faux/scripted" });
	await collect(session, { text: "two", model: "faux/scripted" });
	await runner.close();
	const history = sessionStore.read("errors-two-turn-persist")?.history || [];
	assert.deepEqual(history.map((message) => message.role), ["user", "assistant", "user", "assistant"]);
	console.log("two-turn-store-roles", JSON.stringify(history.map((message) => message.role)));
	console.log("PASS ordinary two-turn persistence remains user/assistant/user/assistant");
}

// --- a second auth failure persists user messages only and emits one error ---
{
	const sessionsDir = mkdtempSync(join(tmpdir(), "cozyclay-agent-runner-errors-retry-fail-store-"));
	const sessionStore = createSessionStore(sessionsDir);
	const models = createModels();
	const faux = fauxProvider({ provider: "openai-codex", models: [{ id: "gpt-6-astra", name: "Astra", input: ["text", "image"] }] });
	models.setProvider(faux.provider);
	const calls = installScripts(faux, [errorMessage("401 Unauthorized"), errorMessage("401 Unauthorized")]);
	let refreshes = 0;
	const originalGetAuth = models.getAuth.bind(models);
	models.getAuth = async (...args) => {
		if (args[1]?.minOAuthValidityMs !== undefined) refreshes++;
		return originalGetAuth(...args);
	};
	const runner = createAgentRunner({ models, tools: [], sessionStore });
	const session = await runner.openSession("errors-401-retry-failed", { surface: "workflow" });
	const frames = await collect(session, { text: "describe this image", attachments: [{ dataUrl: "data:image/png;base64,AA==", name: "probe.png" }] });
	await runner.close();
	const history = sessionStore.read("errors-401-retry-failed")?.history || [];
	assert.deepEqual(history.map((message) => message.role), ["user", "user"]);
	assert.equal(history.some((message) => message.role === "assistant"), false);
	assert.equal(frames.filter((frame) => frame.type === "error").length, 1);
	assert.equal(frames.find((frame) => frame.type === "error").code, "unauthorized");
	assert.equal(frames.filter((frame) => frame.type === "done").length, 1);
	assert.equal(frames.at(-1)?.type, "done");
	assert.equal(calls.length, 2, "a second 401 is terminal, not retried again");
	assert.equal(refreshes, 1);
	console.log("retry-failed-store-roles", JSON.stringify(history.map((message) => message.role)));
	console.log("retry-failed-frames", JSON.stringify(frames));
	console.log("PASS failed auth retry persists user messages only with one error and done");
}

// --- a non-Codex 401 never refreshes Codex credentials or retries ---
{
	const models = createModels();
	const faux = fauxProvider({ provider: "faux", models: [{ id: "scripted", name: "Scripted", input: ["text", "image"] }] });
	models.setProvider(faux.provider);
	const calls = installScripts(faux, [errorMessage("401 Unauthorized"), fauxAssistantMessage([fauxText("must not retry")])]);
	let refreshes = 0;
	const originalGetAuth = models.getAuth.bind(models);
	models.getAuth = async (...args) => {
		if (args[1]?.minOAuthValidityMs !== undefined) refreshes++;
		return originalGetAuth(...args);
	};
	const runner = createAgentRunner({ models });
	const session = await runner.openSession("errors-non-codex-auth");
	const frames = await collect(session, { text: "hi", model: "faux/scripted" });
	await runner.close();
	assert.equal(refreshes, 0);
	assert.equal(calls.length, 1);
	assert.equal(frames.filter((frame) => frame.type === "error").length, 1);
	assert.equal(frames.find((frame) => frame.type === "error").code, "unauthorized");
	assert.equal(frames.filter((frame) => frame.type === "done").length, 1);
	assert.equal(frames.at(-1)?.type, "done");
	console.log("PASS a non-Codex unauthorized response is terminal without a credential refresh");
}

// --- abort mid-stream (#379, strengthened for 16k): the provider stream is
// deliberately frozen — it emits its first delta then blocks forever on
// nothing but the harness's OWN abort signal (never a timer, never a
// self-resolving promise) — so a done+error{aborted} pair can only arrive
// here because `session.abort()` actually propagated pi's real abort signal
// into the still-running generation, strictly before the provider would ever
// have completed on its own. No further model calls follow the abort.
{
	const models = createModels();
	const faux = fauxProvider({ provider: "faux", models: [{ id: "scripted", name: "Scripted", input: ["text", "image"] }] });
	const started = Promise.withResolvers();
	let providerAborted = false;
	let calls = 0;
	const message = { ...fauxAssistantMessage([fauxText("this response streams across several chunks so an abort can land mid-stream")]), provider: "faux", model: "scripted" };
	faux.provider.streamSimple = (_model, _context, options) => {
		calls += 1;
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			stream.push({ type: "start", partial: { ...message, content: [] } });
			stream.push({ type: "text_start", contentIndex: 0, partial: { ...message, content: [fauxText("")] } });
			stream.push({ type: "text_delta", contentIndex: 0, delta: "this response streams", partial: message });
			started.resolve();
			// The ONLY way this stream ever ends: pi's real abort signal firing.
			// If `session.abort()` below did not actually reach this signal, the
			// test hangs until `bounded`'s own deadline, not a false pass.
			options?.signal?.addEventListener("abort", () => {
				providerAborted = true;
				const aborted = { ...message, stopReason: "aborted", errorMessage: "Request was aborted" };
				stream.push({ type: "error", reason: "aborted", error: aborted });
				stream.end(aborted);
			}, { once: true });
		});
		return stream;
	};
	models.setProvider(faux.provider);
	const runner = createAgentRunner({ models, tools: [] });
	const session = await runner.openSession("errors-abort", { surface: "workflow" });
	const frames = [];
	let aborted = false;
	const iterator = session.start({ text: "stream something long", model: "faux/scripted" })[Symbol.asyncIterator]();
	const deadline = async (promise) => {
		let timer;
		try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("abort mid-stream deadline")), 5000); })]); }
		finally { clearTimeout(timer); }
	};
	for (;;) {
		const { value, done } = await deadline(iterator.next());
		if (done) break;
		frames.push(value);
		if (value.type === "text.delta" && !aborted) { aborted = true; await started.promise; await deadline(session.abort("test")); }
	}
	await runner.close();
	expect("the abort signal actually reached the still-running (frozen) provider stream", providerAborted === true);
	expect("the stream actually started before the abort landed", frames.some((f) => f.type === "text.delta"), JSON.stringify(frames));
	expect("the model was only called once (no further model calls after abort)", calls === 1, `calls=${calls}`);
	const errorFrames = frames.filter((f) => f.type === "error");
	expect("every error frame surfaced by the aborted run carries code:'aborted'", errorFrames.length > 0 && errorFrames.every((f) => f.code === "aborted"), JSON.stringify(frames));
	expect("a done frame is the last frame", frames.at(-1)?.type === "done", JSON.stringify(frames));
}

// --- #379 / 16k (F2 pass 5 finding 4): the first assistant text must reach
// the browser immediately, not after the whole provider call completes. A
// controlled faux stream emits its first text_delta then BLOCKS completion
// until this test releases it (no sleeps — the test's own signal bounds the
// wait) — the SSE consumer must receive that delta, preceded by exactly one
// quota frame, before the release, proving `pushFrame`'s gate no longer
// withholds a turn's first output for the whole generation.
{
	const models = createModels();
	const faux = fauxProvider({ provider: "faux", models: [{ id: "scripted", name: "Scripted", input: ["text", "image"] }] });
	const release = Promise.withResolvers();
	const started = Promise.withResolvers();
	const message = { ...fauxAssistantMessage([fauxText("first visible token")]), provider: "faux", model: "scripted" };
	let providerEnded = false;
	faux.provider.streamSimple = () => {
		const stream = createAssistantMessageEventStream();
		queueMicrotask(async () => {
			stream.push({ type: "start", partial: { ...message, content: [] } });
			stream.push({ type: "text_start", contentIndex: 0, partial: { ...message, content: [fauxText("")] } });
			stream.push({ type: "text_delta", contentIndex: 0, delta: "first visible token", partial: message });
			started.resolve();
			await release.promise;
			providerEnded = true;
			stream.push({ type: "text_end", contentIndex: 0, content: "first visible token", partial: message });
			stream.push({ type: "done", reason: "stop", message });
			stream.end();
		});
		return stream;
	};
	models.setProvider(faux.provider);
	const runner = createAgentRunner({ models });
	const session = await runner.openSession("streaming-boundary", { surface: "workflow" });
	const iterator = session.start({ text: "stream the answer", model: "faux/scripted" })[Symbol.asyncIterator]();
	const first = iterator.next();
	await started.promise;
	let timer;
	const early = await Promise.race([first.then((value) => ({ frame: value.value })), new Promise((resolve) => { timer = setTimeout(() => resolve({ deadline: true }), 5000); })]);
	clearTimeout(timer);
	const endedBeforeFirstFrame = providerEnded;
	release.resolve();
	const frames = [(await first).value];
	for (;;) { const next = await iterator.next(); if (next.done) break; frames.push(next.value); }
	await runner.close();
	expect("the first frame arrives before the provider call completes, not at the 5s deadline", !early.deadline, JSON.stringify(early));
	expect("the provider call had not ended when the first frame arrived", endedBeforeFirstFrame === false);
	expect("the first frame delivered is the quota frame", early.frame?.type === "quota", JSON.stringify(early.frame));
	expect("exactly one quota frame precedes the text.delta", frames.filter((f) => f.type === "quota").length === 1 && frames.findIndex((f) => f.type === "quota") < frames.findIndex((f) => f.type === "text.delta"), JSON.stringify(frames));
	expect("the visible text and a terminal done still follow", frames.some((f) => f.type === "text.delta" && f.text === "first visible token") && frames.at(-1)?.type === "done", JSON.stringify(frames));
}

// --- tool-level abort (#379): the harness's REAL abort signal must reach the
// tool handler as `ctx.signal`, not a positional update-callback function.
// A fixture tool awaits its own `ctx.signal` and records `signal.aborted`
// once it fires; before the pi-tools.mjs fix this never resolves that way
// because `signal` is actually the harness's `onUpdate` callback (a
// function), so `ctx.signal.aborted` throws / never becomes true.
{
	const observed = [];
	let started;
	const slowTool = (turn) => ({
		name: "slow_tool",
		description: "A slow tool used to prove the harness abort signal reaches tool handlers.",
		// Subscribe inside the handler before telling the test it may abort.
		// Each turn supplies a new closure with the same name and schema.
		handler: (params, ctx) => new Promise((resolve, reject) => {
			ctx.signal.addEventListener("abort", () => {
				observed.push({ turn, aborted: ctx.signal.aborted });
				reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
			}, { once: true });
			started.resolve(ctx.signal);
		}),
	});
	const bounded = async (promise) => {
		let timer;
		try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("tool abort event deadline")), 5000); })]); }
		finally { clearTimeout(timer); }
	};
	const models = createModels();
	const faux = fauxProvider({ provider: "faux", models: [{ id: "scripted", name: "Scripted", input: ["text", "image"] }] });
	models.setProvider(faux.provider);
	installScripts(faux, [1, 2].map((turn) => fauxAssistantMessage([fauxToolCall("slow_tool", {}, { id: `slow-${turn}` })], { stopReason: "toolUse" })));
	const runner = createAgentRunner({ models });
	const session = await runner.openSession("errors-tool-abort", { surface: "workflow" });
	let previousSignal;
	try {
		for (const turn of [1, 2]) {
			started = Promise.withResolvers();
			const completed = bounded(collect(session, { text: "run the slow tool", model: "faux/scripted", tools: [slowTool(turn)] }));
			const signal = await bounded(started.promise);
			assert.equal(signal.aborted, false, `turn ${turn} starts with a live signal`);
			assert.notEqual(signal, previousSignal, "each turn receives its own harness abort signal");
			await bounded(session.abort(`test turn ${turn}`));
			const frames = await completed;
			assert.equal(signal.aborted, true);
			assert.equal(frames.at(-1)?.type, "done", JSON.stringify(frames));
			assert.ok(frames.some((frame) => frame.type === "error" && frame.code === "aborted"), JSON.stringify(frames));
			previousSignal = signal;
		}
	} finally { await runner.close(); }
	console.log("two-turn tool abort bindings", JSON.stringify(observed));
	assert.deepEqual(observed, [{ turn: 1, aborted: true }, { turn: 2, aborted: true }], "each turn's slow-tool closure observes that turn's abort");
	console.log("PASS both turns' tool handlers receive pi's real harness abort signal and complete with done");
}

// --- abort persistence: the real session store never gets the cancelled
// assistant message, only the completed user turn that preceded it ---
{
	const sessionsDir = mkdtempSync(join(tmpdir(), "cozyclay-agent-runner-errors-store-"));
	const sessionStore = createSessionStore(sessionsDir);
	const models = createModels();
	const faux = fauxProvider({ provider: "faux", models: [{ id: "scripted", name: "Scripted", input: ["text", "image"] }], tokensPerSecond: 2 });
	models.setProvider(faux.provider);
	installScripts(faux, [fauxAssistantMessage([fauxText("this response streams across several chunks so an abort can land mid-stream")])]);
	const runner = createAgentRunner({ models, tools: [], sessionStore });
	const session = await runner.openSession("errors-abort-persist", { surface: "workflow" });
	const iterator = session.start({ text: "stream something long", model: "faux/scripted" })[Symbol.asyncIterator]();
	let aborted = false;
	for (;;) {
		const { value, done } = await iterator.next();
		if (done) break;
		if (value.type === "text.delta" && !aborted) { aborted = true; await session.abort("test"); }
	}
	await runner.close();
	const stored = sessionStore.read("errors-abort-persist");
	const roles = (stored?.history || []).map((message) => message.role);
	// Exactly the user turn: no tool ran in this scenario, so there is no
	// completed toolResult to also expect; a scenario with a tool would keep
	// any toolResult from a tool that finished BEFORE the abort (the `persist`
	// filter withholds the assistant role and a call the abort cut short, never
	// a finished toolResult or the user; see the next block).
	assert.deepEqual(roles, ["user"], `stored roles after abort: ${JSON.stringify(roles)}`);
	console.log("PASS the aborted assistant message never reaches sessionStore; only the completed user turn does");
}

// --- abort mid-tool, by session.abort() or by the caller's signal (the routes' Stop and disconnect): the call the
// abort cut short stays unfinished (no tool.done, no stored toolResult), no further model request is made, and the
// store keeps the user turn with exactly one aborted record ---
for (const via of ["session", "signal"]) {
	const sessionStore = createSessionStore(mkdtempSync(join(tmpdir(), "cozyclay-agent-runner-errors-tool-abort-")));
	const models = createModels();
	const faux = fauxProvider({ provider: "faux", models: [{ id: "scripted", name: "Scripted", input: ["text", "image"] }] });
	models.setProvider(faux.provider);
	const calls = installScripts(faux, [
		fauxAssistantMessage([fauxToolCall("slow_tool", {})], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxText("never requested")]),
	]);
	const tools = [{
		name: "slow_tool",
		parameters: { type: "object", properties: {}, additionalProperties: false },
		// Settles successfully once stopped: a result that arrives after the abort must not count.
		handler: async (_args, { signal }) => { if (!signal.aborted) await once(signal, "abort"); return { ok: true }; },
	}];
	const runner = createAgentRunner({ models, tools, sessionStore, clock: () => Date.now() });
	const controller = new AbortController();
	const frames = [];
	try {
		const session = await runner.openSession(`errors-tool-abort-${via}`, { surface: "workflow" });
		for await (const frame of session.start({ text: "run the slow tool", model: "faux/scripted", ...(via === "signal" ? { signal: controller.signal } : {}) })) {
			frames.push(frame);
			if (frame.type === "tool.start") { if (via === "session") await session.abort("test"); else controller.abort(); }
		}
	} finally { await runner.close(); }
	const stored = sessionStore.read(`errors-tool-abort-${via}`);
	assert.ok(frames.some((frame) => frame.type === "tool.start") && !frames.some((frame) => frame.type === "tool.done"), `${via}: ${JSON.stringify(frames)}`);
	assert.deepEqual(frames.slice(-2).map((frame) => frame.code ?? frame.type), ["aborted", "done"], `${via}: ${JSON.stringify(frames)}`);
	assert.equal(calls.length, 1, `${via}: no model request after the abort`);
	assert.deepEqual((stored?.history || []).map((message) => message.role), ["user"], `${via}: ${JSON.stringify(stored?.history)}`);
	assert.deepEqual((stored?.turnErrors || []).map((record) => record.code), ["aborted"], `${via}: ${JSON.stringify(stored?.turnErrors)}`);
	console.log(`PASS an abort mid-tool by ${via === "session" ? "session.abort()" : "the caller's signal"} leaves the call unfinished and stores the user turn with one aborted record`);
}

// --- status-first classification: a structured numeric status wins over the
// message text; the message regex is only a fallback ---
{
	expect("{status:429, message:'try later'} classifies as rate_limit from status, not text", classifyError({ status: 429, message: "try later" }).code === "rate_limit", JSON.stringify(classifyError({ status: 429, message: "try later" })));
	expect("{status:401, message:'x'} classifies as unauthorized from status, not text", classifyError({ status: 401, message: "x" }).code === "unauthorized", JSON.stringify(classifyError({ status: 401, message: "x" })));
	const overloadedWordsWrongStatus = classifyError({ status: 500, message: "scene overloaded with props" });
	expect("status wins over message text: status:500 classifies as upstream even though the message says 'overloaded'", overloadedWordsWrongStatus.code === "upstream", JSON.stringify(overloadedWordsWrongStatus));
	expect("the numeric status is preserved on the classification even when it decided the code", overloadedWordsWrongStatus.status === 500, JSON.stringify(overloadedWordsWrongStatus));
	const noStatusFallsBackToText = classifyError({ message: "529 Overloaded" });
	expect("with no structured status, the message-text fallback still classifies 529 as overloaded", noStatusFallsBackToText.code === "overloaded" && noStatusFallsBackToText.status === 529, JSON.stringify(noStatusFallsBackToText));
	// network: status first, then the structure agent-stream.mjs kept (errorCode), then the message patterns.
	expect("'fetch failed' (pi-ai's folded string) classifies as network", classifyProviderError("fetch failed") === "network" && classifyError({ message: "fetch failed" }).code === "network");
	expect("{errorCode:'ECONNREFUSED', message:'x'} classifies as network from the structure", classifyError({ errorCode: "ECONNREFUSED", message: "x" }).code === "network");
	expect("{errorCode:'TypeError'} classifies as network", classifyProviderError("x", "TypeError") === "network");
	expect("{status:503, message:'fetch failed'}: the status wins, upstream", classifyError({ status: 503, message: "fetch failed" }).code === "upstream", JSON.stringify(classifyError({ status: 503, message: "fetch failed" })));
	expect("'429 too many requests' stays rate_limit", classifyError({ message: "429 too many requests" }).code === "rate_limit");
	expect("'unauthorized' stays unauthorized", classifyProviderError("unauthorized") === "unauthorized");
	expect("'unauthorized ... fetch failed' keeps the earlier patterns first", classifyProviderError("unauthorized: fetch failed") === "unauthorized");
	expect("an unrelated errorCode does not decide", classifyError({ errorCode: "ERR_INVALID_ARG", message: "x" }).code === "upstream");
}

// --- a tool error containing a status-shaped substring in its own text must
// NOT be reclassified as a provider error: it stays a tool failure with the
// CODE: message format, because classifyError/classifyProviderError are only
// ever invoked at provider response/run failure boundaries, never on a tool
// result's text (verified structurally: tool_end never calls classifyError) ---
{
	const models = createModels();
	const faux = fauxProvider({ provider: "faux", models: [{ id: "scripted", name: "Scripted", input: ["text", "image"] }] });
	models.setProvider(faux.provider);
	installScripts(faux, [
		fauxAssistantMessage([fauxToolCall("failing_tool", {})], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxText("handled the failure")]),
	]);
	const tools = [{
		name: "failing_tool",
		parameters: { type: "object", properties: {}, additionalProperties: false },
		handler: async () => { throw Object.assign(new Error("the backend answered 403 Forbidden"), { code: "BACKEND_UNAVAILABLE" }); },
	}];
	const runner = createAgentRunner({ models, tools, clock: () => Date.now() });
	const session = await runner.openSession("errors-tool-text-not-reclassified", { surface: "workflow" });
	const frames = await collect(session, { text: "run the failing tool", model: "faux/scripted" });
	await runner.close();
	const toolDone = frames.find((f) => f.type === "tool.done");
	expect("the tool's '403' text produces a tool.done failure frame, never a run-level error frame", toolDone && toolDone.ok === false, JSON.stringify(frames));
	expect("the tool failure keeps the CODE: message format instead of being reclassified as code:'unauthorized'", typeof toolDone?.error === "string" && toolDone.error.startsWith("BACKEND_UNAVAILABLE:"), JSON.stringify(toolDone));
	expect("no run-level error frame was produced for a tool failure that the assistant recovered from", frames.every((f) => f.type !== "error"), JSON.stringify(frames));
}

// --- provider attribution: the runner's requests carry no pi attribution headers ---
// pi-agent-core's Agent attributes requests to pi by default (OpenRouter, NVIDIA NIM and OpenCode headers);
// pi 0.99's runner sent none, and these are CozyClay's requests.
{
	const seen = [];
	const fixture = createServer(async (req, res) => {
		req.resume(); await once(req, "end");
		seen.push({ title: req.headers["x-openrouter-title"] ?? null, referer: req.headers["http-referer"] ?? null });
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.write(`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "hi" }, finish_reason: null }] })}\n\n`);
		res.write(`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } })}\n\n`);
		res.end("data: [DONE]\n\n");
	});
	const listening = once(fixture, "listening", { signal: AbortSignal.timeout(5000) });
	fixture.listen(0, "127.0.0.1"); await listening;
	const env = { OPENROUTER_API_KEY: "sk-or-fixture" };
	const models = await createAgentModels({ auth: { readStored: () => undefined }, keys: { readKeys: () => ({}) }, env });
	models.setProvider(await loadProvider("openrouter", { baseUrl: `http://127.0.0.1:${fixture.address().port}/api/v1`, env }));
	const model = models.getModels("openrouter").find((entry) => entry.api === "openai-completions");
	const runner = createAgentRunner({ models });
	let frames;
	try {
		const session = await runner.openSession("errors-attribution");
		frames = await collect(session, { text: "hi", model: `openrouter/${model.id}` });
	} finally {
		await runner.close();
		const closed = once(fixture, "close", { signal: AbortSignal.timeout(5000) });
		fixture.close(); fixture.closeAllConnections(); await closed;
	}
	assert.deepEqual(frames.filter((frame) => frame.type === "error"), [], JSON.stringify(frames));
	assert.equal(frames.at(-1)?.type, "done", JSON.stringify(frames));
	assert.deepEqual(seen, [{ title: null, referer: null }], "one request, with no provider attribution header naming pi");
	console.log("PASS the runner's provider requests carry no pi attribution headers");
}

process.exit(failures === 0 ? 0 : 1);
