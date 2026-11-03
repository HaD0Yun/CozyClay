#!/usr/bin/env node
// The panel side of what a real battery found (parallel Studio tasks): a reload mid-turn reattaches to the turn the
// sidecar still runs (the message and its progress come back, the next message waits instead of failing busy), the
// board is not polled before its main session exists, an incomplete task needs a look, and the Inspector shows no
// "Character 1" when the cast is empty.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createAgentChatStore, createHttpTransport } from "../src/workflow/agent-client.js";
import { TASK_STATUS_COPY, boardGroups, followsBoard, reduceBoard, emptyBoard, retriesBoard } from "../src/workflow/task-board.js";
import { characterRowExists } from "../src/hierarchy-model.js";

const ids = () => { let n = 0; return () => `id-${++n}`; };
const sse = events => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });

test("resume: the reloaded panel shows the running turn's message once, follows it to its end, and a send then is not refused", async () => {
	let finish;
	const attached = [], sent = [];
	const transport = {
		attach: (turnId, onEvent) => { attached.push(turnId); onEvent({ type: "text.delta", text: "Dispatching", eventSeq: 1 }); return new Promise(resolve => { finish = () => { onEvent({ type: "text.delta", text: " the task.", eventSeq: 2 }); onEvent({ type: "done", eventSeq: 3 }); resolve(); }; }); },
		turn: async (request, onEvent) => { sent.push(request.text); onEvent({ type: "text.delta", text: "ok" }); onEvent({ type: "done" }); },
	};
	const store = createAgentChatStore({ transport, surface: "studio", newId: ids(), buildContext: () => ({ host: {}, actionIndex: [] }) });
	// What the sidecar had persisted mid-turn: the message itself, which the replay brings back with its steps.
	store.restore([{ kind: "user", text: "earlier" }, { kind: "assistant", text: "earlier reply" }, { kind: "user", text: "add a character" }], "s-1");
	const resumed = store.resume({ turnId: "turn-1", text: "add a character" });
	assert.equal(store.getState().streaming, true, "the turn reads as running again");
	assert.deepEqual(attached, ["turn-1"]);
	assert.deepEqual(store.getState().items.filter(item => item.kind === "user").map(item => item.text), ["earlier", "add a character"], "the message is back, once");
	await store.send("another one");
	assert.deepEqual(sent, [], "while it runs, a new message does not start a second turn (the server would answer busy)");
	finish(); await resumed;
	const state = store.getState();
	assert.equal(state.streaming, false); assert.equal(state.lastTurn.status, "done");
	assert.ok(state.items.some(item => item.kind === "assistant" && item.text === "Dispatching the task."), "its reply streamed in");
	await store.send("another one");
	assert.deepEqual(sent, ["another one"], "after it ends the next message goes out");
});

test("resume does nothing outside the Studio, without a turn id, or while a turn runs", async () => {
	let calls = 0;
	const transport = { attach: async () => { calls++; } };
	await createAgentChatStore({ transport, surface: "workflow", newId: ids() }).resume({ turnId: "t" });
	await createAgentChatStore({ transport, surface: "studio", newId: ids() }).resume({});
	assert.equal(calls, 0);
});

test("attach reads the turn's events from the first, and resumes a dropped stream from the last one seen", async () => {
	const urls = [];
	const responses = [sse([{ type: "text.delta", text: "a", eventSeq: 1 }, { type: "text.delta", text: "b", eventSeq: 2 }]), sse([{ type: "text.delta", text: "b", eventSeq: 2 }, { type: "done", eventSeq: 3 }])];
	const transport = createHttpTransport({ fetchImpl: async url => { urls.push(String(url)); return responses.shift(); }, surface: "studio" });
	const seen = [];
	await transport.attach("turn-9", event => seen.push(event.eventSeq));
	assert.deepEqual(seen, [1, 2, 3], "no event twice");
	assert.match(urls[0], /\/agent\/turn\/turn-9\/events\?after=0$/); assert.match(urls[1], /after=2$/);
	await assert.rejects(createHttpTransport({ fetchImpl: async () => new Response("", { status: 403 }), surface: "studio" }).attach("x", () => {}), error => error.status === 403);
});

test("the board is followed only once its main session exists, and a missing board is not polled", () => {
	assert.equal(followsBoard({ sessionId: "s" }), false, "a fresh session asks nothing (it answered 403/404 every 2 s)");
	assert.equal(followsBoard({ sessionId: "s", live: true }), true, "a main turn runs");
	assert.equal(followsBoard({ sessionId: "s", pulse: 1 }), true, "a turn ended");
	assert.equal(followsBoard({ sessionId: "s", restored: true }), true, "the sidecar said it has one");
	assert.equal(followsBoard({ sessionId: "", live: true }), false);
	assert.equal(retriesBoard({ status: 403 }, false), false); assert.equal(retriesBoard({ status: 404 }, false), false);
	assert.equal(retriesBoard({ status: 403 }, true), true, "while its first turn is on the way, it is tried again");
	assert.equal(retriesBoard(new TypeError("dropped"), false), true, "a dropped stream is followed again");
});

test("an incomplete task needs a look and says why", () => {
	const board = reduceBoard(emptyBoard(), { type: "task.incomplete", taskId: "a", title: "pull up", status: "incomplete", reason: "criteria unmet: hands off the bar" });
	assert.deepEqual(boardGroups(board).failed.map(task => task.taskId), ["a"]);
	assert.match(TASK_STATUS_COPY.incomplete, /criteria unmet/i);
});

test("a character row names a character only when the cast has it (no phantom Character 1)", () => {
	assert.equal(characterRowExists("characterA", []), false, "the default selection with an empty cast");
	assert.equal(characterRowExists("characterA.rig.head", []), false);
	assert.equal(characterRowExists("characterB", [{ id: "a" }]), false);
	assert.equal(characterRowExists("characterA", [{ id: "a" }]), true);
	assert.equal(characterRowExists("character:b", [{ id: "a" }, { id: "b" }]), true);
	assert.equal(characterRowExists("character:z", [{ id: "a" }]), false);
	assert.equal(characterRowExists("character:b.rig", [{ id: "b" }]), true);
});
