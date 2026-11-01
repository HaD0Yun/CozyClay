#!/usr/bin/env node
// Parallel Studio tasks, P2 (the server). The plan's cases that live in the server, by number:
//   (a) the board (bin/agent/studio-tasks.mjs) with a scripted run: 11 at most three run and the rest wait, the
//       longest chain first with aging,
//       1 a held scope waits, 8 dependsOn waits and hears the summary (a failed dependency fails it), and a plan queues a
//       whole graph at once (refs, cycles refused all or nothing), 12 the second
//       start waits for the first model answer or STAGGER, 13 cost per task, 14 a lost Studio pauses and resumes on the
//       same scene (another scene fails it), 16 summaries are capped, 19 the same work is not started twice, 20 a task
//       past its tool or time limit is stopped and reported; cancel of a queued and of a running task;
//   (b) the main agent's words: 15 a reply that calls an unfinished task done is corrected, 17 in the user's language;
//       the task header and the board in the main agent's context;
//   (c) the routes with a scripted model and the real bus (the shipped binding): POST /agent/main answers at once while
//       two tasks edit two objects of one scene in their own scopes, the board ends with both done, the main agent
//       reports on its own when they end, a quick_edit lands inside a one-command task, and the task sessions are kept
//       with their parent's id and left out of the session list;
//   (d) a Studio reload (case 14 with the coordinator's rule): a task paused by a lost Studio resumes when the scope
//       reads as it left it; when it does not (autosave missed the task's newest edit), the task is told to re-read its
//       scope and the main agent hears task.sceneChanged; a task lost mid-command (UNCERTAIN_APPLY) on a changed scope
//       fails with that reason.
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createTaskBoard, taskHeader, TASK_LIMITS } from "../bin/agent/studio-tasks.mjs";
import { doneClaimCorrection, mainContextText } from "../bin/agent/main-agent.mjs";

const sessionDir = mkdtempSync(join(tmpdir(), "cozyclay-studio-tasks-"));
process.env.COZYCLAY_AGENT_SESSIONS_DIR = sessionDir;
process.on("exit", () => rmSync(sessionDir, { recursive: true, force: true }));
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

// --- (a) the board -------------------------------------------------------------------------------------------
function boardFixture(limits = {}) {
	let t = 1000;
	const timers = [], runs = [], events = [];
	const board = createTaskBoard({ limits: { staggerMs: 0, ...limits }, now: () => t, emit: event => events.push(event),
		setTimer: (fn, ms) => { const timer = { fn, at: t + ms }; timers.push(timer); return timer; }, clearTimer: timer => { const i = timers.indexOf(timer); if (i >= 0) timers.splice(i, 1); },
		run: (task, options) => { const run = { task, options, ...deferred() }; runs.push(run); return run.promise; } });
	const advance = ms => { t += ms; for (const timer of timers.filter(timer => timer.at <= t)) { timers.splice(timers.indexOf(timer), 1); timer.fn(); } };
	const status = () => Object.fromEntries(board.board().map(task => [task.title, task.status]));
	return { board, runs, events, advance, status, timers };
}
const dispatch = (board, title, scope, extra = {}) => board.dispatch({ title, instructions: `do ${title}`, scope, ...extra });

{
	const { board, runs, status } = boardFixture();
	for (const [title, key] of [["a", "object:a"], ["b", "object:b"], ["c", "object:c"], ["d", "object:d"]]) dispatch(board, title, [key]);
	await tick();
	assert.equal(runs.length, 3, "case 11: three tasks run");
	assert.equal(status().d, "waiting");
	assert.match(board.board().find(task => task.title === "d").reason, /3 tasks are running/);
	runs[0].task.onFrame({ type: "text.delta", text: "x" });
	assert.equal(status().a, "running");
	runs[0].resolve({ status: "done", reply: "a moved", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.25, requests: 2 } });
	await tick(); await tick();
	assert.equal(status().a, "done"); assert.equal(runs.length, 4, "the waiting task starts when one ends"); assert.equal(runs[3].task.title, "d");
	assert.equal(board.board().find(task => task.title === "a").usage.cost, 0.25, "case 13: cost per task");
	console.log("PASS cases 11 and 13: three run at once, the fourth waits in order and starts when one ends; usage and cost per task");
}
{
	// case 11, the order among ready tasks: the longest chain still to come first, equal chains in the order they came,
	// and a task that waited AGING ms per level is not starved by later chains.
	const { board, runs } = boardFixture({ cap: 1, agingMs: 60_000 });
	const next = async () => { runs.at(-1).resolve({ status: "done" }); await tick(); await tick(); return runs.at(-1).task.title; };
	dispatch(board, "busy", ["object:busy"]); await tick();
	dispatch(board, "lone", ["object:lone"]);
	const head = dispatch(board, "head", ["object:h"]), mid = dispatch(board, "mid", ["object:m"], { dependsOn: [head.taskId] });
	dispatch(board, "tail", ["object:t"], { dependsOn: [mid.taskId] });
	dispatch(board, "pair", ["object:p"]); dispatch(board, "pair end", ["object:pe"], { dependsOn: [board.board().at(-1).taskId] });
	assert.equal(await next(), "head", "the chain of three starts first, though lone came before it");
	assert.equal(await next(), "mid", "mid now heads a chain of two, as does pair: mid came first");
	assert.equal(await next(), "pair", "pair (chain two) before lone (one) and tail (one)");
	assert.equal(await next(), "lone", "equal chains in the order they came");
	assert.deepEqual([await next(), await next()], ["tail", "pair end"]);
	const aged = boardFixture({ cap: 1, agingMs: 60_000 });
	dispatch(aged.board, "busy", ["object:busy"]); await tick();
	dispatch(aged.board, "old", ["object:old"]);
	aged.advance(2 * 60_000);
	const a = dispatch(aged.board, "chain a", ["object:a"]); dispatch(aged.board, "chain b", ["object:b"], { dependsOn: [a.taskId] });
	aged.runs[0].resolve({ status: "done" }); await tick(); await tick();
	assert.equal(aged.runs.at(-1).task.title, "old", "two minutes of waiting outweigh a chain of two");
	console.log("PASS case 11 order: critical path first among ready tasks, then arrival order; aging keeps an independent task from starving");
}
{
	const { board, runs, status } = boardFixture();
	dispatch(board, "first", ["object:cube"]); dispatch(board, "second", ["object:cube", "object:sphere"]); dispatch(board, "time", ["timeline"]);
	await tick();
	assert.equal(runs.length, 1);
	assert.match(board.board().find(task => task.title === "second").reason, /object:cube is held by task/, "case 1: a held key waits");
	assert.equal(status().time, "waiting", "the timeline key runs alone");
	runs[0].resolve({ status: "done" }); await tick(); await tick();
	assert.equal(runs.length, 2); assert.equal(runs[1].task.title, "second");
	runs[1].resolve({ status: "scopeBusy", error: { message: "object:sphere is held by task x" } }); await tick(); await tick();
	assert.equal(runs.length, 3, "a begin the bus refused waits and is tried again; the timeline task starts once nothing else runs");
	console.log("PASS case 1: a task whose scope is held waits; timeline runs alone; a bus refusal at begin waits and retries");
}
{
	const { board, runs, status } = boardFixture();
	const a = dispatch(board, "make cup", ["object:cup"]);
	const b = dispatch(board, "grab cup", ["character:alex"], { dependsOn: [a.taskId] });
	await tick();
	assert.equal(runs.length, 1); assert.match(board.board().find(task => task.title === "grab cup").reason, /waits for task/);
	runs[0].resolve({ status: "done", reply: "Cup made: cylinder-3." }); await tick(); await tick();
	assert.equal(runs.length, 2);
	assert.deepEqual(runs[1].options.deps, [{ taskId: a.taskId, title: "make cup", summary: { reply: "Cup made: cylinder-3.", receipts: [] }, changed: [] }], "case 8: it hears the earlier summary");
	assert.match(taskHeader(runs[1].task, { deps: runs[1].options.deps }), /Earlier task .* is done: Cup made: cylinder-3\./);
	const c = dispatch(board, "x", ["object:x"]), d = dispatch(board, "y", ["object:y"], { dependsOn: [c.taskId] });
	await tick();
	runs[2].resolve({ status: "failed", error: { message: "boom" } }); await tick(); await tick();
	assert.equal(status().y, "failed"); assert.match(board.board().find(task => task.taskId === d.taskId).reason, /depends on task .* which failed/);
	assert.equal(b.status, "waiting", "dispatch answers the task as the board sees it");
	console.log("PASS case 8: a dependent task waits, hears the summary of what it depends on, and fails when that failed");
}
{
	// case 8, the handoff as data: what a done task changed, from every receipt (not only the capped ones), deduped and
	// capped; an id its scope names reads as that key, an id it made as itself.
	const { board, runs } = boardFixture({ changed: 4 });
	const a = dispatch(board, "set table", ["object:table", "character:alex"]);
	dispatch(board, "frame it", ["shot:s1"], { dependsOn: [a.taskId] });
	await tick();
	const receipts = [{ receiptId: "r1", affectedIds: ["table", "cup-9"] }, ...Array.from({ length: 10 }, (_, i) => ({ receiptId: `n${i}`, affectedIds: [] })), { receiptId: "r2", affectedIds: ["table", "alex", "plate-2", "fork-1"] }];
	runs[0].resolve({ status: "done", reply: "Table set.", receipts }); await tick(); await tick();
	const done = board.board().find(task => task.title === "set table");
	assert.deepEqual(done.changed, ["object:table", "cup-9", "character:alex", "plate-2"], "deduped, keyed where the scope names it, capped");
	assert.equal(done.summary.receipts.length, TASK_LIMITS.receipts, "the summary keeps its own cap");
	assert.deepEqual(runs[1].options.deps.map(dep => Object.keys(dep)), [["taskId", "title", "summary", "changed"]]);
	assert.deepEqual(runs[1].options.deps[0].changed, done.changed);
	assert.match(taskHeader(runs[1].task, { deps: runs[1].options.deps }), /is done: Table set\. It changed: object:table, cup-9, character:alex, plate-2\./);
	const failed = dispatch(board, "bad", ["object:q"]); await tick();
	runs[2].resolve({ status: "failed", receipts: [{ receiptId: "r3", affectedIds: ["q"] }], error: { message: "x" } }); await tick(); await tick();
	assert.equal(board.board().find(task => task.taskId === failed.taskId).changed, undefined, "only a done task hands off what it changed");
	console.log("PASS case 8 handoff: a done task records what it changed as data and its dependents receive it with the summary");
}
{
	// case 8 with a checkpoint: verify ends the run in review; it frees its scope, its dependents wait for accept or
	// fail on reject; without verify nothing changes.
	const { board, runs, events, status } = boardFixture();
	const a = dispatch(board, "make cup", ["object:cup"], { verify: true });
	dispatch(board, "grab cup", ["character:alex"], { dependsOn: [a.taskId] });
	dispatch(board, "paint cup", ["object:cup"]);
	await tick();
	assert.equal(status()["paint cup"], "waiting", "the cup is held while the run runs");
	runs[0].resolve({ status: "done", reply: "Cup made.", receipts: [{ receiptId: "r1", affectedIds: ["cup"] }] }); await tick(); await tick();
	assert.equal(status()["make cup"], "review"); assert.ok(events.some(event => event.type === "task.review" && event.taskId === a.taskId && event.verify), "task.review is told");
	assert.equal(status()["paint cup"], "starting", "a task in review holds no scope");
	assert.equal(status()["grab cup"], "waiting"); assert.match(board.board().find(task => task.title === "grab cup").reason, /to be accepted/, "but counts as not done for dependsOn");
	assert.equal(board.cancel(a.taskId), null, "review is not cancelled: it is accepted or rejected");
	assert.equal(dispatch(board, "make cup", ["object:cup"]).duplicateOf, a.taskId, "nor dispatched again");
	assert.equal(board.accept(a.taskId).status, "done"); await tick();
	assert.equal(status()["grab cup"], "starting", "accept releases its dependents");
	assert.deepEqual(runs.at(-1).options.deps[0].changed, ["object:cup"]);
	assert.equal(board.accept(a.taskId), null, "only a task in review is accepted");
	const b = dispatch(board, "pose", ["character:sam"], { verify: true }), c = dispatch(board, "walk", ["character:sam"], { dependsOn: [b.taskId] });
	await tick();
	runs.find(run => run.task.taskId === b.taskId).resolve({ status: "done", reply: "Posed." }); await tick(); await tick();
	assert.equal(board.reject(b.taskId, "the arm goes through the wall").status, "failed"); await tick();
	assert.match(board.get(b.taskId).reason, /rejected by the coordinator: the arm goes through the wall/);
	assert.equal(board.get(c.taskId).status, "failed", "reject fails the dependents as any failure does");
	const plain = dispatch(board, "plain", ["object:p"]); await tick();
	runs.find(run => run.task.taskId === plain.taskId).resolve({ status: "done" }); await tick(); await tick();
	assert.equal(board.get(plain.taskId).status, "done", "without verify a task ends done");
	const p = board.dispatchPlan({ tasks: [{ ref: "x", title: "x", instructions: "do x", scope: ["object:x"], verify: true }] });
	assert.equal(p.tasks[0].verify, true, "a plan step takes verify");
	console.log("PASS case 8 with a checkpoint: a verify task ends in review, frees its scope, and its dependents start on accept or fail on reject");
}
{
	// case 8 as a plan: one call queues a graph, refs resolve to the new taskIds, and a bad plan queues nothing.
	const { board, runs, events, status } = boardFixture();
	const before = dispatch(board, "base", ["object:base"]);
	const step = (ref, scope, dependsOn) => ({ ref, title: ref, instructions: `do ${ref}`, scope: [scope], ...(dependsOn ? { dependsOn } : {}) });
	const refused = [
		[{ tasks: [step("a", "object:a", ["b"]), step("b", "object:b", ["a"])] }, /cycle: a -> b -> a/],
		[{ tasks: [step("a", "object:a", ["a"])] }, /cycle/],
		[{ tasks: [step("a", "object:a", ["ghost"])] }, /no ref or task ghost/],
		[{ tasks: [step("a", "object:a"), step("a", "object:b")] }, /used twice/],
		[{ tasks: [step("a", "object:a"), { ref: "b", title: "b", instructions: "x", scope: ["cylinder"] }] }, /scope/],
		[{ tasks: [] }, /one or more/],
	];
	const queued = events.length;
	for (const [plan, message] of refused) assert.throws(() => board.dispatchPlan(plan), error => error.code === "INVALID_ARGUMENT" && message.test(error.message));
	assert.equal(events.length, queued, "a refused plan queues nothing (all or nothing)");
	// Listed out of order: grab names cup by ref, frame names grab by ref and the earlier task by its taskId.
	const plan = board.dispatchPlan({ tasks: [step("frame", "shot:s1", ["grab", before.taskId]), step("grab", "character:alex", ["cup"]), step("cup", "object:cup")] });
	const by = Object.fromEntries(plan.tasks.map(task => [task.ref, task]));
	assert.deepEqual(plan.tasks.map(task => task.ref), ["frame", "grab", "cup"], "answered in the plan's order");
	assert.deepEqual(board.get(by.grab.taskId).dependsOn, [by.cup.taskId], "a ref resolves to the taskId it was given");
	assert.deepEqual(board.get(by.frame.taskId).dependsOn, [by.grab.taskId, before.taskId], "an earlier taskId passes through");
	assert.equal(by.cup.status, "starting", "the answer is the board after scheduling"); assert.equal(by.grab.status, "waiting");
	await tick();
	assert.deepEqual(runs.map(run => run.task.title), ["base", "cup"]);
	runs[1].resolve({ status: "done", reply: "Cup made." }); await tick(); await tick();
	assert.equal(status().grab, "starting");
	const again = board.dispatchPlan({ tasks: [{ ...step("cup2", "object:cup"), instructions: "do grab", scope: ["character:alex"] }, step("after", "object:z", ["cup2"])] });
	assert.equal(again.tasks[0].duplicateOf, by.grab.taskId, "a duplicate step answers the equal task");
	assert.deepEqual(board.get(again.tasks[1].taskId).dependsOn, [by.grab.taskId], "and refs to it resolve to that task");
	console.log("PASS case 8 as a plan: one dispatch_plan queues a graph, refs resolve to taskIds, a cycle or unknown ref refuses all of it");
}
{
	// Timing per task: when it was queued, started and ended, and how long it waited on a held scope, its dependencies
	// and the cap; live in the board view, final in the ended event, and kept out of the main agent's context.
	// busyMaxMs 0: a SCOPE_BUSY retry comes at once here (the backoff has its own case below)
	const { board, runs, events, advance } = boardFixture({ cap: 2, busyMaxMs: 0 });
	const a = dispatch(board, "a", ["object:a"]); dispatch(board, "b", ["object:b"]);
	const c = dispatch(board, "c", ["object:c"]), d = dispatch(board, "d", ["object:d"], { dependsOn: [a.taskId] }), e = dispatch(board, "e", ["object:a"]);
	await tick();
	advance(1000);
	assert.deepEqual(board.board().find(task => task.taskId === c.taskId).timing, { queuedAt: 1000, waitScopeMs: 0, waitDepsMs: 0, waitCapMs: 1000 }, "an open wait counts up to now");
	runs[1].resolve({ status: "done" }); await tick(); await tick();
	advance(500);
	runs[0].resolve({ status: "done" }); await tick(); await tick();
	const timing = id => board.board().find(task => task.taskId === id).timing;
	assert.deepEqual(timing(a.taskId), { queuedAt: 1000, startedAt: 1000, endedAt: 2500, waitScopeMs: 0, waitDepsMs: 0, waitCapMs: 0 });
	assert.equal(timing(c.taskId).waitCapMs, 1000, "c waited on the cap until b ended"); assert.equal(timing(c.taskId).startedAt, 2000);
	assert.equal(timing(d.taskId).waitDepsMs, 1500, "d waited on a"); assert.equal(timing(e.taskId).waitScopeMs, 1500, "e waited on a's object");
	// A begin the bus refused (scopeBusy) waits on scope; here d holds the cap's other slot, so it waits on the cap next.
	assert.equal(runs[2].task.taskId, c.taskId);
	runs[2].resolve({ status: "scopeBusy", error: { message: "object:c is held by task x" } }); await tick(); await tick();
	assert.equal(board.get(c.taskId).status, "starting", "retried at once: nothing on the board holds object:c");
	advance(250);
	runs.findLast(run => run.task.taskId === c.taskId).resolve({ status: "done" }); await tick(); await tick();
	const ended = events.findLast(event => event.type === "task.done" && event.taskId === c.taskId);
	assert.deepEqual(ended.timing, { queuedAt: 1000, startedAt: 2000, endedAt: 2750, waitScopeMs: 0, waitDepsMs: 0, waitCapMs: 1000 }, "the ended event carries the final timing");
	assert.equal(timing(e.taskId).waitCapMs, 250, "e waited on a's object, then on the cap");
	assert.ok(!mainContextText(board, events).includes("waitCapMs"), "timing stays out of the main agent's context");
	console.log("PASS timing: each task records queued, started and ended at and its scope, dependency and cap waits; in the view and the ended event");
}
{
	// A holder the board does not see (an editor-side task its run left open): SCOPE_BUSY retries back off 1, 2, 4 .. 15 s,
	// told once (one started, one waiting per reason), and the main agent's context stays small whatever the events.
	const { board, runs, events, advance } = boardFixture();
	const x = dispatch(board, "x", ["character:alex"]);
	await tick();
	const busy = { status: "scopeBusy", error: { message: "character:alex:placement is held by task gone" } };
	let attempts = 0;
	for (let i = 0; i < 40; i++) {
		const run = runs.findLast(r => r.task.taskId === x.taskId);
		if (run && !run.settled) { run.task.onFrame?.({ type: "tool.start" }); run.settled = true; run.resolve(busy); attempts++; await tick(); await tick(); }
		advance(1000); await tick();
	}
	const told = events.filter(e => e.taskId === x.taskId);
	assert.ok(attempts <= 8, `${attempts} attempts in 40 s, not one per tick`);
	assert.equal(told.filter(e => e.type === "task.started").length, 1, "started is told once");
	assert.equal(told.filter(e => e.type === "task.waiting").length, 1, "waiting is told once per reason");
	const flood = [];
	for (let i = 0; i < 3510; i++) flood.push({ type: "task.started", taskId: x.taskId, status: "running", usage: { input: 1 } }, { type: "task.waiting", taskId: x.taskId, status: "waiting", reason: busy.error.message, usage: { input: 1 } });
	flood.push({ type: "task.failed", taskId: "y", status: "failed", reason: "r".repeat(30_000) });
	const text = mainContextText(board, flood);
	assert.ok(text.length < 45_000, `${text.length} chars for 7021 events`);
	assert.ok(/"repeats":7020/.test(text) && !text.includes('"usage":{"input"'), "repeats fold into one line, usage dropped");
	console.log(`PASS SCOPE_BUSY backoff: ${attempts} attempts in 40 s, 1 started + 1 waiting told; 7021 events -> ${text.length} chars of context`);
}
{
	const { board, runs, advance } = boardFixture({ staggerMs: 1500 });
	dispatch(board, "a", ["object:a"]); dispatch(board, "b", ["object:b"]); dispatch(board, "c", ["object:c"]);
	await tick();
	assert.equal(runs.length, 1, "case 12: the second start waits for the first model answer");
	runs[0].task.onFrame({ type: "tool.start", callId: "1" }); await tick();
	assert.equal(runs.length, 2, "the first answered: the second starts");
	advance(1499); await tick();
	assert.equal(runs.length, 2);
	advance(1); await tick();
	assert.equal(runs.length, 3, "or STAGGER passed");
	console.log("PASS case 12: a later start waits until the earlier task's model answered or STAGGER ms passed");
}
{
	const { board, runs, status } = boardFixture();
	dispatch(board, "cube", ["object:cube"]); await tick();
	runs[0].resolve({ status: "lost", sceneId: "scene-main" }); await tick(); await tick();
	assert.equal(status().cube, "paused", "case 14: a lost Studio pauses the task");
	board.reconnect("scene-main"); await tick();
	assert.equal(runs.length, 2); assert.match(runs[1].options.resume.note, /Studio reconnected/);
	runs[1].resolve({ status: "lost", sceneId: "scene-main" }); await tick(); await tick();
	board.reconnect("scene-other");
	assert.equal(status().cube, "failed"); assert.match(board.board()[0].reason, /another scene/);
	console.log("PASS case 14: a run whose Studio went away pauses, resumes on the same scene, and fails on another");
}
{
	const { board, runs } = boardFixture();
	dispatch(board, "long", ["object:a"]); await tick();
	runs[0].resolve({ status: "done", reply: "x".repeat(5000), receipts: Array.from({ length: 20 }, (_, i) => ({ receiptId: `r${i}` })) }); await tick(); await tick();
	const [task] = board.board();
	assert.equal(task.summary.reply.length, TASK_LIMITS.summaryChars, "case 16: the summary is capped");
	assert.equal(task.summary.receipts.length, TASK_LIMITS.receipts); assert.equal(task.summary.receipts.at(-1).receiptId, "r19");
	const text = mainContextText(board, [{ type: "task.done", taskId: task.taskId }]);
	assert.ok(text.length < TASK_LIMITS.summaryChars + 1500, "the board in the main context stays small");
	assert.match(text, /<task-board>.*<\/task-board>\n<task-events>/s);
	console.log("PASS case 16: a task's summary is capped and the board the main agent reads stays small");
}
{
	const { board, runs } = boardFixture();
	const first = board.dispatch({ title: "Move cube", instructions: "Move the cube   1 m left", scope: ["object:cube"] });
	const again = board.dispatch({ title: "move it", instructions: "move the cube 1 m left", scope: ["object:cube"] });
	assert.equal(again.duplicateOf, first.taskId, "case 19: the same work is not started twice");
	await tick(); assert.equal(runs.length, 1);
	assert.throws(() => board.dispatch({ title: "bad", instructions: "x", scope: ["cylinder"] }), /scope/);
	assert.throws(() => board.dispatch({ title: "bad", instructions: "x", scope: ["object:a"], dependsOn: ["nope"] }), /dependsOn/);
	console.log("PASS case 19: equal instructions on an equal scope answer the running task; bad scopes and dependencies are refused");
}
{
	const { board, runs, status, advance } = boardFixture({ maxTools: 2, maxMs: 60_000 });
	dispatch(board, "busy", ["object:a"]); dispatch(board, "slow", ["object:b"]); await tick();
	for (let i = 0; i < 3; i++) runs[0].task.onFrame({ type: "tool.start" });
	assert.ok(runs[0].options.signal.aborted, "case 20: past the tool limit the run is stopped");
	runs[0].resolve({ status: "cancelled" }); await tick(); await tick();
	assert.equal(status().busy, "failed"); assert.match(board.board()[0].reason, /more than 2 tool calls; ask the user whether to continue/);
	advance(60_000);
	assert.ok(runs[1].options.signal.aborted, "and past the time limit");
	runs[1].resolve({ status: "cancelled" }); await tick(); await tick();
	assert.match(board.board()[1].reason, /ran past 1 minutes/);
	console.log("PASS case 20: a task past its tool-call or time limit is stopped and reported as such");
}
{
	const { board, runs, status } = boardFixture({ cap: 1 });
	const a = dispatch(board, "a", ["object:a"]), b = dispatch(board, "b", ["object:b"]); await tick();
	assert.equal(board.cancel(b.taskId).status, "cancelled", "a queued task is cancelled at once");
	board.cancel(a.taskId);
	assert.ok(runs[0].options.signal.aborted, "a running one is stopped");
	runs[0].resolve({ status: "cancelled" }); await tick(); await tick();
	assert.equal(status().a, "cancelled"); assert.equal(board.cancel(a.taskId), null);
	console.log("PASS cancel: a queued task ends at once, a running one stops and ends cancelled");
}
{
	// A cancel that reaches a run which already finished on the bus (task.finish) cannot take it back: the card says done.
	const { board, runs, status } = boardFixture();
	const a = dispatch(board, "a", ["object:a"]); await tick();
	board.cancel(a.taskId);
	runs[0].resolve({ status: "done", reply: "a moved" }); await tick(); await tick();
	assert.equal(status().a, "done");
	console.log("PASS a cancel that arrives after the run finished leaves it done, not cancelled");
}

// --- (b) the main agent's words ----------------------------------------------------------------------------
{
	const tasks = [{ taskId: "t-1", title: "컵 잡기", status: "running" }, { taskId: "t-2", title: "Lighting", status: "done" }, { taskId: "t-3", title: "Make the cup", status: "review" }];
	assert.match(doneClaimCorrection("Make the cup 작업을 완료했습니다.", tasks, "컵 만들어"), /"Make the cup" 작업은 아직 끝나지 않았습니다. 지금 검토 대기입니다/, "a task in review is not done yet");
	assert.match(doneClaimCorrection("컵 잡기 작업을 완료했습니다.", tasks, "컵 잡게 해"), /정정: "컵 잡기" 작업은 아직 끝나지 않았습니다. 지금 진행 중입니다/, "case 15 + 17: corrected in Korean");
	assert.match(doneClaimCorrection("The 컵 잡기 task is done.", tasks, "have her grab the cup"), /Correction: task "컵 잡기" has not finished; it is running/);
	assert.equal(doneClaimCorrection("Lighting is done. 컵 잡기 is still running.", tasks, "x"), null, "a true claim, and a running task called running, pass");
	assert.equal(doneClaimCorrection("I started t-1.", tasks, "x"), null);
	console.log("PASS cases 15 and 17: a reply calling an unfinished task done is corrected, in the user's language");
}

// --- (c) the routes, a scripted model and the real bus ---------------------------------------------------------
const { objectsFixture } = await import("./bus/objects-fixture.mjs");
const { dispatchLiveFrame } = await import("../src/live-control.js");
const { createFakeModel } = await import("./fixtures/fake-model.mjs");
const { createAgentHandler } = await import("../bin/agent/agent-routes.mjs");
const { MAIN_SYSTEM_PROMPT } = await import("../bin/agent/main-prompt.mjs");
{
	const f = objectsFixture(), id = kind => f.store.current.objects.find(o => o.renderer === kind || o.id === kind).id;
	const ids = { cube: id("cube"), sphere: id("sphere"), cylinder: id("cylinder") }, x = objectId => f.store.current.objects.find(o => o.id === objectId)?.x;
	const read = () => { const context = f.binding.handlers.read_studio_context({ host: f.host() }); return { ...context, host: { ...context.host, workspaceHandle: "handle-1" } }; };
	const commands = [];
	const hub = {
		async command(name, payload) {
			commands.push({ name, taskId: payload.taskId, action: payload.args?.action });
			const response = await dispatchLiveFrame(JSON.stringify({ type: "cmd", id: randomUUID(), name, args: payload }), f.binding.handlers);
			if (!response.ok) throw Object.assign(new Error(response.error), { code: String(response.error).split(":")[0] });
			return response.value;
		},
		workspaceId: () => f.host().workspaceId, resolveWorkspace: () => "handle-1", connected: true, workspaceHandles: ["handle-1"],
	};
	const fakeModel = createFakeModel();
	// the conversation only: the system message (prompt and tool declarations) is not something anyone said
	const said = (context, text) => JSON.stringify(context.messages.filter(message => message.role !== "system")).includes(text);
	const toolResults = context => context.messages.filter(message => message.role === "toolResult").length;
	let mainTurns = 0;
	const step = async context => {
		if (getCurrentSystemPrompt(context.messages) === MAIN_SYSTEM_PROMPT) {
			const last = context.messages.at(-1);
			if (last.role === "user" && said({ messages: [last] }, "Task events arrived")) { mainTurns++; return fauxAssistantMessage([fauxText("두 작업이 모두 끝났어요.")]); }
			if (last.role === "user") return fauxAssistantMessage([
				fauxToolCall("dispatch_task", { title: "cube", instructions: `Move ${ids.cube} to x 1.`, scope: [`object:${ids.cube}`] }, { id: `m-${randomUUID()}` }),
				fauxToolCall("dispatch_task", { title: "sphere", instructions: `Move ${ids.sphere} to x 2.`, scope: [`object:${ids.sphere}`] }, { id: `m-${randomUUID()}` }),
				fauxToolCall("quick_edit", { scope: [`object:${ids.cylinder}`], tool: "run_action", args: { action: "object.set", args: { id: ids.cylinder, set: { position: { x: 3, y: 0, z: 0 } } } } }, { id: `m-${randomUUID()}` }),
			]);
			return fauxAssistantMessage([fauxText("큐브와 구를 옮기는 작업 두 개를 시작했고, 의자는 바로 옮겼어요.")]);
		}
		const target = said(context, `Move ${ids.cube}`) ? ids.cube : ids.sphere, to = target === ids.cube ? 1 : 2;
		if (toolResults(context) === 0) return fauxAssistantMessage([fauxToolCall("run_action", { action: "object.set", args: { id: target, set: { position: { x: to, y: 0, z: 0 } } } }, { id: `t-${randomUUID()}` })]);
		return fauxAssistantMessage([fauxText(`Moved ${target} to x ${to}. QA: none.`)]);
	};
	fakeModel.fauxProvider.setResponses(Array.from({ length: 40 }, () => step));
	let server;
	const handler = createAgentHandler({ auth: { getAccessToken: async () => "token" }, codex: { parseQuotaHeaders: () => ({ primary: {}, credits: {} }) }, models: fakeModel.models, fauxProvider: fakeModel.fauxProvider,
		liveHub: hub, studioRuntime: { readContext: async () => read() }, supervisor: false, studioTasks: () => true, taskLimits: { staggerMs: 0 }, port: () => server.address().port });
	server = createServer((req, res) => handler(req, res).catch(error => { if (!res.headersSent) res.writeHead(500); res.end(error.stack); }));
	server.listen(0, "127.0.0.1"); await once(server, "listening");
	const origin = `http://127.0.0.1:${server.address().port}`, sessionId = randomUUID();
	const response = await fetch(`${origin}/agent/main`, { method: "POST", headers: { "content-type": "application/json", origin },
		body: JSON.stringify({ surface: "studio", sessionId, turnId: randomUUID(), text: "큐브는 x 1, 구는 x 2로 옮기고 의자는 x 3으로", context: read(), model: "faux/scripted" }) });
	const cookie = response.headers.get("set-cookie").split(";")[0];
	const frames = [...(await response.text()).matchAll(/^data: (.+)$/gm)].map(match => JSON.parse(match[1]));
	assert.equal(frames.at(-1).type, "done", "the main turn ends");
	assert.ok(frames.filter(frame => frame.type === "tool.done" && frame.name === "dispatch_task").every(frame => frame.ok), "two tasks dispatched");
	assert.equal(x(ids.cylinder), 3, "quick_edit moved the chair inside a one-command task");
	const quick = commands.filter(command => command.action === "task.begin" || command.action === "task.finish");
	assert.ok(quick.length >= 2, "quick_edit opened and finished a task");
	const get = path => fetch(`${origin}${path}`, { headers: { origin, cookie } });
	let board;
	for (let i = 0; i < 200; i++) { board = (await (await get(`/agent/main/${sessionId}/board`)).json()).tasks; if (board.every(task => task.status === "done")) break; await new Promise(r => setTimeout(r, 25)); }
	assert.deepEqual(board.map(task => task.status), ["done", "done"], JSON.stringify(board));
	assert.equal(x(ids.cube), 1); assert.equal(x(ids.sphere), 2);
	assert.ok(board.every(task => task.summary.reply.startsWith("Moved")), "each task's report is its summary");
	const taskCommands = commands.filter(command => command.name === "run_action" && command.action === "object.set" && command.taskId);
	assert.equal(new Set(taskCommands.map(command => command.taskId)).size, 3, "each object.set ran inside its own task (two tasks and the quick edit)");
	assert.equal((await get(`/agent/main/${sessionId}/board`)).status, 200);
	assert.equal((await fetch(`${origin}/agent/main/${sessionId}/board`, { headers: { origin, cookie: "studio_owner=intruder" } })).status, 403, "another owner reads nothing");
	// A main turn carrying a picture is far over 64 KB: the body limit is the turn route's, so the envelope reaches the validator.
	const big = await fetch(`${origin}/agent/main`, { method: "POST", headers: { "content-type": "application/json", origin, cookie },
		body: JSON.stringify({ surface: "studio", sessionId, turnId: randomUUID(), text: "x", attachments: [{ dataUrl: `data:image/jpeg;base64,${"A".repeat(300_000)}` }] }) });
	assert.equal(typeof (await big.json()).error, "object", "an attachment-sized main turn is read and validated, not refused as too large");
	for (let i = 0; i < 200 && !mainTurns; i++) await new Promise(r => setTimeout(r, 25));
	assert.equal(mainTurns, 1, "the main agent reported once on its own when the tasks ended");
	const turnReplay = await (await get(`/agent/turn/${encodeURIComponent(board[0].turnId)}/events?after=0`)).text();
	assert.match(turnReplay, /"type":"done"/, "a task's frames replay on its turn like any turn's");
	const metas = readdirSync(sessionDir).filter(name => name.endsWith(".meta.json")).map(name => JSON.parse(readFileSync(join(sessionDir, name), "utf8")));
	assert.equal(metas.filter(meta => meta.parentId === sessionId).length, 2, "task sessions keep their parent's id");
	const listed = (await (await get("/agent/sessions?surface=studio")).json()).sessions;
	assert.ok(listed.every(meta => !meta.parentId) && listed.some(meta => meta.sessionId === sessionId), "the session list shows the main session, not its tasks");
	const disabled = createAgentHandler({ auth: { getAccessToken: async () => "token" }, liveHub: hub, studioTasks: () => false });
	const res = { statusCode: 0, writeHead(code) { this.statusCode = code; }, setHeader() {}, end() {} };
	await disabled({ method: "POST", url: "/agent/main", headers: {} }, res, "/agent/main");
	assert.equal(res.statusCode, 404, "the flag is off by default: single mode stays");
	// The panel's Tasks switch opts one session in without the flag: its main turn carries x-cozyclay-tasks: on.
	const optIn = Object.assign(Readable.from([Buffer.from("{}")]), { method: "POST", url: "/agent/main", headers: { "x-cozyclay-tasks": "on", "content-type": "application/json" } });
	const answered = { statusCode: 0, writeHead(code) { this.statusCode = code; }, setHeader() {}, end() {} };
	await disabled(optIn, answered, "/agent/main");
	assert.equal(answered.statusCode, 400, "an opted-in main turn reaches the main agent's route (here refused for its empty envelope), not a 404");
	await handler.close?.(); await new Promise(resolve => server.close(resolve)); f.dispose();
	console.log("PASS the routes: the main agent answers at once, two tasks edit two objects of one scene in their own scopes, a quick edit lands, the main agent reports when they end, task sessions keep their parent");
}

// --- (d) a Studio reload while a task runs -----------------------------------------------------------------------
async function reloadScenario({ lostWith, reloadKeeps }) {
	let cur = objectsFixture(), down = false;
	const cube = cur.store.current.objects.find(o => o.renderer === "cube").id;
	const read = () => { if (down) throw Object.assign(new Error("LIVE_HUB_UNAVAILABLE: no editor"), { code: "LIVE_HUB_UNAVAILABLE" }); const context = cur.binding.handlers.read_studio_context({ host: cur.host() }); return { ...context, host: { ...context.host, workspaceHandle: "handle-1" } }; };
	const hub = {
		async command(name, payload) {
			if (down) throw Object.assign(new Error(`${lostWith}: Live editor disconnected while a command was running.`), { code: lostWith });
			const response = await dispatchLiveFrame(JSON.stringify({ type: "cmd", id: randomUUID(), name, args: payload }), cur.binding.handlers);
			if (!response.ok) throw Object.assign(new Error(response.error), { code: String(response.error).split(":")[0] });
			return response.value;
		},
		workspaceId: () => cur.host().workspaceId, resolveWorkspace: () => "handle-1", connected: true, workspaceHandles: ["handle-1"],
	};
	const notes = [], fakeModel = createFakeModel();
	const lastUser = context => JSON.stringify([...context.messages].reverse().find(message => message.role === "user") ?? {});
	const step = async context => {
		if (getCurrentSystemPrompt(context.messages) === MAIN_SYSTEM_PROMPT) {
			const last = context.messages.at(-1);
			if (last.role === "user" && lastUser(context).includes("Move the cube")) return fauxAssistantMessage([fauxToolCall("dispatch_task", { title: "cube", instructions: `Move ${cube} to x 1, then to x 2.`, scope: [`object:${cube}`] }, { id: `m-${randomUUID()}` })]);
			return fauxAssistantMessage([fauxText("알겠어요.")]);
		}
		const user = lastUser(context);
		if (/reads as you left it|scene changed while the Studio reloaded/.test(user) && context.messages.at(-1).role === "user") { notes.push(user.includes("scene changed") ? "changed" : "same"); return fauxAssistantMessage([fauxText("Resumed and finished.")]); }
		const results = context.messages.filter(message => message.role === "toolResult").length;
		if (results === 0) return fauxAssistantMessage([fauxToolCall("run_action", { action: "object.set", args: { id: cube, set: { position: { x: 1, y: 0, z: 0 } } } }, { id: `t-${randomUUID()}` })]);
		if (results === 1) { await new Promise(r => setTimeout(r, 60)); down = true; return fauxAssistantMessage([fauxToolCall("run_action", { action: "object.set", args: { id: cube, set: { position: { x: 2, y: 0, z: 0 } } } }, { id: `t-${randomUUID()}` })]); }
		return fauxAssistantMessage([fauxText("Moved.")]);
	};
	fakeModel.fauxProvider.setResponses(Array.from({ length: 30 }, () => step));
	let server;
	const handler = createAgentHandler({ auth: { getAccessToken: async () => "token" }, codex: { parseQuotaHeaders: () => ({ primary: {}, credits: {} }) }, models: fakeModel.models, fauxProvider: fakeModel.fauxProvider,
		liveHub: hub, studioRuntime: { readContext: async () => read() }, supervisor: false, studioTasks: () => true, taskLimits: { staggerMs: 0 }, port: () => server.address().port });
	server = createServer((req, res) => handler(req, res).catch(error => { if (!res.headersSent) res.writeHead(500); res.end(error.stack); }));
	server.listen(0, "127.0.0.1"); await once(server, "listening");
	const origin = `http://127.0.0.1:${server.address().port}`, sessionId = randomUUID();
	const post = async (text, cookie) => fetch(`${origin}/agent/main`, { method: "POST", headers: { "content-type": "application/json", origin, ...(cookie ? { cookie } : {}) },
		body: JSON.stringify({ surface: "studio", sessionId, turnId: randomUUID(), text, context: read(), model: "faux/scripted" }) });
	const first = await post("Move the cube");
	const cookie = first.headers.get("set-cookie").split(";")[0]; await first.text();
	const board = async () => (await (await fetch(`${origin}/agent/main/${sessionId}/board`, { headers: { origin, cookie } })).json()).tasks[0];
	const until = async want => { let task; for (let i = 0; i < 300; i++) { task = await board(); if (want.includes(task.status)) return task; await new Promise(r => setTimeout(r, 20)); } return task; };
	const paused = await until(["paused", "failed"]);
	assert.equal(paused.status, "paused", JSON.stringify(paused));
	// The reload: a new editor on the same scene, from what autosave kept.
	const kept = structuredClone(cur.store.current.objects).map(o => (o.id === cube && !reloadKeeps ? { ...o, x: 0 } : o));
	cur.dispose(); cur = objectsFixture(kept); down = false;
	await (await post("다시 연결됐어", cookie)).text();
	const ended = await until(["done", "failed"]);
	// The board's feed replays every event from the start; read what arrives in a short window.
	const reader = (await fetch(`${origin}/agent/main/${sessionId}/events?after=0`, { headers: { origin, cookie } })).body.getReader();
	let events = "";
	const stopAt = Date.now() + 300;
	while (Date.now() < stopAt) { const chunk = await Promise.race([reader.read(), new Promise(r => setTimeout(() => r(null), stopAt - Date.now()))]); if (!chunk || chunk.done) break; events += new TextDecoder().decode(chunk.value); }
	await reader.cancel();
	await handler.close?.(); await new Promise(resolve => server.close(resolve)); cur.dispose();
	return { ended, notes, events };
}
{
	const same = await reloadScenario({ lostWith: "LIVE_HUB_UNAVAILABLE", reloadKeeps: true });
	assert.equal(same.ended.status, "done", JSON.stringify(same.ended));
	assert.deepEqual(same.notes, ["same"], "the scope reads as the task left it: it resumes");
	assert.ok(!same.events.includes("task.sceneChanged"));
	const changed = await reloadScenario({ lostWith: "LIVE_HUB_UNAVAILABLE", reloadKeeps: false });
	assert.equal(changed.ended.status, "done");
	assert.deepEqual(changed.notes, ["changed"], "autosave missed its edit: the task is told to re-read its scope");
	assert.match(changed.events, /"type":"task.sceneChanged".*"keys":\["object:cube"\]/s, "the main agent hears it");
	const mid = await reloadScenario({ lostWith: "UNCERTAIN_APPLY", reloadKeeps: false });
	assert.equal(mid.ended.status, "failed");
	assert.match(mid.ended.reason, /scene changed while the Studio reloaded .* mid-command/);
	assert.deepEqual(mid.notes, [], "a task lost mid-command on a changed scope does not resume blind");
	console.log("PASS case 14 after a reload: a paused task resumes when its scope reads as it left it, re-reads when it changed (and the main agent hears it), and fails when it was mid-command");
}
process.exit(0);
