#!/usr/bin/env node
// The motion tool of the Studio agent (bin/agent/motion-door.mjs): it answers the motion run's report and Missing line
// unchanged, passes the user's pictures only when asked and only those of the latest user turn, and rolls the turn back
// once when the Studio refused the install. turnMotionDoor runs against a local stand-in for CLIProxyAPI's model list.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createMotionDoor, turnMotionDoor } from "../../bin/agent/motion-door.mjs";
import { createTaskBoard } from "../../bin/agent/studio-tasks.mjs";
import { mainContextText } from "../../bin/agent/main-agent.mjs";

const DONE = { report: "She waves.\nMissing: the wave has no wrist.", missing: "the wave has no wrist.", frames: 72, clipSeconds: 3, tookSeconds: 31, compiles: 2, characterIds: ["c1"], objectIds: [], switched: [] };
const door = ({ run = async () => DONE, images = () => [] } = {}) => {
	const calls = { mark: 0, rollback: 0, runs: [] };
	const tool = createMotionDoor({ run: async args => { calls.runs.push(args); return run(args); }, mark: async () => { calls.mark++; return null; }, rollback: async () => { calls.rollback++; return null; }, images });
	return { tool, calls };
};
// A plain turn's door answers started and its motion_result answers the motion (verify-motion-background.mjs); a task's answers at once.
const call = async (tool, args) => {
	const answer = await tool.handler(args);
	return answer?.started ? tool.with([]).find(next => next.name === "motion_result").handler() : answer;
};

// the answer is the run's, unchanged
{
	const { tool, calls } = door({ run: async ({ onCompile }) => { onCompile({ n: 1, ok: false, line: "motion 1: problems" }); onCompile({ n: 2, ok: true, line: "motion 2: ok" }); return DONE; } });
	assert.equal(tool.name, "motion");
	assert.deepEqual(tool.parameters.required, [], "a call without request refits (motion-refit.mjs)");
	assert.match(tool.description, /The user's message of this turn reaches it by itself, as typed; request is your note:/, "request is the agent's note");
	const frames = [];
	const answer = await tool.handler({ request: "she waves" }, { toolCallId: "call-1", emit: frame => frames.push(frame) });
	assert.equal(answer.report, DONE.report);
	assert.equal(answer.missing, DONE.missing);
	assert.deepEqual({ ...answer }, { ok: true, report: DONE.report, missing: DONE.missing, frames: 72, clipSeconds: 3, tookSeconds: 31, compiles: 2, characters: ["c1"], objects: [], switched: [], used: null });
	assert.equal(calls.mark, 1);
	assert.equal(calls.runs[0].request, "she waves");
	assert.deepEqual(frames.map(f => [f.type, f.callId, f.index, f.status]), [["tool.progress", "call-1", 1, "failed"], ["tool.progress", "call-1", 2, "done"]]);
	console.log("PASS motion door: report and Missing line unchanged, one progress frame per compile");
}

// pictures only when asked
{
	const pictures = [{ data: "AAAA", mimeType: "image/png" }];
	const { tool, calls } = door({ images: () => pictures });
	await tool.handler({ request: "like this", images: true });
	await tool.handler({ request: "like this" });
	assert.deepEqual(calls.runs.map(r => r.images), [pictures, []]);
	console.log("PASS motion door: images true passes the stored pictures, absent passes none");
}

// a studio refusal rolls back once; other failures do not
{
	const { tool, calls } = door({ run: async () => { throw Object.assign(new Error("refused"), { code: "studio" }); } });
	await assert.rejects(tool.handler({ request: "x" }), error => error.code === "studio");
	assert.equal(calls.rollback, 1);
	const upstream = door({ run: async () => { throw Object.assign(new Error("proxy down"), { code: "upstream" }); } });
	await assert.rejects(upstream.tool.handler({ request: "x" }), error => error.code === "upstream");
	assert.equal(upstream.calls.rollback, 0);
	console.log("PASS motion door: a studio failure calls rollback once");
}

// turnMotionDoor: the pictures of an earlier turn do not go with a later request
{
	const proxy = createServer((req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ data: [{ id: "claude-opus-5-5" }] })); });
	proxy.listen(0, "127.0.0.1"); await once(proxy, "listening");
	const env = { CLIPROXY_BASE_URL: `http://127.0.0.1:${proxy.address().port}`, CLIPROXY_API_KEY: "test" };
	const seen = [];
	const deps = {
		studioScene: () => ({ scene: { characters: [], props: [], others: [] }, ids: { characters: {}, props: {}, switch: [] } }),
		runScene: async options => { seen.push(options.images); return { wallMs: 0, compiles: 0, report: "Nothing to do.\nMissing: everything.", missing: "everything.", final: null }; },
		readClip: () => null, installClip: async () => ({ ok: true }),
	};
	const turn = (extra = {}) => turnMotionDoor({ value: { sessionId: "conv-1", context: { host: { workspaceHandle: "ws" } }, ...extra }, env, hub: { command: async () => ({}) },
		tools: { internal: { invoke: async () => ({}) } }, transaction: { mark: async () => null, rollback: async () => null }, signal: new AbortController().signal, deps });
	try {
		const first = await turn({ attachments: [{ dataUrl: "data:image/png;base64,QUJD", name: "pose.png" }] });
		assert.ok(first, "the door is there while the proxy lists the motion writer's model");
		await call(first, { request: "like the picture", images: true });
		const task = await turn({ sessionId: "task-session", task: { parentId: "conv-1" } });
		await task.handler({ request: "like the picture", images: true });
		const later = await turn();
		await call(later, { request: "now jump", images: true });
		assert.deepEqual(seen, [[{ data: "QUJD", mimeType: "image/png" }], [{ data: "QUJD", mimeType: "image/png" }], []], "a task reads its main session's pictures; a later turn without pictures passes none");
		assert.equal(await turn({ main: {} }), null, "the coordinator gets no motion tool");
		assert.equal(await turnMotionDoor({ value: { sessionId: "x", context: { host: {} } }, env: { ...env, COZYCLAY_MOTION_ENGINE: "old" } }), null, "nor the old engine");
	} finally { proxy.close(); }
	console.log("PASS turnMotionDoor: pictures of an earlier turn are not passed after a turn without pictures");
}

// A plain turn: the user's message of the turn reaches the motion writer verbatim on every call of the turn, next to
// the agent's request as its note; a task run's door hands on the words its task carries.
const WORDS = "then he sits down on the floor  \n(그리고 바닥에 앉아)";
const USER = "USER'S WORDS (the user's message of this turn, exactly as typed):\n", NOTE = "STUDIO AGENT'S NOTE (the Studio agent's own text: which characters and objects, what to keep):\n";
const TASK_USER = "USER'S WORDS (the user's last message to the Studio, exactly as typed; this task may do only part of it):\n";
// with a note (the Studio agent called), the writer hears that its props become stand-ins the agent dresses after it
// ADDED_BEFORE: the line as it was before a body could have a scale and a tint; it is still the line while that step is off
const ADDED_BEFORE = "What your scene adds becomes Studio content: a new character a figure, a new prop a plain object named by its id, at the place, size and turn you give. After you, the Studio agent gives your props a look over the same box and adds what the body does not touch (background, light, camera); it keeps their place, size and turn.";
// PLAIN: said while the kinds step is on (a new prop is never an object of another kind); with it off the line is as before
const PLAIN = " A new prop is only ever a plain box, ball or line, never an object of another kind: when the request needs one the scene does not list with its kind, say so in the Missing line.";
const ADDED = ADDED_BEFORE.replace(" After you,", `${PLAIN} A character's scale and tint are the Studio character's own scale and tint: the ones your scene gives are set on it, one it leaves out stays as the Studio has it. After you,`);
const recordingDeps = requests => ({
	studioScene: () => ({ scene: { characters: [], props: [], others: [] }, ids: { characters: {}, props: {}, switch: [] } }),
	runScene: async options => { requests.push(options.request); return { wallMs: 0, compiles: 0, report: "Done.\nMissing: none", missing: "none", final: null }; },
	readClip: () => null, installClip: async () => ({ ok: true }),
});
const proxyEnv = async () => {
	const proxy = createServer((req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ data: [{ id: "claude-opus-5-5" }] })); });
	proxy.listen(0, "127.0.0.1"); await once(proxy, "listening");
	return { proxy, env: { CLIPROXY_BASE_URL: `http://127.0.0.1:${proxy.address().port}`, CLIPROXY_API_KEY: "test" } };
};
const turnOf = (value, env, deps) => turnMotionDoor({ value: { context: { host: { workspaceHandle: "ws" } }, ...value }, env, hub: { command: async () => ({}) },
	tools: { internal: { invoke: async () => ({}) } }, transaction: { mark: async () => null, rollback: async () => null }, signal: new AbortController().signal, deps });
{
	const { proxy, env } = await proxyEnv(), requests = [];
	try {
		const door = await turnOf({ sessionId: "plain-1", text: WORDS }, env, recordingDeps(requests));
		await call(door, { request: "Keep the existing take as it is. Then, after the wave, he sits down on the floor." });
		await call(door, { request: "c1 sits on the floor; install it as c1's take." });
		assert.equal(requests[0], `${USER}${WORDS}\n\n${NOTE}Keep the existing take as it is. Then, after the wave, he sits down on the floor.\n\n${ADDED}`, "an empty scene adds only the line on what becomes of what the writer adds");
		assert.equal(requests[1], `${USER}${WORDS}\n\n${NOTE}c1 sits on the floor; install it as c1's take.\n\n${ADDED}`, "a repeat call: the same words, the agent's new note");
		const before = [], off = await turnOf({ sessionId: "plain-off", text: WORDS }, { ...env, COZYCLAY_MOTION_OFF: "body,kinds" }, recordingDeps(before));
		await call(off, { request: "c1 sits." });
		assert.equal(before[0], `${USER}${WORDS}\n\n${NOTE}c1 sits.\n\n${ADDED_BEFORE}`, "with the body and kinds steps off the request is the one of before, byte for byte");
		const task = await turnOf({ sessionId: "task-1", text: "the coordinator's task text", task: { parentId: "plain-1", words: WORDS } }, env, recordingDeps(requests));
		await task.handler({ request: "c1 sits." });
		assert.ok(requests[2].startsWith(`${TASK_USER}${WORDS}\n\n${NOTE}c1 sits.\n\n`), requests[2]);
		assert.ok(!requests[2].includes("the coordinator's task text"), "a task's words are the user's, not its task text");
	} finally { proxy.close(); }
	console.log("PASS turnMotionDoor: the turn's user message reaches runScene verbatim on every call, the agent's request as its note");
}

// Tasks mode end to end (studio-task-routes.mjs): each coordinator turn's user message is kept on the tasks it
// dispatches, and the task run's motion tool hands it to runScene verbatim; a later message does not change an earlier task's.
{
	const { proxy, env } = await proxyEnv(), requests = [], taskTexts = [];
	const { createStudioTaskRoutes } = await import("../../bin/agent/studio-task-routes.mjs");
	const studioSessions = new Map([["main-1", { owner: "o" }]]);
	let dispatched = 0;
	const handleStudioTurn = async (req, res, value) => {
		if (value.main) {
			if (value.hidden) return true;
			const tools = value.main.tools({ studio: [{ name: "inspect_studio", handler: async () => ({}) }], hub: { command: async () => ({}) }, admission: { host: {}, revision: 1 } });
			await tools.find(tool => tool.name === "dispatch_task").handler({ title: `sit ${++dispatched}`, instructions: `The agent's own task text ${dispatched}: c1 sits.`, scope: ["stage"] });
			return true;
		}
		taskTexts.push(value.text);
		const door = await turnOf(value, env, recordingDeps(requests));
		await door.handler({ request: `note for ${value.task.title}` });
		await door.handler({ request: `second note for ${value.task.title}` });
		return true;
	};
	const route = createStudioTaskRoutes({ enabled: () => true, handleStudioTurn, studioSessions, studioOwnerTokens: new Map(), studioEvents: new Map(), emitStudioEvent: () => {}, writeStudioStream: () => {},
		newRecord: () => ({ events: [] }), readContext: async host => ({ host }), inspect: null, parseCookies: () => ({ studio_owner: "o" }), json: () => {}, readBody: async req => req.body, validateEnvelope: async body => body,
		limits: { staggerMs: 0 }, eventTurnDelayMs: 60_000 });
	const turn = text => route({ method: "POST", headers: {}, body: { surface: "studio", sessionId: "main-1", turnId: `t-${text.length}`, text, context: { host: { sceneId: "s1", workspaceHandle: "ws", documentEpoch: 1 } } } }, null, "/agent/main");
	const LATER = "now make her wave too";
	try {
		await turn(WORDS);
		for (let i = 0; i < 100 && requests.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 10));
		await turn(LATER);
		for (let i = 0; i < 100 && requests.length < 4; i++) await new Promise(resolve => setTimeout(resolve, 10));
		assert.equal(requests.length, 4, "two tasks, two motion calls each");
		assert.ok(taskTexts.every(text => !text.includes(WORDS) && !text.includes(LATER)), "the task's own text does not carry the user's message");
		assert.ok(requests[0].startsWith(`${TASK_USER}${WORDS}\n\n${NOTE}note for sit 1\n\n`), requests[0]);
		assert.ok(requests[1].startsWith(`${TASK_USER}${WORDS}\n\n${NOTE}second note for sit 1\n\n`), requests[1]);
		assert.ok(requests[2].startsWith(`${TASK_USER}${LATER}\n\n${NOTE}note for sit 2\n\n`), requests[2]);
		assert.ok(requests[3].startsWith(`${TASK_USER}${LATER}\n\n${NOTE}second note for sit 2\n\n`), requests[3]);
	} finally { proxy.close(); }
	console.log("PASS Tasks mode: a task's motion calls carry the user's message of the coordinator turn that dispatched it, verbatim");
}

// a task whose run called the motion tool: its Missing text reaches the coordinator under a fixed label
{
	const events = [];
	const board = createTaskBoard({ limits: { staggerMs: 0 }, emit: event => events.push(event), run: async () => ({ status: "done", reply: "The motion is in.", receipts: [], missing: "the hands do not hold the table edge." }) });
	const { taskId } = board.dispatch({ title: "lean", instructions: "he leans on the table", scope: ["stage"] });
	for (let i = 0; i < 50 && board.board().find(t => t.taskId === taskId)?.status !== "done"; i++) await new Promise(resolve => setTimeout(resolve, 10));
	const task = board.board().find(t => t.taskId === taskId);
	assert.equal(task.summary.missing, "Missing: the hands do not hold the table edge.");
	assert.ok(mainContextText(board, events).includes("\"missing\":\"Missing: the hands do not hold the table edge.\""), "the coordinator's context carries it");
	console.log("PASS a task's done summary carries the motion tool's Missing line for the coordinator");
}

// the motion task's used line reaches its summary; an empty scope is a task that only makes new things
{
	const gate = {};
	assert.throws(() => createTaskBoard({}).dispatch({ title: "plain", instructions: "do it", scope: [] }), /scope: one or more keys/, "without createOnly a task needs a key");
	const board = createTaskBoard({ limits: { staggerMs: 0 }, createOnly: true, run: async task => {
		if (task.title === "dress") await new Promise(resolve => { gate.open = resolve; });
		return { status: "done", reply: `${task.title} done.`, receipts: [], ...(task.title === "motion" ? { missing: "none", used: "The motion uses these objects as boxes (sculpt: 1 x 0.45 x 0.4, [0, 0, 1])." } : {}) };
	} });
	const plan = board.dispatchPlan({ tasks: [{ ref: "m", title: "motion", instructions: "she sits", scope: [] }, { ref: "light", title: "light", instructions: "evening light", scope: ["stage"] }, { ref: "d", title: "dress", instructions: "a bench look", scope: [], dependsOn: ["m"] }] });
	assert.equal(plan.tasks.length, 3);
	const byTitle = title => board.board().find(t => t.title === title);
	for (let i = 0; i < 100 && !gate.open; i++) await new Promise(resolve => setTimeout(resolve, 10));
	assert.equal(byTitle("motion").summary.used, "The motion uses these objects as boxes (sculpt: 1 x 0.45 x 0.4, [0, 0, 1]).");
	gate.open();
	for (let i = 0; i < 100 && byTitle("dress").status !== "done"; i++) await new Promise(resolve => setTimeout(resolve, 10));
	assert.deepEqual(board.board().map(t => [t.title, t.status]).sort(), [["dress", "done"], ["light", "done"], ["motion", "done"]]);
	console.log("PASS the motion task's used line and empty scopes");
}

// verify on a task that ran the motion tool: its report is the review, so it ends done and its dependents start at once;
// verify on any other task still ends in review
{
	const reply = { motion: "She sits.\nUnmet criteria: a true running pace", set: "A room.", dress: "A bench.", plain: "Done.\nUnmet criteria: the lamp is missing" };
	const board = createTaskBoard({ limits: { staggerMs: 0 }, createOnly: true, run: async task => ({ status: "done", reply: reply[task.title], receipts: [], ...(task.title === "motion" ? { missing: "a true running pace", used: null } : {}) }) });
	board.dispatchPlan({ tasks: [{ ref: "m", title: "motion", instructions: "she sits", scope: [], verify: true }, { ref: "set", title: "set", instructions: "a room", scope: [], verify: true }, { ref: "d", title: "dress", instructions: "a bench look", scope: [], dependsOn: ["m"] }, { ref: "p", title: "plain", instructions: "a lamp", scope: [] }] });
	const task = title => board.board().find(t => t.title === title);
	for (let i = 0; i < 100 && task("dress")?.status !== "done"; i++) await new Promise(resolve => setTimeout(resolve, 10));
	assert.deepEqual(["motion", "set", "dress", "plain"].map(title => task(title).status), ["done", "review", "done", "incomplete"]);
	assert.equal(task("motion").reason, "criteria unmet: a true running pace", "what it could not do stays in its reason");
	assert.equal(task("motion").summary.missing, "Missing: a true running pace");
	console.log("PASS a motion task ends done on the motion tool's report, with verify or an unmet line; its dependents start without an accept");
}

// a call without request is the refit (motion-refit.mjs): no motion run, under a mark, rolled back when the Studio refused a step
{
	for (const background of [false, true]) {
		const calls = { mark: 0, rollback: 0, runs: 0, refits: 0 };
		let refuse = false;
		const tool = createMotionDoor({ background, run: async () => { calls.runs++; return DONE; }, mark: async () => { calls.mark++; return null; }, rollback: async () => { calls.rollback++; return null; },
			refit: async () => { calls.refits++; if (refuse) throw Object.assign(new Error("refused"), { code: "studio" }); return { ok: true, refit: [], kept: [], skipped: [] }; } });
		assert.deepEqual(await tool.handler({}), { ok: true, refit: [], kept: [], skipped: [] });
		assert.deepEqual(await tool.handler({ images: true }), { ok: true, refit: [], kept: [], skipped: [] }, "no request: the refit, whatever else is sent");
		refuse = true;
		await assert.rejects(tool.handler({}), error => error.code === "studio");
		assert.deepEqual(calls, { mark: 3, rollback: 1, runs: 0, refits: 3 }, `background ${background}: no motion run, a mark per refit, one rollback`);
		assert.match(tool.description, /Called without request, it writes nothing and uses no model/);
	}
	console.log("PASS a call without request refits: no motion writer, under the turn's mark, rolled back when refused");
}

// while this turn's motion is still being written, a call without request is refused and nothing is refit; after its result, it runs
{
	let end, refits = 0;
	const tool = createMotionDoor({ background: true, mark: async () => null, rollback: async () => null,
		run: ({ onScene }) => { onScene({ characters: { c1: "c1" }, props: {} }); return new Promise(resolve => { end = () => resolve(DONE); }); },
		refit: async () => { refits++; return { ok: true, refit: [], kept: [], skipped: [] }; } });
	assert.deepEqual(await tool.handler({ request: "she waves" }), { ok: true, started: true });
	await assert.rejects(tool.handler({}), error => error.code === "MOTION_RUNNING" && /a refit is another motion call after that/.test(error.message));
	assert.equal(refits, 0);
	end();
	const result = tool.with([]).find(entry => entry.name === "motion_result");
	assert.equal((await result.handler()).ok, true);
	assert.deepEqual(await tool.handler({}), { ok: true, refit: [], kept: [], skipped: [] });
	assert.equal(refits, 1);
	assert.match(tool.description, /In this turn a call with a request answers started .* Called without request, it writes nothing/s, "the refit is said after what a call with a request answers");
	console.log("PASS a refit waits for this turn's motion: refused while it is written, run after its result");
}
