#!/usr/bin/env node
// What a real battery found wrong with dispatching tasks (parallel Studio tasks), each against the shipped code:
//   1 a dispatch naming an id the scene does not have is refused with the ids it has, and the scope description says
//     which keys a job needs (a new character, a new shot, lighting);
//   2 a task whose own report leaves a visible criterion unmet ends incomplete, not done (board and main-agent events),
//     and its dependents fail;
//   3 task.requestScope is reachable from a task: SCOPE_DENIED names the exact run_action call, that call grows the
//     scope, inspect_studio describes it by id, and a task's action list carries it;
//   4 a reload mid-turn: the session read names the turn still running (the panel attaches to it), and the Studio's new
//     handle reaches the board (POST .../reconnect), so a task paused on the old handle resumes there at once; the main
//     agent's reads follow the new handle too.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createTaskBoard, taskHeader, unmetCriteria } from "../bin/agent/studio-tasks.mjs";
import { createMainTools, doneClaimCorrection, unknownScopeIds } from "../bin/agent/main-agent.mjs";
import { MAIN_SYSTEM_PROMPT } from "../bin/agent/main-prompt.mjs";

const sessionDir = mkdtempSync(join(tmpdir(), "cozyclay-task-dispatch-"));
process.env.COZYCLAY_AGENT_SESSIONS_DIR = sessionDir;
process.on("exit", () => rmSync(sessionDir, { recursive: true, force: true }));
const tick = () => new Promise(resolve => setImmediate(resolve));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
let passed = 0;
const pass = text => { passed++; console.log(`PASS ${text}`); };

// --- 1 dispatch validation --------------------------------------------------------------------------------------
const scene = { entityIndex: [{ id: "cube-1", kind: "object" }, { id: "mina", kind: "character" }], entityPage: { returned: 2, total: 2, truncated: false }, shots: [{ id: "s1" }], shotsTruncated: false };
{
	assert.equal(unknownScopeIds([{ scope: ["object:cube-1", "character:mina:take", "shot:s1", "stage", "timeline"] }], scene), null, "ids the scene has pass, layer keys too");
	const ghost = unknownScopeIds([{ scope: ["character:ghost", "stage"] }], scene);
	assert.match(ghost, /character:ghost names nothing in this scene/);
	assert.match(ghost, /Valid ids, character: mina/, "the refusal lists the ids that exist");
	assert.match(unknownScopeIds([{ scope: ["shot:new"] }], { ...scene, shots: [] }), /shot: none \(a new shot needs timeline\)/);
	assert.match(unknownScopeIds([{ scope: ["object:x"], reads: ["object:y"] }], scene), /object:x, object:y name nothing/, "reads are checked too");
	assert.equal(unknownScopeIds([{ scope: ["object:far"] }], { ...scene, entityPage: { returned: 2, total: 900, truncated: true } }), null, "a cut-short list is no proof: let it through");
	assert.equal(unknownScopeIds([{ scope: ["shot:s9"] }], { ...scene, shotsTruncated: true }), null);
	pass("1 unknownScopeIds: unknown ids are named with the valid ones; layers, singletons and cut-short lists pass");
}
{
	const runs = [], board = createTaskBoard({ limits: { staggerMs: 0 }, run: task => { runs.push(task); return new Promise(() => {}); } });
	const handles = [];
	const studio = [{ name: "inspect_studio", handler: async () => { throw Object.assign(new Error("STALE_HANDLE: gone"), { code: "STALE_HANDLE" }); } }];
	const hub = { command: async (name, args, handle) => { handles.push(handle); return { ok: true, read: name }; } };
	let live = null;
	const tools = createMainTools({ board, studio, hub, admission: { host: {}, revision: 1, snapshot: async () => scene }, workspaceHandle: "handle-1", liveHandle: () => live });
	const tool = name => tools.find(entry => entry.name === name);
	const { description } = tool("dispatch_task").parameters.properties.scope;
	assert.match(description, /a new shot, or shot order, ranges or frame count -> timeline/);
	assert.match(description, /Something the task creates \(character\.add, object\.add, a kit\) needs no key/);
	assert.match(description, /lights, environment or lens -> stage/);
	assert.match(description, /Adding a character and framing her in a shot -> that shot:<id>/);
	await assert.rejects(tool("dispatch_task").handler({ title: "add", instructions: "add a character", scope: ["character:ghost"] }), error => error.code === "INVALID_ARGUMENT" && /Valid ids, character: mina/.test(error.message));
	await assert.rejects(tool("dispatch_plan").handler({ tasks: [{ ref: "a", title: "a", instructions: "x", scope: ["shot:nope"] }] }), /shot:nope names nothing/);
	assert.equal(board.board().length, 0, "a refused dispatch queues nothing");
	const queued = await tool("dispatch_task").handler({ title: "frame", instructions: "frame mina", scope: ["shot:s1", "character:mina:placement"] });
	assert.ok(queued.taskId && board.board().length === 1, "real ids dispatch");
	await assert.rejects(tool("inspect_studio").handler({ scope: "scene" }), /STALE_HANDLE/, "no newer handle: the error stands");
	live = "handle-2";
	assert.deepEqual(await tool("inspect_studio").handler({ scope: "scene" }), { ok: true, read: "inspect_studio" });
	assert.deepEqual(handles, ["handle-2"], "a read on the old handle is read again on the Studio's new one");
	pass("1 dispatch_task / dispatch_plan refuse a made-up id before queueing; the scope description names the keys each job needs; 4 the main agent's read follows a new handle");
}

// --- 2 unmet criteria end incomplete ---------------------------------------------------------------------------
{
	assert.equal(unmetCriteria("Moved.\nUnmet criteria: none"), null);
	assert.equal(unmetCriteria("**Unmet criteria:** none."), null);
	assert.equal(unmetCriteria("Moved the cube. QA: 0 unmet."), null);
	assert.equal(unmetCriteria("- hands wrap the bar: met"), null);
	assert.equal(unmetCriteria("Unmet criteria: hands off the bar (7 cm)"), "hands off the bar (7 cm)");
	assert.equal(unmetCriteria("Report:\n- hands wrap the bar: unmet (7 cm off)\n- feet land on top: met"), "hands wrap the bar: unmet (7 cm off)", "a report without the line still counts a criterion it calls unmet");
	assert.match(taskHeader({ taskId: "t", scope: ["stage"], instructions: "" }), /Making something new \(character\.add, object\.add, a kit\) needs no scope key/, "a stage task knows it may make a character");
	assert.match(taskHeader({ taskId: "t", scope: ["stage"], instructions: "" }), /End the report with one line: "Unmet criteria: none" .* ends incomplete, not done/);
	const events = [], runs = [];
	const board = createTaskBoard({ limits: { staggerMs: 0 }, emit: event => events.push(event), run: task => { const run = { task, ...deferred() }; runs.push(run); return run.promise; } });
	const a = board.dispatch({ title: "pull up", instructions: "pull up", scope: ["character:mina"] });
	const b = board.dispatch({ title: "frame it", instructions: "frame", scope: ["shot:s1"], dependsOn: [a.taskId] });
	const c = board.dispatch({ title: "light", instructions: "light", scope: ["stage"], verify: true });
	const d = board.dispatch({ title: "cube", instructions: "cube", scope: ["object:cube-1"] });
	await tick();
	runs[0].resolve({ status: "done", reply: "Compiled. Unmet criteria: hands wrap the bar (7 cm off)", receipts: [{ receiptId: "r", affectedIds: ["mina"] }] });
	runs[1].resolve({ status: "done", reply: "Lit.\nUnmet criteria: the key light is not warm" });
	runs[2].resolve({ status: "done", reply: "Moved.\nUnmet criteria: none" });
	await tick(); await tick();
	const view = id => board.board().find(task => task.taskId === id);
	assert.equal(view(a.taskId).status, "incomplete");
	assert.equal(view(a.taskId).reason, "criteria unmet: hands wrap the bar (7 cm off)");
	assert.deepEqual(view(a.taskId).changed, ["character:mina"], "its changes are still recorded");
	assert.equal(view(c.taskId).status, "incomplete", "a verify task with an unmet criterion is not up for review");
	assert.equal(view(d.taskId).status, "done", "none unmet is done");
	assert.equal(view(b.taskId).status, "failed");
	assert.match(view(b.taskId).reason, /depends on task .* which ended with criteria unmet/);
	assert.ok(events.some(event => event.type === "task.incomplete" && event.taskId === a.taskId), "the main agent hears task.incomplete");
	assert.equal(board.cancel(a.taskId), null, "an incomplete task has ended");
	assert.match(doneClaimCorrection("pull up 작업을 완료했습니다.", board.board(), "턱걸이 해줘"), /"pull up" 작업은 아직 끝나지 않았습니다. 지금 기준 미달로 종료입니다/);
	pass("2 a run whose report leaves a criterion unmet ends incomplete with that reason (event task.incomplete), never done or review; dependents fail");
}

// --- 3 task.requestScope from a task ----------------------------------------------------------------------------
const { objectsFixture } = await import("./bus/objects-fixture.mjs");
const { dispatchLiveFrame } = await import("../src/live-control.js");
{
	const f = objectsFixture(), id = kind => f.store.current.objects.find(o => o.renderer === kind).id;
	const cube = id("cube"), sphere = id("sphere");
	const action = (taskId, name, args) => dispatchLiveFrame(JSON.stringify({ type: "cmd", id: randomUUID(), name: "run_action",
		args: { name: "run_action", args: { action: name, args }, commandId: randomUUID(), host: f.host(), expectedRevision: 0, taskId } }), f.binding.handlers);
	const value = response => (response.ok ? response.value : { ok: false, code: String(response.error).split(":")[0], message: response.error });
	assert.equal(value(await action("t1", "task.begin", { taskId: "t1", scope: [`object:${cube}`] })).ok, true);
	const denied = value(await action("t1", "object.set", { id: sphere, set: { position: { x: 4, y: 0, z: 0 } } }));
	assert.equal(denied.code, "SCOPE_DENIED", JSON.stringify(denied));
	const call = JSON.parse(/run_action (\{.*\}), or leave it/.exec(denied.message)[1]);
	assert.deepEqual(call, { action: "task.requestScope", args: { taskId: "t1", scope: [`object:${sphere}`] } }, "the refusal names the exact call");
	assert.equal(value(await action("t1", call.action, call.args)).ok, true, "that call, sent as run_action, grows the scope");
	assert.equal(value(await action("t1", "object.set", { id: sphere, set: { position: { x: 4, y: 0, z: 0 } } })).ok, true);
	assert.equal(f.store.current.objects.find(o => o.id === sphere).x, 4);
	const [described] = f.binding.handlers.inspect_studio({ scope: "actions", ids: ["task.requestScope"] }).actions;
	assert.equal(described.id, "task.requestScope"); assert.deepEqual(described.input.required, ["taskId", "scope"]);
	assert.ok(!f.binding.handlers.inspect_studio({ scope: "actions" }).actions.some(row => row.id === "task.requestScope"), "the command listing stays the registry's");
	assert.equal(value(await action("t1", "task.finish", { taskId: "t1" })).ok, true);
	f.dispose();
	pass("3 SCOPE_DENIED names the run_action call for task.requestScope, which works as sent; inspect_studio describes it by id");
}

// --- 3 + 4 the routes: a task's action list, a reload mid-turn, the new handle ---------------------------------------
const { createFakeModel } = await import("./fixtures/fake-model.mjs");
const { createAgentHandler } = await import("../bin/agent/agent-routes.mjs");
{
	const f = objectsFixture(), cube = f.store.current.objects.find(o => o.renderer === "cube").id;
	let handle = "handle-1";
	const stale = () => Object.assign(new Error(`STALE_HANDLE: Unknown or stale live workspace handle.`), { code: "STALE_HANDLE" });
	const read = () => { const context = f.binding.handlers.read_studio_context({ host: f.host() }); return { ...context, host: { ...context.host, workspaceHandle: handle } }; };
	const hub = {
		async command(name, payload, workspaceHandle) {
			if (workspaceHandle !== handle) throw stale();
			const response = await dispatchLiveFrame(JSON.stringify({ type: "cmd", id: randomUUID(), name, args: payload }), f.binding.handlers);
			if (!response.ok) throw Object.assign(new Error(response.error), { code: String(response.error).split(":")[0] });
			return response.value;
		},
		workspaceId: () => f.host().workspaceId, resolveWorkspace: (_name, requested) => { if (requested && requested !== handle) throw stale(); return handle; }, connected: true, get workspaceHandles() { return [handle]; },
	};
	const mainGate = deferred(), reloadGate = deferred(), taskPrompts = [], notes = [];
	const results = context => context.messages.filter(message => message.role === "toolResult").length;
	const lastUser = context => JSON.stringify([...context.messages].reverse().find(message => message.role === "user") ?? {});
	const step = async context => {
		if (getCurrentSystemPrompt(context.messages) === MAIN_SYSTEM_PROMPT) {
			if (context.messages.at(-1).role === "user" && lastUser(context).includes("Move the cube")) {
				await mainGate.promise;
				return fauxAssistantMessage([fauxToolCall("dispatch_task", { title: "cube", instructions: `Move ${cube} to x 1, then x 2.`, scope: [`object:${cube}`] }, { id: `m-${randomUUID()}` })]);
			}
			return fauxAssistantMessage([fauxText("작업을 시작했어요.")]);
		}
		taskPrompts.push(getCurrentSystemPrompt(context.messages));
		if (/Studio reconnected|reads as you left it|scene changed while the Studio reloaded/.test(lastUser(context)) && context.messages.at(-1).role === "user") { notes.push("resumed"); return fauxAssistantMessage([fauxText("Moved.\nUnmet criteria: none")]); }
		if (results(context) === 0) return fauxAssistantMessage([fauxToolCall("run_action", { action: "object.set", args: { id: cube, set: { position: { x: 1, y: 0, z: 0 } } } }, { id: `t-${randomUUID()}` })]);
		if (results(context) === 1) { await reloadGate.promise; return fauxAssistantMessage([fauxToolCall("run_action", { action: "object.set", args: { id: cube, set: { position: { x: 2, y: 0, z: 0 } } } }, { id: `t-${randomUUID()}` })]); }
		return fauxAssistantMessage([fauxText("Moved.\nUnmet criteria: none")]);
	};
	const fakeModel = createFakeModel();
	fakeModel.fauxProvider.setResponses(Array.from({ length: 30 }, () => step));
	let server;
	const handler = createAgentHandler({ auth: { getAccessToken: async () => "token" }, codex: { parseQuotaHeaders: () => ({ primary: {}, credits: {} }) }, models: fakeModel.models, fauxProvider: fakeModel.fauxProvider,
		liveHub: hub, studioRuntime: { readContext: async host => { if (host.workspaceHandle && host.workspaceHandle !== handle) throw stale(); return read(); } }, supervisor: false, studioTasks: () => true, taskLimits: { staggerMs: 0 }, port: () => server.address().port });
	server = createServer((req, res) => handler(req, res).catch(error => { if (!res.headersSent) res.writeHead(500); res.end(error.stack); }));
	server.listen(0, "127.0.0.1"); await once(server, "listening");
	const origin = `http://127.0.0.1:${server.address().port}`, sessionId = randomUUID(), turnId = randomUUID();
	const first = await fetch(`${origin}/agent/main`, { method: "POST", headers: { "content-type": "application/json", origin },
		body: JSON.stringify({ surface: "studio", sessionId, turnId, text: "Move the cube", context: read(), model: "faux/scripted" }) });
	const cookie = first.headers.get("set-cookie").split(";")[0];
	const get = (path, extra = {}) => fetch(`${origin}${path}`, { headers: { origin, cookie, ...extra } });
	// The reload: the panel reads its stored session while the main turn still runs.
	const restored = await (await get(`/agent/sessions/${sessionId}`)).json();
	assert.deepEqual(restored.active, { turnId, text: "Move the cube" }, "the session read names the running turn and its message");
	assert.equal(restored.main, true, "and that it has a task board");
	assert.equal((await get(`/agent/sessions/${sessionId}`, { cookie: "studio_owner=intruder" })).status, 404, "another owner learns nothing of it");
	const gone = await get(`/agent/sessions/${randomUUID()}?restore=1`);
	assert.equal(gone.status, 200, "the panel's restore look-up of a session gone with the last server is no error"); assert.equal((await gone.json()).missing, true);
	assert.equal((await get(`/agent/sessions/${randomUUID()}`)).status, 404, "a plain read still answers 404");
	assert.equal((await get(`/agent/sessions/${sessionId}?restore=1`, { cookie: "studio_owner=intruder" })).status, 200, "another owner still learns nothing: it reads as missing");
	const attached = get(`/agent/turn/${encodeURIComponent(turnId)}/events?after=0`).then(response => response.text());
	mainGate.resolve();
	const replay = await attached;
	assert.match(replay, /"name":"dispatch_task"/); assert.match(replay, /"type":"done"/, "the panel that attached follows the turn to its end");
	await first.text();
	assert.equal((await (await get(`/agent/sessions/${sessionId}`)).json()).active, undefined, "an ended turn is not active");
	const boardNow = async () => (await (await get(`/agent/main/${sessionId}/board`)).json()).tasks[0];
	const until = async want => { let task; for (let i = 0; i < 300; i++) { task = await boardNow(); if (task && want.includes(task.status)) return task; await wait(20); } return task; };
	await until(["running"]);
	for (let i = 0; i < 300 && taskPrompts.length < 2; i++) await wait(10);
	assert.ok(taskPrompts.every(prompt => /"id":"task\.requestScope"/.test(prompt)), "3 a task's action list carries task.requestScope");
	// The Studio reloads onto a new handle while the task waits on its model.
	handle = "handle-2";
	reloadGate.resolve();
	const paused = await until(["paused", "failed", "done"]);
	assert.equal(paused.status, "paused", JSON.stringify(paused));
	const reconnect = context => fetch(`${origin}/agent/main/${sessionId}/reconnect`, { method: "POST", headers: { "content-type": "application/json", origin, cookie }, body: JSON.stringify({ context }) });
	assert.equal((await reconnect({ ...read(), host: { ...read().host, workspaceHandle: "handle-1" } })).status, 409, "a handle the Studio does not answer on is refused");
	assert.equal((await fetch(`${origin}/agent/main/${sessionId}/reconnect`, { method: "POST", headers: { "content-type": "application/json", origin, cookie: "studio_owner=intruder" }, body: JSON.stringify({ context: read() }) })).status, 403);
	assert.equal((await reconnect(read())).status, 200);
	const ended = await until(["done", "failed", "incomplete"]);
	assert.equal(ended.status, "done", JSON.stringify(ended));
	assert.deepEqual(notes, ["resumed"], "the paused task resumed on the new handle without another message from the user");
	assert.equal(f.store.current.objects.find(o => o.id === cube).x, 1, "its edit before the reload stands");
	await handler.close?.(); await new Promise(resolve => server.close(resolve)); f.dispose();
	pass("4 a reload mid-turn: the session read names the running turn (attach replays it to its end), and the new handle reaches the board: a task paused on STALE_HANDLE resumes at once");
}
console.log(`${passed} passed`);
process.exit(0);
