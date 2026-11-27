// Verifies the google-antigravity lane without a Google account: a fake ACP agent process
// (test/fixtures/fake-antigravity-acp.mjs) stands in for Google's antigravity-acp, so what is
// checked is the client contract — handshake and oauth-personal sign-in, session options (built-ins
// off, CozyClay tools on the loopback MCP bridge, system prompt appended), model variant choice,
// event mapping (text, thinking, usage, tool handoff), failures that classify as auth /
// rate_limit, env hygiene, the token-free stored marker, and the binary's download guards.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeContext } from "@earendil-works/pi-ai";
import { classifyProviderError } from "../bin/agent/agent-runner.mjs";
import { ensureAntigravityAcp, locateAntigravityAcp, platformKey, PINNED_ENTRY } from "../bin/agent/antigravity-acp-binary.mjs";
import { startAntigravity } from "../bin/agent/google-antigravity-agent.mjs";
import { createAntigravityStream, pickModelId } from "../bin/agent/google-antigravity-stream.mjs";
import { ANTIGRAVITY_PROVIDER_ID, createAntigravityLogin, googleAntigravityProvider, signInMarker } from "../bin/agent/google-antigravity.mjs";
import { PROVIDERS } from "../bin/agent/providers.mjs";

const FAKE = fileURLToPath(new URL("./fixtures/fake-antigravity-acp.mjs", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "verify-agy-"));
let run = 0;
function fakeStart(mode) {
	const logFile = join(dir, `log-${++run}.jsonl`);
	const env = { PATH: process.env.PATH, FAKE_AGY_MODE: mode, FAKE_AGY_LOG: logFile, GEMINI_API_KEY: "should-not-leak" };
	const start = (options) => startAntigravity({ ...options, env, locate: () => ({ command: process.execPath, args: [FAKE] }) });
	const log = () => { try { return readFileSync(logFile, "utf8").trim().split("\n").map((line) => JSON.parse(line)); } catch { return []; } };
	return { start, log };
}
const model = { id: "gemini-4-neon", name: "Gemini 4 Neon", api: "google-generative-ai", provider: ANTIGRAVITY_PROVIDER_ID, reasoning: true, input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 512_000, maxTokens: 65_536 };
const tool = { name: "add_object", description: "Add an object", parameters: { type: "object", properties: { target: { type: "string" }, amount: { type: "number" } }, required: ["target"] } };
async function turn(mode, { tools = [], reasoning = "high", signal } = {}) {
	const fake = fakeStart(mode);
	const stream = createAntigravityStream({ start: fake.start });
	const events = [];
	const context = normalizeContext({ systemPrompt: "You are a previs assistant.", messages: [{ role: "user", content: "say hi", timestamp: 1 }], tools });
	for await (const event of await stream(model, context, { reasoning, signal })) events.push(event);
	return { events, last: events.at(-1), log: fake.log() };
}

// --- registered as an oauth lane beside the unchanged API-key Gemini lane ---
assert.ok(PROVIDERS.some((provider) => provider.id === "google-antigravity" && provider.auth === "oauth"));
assert.deepEqual(PROVIDERS.find((provider) => provider.id === "google").env, ["GEMINI_API_KEY", "GOOGLE_API_KEY"]);
{
	const provider = await googleAntigravityProvider({ login: async () => signInMarker() });
	assert.equal(provider.name, "Gemini (Google AI subscription)");
	assert.ok(provider.getModels().length > 0 && provider.getModels().every((item) => /^gemini-/.test(item.id) && item.provider === ANTIGRAVITY_PROVIDER_ID));
	assert.equal(provider.auth.oauth.isSubscription, true);
	assert.deepEqual(await provider.auth.oauth.toAuth(signInMarker()), {}, "no token is ever handed to a request");
}

// --- a text turn: handshake, session options, model variant, events ---
{
	const { last, events, log } = await turn("text", { tools: [tool] });
	assert.equal(last.type, "done", JSON.stringify(last));
	assert.equal(last.message.stopReason, "stop");
	assert.deepEqual(last.message.content.map((block) => block.type), ["thinking", "text"]);
	assert.equal(last.message.content[1].text, "Hello from Gemini");
	assert.equal(last.message.usage.input, 12);
	assert.ok(events.some((event) => event.type === "text_delta"));
	const methods = log.filter((entry) => entry.method).map((entry) => entry.method);
	assert.deepEqual(methods, ["initialize", "authenticate", "session/new", "session/set_config_option", "session/prompt"]);
	const byMethod = Object.fromEntries(log.filter((entry) => entry.method).map((entry) => [entry.method, entry]));
	assert.deepEqual(byMethod.initialize.params.clientCapabilities, { fs: { readTextFile: false, writeTextFile: false }, terminal: false });
	assert.equal(byMethod.authenticate.params.methodId, "oauth-personal");
	assert.equal(byMethod.authenticate.env.GEMINI_API_KEY, null, "an API key never reaches the subscription binary");
	const meta = byMethod["session/new"].params._meta.antigravity;
	assert.deepEqual(meta.enabledTools, [], "every Antigravity built-in tool is off");
	assert.deepEqual(meta.eagerMcpServers, ["cozyclay-tools"]);
	assert.ok(meta.systemPrompt.append.includes("previs assistant"));
	const [server] = byMethod["session/new"].params.mcpServers;
	assert.equal(server.type, "http");
	assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
	assert.equal(byMethod["session/set_config_option"].params.value, "gemini-4-neon-high");
	assert.ok(byMethod["session/prompt"].params.prompt.some((block) => block.type === "text" && block.text.includes("say hi")));
}

// --- a tool call through the MCP bridge ends the turn as toolUse with the agent's arguments ---
{
	const { last, log } = await turn("tool", { tools: [tool] });
	assert.equal(last.type, "done", JSON.stringify(last));
	assert.equal(last.message.stopReason, "toolUse");
	const call = last.message.content.find((block) => block.type === "toolCall");
	assert.equal(call.name, "add_object");
	assert.deepEqual(call.arguments, { target: "cube", amount: 2 });
	const reply = log.find((entry) => entry.toolReply);
	assert.deepEqual(reply.tools, ["add_object"]);
	assert.equal(reply.toolReply.isError, true, "the bridge runs nothing; it hands the call to CozyClay");
	assert.ok(log.some((entry) => entry.method === "session/cancel"));
}

// --- the binary's sign-in ended: fails as auth, never hangs ---
{
	const { last } = await turn("expired");
	assert.equal(last.type, "error");
	assert.equal(classifyProviderError(last.error.errorMessage), "unauthorized");
	assert.match(last.error.errorMessage, /Sign in with Gemini \(Google AI subscription\)/);
}

// --- a quota refusal reads as rate_limit ---
{
	const { last } = await turn("quota");
	assert.equal(last.type, "error");
	assert.equal(classifyProviderError(last.error.errorMessage), "rate_limit");
}

// --- model choice: thinking variant, bare id, Gemini only ---
assert.equal(pickModelId(["gemini-4-neon-low", "gemini-4-neon-high"], "gemini-4-neon", "high"), "gemini-4-neon-high");
assert.equal(pickModelId(["gemini-4-hydrogen"], "gemini-4-hydrogen", "medium"), "gemini-4-hydrogen");
assert.equal(pickModelId(["gemini-4-hydrogen"], "gemini-4-neon", "medium"), undefined);
{
	const fake = fakeStart("text");
	const stream = createAntigravityStream({ start: fake.start });
	const events = [];
	for await (const event of await stream({ ...model, id: "claude-opus-5-5" }, normalizeContext({ messages: [{ role: "user", content: "x", timestamp: 1 }], tools: [] }), {})) events.push(event);
	assert.equal(events.at(-1).type, "error");
	assert.deepEqual(fake.log(), [], "a non-Gemini model never reaches the binary");
}

// --- login: the binary's own sign-in, a token-free marker, its sign-in link relayed ---
{
	const fake = fakeStart("link");
	const notes = [];
	const login = createAntigravityLogin({ ensure: async () => ({}), start: fake.start });
	const credential = await login({ notify: (event) => notes.push(event) });
	assert.equal(credential.type, "oauth");
	assert.equal(credential.access, "");
	assert.equal(credential.refresh, "");
	assert.equal(credential.via, "antigravity-acp");
	assert.ok(notes.some((note) => note.type === "auth_url" && note.url.startsWith("https://accounts.google.com/")));
}

// --- the binary: override, cache path, official download only, checksum ---
{
	assert.equal(platformKey("darwin", "arm64"), "darwin-aarch64");
	assert.equal(platformKey("win32", "x64"), "windows-x86_64");
	for (const key of ["darwin-aarch64", "darwin-x86_64", "linux-x86_64", "windows-x86_64"]) assert.ok(PINNED_ENTRY.binary[key], key);
	assert.equal(locateAntigravityAcp({ env: { ANTIGRAVITY_ACP_EXECUTABLE: FAKE } }).command, FAKE);
	assert.equal(locateAntigravityAcp({ env: { XDG_CACHE_HOME: dir } }).command, undefined);
	const registry = (archive, sha256 = "0".repeat(64)) => async (url) => url.includes("registry")
		? { ok: true, json: async () => ({ agents: [{ id: "antigravity-acp", version: "9.9.9", distribution: { binary: { [platformKey()]: { archive, cmd: "./agy_acp_server.par", sha256 } } } }] }) }
		: { ok: true, arrayBuffer: async () => new TextEncoder().encode("not the archive").buffer };
	await assert.rejects(ensureAntigravityAcp({ env: { XDG_CACHE_HOME: dir }, fetch: registry("https://evil.example/agy.zip") }), /outside dl\.google\.com/);
	await assert.rejects(ensureAntigravityAcp({ env: { XDG_CACHE_HOME: dir }, fetch: registry("https://dl.google.com/agy-extensions/releases/x.zip") }), /checksum/);
}

rmSync(dir, { recursive: true, force: true });
console.log("verify-google-antigravity: ok");
