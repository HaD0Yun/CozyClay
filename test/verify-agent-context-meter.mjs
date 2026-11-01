#!/usr/bin/env node
// The agent panel's context readout: the formatter (src/workflow/agent-context-meter.js: k/M rounding, a missing window,
// the bold flag past 80%), the runner's `context` frame (bin/agent/agent-runner.mjs: the LATEST request's prompt against
// the model's catalog window, not the turn's sum) and the panel store that keeps the latest one (agent-client.js).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createModels } from "@earendil-works/pi-ai";
import { fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

const sessionDir = mkdtempSync(join(tmpdir(), "cozyclay-agent-context-meter-"));
process.env.COZYCLAY_AGENT_SESSIONS_DIR = sessionDir;
process.on("exit", () => rmSync(sessionDir, { recursive: true, force: true }));

const { compactTokens, contextMeter } = await import("../src/workflow/agent-context-meter.js");
const { createAgentRunner } = await import("../bin/agent/agent-runner.mjs");
const { createAgentChatStore } = await import("../src/workflow/agent-client.js");

test("token counts round to the panel's compact form", () => {
	assert.equal(compactTokens(0), "0");
	assert.equal(compactTokens(512), "512");
	assert.equal(compactTokens(999), "999");
	assert.equal(compactTokens(1000), "1.0k");
	assert.equal(compactTokens(9_600), "9.6k");
	assert.equal(compactTokens(9_949), "9.9k");
	assert.equal(compactTokens(9_950), "10k", "no 10.0k");
	assert.equal(compactTokens(95_900), "96k");
	assert.equal(compactTokens(128_000), "128k");
	assert.equal(compactTokens(999_499), "999k");
	assert.equal(compactTokens(999_500), "1.0M", "no 1000k");
	assert.equal(compactTokens(1_000_000), "1.0M");
	assert.equal(compactTokens(1_048_576), "1.0M");
	assert.equal(compactTokens(2_350_000), "2.4M");
});

test("the readout names tokens, window and percent; a missing window shows tokens only", () => {
	assert.deepEqual(contextMeter({ tokens: 95_900, window: 1_000_000 }), { used: "96k", window: "1.0M", percent: 10, hot: false, text: "CTX 96k / 1.0M (10%)" });
	assert.deepEqual(contextMeter({ tokens: 95_900, window: null }), { used: "96k", window: null, percent: null, hot: false, text: "CTX 96k" });
	assert.equal(contextMeter({ tokens: 95_900 }).text, "CTX 96k");
	assert.equal(contextMeter({ tokens: 95_900, window: 0 }).text, "CTX 96k");
	assert.equal(contextMeter(null), null, "no request yet: nothing");
	assert.equal(contextMeter({ tokens: 0, window: 200_000 }), null, "a failed attempt reports no prompt");
});

test("the percentage is bold only past 80% of the window", () => {
	assert.equal(contextMeter({ tokens: 160_000, window: 200_000 }).hot, false, "exactly 80% is not past it");
	const hot = contextMeter({ tokens: 160_001, window: 200_000 });
	assert.equal(hot.hot, true);
	assert.equal(hot.text, "CTX 160k / 200k (80%)");
	assert.equal(contextMeter({ tokens: 190_000, window: 200_000 }).hot, true);
});

async function runTurn(contextWindow) {
	const models = createModels();
	const faux = fauxProvider({ provider: "faux", models: [{ id: "scripted", name: "Scripted", input: ["text"], contextWindow }] });
	models.setProvider(faux.provider);
	faux.setResponses([fauxAssistantMessage([fauxToolCall("noop", {})], { stopReason: "toolUse" }), fauxAssistantMessage([fauxText("done")])]);
	const noop = { name: "noop", parameters: { type: "object", properties: {}, additionalProperties: false }, handler: async () => ({ ok: true }) };
	const runner = createAgentRunner({ models, tools: [noop] });
	const session = await runner.openSession(`context-meter-${contextWindow}`, { surface: "studio" });
	const frames = [];
	for await (const frame of session.start({ text: "hi", model: "faux/scripted", surface: "studio", contextText: "" })) frames.push(frame);
	await runner.close();
	return frames;
}

test("the runner sends one context frame per request: that request's prompt against the catalog window", async () => {
	const frames = await runTurn(200_000);
	const context = frames.filter((frame) => frame.type === "context");
	assert.equal(context.length, 2, JSON.stringify(frames.map((frame) => frame.type)));
	assert.ok(context.every((frame) => frame.window === 200_000 && frame.tokens > 0), JSON.stringify(context));
	const done = frames.find((frame) => frame.type === "done");
	const sum = done.usage.input + done.usage.cacheRead + done.usage.cacheWrite;
	assert.equal(context[0].tokens + context[1].tokens, sum, "each frame is one request, together the turn");
	assert.ok(context[1].tokens < sum, "the latest frame is the latest request, not the turn's sum");
	assert.ok(frames.indexOf(context[1]) < frames.indexOf(done), "the readout is current before the turn ends");
});

test("a model without a catalog window sends tokens and a null window", async () => {
	const context = (await runTurn(0)).filter((frame) => frame.type === "context");
	assert.ok(context.length > 0 && context.every((frame) => frame.window === null && frame.tokens > 0), JSON.stringify(context));
});

test("the panel store keeps the latest context frame and a new conversation clears it", async () => {
	const transport = {
		turn: async (_request, onEvent) => {
			onEvent({ type: "context", tokens: 40_000, window: 1_000_000 });
			onEvent({ type: "context", tokens: 95_900, window: 1_000_000 });
			onEvent({ type: "done", usage: { input: 135_900, output: 10, cacheRead: 0, cacheWrite: 0, requests: 2 } });
		},
	};
	const store = createAgentChatStore({ transport, surface: "workflow" });
	await store.send("hi");
	assert.deepEqual(store.getState().context, { tokens: 95_900, window: 1_000_000 });
	assert.equal(contextMeter(store.getState().context).text, "CTX 96k / 1.0M (10%)");
	store.clearContext();
	assert.equal(store.getState().context, null);
});
