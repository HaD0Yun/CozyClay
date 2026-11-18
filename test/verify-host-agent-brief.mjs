#!/usr/bin/env node
// A brief a host app hands the Studio's agent (#1319, src/host-agent-brief.js):
// the request limits, the bridge, and the run through the agent panel's chat
// store. Whatever happens to a brief, the host hears exactly one final report.
import assert from "node:assert/strict";

const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

// The host's side of both bridges, as a preload would expose them.
const reports = [];
let push = null;
let openProject = null;
const agentBrief = { onRequest: (listener) => { push = listener; return () => { push = null; }; }, report: (status) => { reports.push(status); } };
const projectFiles = { pickForOpen: async () => null, pickForSave: async () => null, read: async () => ({ text: "{}" }), write: async () => {}, onOpen: (listener) => { openProject = listener; return () => {}; } };
globalThis.window = { cozyclayHost: { agentBrief, projectFiles } };

const { hostBriefReadiness, parseHostBriefRequest, reportHostBrief, runHostBriefs, subscribeHostBriefs } = await import("../src/host-agent-brief.js");
const { subscribeHostProjectOpen } = await import("../src/host-project-files.js");
const { createAgentChatStore } = await import("../src/workflow/agent-client.js");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(condition, what) {
	for (let tries = 0; tries < 1000; tries += 1) {
		if (condition()) return;
		await sleep(2);
	}
	assert.fail(`timed out waiting for ${what}`);
}
const of = (id) => reports.filter((report) => report.id === id);
const final = async (id) => { await until(() => of(id).some((report) => report.state !== "started"), `the final report of ${id}`); return of(id).at(-1); };
const quiet = async (run) => { const warn = console.warn; console.warn = () => {}; try { return await run(); } finally { console.warn = warn; } };

// The panel as the runner reads it, and a chat store with the same turn state as the real one.
const gone = () => Object.assign(new Error("session not found"), { status: 404 });
const fakePanel = (overrides = {}) => { const panel = { ready: true, project: null, turn: { model: "provider/model", effort: "high" }, opened: 0, chats: 0, loads: [], newChat: () => { panel.chats += 1; }, loadChat: async (sessionId) => { panel.loads.push(sessionId); throw gone(); }, open: () => { panel.opened += 1; }, ...overrides }; return panel; };
const hostFile = (token, save = async () => true) => { const file = { current: token, saves: 0, token: () => file.current, save: () => { file.saves += 1; return save(); } }; return file; };
function fakeStore(items = []) {
	let state = { sessionId: "fake-chat", streaming: false, lastTurn: null, items };
	const listeners = new Set();
	const set = (patch) => { state = { ...state, ...patch }; for (const listener of [...listeners]) listener(state); };
	const store = {
		sends: [], stops: 0, refusal: null, set,
		getState: () => state,
		subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
		send: async (text, options) => {
			store.sends.push({ text, options });
			if (store.refusal) set({ items: [...state.items, { kind: "failure", failure: { message: store.refusal } }] });
			else set({ streaming: true, lastTurn: null, items: [...state.items, { kind: "user", text }] });
		},
		stop: () => { store.stops += 1; set({ streaming: false, lastTurn: { status: "stopped", failure: null } }); },
		end: (status, { reply, failure = null } = {}) => set({ streaming: false, lastTurn: { status, failure }, items: reply ? [...state.items, { kind: "assistant", text: reply }] : state.items }),
	};
	return store;
}
// `waitMs` is short only where a case is about the wait running out.
async function running(options, run) {
	const unsubscribe = runHostBriefs({ preview: () => png, waitMs: 20_000, pollMs: 2, ...options });
	try { await run(); } finally { unsubscribe(); }
}

{
	const brief = { kind: "brief", id: "build-1.a_B", text: "Build the set." };
	assert.deepEqual(parseHostBriefRequest(brief), { request: { ...brief, attachments: [], project: null, save: false, chat: "new" } });
	assert.deepEqual(parseHostBriefRequest({ ...brief, attachments: [{ name: "n".repeat(200), dataUrl: png, width: 4 }, { dataUrl: png.replace("png", "webp") }], project: "t-1", save: true, chat: "continue", later: 1 }).request,
		{ ...brief, attachments: [{ dataUrl: png, name: "n".repeat(120) }, { dataUrl: png.replace("png", "webp") }], project: "t-1", save: true, chat: "continue" }, "unknown fields are left out and a name is cut like the composer's");
	assert.deepEqual(parseHostBriefRequest({ ...brief, attachments: null, project: null, save: null, chat: null }).request, { ...brief, attachments: [], project: null, save: false, chat: "new" });
	assert.equal(parseHostBriefRequest({ ...brief, chat: "new" }).request.chat, "new");
	assert.deepEqual(parseHostBriefRequest({ kind: "stop", id: "build-1.a_B", text: 5 }), { request: { kind: "stop", id: "build-1.a_B" } });
	assert.ok(parseHostBriefRequest({ ...brief, id: "i".repeat(128), text: "t".repeat(16_000), attachments: Array(4).fill({ dataUrl: png.padEnd(6_000_000, "A") }) }).request, "the limits themselves are allowed");
	const refused = [
		{ ...brief, text: "" }, { ...brief, text: "   " }, { ...brief, text: "t".repeat(16_001) }, { ...brief, text: 5 },
		{ ...brief, attachments: [] }, { ...brief, attachments: Array(5).fill({ dataUrl: png }) }, { ...brief, attachments: "x" },
		{ ...brief, attachments: [{ dataUrl: png.replace("png", "svg+xml") }] }, { ...brief, attachments: [{ dataUrl: "https://example.com/a.png" }] },
		{ ...brief, attachments: [{ dataUrl: png.padEnd(6_000_001, "A") }] }, { ...brief, attachments: [{ name: 5, dataUrl: png }] }, { ...brief, attachments: [null] },
		{ ...brief, project: "" }, { ...brief, project: 7 }, { ...brief, save: "yes" },
		{ ...brief, chat: "resume" }, { ...brief, chat: "" }, { ...brief, chat: true },
	];
	for (const value of refused) {
		const answer = parseHostBriefRequest(value);
		assert.equal(answer.request, undefined, JSON.stringify(value).slice(0, 80));
		assert.equal(answer.id, brief.id, "a refused brief with a good id can still be answered");
		assert.ok(answer.message.length > 10);
	}
	for (const value of [null, "brief", [], {}, { ...brief, id: "" }, { ...brief, id: "i".repeat(129) }, { ...brief, id: "a b" }, { ...brief, id: 5 }, { kind: "stop" }, { kind: "pause", id: "p-1" }]) {
		const answer = parseHostBriefRequest(value);
		assert.ok(!answer.request && !answer.id && answer.message, `${JSON.stringify(value)} is dropped: there is no brief to answer`);
	}
	console.log("PASS a request is checked against the contract's limits");
}
{
	assert.equal(hostBriefReadiness({ authState: "loading", modelsState: "loading", model: "" }), null);
	assert.equal(hostBriefReadiness({ authState: "ready", modelsState: "loading", model: "" }), null);
	assert.equal(hostBriefReadiness({ authState: "ready", modelsState: "ready", model: "p/m", restoreReady: false }), null, "a chat still being restored would replace the brief's chat");
	assert.equal(hostBriefReadiness({ authState: "ready", modelsState: "ready", model: "p/m", editorReady: false }), null, "the editor may connect at any moment");
	assert.equal(hostBriefReadiness({ authState: "ready", modelsState: "ready", model: "p/m" }), true);
	for (const state of [{ authState: "signed-out", modelsState: "ready", model: "p/m" }, { authState: "offline", modelsState: "failed", model: "" }, { authState: "ready", modelsState: "failed", model: "" }]) {
		assert.match(hostBriefReadiness({ ...state, editorReady: false }), /No model is connected/);
	}
	console.log("PASS the panel is ready with a model, waits while it loads, and says when no model is connected");
}
await quiet(async () => {
	const seen = [];
	const unsubscribe = subscribeHostBriefs((request) => { seen.push(request); if (request.kind === "stop") throw new Error("a handler that throws"); });
	push({ kind: "brief", id: "bridge-1", text: "Hello" });
	push({ kind: "brief", id: "bridge-2", text: "" });
	push({ kind: "brief", id: "bridge-3", text: "t".repeat(16_001) });
	push({ kind: "stop", id: "bridge-1" });
	push({ kind: "brief", text: "no id" });
	push("garbage");
	assert.deepEqual(seen.map((request) => `${request.kind} ${request.id}`), ["brief bridge-1", "stop bridge-1"]);
	assert.deepEqual(reports.splice(0), ["bridge-2", "bridge-3"].map((id) => ({ id, state: "failed", code: "invalid", message: "The brief text must be 1 to 16000 characters." })),
		"a brief that breaks the limits is answered at once and never reaches the panel: an empty text, and one longer than a turn takes; what cannot be read is dropped");
	reportHostBrief({ id: "bridge-1", state: "stopped" });
	assert.deepEqual(reports.splice(0), [{ id: "bridge-1", state: "stopped" }]);
	unsubscribe();
	assert.equal(push, null);
	// A plain browser: no bridge, or one missing a function, is no bridge.
	for (const cozyclayHost of [undefined, { agentBrief: { onRequest: agentBrief.onRequest } }, { agentBrief: { report: agentBrief.report } }]) {
		globalThis.window = { cozyclayHost };
		const panel = fakePanel();
		assert.equal(typeof runHostBriefs({ store: fakeStore(), panel: () => panel }), "function");
		reportHostBrief({ id: "bridge-1", state: "stopped" });
		assert.equal(push, null, "nothing subscribes");
		assert.equal(reports.length, 0);
	}
	globalThis.window = { cozyclayHost: { agentBrief, projectFiles } };
	console.log("PASS the bridge is used only when the host provides both of its functions");
});

{
	// No brief has run in this page yet, so there is no chat to continue.
	const store = fakeStore([{ kind: "user", text: "the user's own chat" }]);
	const panel = fakePanel();
	await running({ store, panel: () => panel }, async () => {
		push({ kind: "brief", id: "continue-first", text: "Build it.", chat: "continue" });
		await until(() => of("continue-first").length === 1, "started");
		assert.deepEqual([panel.chats, panel.loads.length], [1, 0], "it starts a new chat, as a brief that asked for one does");
		store.end("done");
		assert.equal((await final("continue-first")).state, "done");
	});
	console.log("PASS the first brief of a page runs in a new chat even when it asks to continue one");
}

// --- the run, against the panel's real chat store -----------------------------
function scriptedTransport() {
	const transport = {
		turns: [], stops: [],
		turn: (request, onEvent, signal) => new Promise((resolve, reject) => {
			transport.turns.push({ request, onEvent, finish: () => { onEvent({ type: "done" }); resolve(); } });
			signal.addEventListener("abort", () => reject(new DOMException("The turn was stopped.", "AbortError")), { once: true });
		}),
		stop: async (target) => { transport.stops.push(target); return {}; },
	};
	return transport;
}
const studioStore = (transport, context = { actionIndex: [] }) => createAgentChatStore({ transport, surface: "studio", buildContext: () => context });

{
	const transport = scriptedTransport();
	const store = studioStore(transport);
	const file = hostFile("t-1");
	const panel = fakePanel({ project: file });
	await running({ store, panel: () => panel }, async () => {
		push({ kind: "brief", id: "real-done", text: "Build the storyboard.", attachments: [{ name: "storyboard-1.jpg", dataUrl: png }], project: "t-1", save: true });
		await until(() => of("real-done").length === 1, "started");
		assert.deepEqual(of("real-done"), [{ id: "real-done", state: "started" }]);
		assert.equal(panel.opened, 1, "the panel is opened for the brief");
		assert.equal(panel.chats, 0, "an empty chat is already a new one");
		const { request, onEvent, finish } = transport.turns[0];
		assert.equal(request.text, "Build the storyboard.");
		assert.deepEqual(request.attachments, [{ dataUrl: png, name: "storyboard-1.jpg" }]);
		assert.deepEqual([request.surface, request.model, request.effort, request.attachFrame, request.tasks], ["studio", "provider/model", "high", false, undefined], "one plain turn with the panel's model: its end is the end of the work");
		assert.deepEqual(store.getState().items.map((item) => [item.kind, item.text, item.attachments?.length]), [["user", "Build the storyboard.", 1]], "the brief shows in the chat like a typed message");
		assert.equal(file.saves, 0, "nothing is saved before the turn ends");
		onEvent({ type: "text.delta", text: "Built the set " });
		onEvent({ type: "text.delta", text: "and three views." });
		finish();
		assert.deepEqual(await final("real-done"), { id: "real-done", state: "done", reply: "Built the set and three views.", saved: true, preview: png });
		assert.equal(file.saves, 1);
	});
	console.log("PASS a brief runs as one message with its pictures and ends done, saved, with a preview");
}
{
	const transport = scriptedTransport();
	const store = studioStore(transport);
	const panel = fakePanel();
	await running({ store, panel: () => panel }, async () => {
		push({ kind: "brief", id: "real-failed", text: "Build it." });
		await until(() => transport.turns.length === 1, "the turn");
		transport.turns[0].onEvent({ type: "error", code: "upstream", message: "The model refused the request." });
		transport.turns[0].finish();
		assert.deepEqual(await final("real-failed"), { id: "real-failed", state: "failed", code: "turn", message: "The model refused the request." });

		push({ kind: "brief", id: "real-empty", text: "Build it." });
		await until(() => transport.turns.length === 2, "the second turn");
		assert.equal(panel.chats, 1, "a chat that already holds messages is left for a new one");
		transport.turns[1].finish();
		assert.deepEqual(await final("real-empty"), { id: "real-empty", state: "failed", code: "turn", message: "The turn ended without a response." });

		push({ kind: "brief", id: "real-stopped", text: "Build it.", save: true });
		await until(() => transport.turns.length === 3, "the third turn");
		push({ kind: "stop", id: "some-other-brief" });
		assert.equal(transport.stops.length, 0, "a stop for another id is ignored");
		push({ kind: "stop", id: "real-stopped" });
		assert.deepEqual(await final("real-stopped"), { id: "real-stopped", state: "stopped" });
		assert.equal(transport.stops.length, 1, "the host's stop is the panel's Stop");
		push({ kind: "stop", id: "real-stopped" });
		await sleep(20);
		assert.deepEqual(of("real-stopped").map((report) => report.state), ["started", "stopped"], "the stopped turn settling and a second stop report nothing more");
	});
	const offline = studioStore(scriptedTransport(), null);
	await running({ store: offline, panel: () => panel }, async () => {
		push({ kind: "brief", id: "real-no-editor", text: "Build it." });
		assert.deepEqual(await final("real-no-editor"), { id: "real-no-editor", state: "failed", code: "not-ready", message: "The editor is not ready to describe the scene yet." });
		assert.deepEqual(of("real-no-editor").length, 1, "a message the store refused never started");
	});
	console.log("PASS a failed, an empty, a stopped and a refused turn each end in their own final report");
}
{
	const transport = scriptedTransport();
	const store = studioStore(transport);
	const panel = fakePanel();
	await running({ store, panel: () => panel }, async () => {
		push({ kind: "brief", id: "tool-failed", text: "Build it." });
		await until(() => transport.turns.length === 1, "the turn");
		const { onEvent, finish } = transport.turns[0];
		const call = (callId, ok) => { onEvent({ type: "tool.start", callId, name: "patch_elements", label: "Edit the scene", args: {} }); onEvent({ type: "tool.done", callId, ok, elapsedMs: 4, ...(ok ? { result: {} } : { error: "TARGET_BUSY" }) }); };
		const summary = "Built the set: a counter, two stools and a shutter. Both characters stand behind the counter.";
		onEvent({ type: "text.delta", text: "Building the set first." });
		call("call-1", false);
		call("call-2", true);
		onEvent({ type: "text.delta", text: "Built the set: a counter, two stools and a shutter. " });
		onEvent({ type: "text.delta", text: "Both characters stand behind the counter." });
		call("call-3", true);
		onEvent({ type: "text.delta", text: "Framing repaired." });
		finish();
		const report = await final("tool-failed");
		const { lastTurn, items } = store.getState();
		assert.deepEqual([lastTurn.status, lastTurn.failure], ["done", null], "the store counts a failed call as part of a turn that ran to its end");
		assert.ok(items.some((item) => item.kind === "tool" && item.status === "failed"), "the failed call stays in the chat: it is what gives the panel its error look");
		assert.deepEqual(report, { id: "tool-failed", state: "done", reply: summary, preview: png }, "the reply is the longest text of the turn, not the note that came last");

		// The same failed call followed by the turn's own error is a failed turn.
		push({ kind: "brief", id: "tool-then-error", text: "Build it." });
		await until(() => transport.turns.length === 2, "the second turn");
		transport.turns[1].onEvent({ type: "tool.start", callId: "call-4", name: "patch_elements", label: "Edit the scene", args: {} });
		transport.turns[1].onEvent({ type: "tool.done", callId: "call-4", ok: false, elapsedMs: 4, error: "TARGET_BUSY" });
		transport.turns[1].onEvent({ type: "error", code: "overloaded", message: "The model service is overloaded right now." });
		transport.turns[1].finish();
		assert.deepEqual(await final("tool-then-error"), { id: "tool-then-error", state: "failed", code: "turn", message: "The model service is overloaded right now." });
	});
	const ties = fakeStore();
	await running({ store: ties, panel: () => panel, preview: () => null }, async () => {
		push({ kind: "brief", id: "reply-tie", text: "Build it." });
		await until(() => of("reply-tie").length === 1, "started");
		ties.set({ items: [...ties.getState().items, { kind: "assistant", text: "  First.  " }, { kind: "tool", status: "done" }, { kind: "assistant", text: "Later." }, { kind: "tool", status: "done" }, { kind: "assistant", text: "End." }] });
		ties.end("done");
		assert.deepEqual(await final("reply-tie"), { id: "reply-tie", state: "done", reply: "Later." }, "blocks are measured without the space around them, and of two equally long ones the later is used");
	});
	console.log("PASS a turn that ran to its end with a failed tool call is done, and its reply is its longest text");
}
{
	// A long job handed over as several briefs: the first in a new chat, the others continuing it.
	const transport = scriptedTransport();
	const store = studioStore(transport);
	const file = hostFile("t-1");
	const history = new Map(); // the Studio's kept chats, as its history answers for them
	const panel = fakePanel({ project: file, newChat: () => { panel.chats += 1; store.newSession(); }, loadChat: async (sessionId) => { panel.loads.push(sessionId); if (!history.has(sessionId)) throw gone(); return { sessionId, transcript: history.get(sessionId) }; } });
	const texts = () => store.getState().items.filter((item) => item.kind === "user").map((item) => item.text);
	// Ends the turn the brief started and answers with the chat id it was posted with and the brief's final report.
	const turnOf = async (id, reply) => {
		await until(() => of(id).length === 1, `${id} to start`);
		const turn = transport.turns.at(-1);
		turn.onEvent({ type: "text.delta", text: reply });
		turn.finish();
		return [turn.request.sessionId, await final(id)];
	};
	await running({ store, panel: () => panel }, async () => {
		push({ kind: "brief", id: "sequence-1", text: "Build the set.", project: "t-1", save: true, chat: "new" });
		const [first, report1] = await turnOf("sequence-1", "Built the set.");
		assert.deepEqual(report1, { id: "sequence-1", state: "done", reply: "Built the set.", saved: true, preview: png });
		assert.equal(file.saves, 1);
		push({ kind: "brief", id: "sequence-2", text: "Stage scene 1.", project: "t-1", save: true, chat: "continue" });
		const [second, report2] = await turnOf("sequence-2", "Staged scene 1.");
		assert.equal(second, first, "the next brief is posted with the chat id of the one before");
		assert.deepEqual(texts(), ["Build the set.", "Stage scene 1."], "it is the next message of that chat");
		assert.deepEqual(report2, { id: "sequence-2", state: "done", reply: "Staged scene 1.", saved: true, preview: png }, "the reply is this turn's, not the chat's longest");
		assert.equal(file.saves, 2, "each brief saves after its own turn");
		assert.deepEqual([panel.chats, panel.loads.length], [0, 0], "the panel still shows that chat: nothing is started or opened");

		// The user started a chat of their own meanwhile: the brief's chat is opened again from the history.
		history.set(first, [{ kind: "user", text: "Build the set." }, { kind: "assistant", text: "Built the set." }, { kind: "user", text: "Stage scene 1." }, { kind: "assistant", text: "Staged scene 1." }]);
		store.newSession();
		push({ kind: "brief", id: "sequence-3", text: "Stage scene 2.", chat: "continue" });
		const [third] = await turnOf("sequence-3", "Staged scene 2.");
		assert.equal(third, first);
		assert.deepEqual([panel.loads, panel.chats], [[first], 0]);
		assert.deepEqual(texts(), ["Build the set.", "Stage scene 1.", "Stage scene 2."]);

		// That chat is gone from the history too: the brief runs as a new one, and the next one continues that.
		history.clear();
		store.newSession();
		store.note("A chat of the user's own.");
		push({ kind: "brief", id: "sequence-4", text: "Stage scene 3.", chat: "continue" });
		const [fourth] = await turnOf("sequence-4", "Staged scene 3.");
		assert.ok(fourth !== first && fourth === store.getState().sessionId);
		assert.deepEqual([panel.loads, panel.chats, texts()], [[first, first], 1, ["Stage scene 3."]]);
		push({ kind: "brief", id: "sequence-5", text: "Stage scene 4.", chat: "continue" });
		assert.equal((await turnOf("sequence-5", "Staged scene 4."))[0], fourth);
		push({ kind: "brief", id: "sequence-6", text: "Another job." });
		const [sixth] = await turnOf("sequence-6", "Done.");
		assert.ok(sixth !== fourth, "a brief that does not ask to continue leaves the chat");
		assert.deepEqual([panel.loads.length, panel.chats, texts()], [2, 2, ["Another job."]]);

		// Opening the chat again takes a moment. A stop in that moment ends the brief; an answer that started in it is not replaced.
		let answer = null;
		panel.loadChat = () => new Promise((resolve) => { answer = resolve; });
		store.newSession();
		push({ kind: "brief", id: "reopen-stopped", text: "Stage scene 5.", chat: "continue" });
		await until(() => answer, "the chat being opened");
		push({ kind: "stop", id: "reopen-stopped" });
		answer({ transcript: [{ kind: "user", text: "Another job." }] });
		assert.deepEqual(await final("reopen-stopped"), { id: "reopen-stopped", state: "stopped" });
		store.newSession();
		answer = null;
		push({ kind: "brief", id: "reopen-busy", text: "Stage scene 5.", chat: "continue" });
		await until(() => answer, "the chat being opened");
		void store.send("The user's own message.");
		answer({ transcript: [{ kind: "user", text: "Another job." }] });
		assert.deepEqual(await final("reopen-busy"), { id: "reopen-busy", state: "failed", code: "busy", message: "An answer is already running in the Studio's agent panel." });
		assert.deepEqual(texts(), ["The user's own message."], "the user's chat stays as it is");
		assert.equal(transport.turns.length, 7, "neither brief posted a turn");
		transport.turns.at(-1).finish();
	});
	console.log("PASS a brief continues the chat of the brief before it, opens that chat again when the panel left it, and starts a new one when it is gone");
}

// --- waiting, refusing and finishing, with the store's turn state scripted ----
{
	const store = fakeStore();
	const panel = fakePanel({ ready: null });
	await running({ store, panel: () => panel }, async () => {
		push({ kind: "brief", id: "wait-ready", text: "Build it." });
		push({ kind: "brief", id: "wait-ready", text: "The same id again." });
		push({ kind: "brief", id: "second", text: "Another brief." });
		assert.deepEqual(await final("second"), { id: "second", state: "failed", code: "busy", message: "Another brief is already running in the Studio." });
		await sleep(20);
		assert.equal(store.sends.length, 0, "nothing is sent while the model list is still loading");
		assert.deepEqual(of("wait-ready"), []);
		panel.ready = true;
		await until(() => of("wait-ready").length === 1, "started");
		assert.equal(store.sends.length, 1, "a repeated id is not a second brief");
		store.end("done");
		assert.deepEqual(await final("wait-ready"), { id: "wait-ready", state: "done", preview: png }, "no text and no save asked: neither is reported");
		store.end("failed", { failure: { message: "a later turn" } });
		push({ kind: "stop", id: "wait-ready" });
		await sleep(10);
		assert.equal(of("wait-ready").length, 2, "what the chat does afterwards is not this brief's");
	});
	console.log("PASS a brief waits for the panel, and a second brief meanwhile is refused as busy");
}
{
	const panel = fakePanel({ ready: "No model is connected in the Studio's agent panel." });
	const store = fakeStore();
	await running({ store, panel: () => panel }, async () => {
		push({ kind: "brief", id: "no-model", text: "Build it." });
		assert.deepEqual(await final("no-model"), { id: "no-model", state: "failed", code: "not-ready", message: "No model is connected in the Studio's agent panel." });
		panel.ready = true;
		store.set({ streaming: true });
		push({ kind: "brief", id: "answer-running", text: "Build it." });
		assert.deepEqual(await final("answer-running"), { id: "answer-running", state: "failed", code: "busy", message: "An answer is already running in the Studio's agent panel." });
		store.set({ streaming: false });
		store.refusal = "The editor is not ready to describe the scene yet.";
		push({ kind: "brief", id: "refused", text: "Build it." });
		assert.deepEqual(await final("refused"), { id: "refused", state: "failed", code: "not-ready", message: store.refusal });
		panel.ready = null;
		push({ kind: "brief", id: "stopped-waiting", text: "Build it." });
		push({ kind: "stop", id: "stopped-waiting" });
		assert.deepEqual(await final("stopped-waiting"), { id: "stopped-waiting", state: "stopped" });
		assert.equal(store.sends.length, 1, "only the refused message ever reached the store");
		assert.equal(store.stops, 0);
	});
	await running({ store, panel: () => panel, waitMs: 30 }, async () => {
		push({ kind: "brief", id: "never-ready", text: "Build it." });
		assert.deepEqual(await final("never-ready"), { id: "never-ready", state: "failed", code: "not-ready", message: "The Studio's agent was not ready in time." });
	});
	console.log("PASS no model, a panel that never gets ready, a running answer, a refused message and an early stop are each reported once");
}
{
	// The host asks for a project and sends the brief at once, as it does when the page loads.
	const file = hostFile(null);
	const panel = fakePanel({ project: file });
	const store = fakeStore([{ kind: "user", text: "an earlier chat" }, { kind: "assistant", text: "An earlier answer." }]);
	let opened;
	subscribeHostProjectOpen(() => new Promise((resolve) => { opened = resolve; }));
	await running({ store, panel: () => panel }, async () => {
		push({ kind: "brief", id: "project-opening", text: "Build it.", project: "t-9", save: true });
		await sleep(10);
		openProject({ token: "t-9", name: "Chase.cclayproject" });
		// The handle is in place before the project itself is: the brief still waits.
		file.current = "t-9";
		await sleep(20);
		assert.equal(store.sends.length, 0, "the brief waits while the project it names is still opening");
		opened();
		await until(() => of("project-opening").length === 1, "started");
		assert.equal(panel.chats, 1, "the brief starts a new chat");
		file.current = "t-other";
		store.end("done");
		assert.deepEqual(await final("project-opening"), { id: "project-opening", state: "done", saved: false, preview: png }, "the agent wrote no text of its own, and another project is never saved in the brief's name");
		assert.equal(file.saves, 0);
	});
	await running({ store, panel: () => panel, waitMs: 30 }, async () => {
		push({ kind: "brief", id: "project-other", text: "Build it.", project: "t-9" });
		assert.deepEqual(await final("project-other"), { id: "project-other", state: "failed", code: "project", message: "That project is not the one open in the Studio." });
		assert.equal(store.sends.length, 1);
	});
	console.log("PASS a brief waits for the project it names and fails when another one is open");
}
{
	const store = fakeStore();
	const saves = [async () => true, async () => false, async () => { throw new Error("disk full"); }, () => { throw new Error("not a promise"); }];
	const previews = [() => png, () => `data:image/png;base64,${"A".repeat(1_500_000)}`, () => "not a picture", () => { throw new Error("no stage"); }, async () => null];
	for (const [index, save] of saves.entries()) {
		const file = hostFile("t-1", save);
		const panel = fakePanel({ project: file });
		const id = `save-${index}`;
		await running({ store, panel: () => panel, preview: previews[index] }, async () => {
			push({ kind: "brief", id, text: "Build it.", save: true });
			await until(() => of(id).length === 1, "started");
			store.end("done", { reply: "r".repeat(4100) });
			assert.deepEqual(await final(id), { id, state: "done", reply: "r".repeat(4000), saved: index === 0, ...(index === 0 ? { preview: png } : {}) });
			assert.equal(file.saves, 1, "a host file is saved with or without a project named");
		});
	}
	const panel = fakePanel({ project: null });
	await running({ store, panel: () => panel, preview: previews[4] }, async () => {
		push({ kind: "brief", id: "save-no-file", text: "Build it.", save: true });
		await until(() => of("save-no-file").length === 1, "started");
		store.end("stopped");
		assert.deepEqual(await final("save-no-file"), { id: "save-no-file", state: "stopped" }, "the user's own Stop ends the brief as stopped");
		push({ kind: "brief", id: "save-no-file-2", text: "Build it.", save: true });
		await until(() => of("save-no-file-2").length === 1, "started");
		store.end("done");
		assert.deepEqual(await final("save-no-file-2"), { id: "save-no-file-2", state: "done", saved: false }, "a project that is not a host file is not saved: that would open a dialog");
	});
	console.log("PASS done reports the reply cut to 4000 characters, whether the save happened, and a preview that fits");
}
{
	// The panel may subscribe again while a brief runs (React replays effects in development): the page still knows the brief.
	const store = fakeStore();
	const panel = fakePanel();
	const first = runHostBriefs({ store, panel: () => panel, preview: () => null });
	push({ kind: "brief", id: "resubscribed", text: "Build it." });
	await until(() => of("resubscribed").length === 1, "started");
	first();
	const second = runHostBriefs({ store, panel: () => panel, preview: () => null });
	push({ kind: "brief", id: "resubscribed", text: "Build it." });
	push({ kind: "brief", id: "while-resubscribed", text: "Build it." });
	assert.deepEqual(await final("while-resubscribed"), { id: "while-resubscribed", state: "failed", code: "busy", message: "Another brief is already running in the Studio." });
	push({ kind: "stop", id: "resubscribed" });
	assert.deepEqual(await final("resubscribed"), { id: "resubscribed", state: "stopped" });
	assert.deepEqual([store.sends.length, store.stops], [1, 1]);
	second();
	console.log("PASS a brief outlives the subscription that took it");
}
{
	// Whatever happened above, each brief was answered once.
	await sleep(150);
	const ids = [...new Set(reports.map((report) => report.id))];
	assert.ok(ids.length >= 34, `every brief above reported (${ids.length})`);
	for (const id of ids) {
		const states = of(id).map((report) => report.state);
		assert.equal(states.filter((state) => state !== "started").length, 1, `${id} has exactly one final report: ${states.join(", ")}`);
		assert.ok(states.filter((state) => state === "started").length <= 1 && states.indexOf("started") <= 0, `${id} started at most once, before its final report: ${states.join(", ")}`);
	}
	console.log(`PASS every brief got exactly one final report (${ids.length} briefs)`);
}
