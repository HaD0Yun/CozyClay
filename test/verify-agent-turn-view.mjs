#!/usr/bin/env node
// What the agent panel shows while a turn runs: the sidecar's live frames (bin/agent/turn-frames.mjs: the
// reasoning summary and the tool call being written; script-tool.mjs: a script's nested calls), the chat store
// that folds them into steps, and the step list's data (src/workflow/agent-turn.js): one list per turn with plain
// labels, a one-line result each, the turn's end state, and the activity line's current step.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createReasoningFrames } from "../bin/agent/turn-frames.mjs";
import { createScriptTool } from "../bin/agent/script-tool.mjs";
import { createAgentChatStore, describeActivity, receiptSummary } from "../src/workflow/agent-client.js";
import * as agentTurn from "../src/workflow/agent-turn.js";
const { changedLine, stepLabel, stepResult, stepsHeader, thinkingLine, turnLayout } = agentTurn;

test("reasoning is batched and a tool call names its action and subject only once they are complete", () => {
	let now = 0;
	const frames = [];
	const reasoning = createReasoningFrames(frame => frames.push(frame), () => now);
	reasoning.onMessageEvent({ type: "thinking_delta", delta: "Plan the " });
	assert.equal(frames.length, 0, "a delta inside the batch window waits");
	now = 500;
	reasoning.onMessageEvent({ type: "thinking_delta", delta: "I" });
	assert.equal(frames.length, 0, "a batch too short to say anything waits too");
	reasoning.onMessageEvent({ type: "thinking_delta", delta: " walk three steps." });
	assert.deepEqual(frames, [{ type: "thinking.delta", text: "Plan the I walk three steps." }]);
	const partial = { content: [{ type: "toolCall", name: "run_action", arguments: {} }] };
	reasoning.onMessageEvent({ type: "toolcall_start", contentIndex: 0, partial });
	for (const delta of ['{"action":"motion.com', 'pile","args":{"spec":{"label":"walk 3 st', 'eps, wave","use":[]}}}']) reasoning.onMessageEvent({ type: "toolcall_delta", contentIndex: 0, delta, partial });
	assert.deepEqual(frames.slice(1), [
		{ type: "tool.compose", index: 0, name: "run_action" },
		{ type: "tool.compose", index: 0, name: "run_action", action: "motion.compile" },
		{ type: "tool.compose", index: 0, name: "run_action", action: "motion.compile", subject: "walk 3 steps, wave" },
	], "never half an action id, never a repeat");
	// the next message starts its own call at the same index
	const script = { content: [{ type: "toolCall", name: "script", arguments: {} }] };
	reasoning.onMessageEvent({ type: "toolcall_start", contentIndex: 0, partial: script });
	reasoning.onMessageEvent({ type: "toolcall_delta", contentIndex: 0, delta: '{"code":"// Place three cameras\\nconst a = 1;"}', partial: script });
	assert.deepEqual(frames.at(-1), { type: "tool.compose", index: 0, name: "script", subject: "Place three cameras" });
});

test("a script tells the panel each nested call as it starts and ends", async () => {
	const tools = [{ name: "run_action", description: "x", handler: async args => (args.action === "bad" ? Promise.reject(Object.assign(new Error("no"), { code: "STALE_SCENE" })) : { ok: true, summary: "Compiled 24 frames; QA clean; installed." }) }];
	const frames = [];
	const result = await createScriptTool({ tools }).handler({ code: "await tools.run_action({ action: 'motion.compile' }); try { await tools.run_action({ action: 'bad' }); } catch {} return 1;" }, { toolCallId: "call-1", emit: frame => frames.push(frame) });
	assert.equal(result.ok, true);
	assert.deepEqual(frames.map(frame => [frame.callId, frame.index, frame.action, frame.status, frame.summary ?? null]), [
		["call-1", 1, "motion.compile", "running", null],
		["call-1", 1, "motion.compile", "done", "Compiled 24 frames; QA clean; installed."],
		["call-1", 2, "bad", "running", null],
		["call-1", 2, "bad", "failed", "STALE_SCENE: no"],
	]);
});

const context = { actionIndex: [{ id: "motion.compile", label: "Compile motion" }], entityIndex: [{ id: "char-a", kind: "character", name: "Mina" }], shots: [{ id: "shot-1", name: "Shot 1" }] };

test("the store folds the frames into steps and records how the turn ended", async () => {
	let now = 1000, seen = null;
	const store = createAgentChatStore({ surface: "studio", buildContext: () => context, clock: () => now, transport: { turn: async (_request, on) => {
		on({ type: "thinking.delta", text: "Plan the walk." });
		on({ type: "tool.compose", index: 0, name: "run_action", action: "motion.compile", subject: "walk" });
		seen = describeActivity(store.getState(), { now: now + 4000, toolLabel: call => stepLabel(call) });
		on({ type: "tool.start", callId: "c1", name: "run_action", args: { action: "motion.compile", args: { spec: { label: "walk and wave" } } } });
		on({ type: "tool.done", callId: "c1", ok: true, elapsedMs: 600, result: { ok: true, summary: "Compiled 200 frames; QA 4 issues; not installed." } });
		on({ type: "text.delta", text: "Checking the frame." });
		on({ type: "tool.start", callId: "c2", name: "script", args: { code: "// Place cameras\n" } });
		on({ type: "tool.progress", callId: "c2", index: 3, name: "run_action", action: "motion.compile", status: "running" });
		now = 9000;
		on({ type: "tool.done", callId: "c2", ok: true, elapsedMs: 1800, result: { ok: true, calls: [{ ok: true }, { ok: true }, { ok: false, code: "STALE_SCENE" }] } });
		on({ type: "text.delta", text: "Done: Mina walks." });
		on({ type: "done" });
	} } });
	await store.send("walk and wave");
	assert.deepEqual([seen.text, seen.detail], ["Preparing Compile motion… · 4 s", "walk"], "the call being written is named");
	const items = store.getState().items;
	assert.deepEqual(items.map(item => item.kind), ["user", "thinking", "tool", "assistant", "tool", "assistant", "turn-end"], "the compose step became the call it wrote");
	const [compile, script] = items.filter(item => item.kind === "tool");
	assert.deepEqual([stepLabel(compile), compile.subject, stepResult(compile)], ["Compile motion", "walk and wave", "Compiled 200 frames; QA 4 issues; not installed"]);
	assert.deepEqual([stepLabel(script), script.subject, stepResult(script)], ["Script", "Place cameras", "3 calls · 1 refused: STALE_SCENE"]);
	assert.equal(script.progress.label, "Compile motion", "a nested call is named by the action index");
	const layout = turnLayout(store.getState().items);
	const block = layout.find(entry => entry.type === "steps");
	assert.deepEqual(block.steps.map(step => step.kind), ["thinking", "tool", "narration", "tool"], "text between calls is narration inside the list");
	assert.equal(layout.at(-1).item.text, "Done: Mina walks.", "the reply after the last call stays a card");
	assert.match(stepsHeader(block, 0, ms => `${ms / 1000} s`).text, /^Done · 2 steps · 8 s$/);
});

test("a stopped turn closes the call it was running and says so", async () => {
	let release;
	const store = createAgentChatStore({ surface: "studio", buildContext: () => context, clock: () => 0, transport: {
		turn: (_request, on, signal) => { on({ type: "tool.start", callId: "c1", name: "run_action", args: { action: "motion.compile" } }); return new Promise(resolve => { release = resolve; signal.addEventListener("abort", resolve, { once: true }); }); },
		stop: async () => ({ ok: true }),
	} });
	const sent = store.send("jump");
	store.stop();
	await sent;
	release?.();
	const block = turnLayout(store.getState().items).find(entry => entry.type === "steps");
	assert.equal(block.steps[0].status, "cancelled");
	assert.equal(stepResult(block.steps[0]), "result unknown");
	assert.match(stepsHeader(block, 0, () => "0 s").text, /^Stopped · 1 step/);
	assert.equal(agentTurn.stoppedNote(block), "Stopped by you while a step was running; its result is unknown.");
	assert.match(agentTurn.stoppedNote({ steps: [{ kind: "tool", status: "done", result: { authored: true } }] }), /Cmd\+Z undoes this turn/);
	assert.equal(agentTurn.stoppedNote({ steps: [{ kind: "thinking" }] }), "Stopped by you before anything changed in the scene.");
});

test("the activity line names the phase and what it is about", () => {
	const at = (items, now = 4000) => describeActivity({ items, streaming: true, turnStartedAt: 1000 }, { now, toolLabel: call => stepLabel(call) });
	const prompt = { kind: "user", id: "u", text: "go" };
	assert.equal(at([prompt], 2000).text, "Sending… · 1 s");
	assert.equal(at([prompt]).text, "Waiting for the model… · 3 s", "a request the model has not answered yet is not still sending");
	const thinking = at([prompt, { kind: "thinking", id: "t", text: "**Plan**\n\nFirst the walk, then the wave." }]);
	assert.deepEqual([thinking.text, thinking.detail], ["Thinking… · 3 s", "First the walk, then the wave."]);
	assert.equal(at([prompt, { kind: "assistant", id: "a", text: "Here" }]).text, "Writing the reply… · 3 s");
	const script = at([prompt, { kind: "tool", id: "s", name: "script", status: "running", progress: { index: 2, label: "Compile motion" } }]);
	assert.deepEqual([script.text, script.detail], ["Running Script… · 3 s", "Compile motion (call 2)"]);
});

test("results read as product copy, never ids or JSON", () => {
	assert.equal(stepResult({ kind: "tool", name: "verify_result", status: "done", args: { visual: "contact_sheet" }, result: { checks: { framing: { derivedSize: "wide shot" } }, verification: { status: "verified" }, visualStatus: "attached" } }),
		"wide shot · motion checked · looked at a contact sheet");
	assert.equal(stepResult({ kind: "tool", name: "run_action", status: "failed", error: "INVALID_ARGUMENT: spec.fps must be 24" }), "INVALID_ARGUMENT: spec.fps must be 24");
	assert.equal(stepResult({ kind: "tool", name: "run_action", status: "cancelled", result: { status: "not_applied" } }), "not applied");
	assert.equal(changedLine(["char-a", "shot-1", "camera-key-9", "camera-key-10"], context), "Changed Mina, Shot 1 and 2 more");
	assert.equal(receiptSummary({ status: "applied", affectedIds: ["char-a"] }, context), "Changed Mina");
	const { stepFields } = agentTurn;
	assert.equal(stepFields("script", { code: "for (const s of shots) { await tools.run_action({ action: 'shot.create', args: s }); await tools.frame_shot({}); }\nreturn await tools.verify_result({});" }, new Map([["shot.create", "Add shot"]])).subject,
		"Add shot, Frame the shot, Verify the result", "an untitled script is named by what it calls");
	assert.equal(thinkingLine("**Planning the walk**\n\nThe walk ends at z=0.97, three steps."), "The walk ends at z=0.97, three steps.");
	assert.equal(thinkingLine("The walk ends at z=0.97, three steps.\n\nNow I'm"), "The walk ends at z=0.97, three steps.", "a paragraph that has only begun waits");
});

test("a done turn that changed nothing after a refusal says so in one line", () => {
	const refused = { kind: "tool", status: "failed", error: "TARGET_BUSY: Another edit is still running." };
	const done = { status: "done" };
	const block = (steps, extra = {}) => ({ steps, end: done, live: false, ...extra });
	assert.equal(agentTurn.unchangedNote(block([refused, { kind: "tool", status: "done", result: {} }])), "Nothing in the scene changed: Another edit is still running.");
	assert.equal(agentTurn.unchangedNote(block([{ kind: "tool", status: "done", result: { ok: true, calls: [{ ok: false, code: "SCOPE_DENIED", message: "That shot is locked." }] } }])), "Nothing in the scene changed: That shot is locked.");
	const exportRefused = { kind: "tool", status: "done", result: { ok: false, code: "EXPORT_UNAVAILABLE", message: "There is nothing to record yet: add a shot (shot.create), camera keys or a motion take first." } };
	assert.equal(agentTurn.unchangedNote(block([exportRefused])), "Nothing in the scene changed: There is nothing to record yet: add a shot, camera keys or a motion take first.", "no command id reaches the author");
	assert.equal(agentTurn.unchangedNote(block([{ kind: "tool", status: "failed", error: "TARGET_BUSY: Wait for it (camera.addKey, motion.fill) to finish (v1.2)." }])), "Nothing in the scene changed: Wait for it to finish (v1.2).", "only parenthesized command ids go, not other parentheses");
	assert.equal(agentTurn.unchangedNote(block([refused, { kind: "tool", status: "done", result: { authored: true } }])), "", "the turn did change the scene");
	assert.equal(agentTurn.unchangedNote(block([refused], { receipted: true })), "", "a receipt is a change");
	assert.equal(agentTurn.unchangedNote(block([{ kind: "tool", status: "failed", error: "ABORTED: Stopped." }])), "", "a stop is no refusal");
	assert.equal(agentTurn.unchangedNote(block([{ kind: "tool", status: "done", result: {} }])), "", "no refusal, nothing to say");
	assert.equal(agentTurn.unchangedNote(block([refused], { end: { status: "failed" } })), "", "a failed turn has its own card");
	assert.equal(agentTurn.unchangedNote(block([refused], { live: true })), "");
	const items = [{ kind: "user", id: "u", text: "move" }, { ...refused, id: "t" }, { kind: "receipt", id: "r" }, { kind: "turn-end", id: "e", status: "done" }];
	assert.equal(turnLayout(items).find(entry => entry.type === "steps").receipted, true);
});
