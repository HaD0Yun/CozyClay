// A message the user sends to a running turn (bin/agent/steer-inbox.mjs on the pi runner, bin/agent/agent-runner.mjs):
// it enters the model's context between steps, after the step's tool result and before the next model call, and the
// turn's stream says so (steer.received with the caller's id) before that call's output; a message the turn never read
// (Stop) is reported steer.dropped and never reaches a later turn; a turn that already ended takes nothing.
// Also the inbox on a bare pi Agent, the way the lowvis motion writer (src/lowvis/pi/harness.mjs) uses it.
import { Agent } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { createAgentRunner } from "../bin/agent/agent-runner.mjs";
import { createSteerInbox } from "../bin/agent/steer-inbox.mjs";
import { createFakeModel } from "./fixtures/fake-model.mjs";

let failures = 0;
const expect = (name, condition, detail = "") => {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
};
const deferred = () => { let resolve; const promise = new Promise((res) => { resolve = res; }); return { promise, resolve }; };
const textOf = (message) => JSON.stringify(message?.content ?? "");

// --- the pi runner: received at the next step, before the next call's output -------------------------------------------
{
	const gate = deferred(), started = deferred();
	const fake = createFakeModel();
	fake.script([{ type: "toolCall", id: "c1", name: "work", arguments: {} }, "I read your note."]);
	const tools = [{ name: "work", parameters: { type: "object", properties: {}, additionalProperties: false }, handler: async () => { started.resolve(); await gate.promise; return { ok: true }; } }];
	const runner = createAgentRunner({ models: fake.models, fauxProvider: fake.fauxProvider, tools });
	const session = await runner.openSession("inbox-received", { surface: "workflow" });
	const frames = [];
	const run = (async () => { for await (const frame of session.start({ text: "do the work", model: "faux/scripted" })) frames.push(frame); })();
	await started.promise;
	const taken = await session.steer("make it blue", [], "row-7");
	gate.resolve();
	await run;
	expect("a running turn takes the message", taken === true);
	expect("exactly two model calls: the steer rides the step boundary, it starts no turn", fake.calls.length === 2, String(fake.calls.length));
	const messages = fake.calls[1]?.messages ?? [];
	const toolAt = messages.findIndex((message) => message.role === "toolResult"), steerAt = messages.findIndex((message) => message.role === "user" && textOf(message).includes("make it blue"));
	expect("the next model call reads it as a user message, as typed, after the tool result", toolAt !== -1 && steerAt > toolAt && steerAt === messages.length - 1, `tool ${toolAt} steer ${steerAt} of ${messages.length}`);
	expect("the first model call did not have it", !JSON.stringify(fake.calls[0]?.messages ?? []).includes("make it blue"));
	const receivedAt = frames.findIndex((frame) => frame.type === "steer.received"), replyAt = frames.findIndex((frame) => frame.type === "text.delta" && frame.text.includes("note"));
	expect("the stream says steer.received with the caller's id, before the answer to it", receivedAt !== -1 && frames[receivedAt].id === "row-7" && replyAt > receivedAt, JSON.stringify(frames.map((frame) => frame.type)));
	expect("no steer.dropped", !frames.some((frame) => frame.type === "steer.dropped"));
	expect("a turn that ended takes nothing", await session.steer("too late", [], "row-8") === false);
	await runner.close();
}

// --- Stop while the model writes: the unread message is dropped and never reaches the next turn -----------------------
// (Stopped during a tool instead, the loop still files the tool's result and reads the queue before it ends: such a
// message is in the conversation, reported received, and the next turn's model reads it.)
{
	const started = deferred(), gate = deferred(), calls = [];
	const fake = createFakeModel();
	fake.fauxProvider.setResponses([
		async (context) => { calls.push(context); started.resolve(); await gate.promise; return fauxAssistantMessage([fauxText("unused")]); },
		async (context) => { calls.push(context); return fauxAssistantMessage([fauxText("second turn answer")]); },
	]);
	const controller = new AbortController();
	const runner = createAgentRunner({ models: fake.models, fauxProvider: fake.fauxProvider, tools: [] });
	const session = await runner.openSession("inbox-dropped", { surface: "workflow" });
	const frames = [];
	const run = (async () => { for await (const frame of session.start({ text: "long work", model: "faux/scripted", signal: controller.signal })) frames.push(frame); })();
	await started.promise;
	await session.steer("never read", [], "row-9");
	controller.abort();
	gate.resolve();
	await run;
	const droppedAt = frames.findIndex((frame) => frame.type === "steer.dropped"), doneAt = frames.findIndex((frame) => frame.type === "done");
	expect("a stopped turn reports the unread message dropped, with its id, before done", droppedAt !== -1 && frames[droppedAt].id === "row-9" && doneAt > droppedAt, JSON.stringify(frames.map((frame) => frame.type)));
	expect("and never received", !frames.some((frame) => frame.type === "steer.received"));
	const second = [];
	for await (const frame of session.start({ text: "next request", model: "faux/scripted" })) second.push(frame);
	const last = calls.at(-1)?.messages ?? [];
	expect("the next turn's model call does not carry the dropped message", !JSON.stringify(last).includes("never read") && JSON.stringify(last).includes("next request"), JSON.stringify(last.map((message) => message.role)));
	await runner.close();
}

// --- the inbox on a bare pi Agent (the motion writer's loop): held until the Agent exists ------------------------------
{
	const fake = createFakeModel();
	fake.script([{ type: "toolCall", id: "m1", name: "motion", arguments: {} }, { type: "toolCall", id: "m2", name: "motion", arguments: {} }, "report"]);
	const model = fake.models.getModels?.()?.[0] ?? fake.fauxProvider.getModel?.();
	const received = [], dropped = [];
	const inbox = createSteerInbox({ received: (id) => received.push(id), dropped: (id) => dropped.push(id) });
	expect("a message sent before the run's Agent exists is taken", inbox.steer("before the first call", [], "early") === true);
	let calls = 0;
	const agent = new Agent({
		initialState: { systemPrompt: "test", model, thinkingLevel: "off", tools: [{ name: "motion", label: "motion", description: "compile", parameters: { type: "object", properties: {} }, execute: async () => { calls += 1; if (calls === 1) inbox.steer("between the calls", [{ type: "image", data: "AA==", mimeType: "image/png" }], "mid"); return { content: [{ type: "text", text: `compiled ${calls}` }], details: {} }; } }] },
		streamFn: (m, context, options) => fake.models.streamSimple(m, context, options),
		toolExecution: "sequential",
	});
	inbox.attach(agent);
	await agent.prompt("the request");
	inbox.close();
	const firstCall = fake.calls[0]?.messages ?? [], secondCall = fake.calls[1]?.messages ?? [];
	expect("held message: in the first model call, right after the request", textOf(firstCall.at(-1)).includes("before the first call") && textOf(firstCall.at(-2)).includes("the request"), JSON.stringify(firstCall.map(textOf)));
	expect("a message sent during a step: in the next call, after that step's result, with its picture", textOf(secondCall.at(-1)).includes("between the calls") && textOf(secondCall.at(-1)).includes("image/png") && secondCall.at(-2)?.role === "toolResult", JSON.stringify(secondCall.map((message) => message.role)));
	expect("both reported received, in order; none dropped", received.join() === "early,mid" && dropped.length === 0, `${received} / ${dropped}`);
	expect("a closed inbox takes nothing", inbox.steer("after the end", [], "late") === false);
}

if (failures) { console.error(`${failures} FAILURES`); process.exit(1); }
console.log("all steer inbox checks PASS");
