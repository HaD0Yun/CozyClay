#!/usr/bin/env node
// The edit on the user's last message in the Studio's Agent box (bin/agent/session-rewind.mjs): POST
// /agent/sessions/<id>/rewind { turnId } stops that turn if it runs, takes it out of the conversation (the session
// file, so the model's next context and the panel's restored transcript), and the next turn's message says it replaces
// the removed one and what became of the scene. Driven through the real routes, pi runner and session store; only the
// model is scripted. A check ({ check: true }) answers without touching anything; a task-mode turn is refused and not
// stopped; the panel's side (src/workflow/agent-edit.js) runs over the real chat store and queue with a scripted transport.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentHandler } from "../bin/agent/agent-routes.mjs";
import { createSessionStore, transcriptFromHistory } from "../bin/agent/session-store.mjs";
import { editNote, markTurn, rewindTurn, sceneEpoch, withLastTurnId } from "../bin/agent/session-rewind.mjs";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { createFakeModel } from "./fixtures/fake-model.mjs";
import { createAgentChatStore } from "../src/workflow/agent-client.js";
import { createMessageQueue } from "../src/workflow/agent-queue.js";
import { checkEdit, editableMessageId, resendEdited, steeredAfter } from "../src/workflow/agent-edit.js";
import { withTurnControls } from "./fixtures/turn-controls.mjs";
import { envelopeFixture, contextFixture } from "./verify-studio-agent-protocol.mjs";

let failures = 0;
const check = async (name, fn) => { try { await fn(); console.log(`PASS ${name}`); } catch (error) { failures += 1; console.log(`FAIL ${name} — ${error.message}`); } };
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const texts = (message) => (Array.isArray(message?.content) ? message.content : [{ type: "text", text: String(message?.content ?? "") }]).filter((part) => part?.type === "text").map((part) => part.text);
const userWords = (messages) => messages.filter((message) => message.role === "user").map((message) => texts(message).at(-1));

async function readEvents(response, onEvent) {
	const reader = response.body.getReader(), decoder = new TextDecoder(), events = [];
	let buffer = "";
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		for (let index; (index = buffer.indexOf("\n\n")) !== -1;) {
			const match = /^data: (.+)$/m.exec(buffer.slice(0, index));
			buffer = buffer.slice(index + 2);
			if (!match) continue;
			const event = JSON.parse(match[1]);
			events.push(event);
			await onEvent?.(event);
		}
	}
	return events;
}

// --- through the routes: send, a stalled second turn, edit it while it runs, resend --------------------------------
{
	const dir = mkdtempSync(join(tmpdir(), "cozyclay-edit-message-"));
	const store = createSessionStore(dir);
	const slow = deferred();
	const fake = createFakeModel();
	fake.script([
		["reply one"],
		[{ type: "toolCall", id: "typo-call", name: "inspect_studio", arguments: { scope: "scene" } }], // stopped in the tool: no further call
		["reply to the corrected one"],
		["reply four"],
	]);
	const hub = withTurnControls({ command: async (name) => { if (name === "inspect_studio") { await slow.promise; return { context: { revision: { scene: 41 } } }; } return {}; } });
	let server;
	const handler = createAgentHandler({ auth: { getAccessToken: async () => "token" }, port: () => server.address().port, codex: { parseQuotaHeaders: () => ({ primary: {}, credits: {} }) }, models: fake.models, fauxProvider: fake.fauxProvider, liveHub: hub, studioRuntime: { readContext: async () => contextFixture() }, sessionStore: store, supervisor: false });
	server = createServer((req, res) => handler(req, res).catch((error) => { console.error(error.stack); if (!res.headersSent) res.writeHead(500); res.end(); }));
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const origin = `http://127.0.0.1:${server.address().port}`;
	const base = envelopeFixture(), sessionId = base.sessionId;
	const turnIds = ["00000000-0000-4000-8000-0000000000a1", "00000000-0000-4000-8000-0000000000a2", "00000000-0000-4000-8000-0000000000a3", "00000000-0000-4000-8000-0000000000a4"];
	const turn = (turnId, text, cookie) => fetch(`${origin}/agent/turn`, { method: "POST", headers: { "content-type": "application/json", origin, ...(cookie ? { cookie } : {}) }, body: JSON.stringify({ ...base, turnId, text }) });
	const rewind = (turnId, cookie) => fetch(`${origin}/agent/sessions/${sessionId}/rewind`, { method: "POST", headers: { "content-type": "application/json", origin, ...(cookie ? { cookie } : {}) }, body: JSON.stringify({ turnId }) });
	const fileLines = () => readFileSync(join(dir, `${sessionId}.jsonl`), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));

	const first = await turn(turnIds[0], "first message");
	const cookie = first.headers.get("set-cookie")?.split(";")[0];
	await readEvents(first);
	let anonymous = null, edited = null, editedBody = null, asked = null, askedFile = null;
	const beforeSecond = readFileSync(join(dir, `${sessionId}.jsonl`), "utf8");
	const second = await turn(turnIds[1], "a message with a typo", cookie);
	const secondEvents = await readEvents(second, async (event) => {
		if (event.type !== "tool.start" || edited) return;
		anonymous = await rewind(turnIds[1]);
		// the panel's question before it opens the edit or stops a turn: answered, and nothing is touched
		const before = readFileSync(join(dir, `${sessionId}.jsonl`), "utf8");
		asked = await fetch(`${origin}/agent/sessions/${sessionId}/rewind`, { method: "POST", headers: { "content-type": "application/json", origin, cookie }, body: JSON.stringify({ turnId: turnIds[1], check: true }) });
		const live = await (await fetch(`${origin}/agent/sessions/${sessionId}`, { headers: { origin, cookie } })).json();
		askedFile = { same: readFileSync(join(dir, `${sessionId}.jsonl`), "utf8") === before, active: live.active?.turnId };
		edited = await rewind(turnIds[1], cookie);
		editedBody = await edited.json();
		slow.resolve();
	});
	await check("a rewind without the owner cookie is refused (403 AUTH_REQUIRED)", async () => {
		assert.equal(anonymous?.status, 403);
		assert.equal((await anonymous.json())?.error?.code, "AUTH_REQUIRED");
	});
	await check("a check of the running turn answers 200 and changes nothing: the file is the same and the turn still runs", async () => {
		assert.equal(asked?.status, 200);
		assert.deepEqual(await asked.json(), { ok: true, check: true });
		assert.deepEqual(askedFile, { same: true, active: turnIds[1] });
	});
	await check("the owner's rewind of the running turn stops it first, then answers 200 with what it removed", () => {
		assert.equal(edited?.status, 200, JSON.stringify(editedBody));
		assert.equal(editedBody.ok, true);
		assert.equal(editedBody.revision, 41);
		assert.ok(secondEvents.some((event) => event.type === "error" && event.code === "aborted"), JSON.stringify(secondEvents.map((event) => event.type)));
		assert.equal(secondEvents.at(-1)?.type, "done");
	});
	await check("the session file holds the first turn alone: its line, its message and reply; no trace of the edited turn", () => {
		const lines = fileLines();
		assert.deepEqual(lines.filter((line) => line.kind === "turn").map((line) => line.turnId), [turnIds[0]]);
		const all = JSON.stringify(lines);
		assert.ok(!all.includes("a message with a typo"), all.slice(0, 400));
		assert.ok(!lines.some((line) => line.kind === "turn_error"), "the aborted card's record is gone too");
		assert.deepEqual(userWords(lines.filter((line) => line.kind === "message").map((line) => line.message)), ["first message"]);
	});
	await check("the cut leaves the file exactly as it was when the edited turn was admitted (no call parted from its result), and no temporary file", () => {
		assert.equal(readFileSync(join(dir, `${sessionId}.jsonl`), "utf8"), beforeSecond);
		assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith(".tmp")), []);
	});
	await check("the restored transcript has the first message, marked with its turn for the panel's edit", async () => {
		const payload = await (await fetch(`${origin}/agent/sessions/${sessionId}`, { headers: { origin, cookie } })).json();
		const users = payload.transcript.filter((item) => item.kind === "user");
		assert.deepEqual(users.map((item) => [item.text, item.turnId]), [["first message", turnIds[0]]]);
	});
	await check("a turn the sidecar never recorded (refused before admission) rewinds nothing and leaves no note for the next turn", async () => {
		const before = readFileSync(join(dir, `${sessionId}.jsonl`), "utf8");
		const response = await rewind("00000000-0000-4000-8000-0000000000ff", cookie);
		assert.equal(response.status, 200);
		assert.equal((await response.json()).removed, 0);
		assert.equal(readFileSync(join(dir, `${sessionId}.jsonl`), "utf8"), before);
	});
	const callsBefore = fake.calls.length;
	const third = await turn(turnIds[2], "the corrected message", cookie);
	const thirdEvents = await readEvents(third);
	const context = fake.calls[callsBefore]?.messages ?? [];
	await check("the corrected turn ends done", () => assert.equal(thirdEvents.at(-1)?.type, "done", JSON.stringify(thirdEvents.filter((event) => event.type === "error"))));
	await check("the model receives one corrected request: the first exchange, then the corrected message; never the typo", () => {
		assert.equal(fake.calls.length, callsBefore + 1);
		assert.deepEqual(userWords(context), ["first message", "the corrected message"]);
		assert.ok(!JSON.stringify(context).includes("a message with a typo"));
		assert.deepEqual(context.filter((message) => message.role !== "system").map((message) => message.role), ["user", "assistant", "user"]);
	});
	await check("the corrected message tells the model it replaces the removed one and that the scene was not rolled back (same revision)", () => {
		const note = texts(context.at(-1)).find((text) => text.startsWith("<edited-message>"));
		assert.ok(note, JSON.stringify(texts(context.at(-1))).slice(0, 300));
		assert.match(note, /replaces it/);
		assert.match(note, /revision 41, the same as when that message was sent: nothing was changed in it since/);
	});
	await check("the panel's bubble shows the corrected words only, and it is the one now marked for the edit", async () => {
		const payload = await (await fetch(`${origin}/agent/sessions/${sessionId}`, { headers: { origin, cookie } })).json();
		const users = payload.transcript.filter((item) => item.kind === "user");
		assert.deepEqual(users.map((item) => [item.text, item.turnId ?? null]), [["first message", null], ["the corrected message", turnIds[2]]]);
	});
	await check("the earlier turn is not the last any more: 409 NOT_LAST", async () => {
		const response = await rewind(turnIds[0], cookie);
		assert.equal(response.status, 409);
		assert.equal((await response.json())?.error?.code, "NOT_LAST");
	});
	await check("the note goes with the corrected message alone: the next turn's message carries none", async () => {
		await readEvents(await turn(turnIds[3], "a later message", cookie));
		const latest = fake.calls.at(-1).messages.filter((message) => message.role === "user").at(-1);
		assert.equal(texts(latest).at(-1), "a later message");
		assert.ok(!texts(latest).some((text) => text.includes("<edited-message>")));
	});
	await new Promise((resolve) => server.close(resolve));
}

// --- task mode through the routes: a message sent with Tasks on is refused and nothing is stopped; one sent with Tasks off
// in the same conversation is replaced --------------------------------------------------------------------------------
{
	const store = createSessionStore(mkdtempSync(join(tmpdir(), "cozyclay-edit-tasks-")));
	const hold = deferred(), calls = [], fake = createFakeModel();
	fake.fauxProvider.setResponses(Array.from({ length: 12 }, () => async (context) => {
		calls.push(context.messages);
		if (JSON.stringify(context.messages.findLast((message) => message.role === "user")).includes("[[hold]]")) await hold.promise;
		return fauxAssistantMessage([fauxText(`reply ${calls.length}`)]);
	}));
	let server;
	const read = async () => ({ ...contextFixture(), entityIndex: [{ id: "char-alex", kind: "character", name: "Alex" }] });
	const handler = createAgentHandler({ auth: { getAccessToken: async () => "token" }, port: () => server.address().port, codex: { parseQuotaHeaders: () => ({ primary: {}, credits: {} }) }, models: fake.models, fauxProvider: fake.fauxProvider, liveHub: withTurnControls({ command: async () => ({}) }), studioRuntime: { readContext: read }, sessionStore: store, supervisor: false, studioTasks: () => true, taskLimits: { staggerMs: 0 } });
	server = createServer((req, res) => handler(req, res).catch((error) => { console.error(error.stack); if (!res.headersSent) res.writeHead(500); res.end(); }));
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const origin = `http://127.0.0.1:${server.address().port}`, base = envelopeFixture(), sessionId = base.sessionId;
	const ids = ["00000000-0000-4000-8000-0000000000b1", "00000000-0000-4000-8000-0000000000b2", "00000000-0000-4000-8000-0000000000b3"];
	let cookie;
	const post = (path, body) => fetch(`${origin}${path}`, { method: "POST", headers: { "content-type": "application/json", origin, ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
	const running = post("/agent/main", { ...base, turnId: ids[0], text: "a task-mode message [[hold]]", model: "faux/scripted" });
	for (let i = 0; i < 200 && !calls.length; i++) await new Promise((resolve) => setTimeout(resolve, 10));
	const opened = await running; cookie = opened.headers.get("set-cookie")?.split(";")[0];
	const refused = await post(`/agent/sessions/${sessionId}/rewind`, { turnId: ids[0] }), refusedBody = await refused.json();
	const live = await (await fetch(`${origin}/agent/sessions/${sessionId}`, { headers: { origin, cookie } })).json();
	hold.resolve();
	const mainEvents = await readEvents(opened);
	await check("the edit of a running task-mode message is refused (409 TASK_MODE) and stops nothing: the turn runs on to its reply", () => {
		assert.equal(refused.status, 409);
		assert.equal(refusedBody.error?.code, "TASK_MODE");
		assert.equal(live.active?.turnId, ids[0]);
		assert.equal(mainEvents.at(-1)?.type, "done");
		assert.ok(!mainEvents.some((event) => event.type === "error"), JSON.stringify(mainEvents.filter((event) => event.type === "error")));
	});
	await readEvents(await post("/agent/turn", { ...base, turnId: ids[1], text: "a plain message with a typo" }));
	const cut = await post(`/agent/sessions/${sessionId}/rewind`, { turnId: ids[1] });
	const before = calls.length;
	await readEvents(await post("/agent/turn", { ...base, turnId: ids[2], text: "the corrected plain message" }));
	await check("a message sent with Tasks off in that conversation is replaced: the model holds the task-mode exchange and the corrected message", () => {
		assert.equal(cut.status, 200);
		assert.deepEqual(userWords(calls[before]), ["a task-mode message [[hold]]", "the corrected plain message"]);
		assert.ok(!JSON.stringify(calls[before]).includes("a plain message with a typo"));
		assert.ok(texts(calls[before].at(-1)).some((text) => text.startsWith("<edited-message>")));
	});
	await new Promise((resolve) => server.close(resolve));
}

// --- the panel's side (src/workflow/agent-edit.js) over the real chat store and queue, a scripted transport ---------------
{
	const log = [], turns = [];
	let refuseWith = null, n = 0, queue = null;
	const transport = {
		turn(request, onEvent, signal) {
			request.onTurnId?.(request.turnId); request.onOpen?.(request.sessionId);
			return new Promise((resolve) => { turns.push({ request, emit: onEvent }); signal?.addEventListener("abort", () => resolve(), { once: true }); });
		},
		async stop() { log.push("stop"); return { ok: true }; },
		async steer() { return { ok: true, queued: true }; },
		async rewind(sessionId, turnId, asked = false) { log.push(`${asked ? "check" : "rewind"} ${turnId}`); if (refuseWith) throw Object.assign(new Error("refused"), { code: refuseWith }); return { ok: true }; },
	};
	const memory = new Map(), storage = { getItem: (key) => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, String(value)), removeItem: (key) => memory.delete(key) };
	const store = createAgentChatStore({ transport, surface: "studio", newId: () => `id-${++n}`, buildContext: () => ({ host: {}, revision: { scene: 1 } }), onSteer: (event) => queue?.steered(event) });
	queue = createMessageQueue({ store, storage, newId: () => `row-${++n}`, send: (row) => store.send(row.text, { ...row.options, queued: true }) });
	queue.subscribe(() => {});
	const users = () => store.getState().items.filter((item) => item.kind === "user").map((item) => `${item.steered ? "steer:" : ""}${item.text}`);
	void store.send("a message with a typo", { model: "p/one" });
	const typo = store.getState().items.find((item) => item.kind === "user");
	store.setDraft("a draft the user is writing");
	queue.add("a message that waits", { model: "p/one" });
	await store.steer("sent into the turn", { id: "steer-1" });
	turns[0].emit({ type: "steer.received", id: "steer-1" });
	await check("the turn holds a message sent into it (Send now): the edit box is told so", () => {
		assert.deepEqual(users(), ["a message with a typo", "steer:sent into the turn"]);
		assert.equal(editableMessageId(store.getState().items), typo.id, "the edit goes on the message that started the turn");
		assert.equal(steeredAfter(store.getState().items, typo.id), true);
		assert.equal(steeredAfter([{ id: "a", kind: "user", steered: true }, { id: "b", kind: "user" }, { id: "c", kind: "assistant" }], "b"), false, "a steer of an earlier turn does not count");
	});
	refuseWith = "TASK_MODE";
	const refused = await resendEdited({ store, transport, itemId: typo.id, text: "the corrected message" });
	await check("a refusal the sidecar tells beforehand changes nothing: no Stop, the turn runs on, the transcript as it was, the reason in the user's words", () => {
		assert.equal(refused.ok, false);
		assert.match(refused.message, /sent with Tasks on cannot be edited/);
		assert.deepEqual(log, [`check ${typo.turnId}`]);
		assert.equal(store.getState().streaming, true);
		assert.deepEqual(users(), ["a message with a typo", "steer:sent into the turn"]);
		assert.equal(turns.length, 1);
	});
	await check("the pencil's question (checkEdit) answers the same without touching anything", async () => {
		assert.match((await checkEdit({ store, transport, itemId: typo.id })).message, /Tasks on/);
		refuseWith = null;
		assert.deepEqual(await checkEdit({ store, transport, itemId: typo.id }), { ok: true, message: "" });
		assert.equal(store.getState().streaming, true);
	});
	log.length = 0;
	const picture = { dataUrl: "data:image/png;base64,iVBORw0KGgo=", name: "shot.png" };
	const sent = await resendEdited({ store, transport, itemId: typo.id, text: "the corrected message", attachments: [picture], options: { model: "p/two", effort: "high", attachFrame: true } });
	await new Promise((resolve) => setTimeout(resolve, 0));
	await check("an accepted edit of a running turn: asked, stopped, cut, then one new turn with the corrected text, its pictures and the given model", () => {
		assert.equal(sent.ok, true);
		assert.deepEqual(log, [`check ${typo.turnId}`, "stop", `rewind ${typo.turnId}`]);
		assert.equal(turns.length, 2);
		const request = turns[1].request;
		assert.deepEqual([request.text, request.model, request.effort, request.attachFrame], ["the corrected message", "p/two", "high", true]);
		assert.deepEqual(request.attachments.map((entry) => [entry.dataUrl, entry.name]), [[picture.dataUrl, picture.name]]);
		assert.deepEqual(users(), ["the corrected message"], "the old message and the one sent into its turn left the transcript");
	});
	await check("the composer's draft stays, and the queued message stays held: it does not go by itself after the corrected turn", async () => {
		assert.equal(store.getState().draft, "a draft the user is writing");
		assert.deepEqual(queue.getState().rows.map((row) => `${row.status}:${row.text}`), ["queued:a message that waits"]);
		assert.equal(queue.getState().held, true);
		turns[1].emit({ type: "text.delta", text: "done" }); turns[1].emit({ type: "done" });
		store.stop(); // the scripted stream never closes by itself
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(turns.length, 2, "no third turn");
	});
}

// --- the module alone ------------------------------------------------------------------------------------------------
const epochOf = (documentEpoch) => sceneEpoch({ documentEpoch, sceneId: "scene-main", sceneEpoch: "open-1" });
await check("editNote names both revisions when the scene moved under one editor epoch, and says nothing was rolled back", () => {
	const note = editNote({ revision: 12, epoch: epochOf("doc-1") }, 15, epochOf("doc-1"));
	assert.match(note, /was at revision 12 when that message was sent and is at revision 15 now/);
	assert.match(note, /not rolled back/);
	assert.match(note, /whose tool calls and results you no longer have/);
	assert.match(editNote({ revision: null, epoch: null }, 15, epochOf("doc-1")), /nothing the removed turn changed in it was undone by this edit/);
});
await check("a reloaded editor counts revisions from the start again: equal numbers under another epoch never read as 'nothing changed'", () => {
	const same = editNote({ revision: 0, epoch: epochOf("doc-1") }, 0, epochOf("doc-1")), reloaded = editNote({ revision: 0, epoch: epochOf("doc-1") }, 0, epochOf("doc-2"));
	assert.match(same, /the same as when that message was sent: nothing was changed in it since/);
	assert.ok(!/nothing was changed/.test(reloaded), reloaded);
	assert.match(reloaded, /reloaded or went to another scene or document.*do not compare: the scene may hold changes the removed turn made/);
	assert.ok(!/nothing was changed/.test(editNote({ revision: 0, epoch: null }, 0, null)), "a turn line without an epoch compares with nothing");
	assert.equal(sceneEpoch({ sceneId: "scene-main" }), null);
});
await check("a task-mode turn is refused (TASK_MODE) and its file untouched; a plain turn after it in the same conversation is cut", () => {
	const store = createSessionStore(mkdtempSync(join(tmpdir(), "cozyclay-edit-task-")));
	const prompt = (text) => ({ role: "user", content: [{ type: "text", text: "<studio-context>\n{}\n</studio-context>" }, { type: "text", text }] });
	markTurn(store, "m", { turnId: "main-1", revision: 1, main: true });
	store.append("m", [prompt("a task-mode message"), { role: "assistant", content: [{ type: "text", text: "on it" }] }]);
	const before = readFileSync(join(store.dir, "m.jsonl"), "utf8");
	assert.deepEqual(rewindTurn(store, "m", "main-1"), { ok: false, code: "TASK_MODE" });
	assert.equal(readFileSync(join(store.dir, "m.jsonl"), "utf8"), before);
	markTurn(store, "followed", { turnId: "main-1", revision: 1, main: true });
	markTurn(store, "followed", { turnId: "report-2", revision: 1, main: true });
	assert.deepEqual(rewindTurn(store, "followed", "main-1"), { ok: false, code: "TASK_MODE" }, "the main agent's own report after it does not turn the reason into NOT_LAST");
	markTurn(store, "m", { turnId: "plain-2", revision: 2, epoch: "e" });
	store.append("m", [prompt("a plain message"), { role: "assistant", content: [{ type: "text", text: "done" }] }]);
	assert.deepEqual(rewindTurn(store, "m", "plain-2", { check: true }), { ok: true, removed: 2, revision: 2, epoch: "e" });
	assert.equal(store.read("m").history.length, 4, "a check cuts nothing");
	assert.deepEqual(rewindTurn(store, "m", "plain-2"), { ok: true, removed: 2, revision: 2, epoch: "e" });
	assert.equal(readFileSync(join(store.dir, "m.jsonl"), "utf8"), before);
});
await check("a turn of the v4 single-session engine (v4/studio-turn.mjs) cannot be cut (its own session keeps it): ENGINE_KEEPS_HISTORY, file untouched", () => {
	const store = createSessionStore(mkdtempSync(join(tmpdir(), "cozyclay-edit-v4-")));
	markTurn(store, "v4-session", { turnId: "t1", revision: 3, model: "v4/claude-opus-5-5" });
	store.append("v4-session", [{ role: "user", content: [{ type: "text", text: "<studio-context>\n{}\n</studio-context>" }, { type: "text", text: "hello" }] }]);
	assert.deepEqual(rewindTurn(store, "v4-session", "t1"), { ok: false, code: "ENGINE_KEEPS_HISTORY" });
	assert.equal(store.read("v4-session").history.length, 1);
});
await check("the last turn's message is found behind steers and earlier turns; a session written before turn lines marks nothing", () => {
	const store = createSessionStore(mkdtempSync(join(tmpdir(), "cozyclay-edit-mark-")));
	const prompt = (text) => ({ role: "user", content: [{ type: "text", text: "<studio-context>\n{}\n</studio-context>" }, { type: "text", text }] });
	store.append("old", [prompt("before turn lines"), { role: "assistant", content: [{ type: "text", text: "ok" }] }]);
	assert.deepEqual(withLastTurnId(store, "old", transcriptFromHistory(store.read("old").history), transcriptFromHistory).map((item) => item.turnId ?? null), [null, null]);
	markTurn(store, "s", { turnId: "a", revision: 1 });
	store.append("s", [prompt("one"), { role: "assistant", content: [{ type: "text", text: "r1" }] }]);
	markTurn(store, "s", { turnId: "b", revision: 2 });
	store.append("s", [prompt("two"), { role: "user", content: [{ type: "text", text: "a steer" }] }, { role: "assistant", content: [{ type: "text", text: "r2" }] }]);
	const marked = withLastTurnId(store, "s", transcriptFromHistory(store.read("s").history), transcriptFromHistory).filter((item) => item.kind === "user");
	assert.deepEqual(marked.map((item) => [item.text, item.turnId ?? null]), [["one", null], ["two", "b"], ["a steer", null]]);
	assert.deepEqual(rewindTurn(store, "s", "b"), { ok: true, removed: 3, revision: 2, epoch: null });
	assert.deepEqual(transcriptFromHistory(store.read("s").history).map((item) => item.text), ["one", "r1"]);
	assert.equal(store.read("s").meta.firstText, "one", "the title stays while a message is left");
	assert.deepEqual(rewindTurn(store, "s", "a"), { ok: true, removed: 2, revision: 1, epoch: null });
	assert.equal(store.read("s").meta.firstText, null, "no message left: the next one names the conversation");
});

if (failures) { console.error(`${failures} edit message check(s) failed`); process.exit(1); }
console.log("agent edit message: all checks passed");
