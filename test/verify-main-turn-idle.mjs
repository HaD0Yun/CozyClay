#!/usr/bin/env node
// #1058: a Studio main turn that never ended kept the panel on "Thinking…" and its input disabled. Against the shipped
// route, runner and tools with a scripted model:
//   1 a model request that never answers ends the turn after the no-progress limit with "the model did not respond",
//     one error and one done frame, and the session takes the next message;
//   2 a tool call that never finishes ends it with that call named;
//   3 a model still streaming (reasoning whose panel frames come further apart than the limit) is not stopped;
//   4 the turn's review names the user's request, so a passed check does not send the model back to an earlier one.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

const sessionDir = mkdtempSync(join(tmpdir(), "cozyclay-main-idle-"));
process.env.COZYCLAY_AGENT_SESSIONS_DIR = sessionDir;
process.env.COZYCLAY_AGENT_REVIEW = "off";
process.on("exit", () => rmSync(sessionDir, { recursive: true, force: true }));
const { createAgentHandler } = await import("../bin/agent/agent-routes.mjs");
const { MAIN_SYSTEM_PROMPT } = await import("../bin/agent/main-prompt.mjs");
const { reviewContent, createTurnReview } = await import("../bin/agent/studio-review.mjs");
const { objectsFixture } = await import("./bus/objects-fixture.mjs");
const { dispatchLiveFrame } = await import("../src/live-control.js");
let passed = 0;
const pass = text => { passed++; console.log(`PASS ${text}`); };
const IDLE_MS = 250;

// The editor answers every command except the ones `hang` names.
const f = objectsFixture(), hang = new Set();
const read = () => f.binding.handlers.read_studio_context({ host: f.host() });
const hub = {
	async command(name, payload) {
		if (hang.has(name)) return new Promise(() => {});
		const response = await dispatchLiveFrame(JSON.stringify({ type: "cmd", id: randomUUID(), name, args: payload }), f.binding.handlers);
		if (!response.ok) throw Object.assign(new Error(response.error), { code: String(response.error).split(":")[0] });
		return response.value;
	},
	workspaceId: () => f.host().workspaceId, resolveWorkspace: () => f.host().workspaceHandle, connected: true, get workspaceHandles() { return [f.host().workspaceHandle]; },
};
// The main agent's model: each test queues its own steps. tokensPerSecond paces the streamed chunks.
const faux = fauxProvider({ provider: "faux", models: [{ id: "scripted", name: "Scripted", reasoning: true, input: ["text", "image"] }], tokensPerSecond: 40 });
const models = createModels(); models.setProvider?.(faux.provider);
const steps = [];
faux.setResponses(Array.from({ length: 20 }, () => (context, options) => {
	assert.equal(getCurrentSystemPrompt(context.messages), MAIN_SYSTEM_PROMPT);
	return (steps.shift() ?? (() => fauxAssistantMessage([fauxText("ok")])))(context, options);
}));
let server;
const handler = createAgentHandler({ auth: { getAccessToken: async () => "token" }, codex: { parseQuotaHeaders: () => ({ primary: {}, credits: {} }) }, models, fauxProvider: faux,
	liveHub: hub, studioRuntime: { readContext: async () => read() }, supervisor: false, studioTasks: () => true, taskLimits: { staggerMs: 0, mainIdleMs: IDLE_MS }, port: () => server.address().port });
server = createServer((req, res) => handler(req, res).catch(error => { if (!res.headersSent) res.writeHead(500); res.end(error.stack); }));
server.listen(0, "127.0.0.1"); await once(server, "listening");
const origin = `http://127.0.0.1:${server.address().port}`, sessionId = randomUUID();
let cookie = "";
const turn = async text => {
	const started = Date.now();
	const response = await fetch(`${origin}/agent/main`, { method: "POST", headers: { "content-type": "application/json", origin, ...(cookie ? { cookie } : {}) },
		body: JSON.stringify({ surface: "studio", sessionId, turnId: randomUUID(), text, context: read(), model: "faux/scripted" }) });
	cookie ||= response.headers.get("set-cookie").split(";")[0];
	const frames = (await response.text()).split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6)));
	return { frames, ms: Date.now() - started, errors: frames.filter(frame => frame.type === "error"), done: frames.filter(frame => frame.type === "done").length };
};
// A request the provider never answers; like a real fetch it ends only when the run is aborted.
const silent = (_context, options) => new Promise(resolve => options?.signal?.addEventListener("abort", () => resolve(fauxAssistantMessage([fauxText("late")])), { once: true }));

// --- 1 a model that never answers ---------------------------------------------------------------------------------
{
	steps.push(silent);
	const stalled = await turn("방금 조명 바꾼 거 되돌려줘.");
	assert.equal(stalled.done, 1, "the turn ends: one done frame");
	assert.deepEqual(stalled.errors.map(e => e.code), ["stalled"], `one error, the reason, not a second "aborted": ${JSON.stringify(stalled.errors)}`);
	assert.match(stalled.errors[0].message, /the model did not respond for 0\.?\d* ?s|the model did not respond for \d+ s/);
	assert.ok(stalled.ms >= IDLE_MS && stalled.ms < IDLE_MS + 3000, `ended after the limit, not before: ${stalled.ms} ms`);
	const next = await turn("캐릭터 뒤에 따뜻한 포인트 라이트 하나 추가해줘.");
	assert.deepEqual([next.errors.length, next.done], [0, 1], `the next message is taken, not answered busy: ${JSON.stringify(next.errors)}`);
	assert.ok(next.frames.some(frame => frame.type === "text.delta"), "and answered");
	pass("1 a model request with no answer ends the main turn after the limit: \"the model did not respond\", one error, and the next message runs");
}

// --- 2 a tool call that never finishes ----------------------------------------------------------------------------
{
	hang.add("inspect_studio");
	steps.push(() => fauxAssistantMessage([fauxToolCall("inspect_studio", { scope: "scene" }, { id: `c-${randomUUID()}` })]));
	const stalled = await turn("what is in the scene?");
	hang.clear();
	assert.equal(stalled.done, 1);
	assert.deepEqual(stalled.errors.map(e => e.code), ["stalled"], JSON.stringify(stalled.errors));
	const started = stalled.frames.find(frame => frame.type === "tool.start");
	assert.match(stalled.errors[0].message, new RegExp(`the ${started.label} call did not finish`), stalled.errors[0].message);
	assert.equal((await turn("hello")).errors.length, 0, "the session takes the next message");
	pass("2 a tool call that never finishes ends the main turn with that call named");
}

// --- 3 a model still streaming is progress ------------------------------------------------------------------------
{
	// ~3 s of reasoning at 40 tokens/s: the panel's thinking frames are batched (turn-frames.mjs FLUSH_MS 400 ms), further
	// apart than the 250 ms limit, but every chunk is an event of the model's stream.
	steps.push(() => fauxAssistantMessage([fauxThinking("weighing the lighting presets one by one. ".repeat(12)), fauxText("되돌렸어요.")]));
	const slow = await turn("slow but alive");
	assert.equal(slow.errors.length, 0, `a streaming model is not stopped: ${JSON.stringify(slow.errors)}`);
	assert.ok(slow.ms > 4 * IDLE_MS, `it streamed longer than the limit: ${slow.ms} ms`);
	assert.ok(slow.frames.some(frame => frame.type === "text.delta"));
	pass("3 a model still streaming is not stopped, even when the panel's frames come further apart than the limit");
}
await handler.close?.(); await new Promise(resolve => server.close(resolve)); f.dispose();

// --- 4 the review names the request --------------------------------------------------------------------------------
{
	const asked = reviewContent({ findings: [], request: "방금 조명 바꾼 거 되돌려줘." })[0].text;
	assert.match(asked, /This turn's request: "방금 조명 바꾼 거 되돌려줘\."/);
	assert.match(asked, /what this request asked, fix it; an earlier request is not this turn's to finish/);
	assert.match(reviewContent({ findings: [] })[0].text, /what was asked, fix it\. If they do/, "no request: the ask reads as before");
	const quietHub = { async command(name) { return name === "inspect_studio" ? { revision: { scene: 3 }, relations: [], characters: [], camera: null } : { dataUrl: "data:image/png;base64,AA" }; } };
	const main = await createTurnReview({ invoke: async () => ({}), hub: quietHub, workspaceHandle: "w" })({ edited: true, ids: [], motionIds: [], stage: true }, "undo the lighting");
	assert.match(main.content[0].text, /This turn's request: "undo the lighting"/, "the main turn's review carries the user's message");
	const task = await createTurnReview({ invoke: async () => ({}), hub: quietHub, workspaceHandle: "w", scope: ["stage"] })({ edited: true, ids: [], motionIds: [], stage: true }, "a long task brief");
	assert.doesNotMatch(task.content[0].text, /This turn's request/, "a task's review keeps its scope, not its brief");
	pass("4 the turn's review names the user's request; a task's review does not");
}
console.log(`${passed} passed`);
process.exit(0);
