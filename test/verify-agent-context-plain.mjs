#!/usr/bin/env node
// Two opt-in hooks of the agent runner: input.contextView "plain" sends a Studio turn's transcript to the model as it was
// appended (no context diet, no budget), and a ready pi AgentTool in input.tools runs as the same object. Checked here:
// a two-turn plain session keeps the first context whole, adds no marker, stand-in or reply reminder, sends the caller's
// system prompt exactly and runs the ready tool; a control session without the flag still gets the diet.
import assert from "node:assert/strict";
import { Type } from "@earendil-works/pi-ai";
import { createAgentRunner } from "../bin/agent/agent-runner.mjs";
import { toAgentTools } from "../bin/agent/pi-tools.mjs";
import { createFakeModel } from "./fixtures/fake-model.mjs";

let failures = 0;
const check = (name, fn) => { try { fn(); console.log(`PASS ${name}`); } catch (error) { failures += 1; console.log(`FAIL ${name} — ${error.message}`); } };
const texts = message => (Array.isArray(message.content) ? message.content : [{ type: "text", text: String(message.content ?? "") }]).filter(part => part.type === "text").map(part => part.text);
const ready = { name: "ready", label: "ready", description: "d", parameters: Type.Object({ x: Type.Number() }, { additionalProperties: false }),
	execute: async (_id, params) => ({ content: [{ type: "text", text: `ok ${params.x}` }], details: { ok: true } }) };
const tools = [ready];

// Two Studio turns through the real runner; each turn's script is installed just before it starts.
async function twoTurns(sessionId, extra) {
	const fake = createFakeModel();
	const stored = [];
	const runner = createAgentRunner({ models: fake.models, fauxProvider: fake.fauxProvider, sessionStore: { read: () => null, append: async (_id, messages) => { stored.push(...messages); } } });
	const session = await runner.openSession(sessionId, { surface: "studio" });
	const base = { surface: "studio", model: "faux/scripted", systemPrompt: "V4 RULES", tools, ...extra };
	const frames = [[], []];
	fake.script([[{ type: "toolCall", id: "r1", name: "ready", arguments: { x: 1 } }], [{ type: "text", text: "done-1" }]]);
	for await (const frame of session.start({ ...base, text: "turn one", studioContextText: "<studio-context>\nBRIEF-1\n</studio-context>" })) frames[0].push(frame);
	fake.script([[{ type: "text", text: "done-2" }]]);
	for await (const frame of session.start({ ...base, text: "turn two", studioContextText: "<studio-context>\nSTATE-2\n</studio-context>" })) frames[1].push(frame);
	await runner.close();
	return { fake, frames, stored };
}

const plain = await twoTurns("plain", { contextView: "plain" });
const last = plain.fake.calls.at(-1);
check("plain: both turns end with done after three model requests", () => {
	assert.equal(plain.frames[0].at(-1)?.type, "done", JSON.stringify(plain.frames[0].filter(f => f.type === "error")));
	assert.equal(plain.frames[1].at(-1)?.type, "done");
	assert.equal(plain.fake.calls.length, 3);
});
check("plain: the last request's first user message still carries BRIEF-1 verbatim", () => {
	const first = last.messages.find(m => m.role === "user");
	assert.ok(texts(first).some(text => text.includes("<studio-context>\nBRIEF-1\n</studio-context>")), JSON.stringify(first).slice(0, 300));
});
check("plain: no superseded marker, no left-out stand-in, no reply-language reminder", () => {
	const all = last.messages.flatMap(texts);
	assert.ok(all.every(text => !text.includes("<studio-context superseded/>")), "superseded marker found");
	assert.ok(all.every(text => !text.includes("left out of this request")), "left-out stand-in found");
	const userTexts = last.messages.filter(m => m.role === "user").flatMap(texts);
	assert.ok(userTexts.every(text => !text.startsWith("[Reply in")), "reply reminder found");
});
// The fixture records pi's provider context, where the system prompt is the leading system message.
check("plain: the provider received the caller's system prompt exactly", () => {
	const system = last.messages.filter(m => m.role === "system");
	assert.equal(system.length, 1);
	assert.equal(last.messages[0], system[0]);
	assert.equal(texts(system[0]).join(""), "V4 RULES");
});
check("plain: turn 1 ran the ready tool (tool.start ready, tool.done ok)", () => {
	const start = plain.frames[0].find(f => f.type === "tool.start");
	assert.equal(start?.name, "ready");
	const done = plain.frames[0].find(f => f.type === "tool.done" && f.callId === start.callId);
	assert.equal(done?.ok, true, JSON.stringify(done));
	const result = last.messages.find(m => m.role === "toolResult" && m.toolName === "ready");
	assert.deepEqual(texts(result), ["ok 1"]);
});
check("toAgentTools returns a ready AgentTool as the same object; a catalogue entry is still wrapped", () => {
	assert.equal(toAgentTools([ready])[0], ready);
	const handler = { name: "h", parameters: { type: "object", properties: {}, additionalProperties: false }, handler: async () => ({ ok: true }) };
	const [wrapped] = toAgentTools([handler]);
	assert.notEqual(wrapped, handler);
	assert.equal(typeof wrapped.execute, "function");
	assert.equal(typeof wrapped.prepareArguments, "function");
});

// Control: the same two turns without the flag take the default diet.
const diet = await twoTurns("diet", {});
check("control: without contextView the first context is superseded and BRIEF-1 is gone", () => {
	assert.equal(diet.frames[1].at(-1)?.type, "done");
	const first = diet.fake.calls.at(-1).messages.find(m => m.role === "user");
	assert.ok(texts(first).some(text => text.startsWith("<studio-context superseded/>")), JSON.stringify(first).slice(0, 300));
	assert.ok(texts(first).every(text => !text.includes("BRIEF-1")), "BRIEF-1 still sent");
	assert.ok(diet.fake.calls.at(-1).messages.flatMap(texts).some(text => text.includes("STATE-2")), "the latest context stays");
});
check("control: the stored transcript keeps BRIEF-1 whole", () => {
	assert.ok(diet.stored.some(m => m.role === "user" && JSON.stringify(m).includes("BRIEF-1")));
});

if (failures) { console.error(`${failures} context plain check(s) failed`); process.exit(1); }
console.log("agent context plain: all checks passed");
