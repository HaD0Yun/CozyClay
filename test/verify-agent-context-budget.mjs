#!/usr/bin/env node
// Studio per-request context diet (#716): three scripted Studio turns, each
// calling inspect_studio once. The provider request of turn 3 must carry the
// full <studio-context> only in the latest user message, keep the re-embedded
// inspect_studio `context` only in the most recent tool result, and read the
// static actionIndex from an <actions> block in the system prompt. The done
// frame carries the turn's accumulated provider usage.
import assert from "node:assert/strict";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import * as runnerModule from "../bin/agent/agent-runner.mjs";
import { encodeStudioContext, studioActionIndex } from "../src/studio-agent-context.js";
import { createFakeModel } from "./fixtures/fake-model.mjs";
import { motionReference } from "../bin/agent/studio-motion-reference.mjs";
import { STUDIO_SYSTEM_PROMPT } from "../bin/agent/studio-prompt.mjs";
import { contextFixture } from "./verify-studio-agent-protocol.mjs";

const actionIndex = studioActionIndex([
	{ id: "shot.createStill", label: "New still" },
	{ id: "character.add", label: "Add character" },
	{ id: "motion.generate", label: "Generate motion", timeoutMs: 300000 },
]);
const contextFor = (turn) => ({ ...contextFixture(), revision: { scene: 40 + turn, physics: 9, view: 18 }, actionIndex });

const fake = createFakeModel();
fake.script([1, 2, 3].flatMap((turn) => [
	[{ type: "toolCall", id: `inspect-${turn}`, name: "inspect_studio", arguments: { scope: "selection" } }],
	[{ type: "text", text: `turn ${turn} done` }],
]));
const stored = [];
const sessionStore = { read: () => null, append: async (_sessionId, messages) => { stored.push(...messages); } };
let inspected = 0;
const tools = [{
	name: "inspect_studio",
	parameters: { type: "object", properties: { scope: { type: "string" } }, additionalProperties: false },
	handler: async ({ scope }) => ({ ok: true, scope, selection: { kind: "character", id: "char-alex" }, context: contextFor(++inspected) }),
}];
const { createAgentRunner, withAnthropicCacheBreakpoints } = runnerModule;
const runner = createAgentRunner({ models: fake.models, fauxProvider: fake.fauxProvider, sessionStore });
const session = await runner.openSession("context-budget", { surface: "studio" });
const turns = [];
for (const turn of [1, 2, 3]) {
	const frames = [];
	for await (const frame of session.start({ surface: "studio", model: "faux/scripted", text: `request ${turn}`, contextText: encodeStudioContext(contextFor(turn)), tools })) frames.push(frame);
	turns.push(frames);
}
await runner.close();

assert.equal(fake.calls.length, 6, "two provider requests per turn");
const request = fake.calls.at(-1);
// pi hands providers a TranscriptContext: the system prompt is replayed from its system messages
const systemPrompt = getCurrentSystemPrompt(request.messages);
const userParts = (messages) => messages.filter((message) => message.role === "user").flatMap((message) => message.content).filter((part) => part.type === "text");
const bytes = (parts) => parts.reduce((total, part) => total + Buffer.byteLength(part.text), 0);
const toolResultParts = (messages) => messages.filter((message) => message.role === "toolResult").flatMap((message) => message.content).filter((part) => part.type === "text");
// The lane's stored history is the untransformed view; turn 3's final request
// saw all of it except the final assistant answer.
const raw = stored.slice(0, -1);
console.log(`turn-3 request user text parts: ${bytes(userParts(raw))} bytes before the hook, ${bytes(userParts(request.messages))} bytes after`);
console.log(`turn-3 request user + toolResult text parts: ${bytes([...userParts(raw), ...toolResultParts(raw)])} bytes before the hook, ${bytes([...userParts(request.messages), ...toolResultParts(request.messages)])} bytes after`);
console.log(`turn-3 system prompt: ${Buffer.byteLength(systemPrompt)} bytes after the hook`);

const parts = userParts(request.messages);
assert.equal(parts.filter((part) => part.text.startsWith("<studio-context>\n{")).length, 1, "exactly one full studio context reaches the provider");
assert.equal(parts.filter((part) => part.text === "<studio-context superseded/>").length, 2, "the two earlier studio contexts are superseded");
assert.ok(parts.every((part) => !part.text.includes("actionIndex")), "no user text part carries actionIndex");
const latest = JSON.parse(/^<studio-context>\n(.*)\n<\/studio-context>$/s.exec(parts.find((part) => part.text.startsWith("<studio-context>\n{")).text)[1]);
assert.equal(latest.revision.scene, 43, "the kept studio context is the latest turn's");
assert.ok(systemPrompt.includes("<actions>"), "the system prompt carries the actions block");
const actions = JSON.parse(/\n<actions>\n(.*)\n<\/actions>$/s.exec(systemPrompt)[1]);
assert.deepEqual(actions, actionIndex, "the actions block is the context's actionIndex");
for (const { id } of actionIndex) assert.ok(systemPrompt.includes(id), `the system prompt names ${id}`);
// The motion reference sits after the rules and before the actions, and the prompt prefix is the same bytes on every request.
const reference = await motionReference();
assert.ok(systemPrompt.startsWith(`${STUDIO_SYSTEM_PROMPT}\n\n${reference}\n<actions>\n`), "rules, then the motion reference, then the actions");
assert.ok(fake.calls.every((call) => getCurrentSystemPrompt(call.messages) === systemPrompt), "every request of the session carries the same system prompt");
const inspectResults = request.messages.filter((message) => message.role === "toolResult" && message.toolName === "inspect_studio");
assert.equal(inspectResults.length, 3, "all three inspect_studio results are in the request");
assert.deepEqual(inspectResults.map((message) => message.content[0].text.includes("\"context\"")), [false, false, true], "only the most recent inspect_studio result keeps its context");
assert.deepEqual(JSON.parse(inspectResults[0].content[0].text), { ok: true, scope: "selection", selection: { kind: "character", id: "char-alex" } }, "a stripped result keeps everything but context");
assert.ok(stored.filter((message) => message.role === "toolResult").every((message) => message.content[0].text.includes("\"context\"")), "the stored history is never edited");

const done = turns[2].at(-1);
assert.equal(done.type, "done", "the turn ends with done");
assert.deepEqual(Object.keys(done.usage).sort(), ["cacheRead", "cacheWrite", "input", "output", "requests"]);
assert.ok(Number.isFinite(done.usage.input) && Number.isFinite(done.usage.output), JSON.stringify(done));
assert.equal(done.usage.requests, 2, "the done frame counts this turn's provider requests");

// Anthropic cache breakpoints: fill only a missing mark, never past four.
const bare = { system: [{ type: "text", text: "s" }], tools: [{ name: "a" }, { name: "b" }], messages: [{ role: "user", content: [{ type: "text", text: "u" }] }] };
const marked = withAnthropicCacheBreakpoints(bare, { api: "anthropic-messages" });
assert.deepEqual(marked.system.at(-1).cache_control, { type: "ephemeral" });
assert.deepEqual(marked.tools.at(-1).cache_control, { type: "ephemeral" });
assert.equal(marked.tools[0].cache_control, undefined);
assert.equal(bare.system[0].cache_control, undefined, "the payload pi built is not mutated");
assert.equal(withAnthropicCacheBreakpoints(marked, { api: "anthropic-messages" }), undefined, "an already-marked payload is left alone");
assert.equal(withAnthropicCacheBreakpoints(bare, { compat: { supportsCacheControlOnTools: false } }).tools.at(-1).cache_control, undefined, "tools stay unmarked when compat refuses it");
// pi-ai 1.4 appends a deferred placeholder tool; the API rejects cache_control on it (#905).
const deferred = withAnthropicCacheBreakpoints({ ...bare, tools: [...bare.tools, { name: "__pi_deferred_placeholder__", defer_loading: true }] }, { api: "anthropic-messages" });
assert.deepEqual(deferred.tools.map(tool => tool.cache_control ?? null), [null, { type: "ephemeral" }, null], "the last real tool carries the mark, the deferred placeholder none");
console.log("PASS agent context budget: one live studio context, the motion reference and actions in a stable system prompt, usage on done");
