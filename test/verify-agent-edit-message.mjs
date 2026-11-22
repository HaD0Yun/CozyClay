#!/usr/bin/env node
// The edit on the user's last message in the Studio's Agent box (bin/agent/session-rewind.mjs): POST
// /agent/sessions/<id>/rewind { turnId } stops that turn if it runs, takes it out of the conversation (the session
// file, so the model's next context and the panel's restored transcript), and the next turn's message says it replaces
// the removed one and what became of the scene. Driven through the real routes, pi runner and session store; only the
// model is scripted.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentHandler } from "../bin/agent/agent-routes.mjs";
import { createSessionStore, transcriptFromHistory } from "../bin/agent/session-store.mjs";
import { editNote, markTurn, rewindTurn, withLastTurnId } from "../bin/agent/session-rewind.mjs";
import { createFakeModel } from "./fixtures/fake-model.mjs";
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
	let anonymous = null, edited = null, editedBody = null;
	const second = await turn(turnIds[1], "a message with a typo", cookie);
	const secondEvents = await readEvents(second, async (event) => {
		if (event.type !== "tool.start" || edited) return;
		anonymous = await rewind(turnIds[1]);
		edited = await rewind(turnIds[1], cookie);
		editedBody = await edited.json();
		slow.resolve();
	});
	await check("a rewind without the owner cookie is refused (403 AUTH_REQUIRED)", async () => {
		assert.equal(anonymous?.status, 403);
		assert.equal((await anonymous.json())?.error?.code, "AUTH_REQUIRED");
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
		assert.match(note, /revision 41, the same as when that message was sent/);
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

// --- the module alone ------------------------------------------------------------------------------------------------
await check("editNote names both revisions when the scene moved, and says nothing was rolled back", () => {
	const note = editNote({ revision: 12 }, 15);
	assert.match(note, /was at revision 12 when that message was sent and is at revision 15 now/);
	assert.match(note, /not rolled back/);
	assert.match(editNote({ revision: null }, 15), /whatever the removed turn changed in it is still there/);
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
	assert.deepEqual(rewindTurn(store, "s", "b"), { ok: true, removed: 3, revision: 2 });
	assert.deepEqual(transcriptFromHistory(store.read("s").history).map((item) => item.text), ["one", "r1"]);
	assert.equal(store.read("s").meta.firstText, "one", "the title stays while a message is left");
	assert.deepEqual(rewindTurn(store, "s", "a"), { ok: true, removed: 2, revision: 1 });
	assert.equal(store.read("s").meta.firstText, null, "no message left: the next one names the conversation");
});

if (failures) { console.error(`${failures} edit message check(s) failed`); process.exit(1); }
console.log("agent edit message: all checks passed");
