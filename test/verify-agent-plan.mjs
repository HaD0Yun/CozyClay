#!/usr/bin/env node
// The Studio agent's step checklist: the side-effect-free plan tool (bin/agent/plan-tool.mjs) and its refusals, the
// plan.update frames it sends (directly and from inside a script, where it is quiet), a whole Studio turn through the
// route with the plan persisted in the session history, and the panel's side (src/workflow/agent-plan.js): one card under
// the prompt, auto-advance, the plan call never a step, and the end-of-turn and restored fallbacks that never claim
// more than happened.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { withTurnControls } from "./fixtures/turn-controls.mjs";

const sessionDir = mkdtempSync(join(tmpdir(), "cozyclay-agent-plan-"));
process.env.COZYCLAY_AGENT_SESSIONS_DIR = sessionDir;
process.on("exit", () => rmSync(sessionDir, { recursive: true, force: true }));

const { createPlanTool } = await import("../bin/agent/plan-tool.mjs");
const { createScriptTool } = await import("../bin/agent/script-tool.mjs");
const { toAgentTools } = await import("../bin/agent/pi-tools.mjs");
const { createAgentHandler } = await import("../bin/agent/agent-routes.mjs");
const { createSessionStore, transcriptFromHistory } = await import("../bin/agent/session-store.mjs");
const { STUDIO_TOOL_FAMILIES } = await import("../src/studio-agent-protocol.js");
const { createAgentChatStore } = await import("../src/workflow/agent-client.js");
const { turnLayout } = await import("../src/workflow/agent-turn.js");
const { restoredPlans, settledPlan } = await import("../src/workflow/agent-plan.js");
const { createFakeModel } = await import("./fixtures/fake-model.mjs");

const statuses = steps => steps.map(step => step.status).join(" ");
const planned = () => { const frames = []; return { frames, plan: createPlanTool({ emit: frame => frames.push(frame) }) }; };
const STEPS = ["수레 몸체", "진열 소품", "자전거", "풀밭", "조명·카메라"];

test("plan sets a list, checks steps off and moves the active step on by itself", async () => {
	const { frames, plan } = planned();
	assert.deepEqual(await plan.handler({ steps: STEPS }), { ok: true, plan: STEPS.map((text, i) => ({ text, status: i ? "pending" : "active" })) }, "a new plan starts at step 0");
	assert.equal(statuses((await plan.handler({ done: 0 })).plan), "done active pending pending pending", "done without active: the next step is under way");
	assert.equal(statuses((await plan.handler({ done: [1, 2] })).plan), "done done done active pending", "several at once: after the last one done");
	assert.equal(statuses((await plan.handler({ active: 1 })).plan), "done active done pending pending", "an explicit active step takes over; the other goes back to pending");
	assert.equal(statuses((await plan.handler({ done: 1, active: 4 })).plan), "done done done pending active");
	assert.equal(statuses((await plan.handler({ done: 0 })).plan), "done done done pending active", "an active step left as it is keeps the turn where it is");
	assert.equal(statuses((await plan.handler({ done: 4 })).plan), "done done done active done", "after the last step, the first one still pending");
	assert.equal(statuses((await plan.handler({ done: 3, add: ["렌더 확인"] })).plan), "done done done done done active", "add appends, and the added step is next");
	assert.equal(frames.length, 7, "every change is one frame; the call that changed nothing sent none");
	assert.ok(frames.every(frame => frame.type === "plan.update" && Array.isArray(frame.steps)), "a frame carries the whole list");
	assert.deepEqual(frames.at(-1).steps.at(-1), { text: "렌더 확인", status: "active" });
	await plan.handler({ done: 3 });
	assert.equal(frames.length, 7, "a call that changes nothing sends nothing");
	assert.deepEqual((await plan.handler({ steps: ["Set", "Props", "Light"] })).plan.map(step => step.text), ["Set", "Props", "Light"], "steps again replaces the list");
	assert.equal(statuses(frames.at(-1).steps), "active pending pending");
	assert.equal(statuses((await plan.handler({ steps: [" A  b ", "C"], done: 0, active: 1 })).plan), "done active", "a new list can arrive with its progress");
	assert.equal(frames.at(-1).steps[0].text, "A b", "labels are one trimmed line");
});

test("plan refuses junk with a message that says what to send instead, and changes nothing", async () => {
	const { frames, plan } = planned();
	const refuses = async (args, pattern) => {
		await assert.rejects(plan.handler(args), error => error.code === "INVALID_ARGUMENT" && pattern.test(error.message), JSON.stringify(args));
	};
	await refuses({ done: 0 }, /no plan yet: set one with \{ steps/);
	await refuses({}, /needs steps \(2-8 short labels\)/);
	await refuses("steps", /takes an object/);
	await refuses({ steps: ["one"] }, /steps has 1 item; a plan has 2-8 steps \(skip plan for a small request\)/);
	await refuses({ steps: Array.from({ length: 9 }, (_, i) => `step ${i}`) }, /9 steps; a plan has at most 8: merge some/);
	await refuses({ steps: ["ok", "x".repeat(61)] }, /steps\[1\] is 61 characters; keep each step under 60/);
	await refuses({ steps: ["ok", "  "] }, /steps\[1\] is empty/);
	await refuses({ steps: "a, b" }, /steps must be an array of short strings/);
	await refuses({ steps: ["a", "b"], note: "x" }, /unknown field "note"; allowed: steps, done, active, add/);
	assert.equal(frames.length, 0, "no refusal reached the panel");
	await plan.handler({ steps: ["a", "b", "c"] });
	await refuses({ done: 3 }, /done is 3; the plan has 3 steps, so a step index is 0-2/);
	await refuses({ done: [0, -1] }, /done\[1\] is -1/);
	await refuses({ active: 1.5 }, /active is 1\.5/);
	await refuses({ done: 1, active: 1 }, /Step 1 cannot be both done and active/);
	await refuses({ add: Array.from({ length: 6 }, (_, i) => `more ${i}`) }, /9 steps; a plan has at most 8/);
	assert.equal(frames.length, 1, "only the valid plan was sent");
	assert.equal(statuses(frames[0].steps), "active pending pending", "refusals left the plan as it was");
});

test("the model-facing tool carries its usage rule and a schema that takes an index or a list", async () => {
	const { plan } = planned();
	assert.ok(plan.description.includes("For any request with 3 or more visible stages (building a set or several props, a multi-shot sequence), call plan first with short steps, in the same message as your first real call; then mark each step done right after its tool call — inside your script when you use one."));
	const [tool] = toAgentTools([plan]);
	assert.equal(tool.name, "plan");
	assert.equal(tool.label, "Plan");
	for (const args of [{ steps: ["a", "b", "c"] }, { done: 1 }, { done: [0, 1], active: 2 }, { add: ["d"] }]) assert.equal((await tool.execute("call", args)).details.ok, true, JSON.stringify(args));
	await assert.rejects(tool.execute("call", { done: "1" }), /Invalid arguments for plan/);
	assert.throws(() => tool.prepareArguments({ steps: ["a", "b"], extra: 1 }), /unknown field "extra"; allowed: steps, done, active, add/);
});

test("inside a script, tools.plan is quiet: frames for the panel, no progress or calls line, never a failed script", async () => {
	const { frames, plan } = planned();
	const scene = { name: "inspect_studio", description: "Read the scene.", handler: async () => ({ ok: true, summary: "Read 3 objects" }) };
	const script = plan.track(createScriptTool({ tools: [scene, plan.nested] }));
	assert.match(script.description, /tools\.plan/, "the script lists tools.plan beside the Studio tools");
	const code = `
		await tools.plan({ steps: ["Body", "Props", "Light"] });
		await tools.inspect_studio({ scope: "scene" });
		await tools.plan({ done: 0 });
		const refused = await tools.plan({ done: 9 });
		await tools.inspect_studio({ scope: "scene" });
		await tools.plan({ done: 1 });
		return refused;
	`;
	const result = await script.handler({ code }, { toolCallId: "script-1", emit: frame => frames.push(frame) });
	assert.equal(result.ok, true, JSON.stringify(result));
	assert.deepEqual(result.value, { ok: false, code: "INVALID_ARGUMENT", message: "done is 9; the plan has 3 steps, so a step index is 0-2." }, "the script got the refusal as a value");
	assert.deepEqual(result.calls.map(call => call.name), ["inspect_studio", "inspect_studio"], "plan calls are not script calls");
	assert.deepEqual(frames.map(frame => frame.type === "plan.update" ? `plan ${statuses(frame.steps)}` : `${frame.name} ${frame.index} ${frame.status}`), [
		"plan active pending pending",
		"inspect_studio 1 running", "inspect_studio 1 done",
		"plan done active pending",
		"inspect_studio 2 running", "inspect_studio 2 done",
		"plan done done active",
	], "the panel hears each step as the script reaches it, between its real calls");
	assert.equal(statuses(result.plan), "done done active", "the script's result carries the plan it changed (the persisted history keeps it)");
	assert.deepEqual(result.planRefused, ["done is 9; the plan has 3 steps, so a step index is 0-2."], "and tells the model what was refused");
	const untouched = await plan.track(createScriptTool({ tools: [scene] })).handler({ code: "return 1;" }, {});
	assert.equal("plan" in untouched || "planRefused" in untouched, false, "a script that leaves the plan alone answers as before");
});

// --- one whole Studio turn through the route: the plan frames reach the browser, and the history keeps the plan ---
const identity = { workspaceId: "tab-plan", documentEpoch: "doc-plan", sceneId: "scene-plan", sceneEpoch: "scene-open-plan" };
const context = () => ({
	schema: "studio-context-v1",
	host: { surface: "studio", workspaceHandle: "handle-plan", ...identity },
	revision: { scene: 7, physics: 1, view: 1 },
	units: { distance: "m", angle: "deg", up: "+Y", yawZero: "+Z", yawPositiveToward: "+X", pivot: "base", fps: 24, rangeEnd: "exclusive" },
	scene: { name: "Yatai", aspect: "16:9", floorY: 0, frameCount: 144, objectCount: 0, characterCount: 0 },
	selection: null, activeCharacterId: null,
	view: { mode: "scene", frame: 0, playing: false, lookThrough: false, grid: false, autoColor: false }, shot: null, camera: null,
	entities: [], entityPage: { returned: 0, total: 0, truncated: false, nextCursor: null },
	shots: [], shotsTruncated: false, assets: [], recentReceipts: [], jobs: [],
	capabilities: { profile: "studio-slice-1", tools: [...STUDIO_TOOL_FAMILIES], rigReady: true, cameraReady: false, bridgeReady: false },
});
const commands = [];
const liveHub = withTurnControls({ command: async (name) => {
	commands.push(name);
	if (name === "inspect_studio") return { context: { revision: { scene: 7 } } };
	throw new Error(`unexpected hub command ${name}`);
} });

async function readSse(response) {
	const text = await response.text();
	return text.split("\n\n").map(block => /^data: (.+)$/m.exec(block)?.[1]).filter(Boolean).map(line => JSON.parse(line));
}

test("a Studio turn sends plan.update frames and keeps the plan in its history", async () => {
	const fake = createFakeModel();
	fake.script([
		[{ type: "toolCall", id: "plan-1", name: "plan", arguments: { steps: ["수레 몸체", "진열 소품", "조명"] } },
			{ type: "toolCall", id: "script-1", name: "script", arguments: { code: "// Build the cart\nawait tools.inspect_studio({ scope: \"scene\" });\nawait tools.plan({ done: 0 });\nawait tools.inspect_studio({ scope: \"scene\" });\nawait tools.plan({ done: 1 });\nreturn 1;" } }],
		"포장마차를 만들었습니다.",
	]);
	let server;
	const handler = createAgentHandler({ auth: { getAccessToken: async () => "token" }, codex: { parseQuotaHeaders: () => ({ primary: {}, credits: {} }) }, models: fake.models, fauxProvider: fake.fauxProvider, liveHub, studioRuntime: { readContext: async () => context() }, port: () => server.address().port });
	server = createServer((req, res) => handler(req, res).catch(error => { if (!res.headersSent) { res.writeHead(500); res.end(error.stack); } else if (!res.writableEnded) res.end(); }));
	server.listen(0, "127.0.0.1"); await once(server, "listening");
	const origin = `http://127.0.0.1:${server.address().port}`;
	const sessionId = crypto.randomUUID();
	try {
		const response = await fetch(`${origin}/agent/turn`, { method: "POST", signal: AbortSignal.timeout(30000), headers: { origin, "content-type": "application/json" },
			body: JSON.stringify({ surface: "studio", sessionId, turnId: crypto.randomUUID(), text: "이 사진처럼 포장마차 만들어줘", context: context() }) });
		assert.equal(response.status, 200);
		const events = await readSse(response);
		assert.deepEqual(events.filter(event => event.type === "plan.update").map(event => statuses(event.steps)), ["active pending pending", "done active pending", "done done active"]);
		assert.deepEqual(events.filter(event => event.type === "tool.start").map(event => [event.name, event.label]), [["plan", "Plan"], ["script", "Run a script"]]);
		assert.deepEqual(events.filter(event => event.type === "tool.progress").map(event => event.name), ["inspect_studio", "inspect_studio", "inspect_studio", "inspect_studio"], "no progress frame for the quiet plan calls");
		const [planDone, scriptDone] = events.filter(event => event.type === "tool.done");
		assert.equal(planDone.ok, true);
		assert.deepEqual(scriptDone.result.calls.map(call => call.name), ["inspect_studio", "inspect_studio"]);
		assert.equal(statuses(scriptDone.result.plan), "done done active");
		assert.deepEqual(commands.filter(name => name !== "inspect_studio"), [], "the plan never reached the editor");
		assert.equal(events.at(-1).type, "done");
		// What a reload restores: the sidecar's transcript, then the panel's own restore.
		const transcript = transcriptFromHistory(createSessionStore(sessionDir).read(sessionId).history);
		assert.deepEqual(transcript.filter(item => item.kind === "plan").map(item => statuses(item.steps)), ["active pending pending", "done done active"], "each result that changed the plan keeps its list");
		const store = createAgentChatStore({ surface: "studio", transport: { turn: async () => {} } });
		const restored = store.restore(transcript, sessionId);
		assert.deepEqual(restored.map(item => item.kind), ["user", "plan", "tool", "assistant"], "one card under the prompt; the plan call is no step");
		assert.deepEqual(restored[1].steps.map(step => [step.text, step.status]), [["수레 몸체", "done"], ["진열 소품", "done"], ["조명", "done"]], "the turn ended on its reply, so the step under way counts as done");
		assert.equal(restored[1].outcome, "done");
	} finally {
		await handler.close(); await new Promise(resolve => server.close(resolve));
	}
});

// --- the panel's store ---
const plan = (...list) => ({ type: "plan.update", steps: list.map(([text, status]) => ({ text, status })) });
const runTurn = async frames => {
	const store = createAgentChatStore({ surface: "studio", buildContext: () => ({ actionIndex: [] }), clock: () => 0, transport: { turn: async (_request, on) => { for (const frame of frames) on(frame); } } });
	await store.send("build the yatai");
	return store.getState().items;
};

test("the store keeps one plan card under the prompt, replaced whole, and never makes the plan call a step", async () => {
	const items = await runTurn([
		{ type: "text.delta", text: "Building it in four parts." },
		{ type: "tool.compose", index: 0, name: "plan" },
		{ type: "tool.compose", index: 1, name: "script", subject: "Cart body" },
		{ type: "tool.start", callId: "p1", name: "plan", args: { steps: ["Body", "Props"] } },
		{ type: "tool.done", callId: "p1", ok: true, elapsedMs: 1, result: { ok: true } },
		plan(["Body", "active"], ["Props", "pending"]),
		{ type: "tool.start", callId: "s1", name: "script", args: { code: "// Cart body\n" } },
		plan(["Body", "done"], ["Props", "active"]),
		plan(["Body", "done"], ["Props", "done"], ["Light", "active"]),
		{ type: "tool.done", callId: "s1", ok: true, elapsedMs: 900, result: { ok: true, calls: [] } },
		{ type: "text.delta", text: "Done." },
		{ type: "done" },
	]);
	assert.deepEqual(items.map(item => item.kind), ["user", "plan", "assistant", "tool", "assistant", "turn-end"]);
	assert.deepEqual(items.filter(item => item.kind === "tool").map(item => item.name), ["script"], "no plan step, no stray compose step");
	assert.deepEqual(items[1].steps.map(step => [step.text, step.status]), [["Body", "done"], ["Props", "done"], ["Light", "done"]], "a successful turn's step under way ends done");
	assert.equal(items[1].outcome, "done");
	assert.deepEqual(turnLayout(items).map(entry => entry.type === "item" ? entry.item.kind : "steps"), ["user", "plan", "assistant", "steps", "assistant"], "the card sits at the top of its turn");
	const junk = await runTurn([{ type: "plan.update", steps: [{ text: "", status: "done" }] }, { type: "plan.update", steps: "x" }, { type: "text.delta", text: "ok" }, { type: "done" }]);
	assert.ok(!junk.some(item => item.kind === "plan"), "a malformed frame makes no card");
	const none = await runTurn([{ type: "tool.start", callId: "a", name: "inspect_studio", args: {} }, { type: "tool.done", callId: "a", ok: true, elapsedMs: 3, result: {} }, { type: "text.delta", text: "ok" }, { type: "done" }]);
	assert.ok(!none.some(item => item.kind === "plan"), "no plan call, no card");
});

test("a failed or stopped turn leaves its step under way unfinished, never done", async () => {
	const failed = await runTurn([plan(["Body", "done"], ["Props", "active"], ["Light", "pending"]), { type: "error", code: "upstream", message: "The model went away." }, { type: "done" }]);
	const card = failed.find(item => item.kind === "plan");
	assert.equal(card.outcome, "failed");
	assert.equal(statuses(card.steps), "done unfinished pending");
	assert.equal(statuses(settledPlan({ steps: card.steps.map((step, i) => ({ ...step, status: i === 1 ? "active" : step.status })) }, "stopped").steps), "done unfinished pending");
	let release;
	const store = createAgentChatStore({ surface: "studio", buildContext: () => ({ actionIndex: [] }), clock: () => 0, transport: {
		turn: (_request, on, signal) => { on(plan(["Body", "active"], ["Props", "pending"])); return new Promise(resolve => { release = resolve; signal.addEventListener("abort", resolve, { once: true }); }); },
		stop: async () => ({ ok: true }),
	} });
	const sent = store.send("build");
	assert.equal(store.getState().items.find(item => item.kind === "plan").outcome, undefined, "a running turn's card is live");
	store.stop();
	await sent;
	release?.();
	const stopped = store.getState().items.find(item => item.kind === "plan");
	assert.deepEqual([stopped.outcome, statuses(stopped.steps)], ["stopped", "unfinished pending"]);
});

test("a restored transcript keeps each turn's last plan under its prompt, settled by how the turn ended", () => {
	const steps = (...list) => list.map(([text, status]) => ({ text, status }));
	const restored = restoredPlans([
		{ kind: "user", id: "u1", text: "first" },
		{ kind: "tool", id: "t1", name: "plan" },
		{ kind: "plan", id: "p1", steps: steps(["A", "active"], ["B", "pending"]) },
		{ kind: "tool", id: "t2", name: "script" },
		{ kind: "plan", id: "p2", steps: steps(["A", "done"], ["B", "active"]) },
		{ kind: "assistant", id: "a1", text: "done" },
		{ kind: "user", id: "u2", text: "second" },
		{ kind: "plan", id: "p3", steps: steps(["C", "done"], ["D", "active"]) },
		{ kind: "tool", id: "t3", name: "script" },
		{ kind: "failure", id: "f1", failure: {} },
		{ kind: "user", id: "u3", text: "third (the panel reloaded while it ran)" },
		{ kind: "plan", id: "p4", steps: steps(["E", "active"], ["F", "pending"]) },
		{ kind: "tool", id: "t4", name: "script" },
		{ kind: "user", id: "u4", text: "fourth, no plan" },
		{ kind: "assistant", id: "a4", text: "ok" },
	]);
	assert.deepEqual(restored.map(item => item.id), ["u1", "p2", "t2", "a1", "u2", "p3", "t3", "f1", "u3", "p4", "t4", "u4", "a4"]);
	const cards = restored.filter(item => item.kind === "plan");
	assert.deepEqual(cards.map(card => [card.outcome, statuses(card.steps)]), [["done", "done done"], ["failed", "done unfinished"], ["stopped", "unfinished pending"]]);
});
