#!/usr/bin/env node
// The v4 turn dispatch (bin/agent/v4/dispatch.mjs): the v4 key goes to the Claude Code turn, the v4pi key to the pi
// turn, every other key back to the route. When a conversation moves between the Studio engine and v4 on the pi loop,
// the other engine's pi runner is closed and dropped. The last part runs the real pi runner over one stored history:
// each engine's turn reaches the model with its own system prompt and with the earlier turns.
import { createAgentRunner } from "../../bin/agent/agent-runner.mjs";
import { runV4Turn } from "../../bin/agent/v4/dispatch.mjs";
import { V4_MODEL_KEY, V4_PI_MODEL_KEY } from "../../bin/agent/v4/models.mjs";
import { createFakeModel } from "../fixtures/fake-model.mjs";

let failures = 0;
function expect(name, condition, detail = "") {
	console.log(`${condition ? "PASS" : "FAIL"} ${name}${condition ? "" : ` — ${detail}`}`);
	if (!condition) failures += 1;
}
const show = value => JSON.stringify(value)?.slice(0, 300);

// ---- a. routing and the runner hand-over, with fake turns ----
function setup({ model, session = {}, withRunner = false }) {
	const closed = [], made = [], calls = [];
	const studioRunners = new Map();
	const old = { close: async () => { closed.push("old"); } };
	if (withRunner) studioRunners.set("s1", old);
	const turns = { sdk: async args => { calls.push(["sdk", args]); return true; }, pi: async args => { calls.push(["pi", args]); return true; } };
	const makeRunner = async () => { const runner = { made: made.length }; made.push(runner); return runner; };
	const run = () => runV4Turn({ value: { model, sessionId: "s1" }, session, studioRunners, makeRunner, turns, send: "SEND" });
	return { run, session, studioRunners, old, closed, made, calls };
}

const a1 = setup({ model: "cliproxy/claude-opus-5-5" });
expect("another model, new session: the route runs it", await a1.run() === false && a1.calls.length === 0 && a1.session.piEngine === "studio", show(a1.session));

const a2 = setup({ model: "cliproxy/claude-opus-5-5", session: { modelSession: "studio-session" }, withRunner: true });
expect("another model on its own pi session: runner and session kept", await a2.run() === false && a2.closed.length === 0 && a2.studioRunners.get("s1") === a2.old && a2.session.modelSession === "studio-session", show({ closed: a2.closed, session: a2.session }));

const a3 = setup({ model: "cliproxy/claude-opus-5-5", session: { modelSession: "v4pi-session", piEngine: "v4pi" }, withRunner: true });
const a3Result = await a3.run();
expect("another model after v4pi: the v4pi runner is closed and dropped", a3Result === false && a3.closed.length === 1 && !a3.studioRunners.has("s1") && a3.session.modelSession === null && a3.session.piEngine === "studio", show({ closed: a3.closed, session: a3.session }));

const a4 = setup({ model: V4_PI_MODEL_KEY, session: { modelSession: "studio-session" }, withRunner: true });
const a4Result = await a4.run();
const [a4Kind, a4Args] = a4.calls[0] ?? [];
expect("v4pi after the Studio engine: the Studio runner is closed and dropped, the pi turn runs", a4Result === true && a4Kind === "pi" && a4.closed.length === 1 && a4.session.modelSession === null && a4.session.piEngine === "v4pi", show({ kind: a4Kind, closed: a4.closed, session: a4.session }));
expect("the pi turn gets the turn's arguments", a4Args?.value?.sessionId === "s1" && a4Args?.session === a4.session && a4Args?.send === "SEND" && typeof a4Args?.runnerFor === "function", show(Object.keys(a4Args ?? {})));
const first = await a4Args.runnerFor("s1"), second = await a4Args.runnerFor("s1");
expect("runnerFor makes one runner and keeps it in the route's map", a4.made.length === 1 && first === second && a4.studioRunners.get("s1") === first, show({ made: a4.made.length }));

const a5 = setup({ model: V4_PI_MODEL_KEY, session: { modelSession: "v4pi-session", piEngine: "v4pi" }, withRunner: true });
await a5.run();
expect("v4pi on its own pi session: runner and session kept", a5.closed.length === 0 && a5.session.modelSession === "v4pi-session" && await a5.calls[0][1].runnerFor("s1") === a5.old && a5.made.length === 0, show({ closed: a5.closed, made: a5.made.length }));

const a6 = setup({ model: V4_MODEL_KEY, session: { modelSession: "studio-session" }, withRunner: true });
const a6Result = await a6.run();
expect("v4 on Claude Code: the Claude Code turn runs and the pi runner is left alone", a6Result === true && a6.calls[0]?.[0] === "sdk" && a6.calls[0][1].send === "SEND" && a6.closed.length === 0 && a6.session.modelSession === "studio-session" && a6.session.piEngine === undefined, show({ calls: a6.calls.map(call => call[0]), session: a6.session }));

// ---- b. the real pi runner: Studio turn, v4pi turn, Studio turn over one stored history ----
const fake = createFakeModel();
const stored = [];
const sessionStore = { read: () => (stored.length ? { history: stored.slice() } : null), append: async (_id, messages) => { stored.push(...messages); } };
const makeRunner = async () => createAgentRunner({ models: fake.models, fauxProvider: fake.fauxProvider, sessionStore });
const studioRunners = new Map(), session = {};
const texts = message => (Array.isArray(message.content) ? message.content : [{ type: "text", text: String(message.content ?? "") }]).filter(part => part.type === "text").map(part => part.text);
const systemOf = call => texts(call.messages.find(message => message.role === "system") ?? {}).join("");
const sent = call => call.messages.filter(message => message.role !== "system").flatMap(texts).join("\n");
const errors = [];
async function start(runner, input) {
	session.modelSession ??= await runner.openSession("c1", { surface: "studio" });
	for await (const frame of session.modelSession.start({ surface: "studio", model: "faux/scripted", tools: [], ...input })) if (frame.type === "error") errors.push(frame);
}
// What the route does after the dispatch answers false: its own runner for the session, then the turn.
async function studioTurn(text) {
	const handled = await runV4Turn({ value: { model: "faux/scripted", sessionId: "c1" }, session, studioRunners, makeRunner });
	let runner = studioRunners.get("c1");
	if (!runner) { runner = await makeRunner(); studioRunners.set("c1", runner); }
	await start(runner, { systemPrompt: "STUDIO RULES", text });
	return handled;
}
// The pi turn's use of the runner (pi-turn.mjs): runnerFor, the session's pi session, the v4 prompt, a plain view.
const pi = async ({ value, runnerFor }) => { await start(await runnerFor(value.sessionId), { systemPrompt: "V4 RULES", contextView: "plain", text: value.text }); return true; };

fake.script([[{ type: "text", text: "studio-done-1" }]]);
const handled1 = await studioTurn("turn one");
fake.script([[{ type: "text", text: "v4-done-2" }]]);
const handled2 = await runV4Turn({ value: { model: V4_PI_MODEL_KEY, sessionId: "c1", text: "turn two" }, session, studioRunners, makeRunner, turns: { pi } });
fake.script([[{ type: "text", text: "studio-done-3" }]]);
const handled3 = await studioTurn("turn three");
for (const runner of studioRunners.values()) await runner.close();

expect("real runner: three turns, three model requests, no error frame", fake.calls.length === 3 && errors.length === 0 && handled1 === false && handled2 === true && handled3 === false, show({ calls: fake.calls.length, errors }));
expect("turn 1 (Studio engine) runs under the Studio prompt", systemOf(fake.calls[0]) === "STUDIO RULES", systemOf(fake.calls[0]));
expect("turn 2 (v4pi) runs under the v4 prompt", systemOf(fake.calls[1]) === "V4 RULES", systemOf(fake.calls[1]));
expect("turn 2 still carries turn 1", sent(fake.calls[1]).includes("turn one") && sent(fake.calls[1]).includes("studio-done-1") && sent(fake.calls[1]).includes("turn two"), sent(fake.calls[1]).slice(0, 300));
expect("turn 3 (Studio engine again) runs under the Studio prompt", systemOf(fake.calls[2]) === "STUDIO RULES", systemOf(fake.calls[2]));
expect("turn 3 still carries turns 1 and 2", ["turn one", "studio-done-1", "turn two", "v4-done-2", "turn three"].every(text => sent(fake.calls[2]).includes(text)), sent(fake.calls[2]).slice(0, 400));
expect("the stored history has every turn once", stored.filter(message => message.role === "user").length === 3 && stored.filter(message => message.role === "assistant").length === 3, show(stored.map(message => message.role)));

if (failures) { console.log(`${failures} failure(s)`); process.exit(1); }
console.log("all passed");
process.exit(0);
