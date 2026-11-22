#!/usr/bin/env node
// What the motion tool installs, when, and what survives it (bin/agent/motion-run.mjs, motion-door.mjs, motion-job.mjs,
// src/lowvis/studio/install.js):
//  1. only a motion the writer answered for with its report is installed: a run stopped at a limit, a report with the
//     line "Install: no", a motion that is the one that plays, a stop on request before the install and another scene
//     open than the motion's install nothing and say why; the last compiled motion can then be installed on request; an
//     install answers the receipt ids of its edits (the steps that changed the scene), newest first
//  2. a plain turn's motion outlives a stopped turn: the writer is not stopped, nothing is installed while no turn runs,
//     the next turn's agent is told, and its motion_result installs it under that turn's mark; stop: true stops it; an
//     edit of the user's last message drops the motion that message started
//  3. a place on a bone that someone set after an install stays across the next install and a refit of the same
//     carrier; an unedited one, one on a take that does not say what it attached and one the clip moves to another bone
//     take the new clip's place; the writer is told a place set by hand
// The same in a real Studio: test/lowvis/qa-install-browser.mjs.
// Every scene and spec here is made up for this test.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runMotion } from "../../bin/agent/motion-run.mjs";
import { createServer } from "node:http";
import { createMotionDoor, turnMotionDoor } from "../../bin/agent/motion-door.mjs";
import { refitMotion } from "../../bin/agent/motion-refit.mjs";
import { buildClip } from "../../src/lowvis/engine-simple/engine.js";
import { serializeClip } from "../../src/lowvis/clip.js";
import { studioScene } from "../../src/lowvis/studio/scene.js";
import { installClip, placeSetLater } from "../../src/lowvis/studio/install.js";
import { eulerXYZ } from "../../src/lowvis/studio/attach.js";
import { createCompileTool } from "../../src/lowvis/pi/compile-tool.mjs";
import { stoppedNote } from "../../src/workflow/agent-turn.js";
import { takeScaleOf } from "../../src/lowvis/studio/figure.js";

const tick = () => new Promise(resolve => setTimeout(resolve, 2));

// --- 1. what the writer answered for ---
{
	const SCENE = { characters: [{ id: "c1", at: [0, 0] }], props: [] }, SPEC = { c1: [[0, "idle"]] };
	const DESCRIBE = { characters: [{ id: "c1", model: "x-bot-tpose", x: 0, z: 0, rot: 0, scale: 1 }], objects: [] };
	const shots = [{ n: 1, status: "ok" }, { n: 2, status: "problems" }, { n: 3, status: "ok" }];
	const ask = async (record, { playing = null, exclusive, signal } = {}) => {
		const installs = [], read = playing ? { ...DESCRIBE, document: { activeSceneId: "s", scenes: [{ id: "s", stage: { characters: [{ id: "c1", motionTake: { spec: { lowvis: playing } } }] } }] } } : DESCRIBE;
		let n = 0;
		// the Studio's receipts: a step that changed nothing (no waypoints to clear) is not authored, so it is no edit of the turn
		const done = await runMotion({ words: "x", memoryKey: "conv", hub: { command: async () => read }, workspaceHandle: "ws", env: {}, ...(exclusive ? { exclusive } : {}), ...(signal ? { signal } : {}),
			invoke: async action => ({ receiptId: `r${++n}-${action}`, affectedIds: [], authored: action !== "character.clearWaypoints" }),
			deps: { studioScene, readClip: () => ({ frameCount: 48, characters: [{ id: "c1" }], props: [] }),
				installClip: async (clip, run, options) => { installs.push(options); await run("object.update", {}); await run("character.clearWaypoints", {}); await run("motion.v4.install", {}); return { characterIds: [], objectIds: [], switched: [], ok: true }; },
				runScene: async () => ({ wallMs: 1800_000, compiles: 3, final: { clip: "c.json", scene: SCENE, spec: SPEC, frames: 48 }, calls: { shots }, report: null, missing: null, ...record }) } });
		return { done, installs };
	};
	const UNDO = ["r3-motion.v4.install", "r1-object.update"];
	// a run that hit the time limit with no report (the study's 1800 s run): nothing goes in, and the agent is told
	let { done, installs } = await ask({ finished: false, endedBy: "safety limit (time)" });
	assert.equal(installs.length, 0, "a run stopped at its time limit installs nothing");
	assert.equal(done.installed, false);
	assert.equal(done.notInstalled, "The motion writer ended at safety limit (time) before its report, so its last compiled motion (compile 3, 48 frames) is not installed.");
	assert.equal(done.frames, 48, "what exists is told: the last compiled motion's length");
	assert.equal(typeof done.install, "function", "and it can be installed on request");
	const later = await done.install();
	assert.deepEqual([later.installed, later.undo], [true, UNDO], "installed on request: the receipts of its edits, newest first, without the step that changed nothing");
	// a report that says not to install
	({ done, installs } = await ask({ finished: true, report: "The hands still slip.\nInstall: no (the grip is not fixed yet)\nMissing: none", missing: "none" }));
	assert.deepEqual([installs.length, done.installed, typeof done.install], [0, false, "function"]);
	assert.equal(done.notInstalled, "The motion writer's report says not to install its last compiled motion (compile 3, 48 frames) (Install: no).");
	// a report with the scene and spec of the motion that plays: nothing new, nothing to offer
	({ done, installs } = await ask({ finished: true, report: "Nothing was changed.\nMissing: none", missing: "none" }, { playing: { name: "agent-20260101-000000-aaaa", scene: SCENE, spec: SPEC } }));
	assert.deepEqual([installs.length, done.installed, done.install, done.kept?.name], [0, false, undefined, "agent-20260101-000000-aaaa"]);
	assert.equal(done.notInstalled, "The motion writer ended with the scene and spec the Studio plays already: nothing new was installed.");
	// a report and no compile: nothing exists to install
	({ done } = await ask({ finished: true, final: null, report: "The engine has no word for this.\nMissing: a cartwheel", missing: "a cartwheel" }));
	assert.deepEqual([done.installed, done.notInstalled, done.frames, done.install], [false, "The motion writer compiled no motion.", 0, undefined]);
	// an answered run installs, and its answer names the receipts that undo it
	({ done, installs } = await ask({ finished: true, report: "He waves.\nMissing: none", missing: "none" }));
	assert.deepEqual([installs.length, done.installed, done.undo], [1, true, UNDO]);
	// a stop on request that comes after the writer's report and before the install (the motion waited for a turn):
	// kept out and offered; the offered install goes in although the stop stays set
	const stop = new AbortController();
	({ done, installs } = await ask({ finished: true, report: "He waves.\nMissing: none", missing: "none" }, { signal: stop.signal, exclusive: async install => { stop.abort(); return install(); } }));
	assert.deepEqual([installs.length, done.installed, done.notInstalled], [0, false, "The motion was stopped on request before its install, so its last compiled motion (compile 3, 48 frames) is not installed."]);
	assert.deepEqual([(await done.install()).undo, installs.length], [UNDO, 1]);
	// another scene is open than the motion's when the install would run (the door's exclusive says so): kept out and
	// offered, and installed on request once the door lets it through
	let other = true;
	({ done, installs } = await ask({ finished: true, report: "He waves.\nMissing: none", missing: "none" }, { exclusive: async install => { if (other) throw Object.assign(new Error("Another scene is open than the one the motion was written in"), { code: "scene" }); return install(); } }));
	assert.deepEqual([installs.length, done.installed, done.notInstalled], [0, false, "Another scene is open than the one the motion was written in, so its last compiled motion (compile 3, 48 frames) is not installed."]);
	const again = await done.install();
	assert.deepEqual([again.installed, typeof again.install, installs.length], [false, "function", 0], "still another scene: kept out again, offered again");
	other = false;
	assert.deepEqual([(await again.install()).installed, installs.length], [true, 1]);
	console.log("PASS install: only an answered motion goes in; a limit, Install: no, the playing motion, a stop and another scene are told; receipts of the edits, newest first");
}

// --- 2. a plain turn's motion outlives a stopped turn ---
{
	const jobs = new Map(), log = [];
	let release, aborted = false;
	const run = async ({ signal, onScene, exclusive, onCompile }) => {
		signal.addEventListener("abort", () => { aborted = true; release?.(); }, { once: true });
		onScene({ characters: { c1: "c1" }, props: {} });
		onCompile({ n: 1, ok: true, line: "motion 1: ok" });
		await new Promise(resolve => { release = resolve; });
		if (aborted) return { report: null, frames: 48, installed: false, notInstalled: "The motion writer was stopped on request before its report, so its last compiled motion (compile 1, 48 frames) is not installed.", install: async () => ({ installed: true, undo: ["r9"] }), characterIds: [], objectIds: [], switched: [] };
		return exclusive(async () => { log.push("install"); return { report: "Done.\nMissing: none", missing: "none", frames: 48, characterIds: ["c1"], objectIds: [], switched: [], installed: true, undo: ["r2", "r1"] }; });
	};
	const turn = name => {
		const frames = [];
		const door = createMotionDoor({ background: true, key: "conv-a", jobs, run, mark: async () => { log.push(`${name} mark`); }, rollback: async () => { log.push(`${name} rollback`); } });
		return { door, frames, result: door.with([]).find(tool => tool.name === "motion_result") };
	};
	const first = turn("t1");
	assert.deepEqual(await first.door.handler({ request: "she waves" }, { toolCallId: "m1", emit: () => {} }), { ok: true, started: true });
	assert.equal(await first.door.unfinished({ failed: true }), null, "a stopped turn hands nothing over");
	assert.equal(aborted, false, "and does not stop the writer");
	release();
	await tick(); await tick();
	assert.deepEqual(log, [], "the writer ended while no turn runs: nothing is installed, no mark is taken");
	const second = turn("t2");
	assert.equal(second.door.note(), "Studio motion observation: a motion that an earlier turn of this conversation started has ended and nothing of it is installed; motion_result answers it.");
	await assert.rejects(second.door.handler({ request: "now jump" }), error => error.code === "MOTION_RUNNING", "a new motion waits for that one");
	const frames = [], answer = await second.result.handler({}, { toolCallId: "r1", emit: frame => frames.push(frame) });
	assert.deepEqual([answer.installed, answer.undo, log], [true, ["r2", "r1"], ["t2 mark", "install"]], "the next turn's motion_result installs it under that turn's mark");
	assert.equal(second.door.note(), null, "collected: nothing more to tell");
	// a turn that took a motion over and would end before its result: the result is handed to it as an earlier turn's
	{
		const hand = new Map(), free = [];
		const go = async ({ onScene, exclusive }) => { onScene({ characters: { c1: "c1" }, props: {} }); await new Promise(resolve => free.push(resolve)); return exclusive(async () => ({ report: "Done.", frames: 24, characterIds: ["c1"], objectIds: [], switched: [], installed: true, undo: ["r1"] })); };
		const of = () => createMotionDoor({ background: true, key: "conv-h", jobs: hand, run: go, mark: async () => {}, rollback: async () => {} });
		const one = of();
		await one.handler({ request: "x" }, {});
		await one.unfinished({ failed: true });
		const two = of();
		await assert.rejects(two.handler({ request: "y" }, {}), error => error.code === "MOTION_RUNNING"); // the refused call takes it over
		const handed = two.unfinished();
		free[0]();
		assert.match(await handed, /^Studio motion observation: the motion an earlier turn started has ended\. Its result, as motion_result answers it:\n\{"ok":true.*"installed":true,"undo":\["r1"\]\}$/);
	}
	// a writer the user asks to stop: stop: true answers what it has, not installed; install: true installs it then
	const third = turn("t3");
	await third.door.handler({ request: "she bows" }, { toolCallId: "m3", emit: () => {} });
	await third.door.unfinished({ failed: true });
	const fourth = turn("t4");
	assert.equal(fourth.door.note(), "Studio motion observation: a motion that an earlier turn of this conversation started is still being written and nothing of it is installed; motion_result waits for it and answers it.");
	const stopped = await fourth.result.handler({ stop: true }, {});
	assert.deepEqual([aborted, stopped.installed, /stopped on request/.test(stopped.notInstalled)], [true, false, true]);
	// the offer stays with the conversation: a later turn installs it on the user's word (its agent has the answer that
	// offered it, so no note repeats it every turn)
	const fifth = turn("t5");
	assert.equal(fifth.door.note(), null);
	assert.deepEqual(await fifth.result.handler({ install: true }, {}), { ok: true, report: undefined, missing: undefined, frames: undefined, clipSeconds: undefined, tookSeconds: undefined, compiles: undefined, characters: undefined, objects: undefined, switched: undefined, used: null, installed: true, undo: ["r9"] });
	await assert.rejects(fifth.result.handler({ install: true }, {}), error => error.code === "NO_OFFER");
	assert.equal(turn("t6").door.note(), null, "installed: nothing more to tell");
	await assert.rejects(turn("t6").result.handler({}, {}), error => error.code === "NO_MOTION" && error.message === "This conversation has no motion that is being written or waits to be collected.", "nothing left: said as it is (also after the agent process restarted)");
	// a motion_result that waited when its turn was stopped collects nothing: a result that ends meanwhile stays for the
	// next turn, which is told of it and gets it (here a motion kept out with an offer)
	const seventh = turn("t7");
	await seventh.door.handler({ request: "she turns" }, { toolCallId: "m7", emit: () => {} });
	await seventh.door.unfinished({ failed: true });
	const eighth = turn("t8"), hanging = eighth.result.handler({ stop: true }, {});
	await eighth.door.unfinished({ failed: true }); // that turn is stopped while its motion_result waits
	assert.equal((await hanging).installed, false);
	const ninth = turn("t9");
	assert.equal(ninth.door.note(), "Studio motion observation: a motion that an earlier turn of this conversation started has ended and nothing of it is installed; motion_result answers it.", "the stopped turn's call did not collect it");
	assert.match((await ninth.result.handler({}, {})).notInstalled, /stopped on request/);
	assert.equal((await ninth.result.handler({ install: true }, {})).installed, true);
	// an install whose turn ends while it waits for the scene does not run in that turn: it waits for the next one
	{
		const waits = new Map(), order = [];
		let free, go;
		const busy = new Promise(resolve => { free = resolve; });
		const held = async ({ onScene, exclusive }) => { onScene({ characters: { c1: "c1" }, props: {} }); await new Promise(resolve => { go = resolve; }); return exclusive(async () => { order.push("install"); return { report: "Done.", frames: 24, characterIds: ["c1"], objectIds: [], switched: [], installed: true, undo: ["r1"] }; }); };
		const of = name => { const d = createMotionDoor({ background: true, key: "conv-w", jobs: waits, run: held, mark: async () => { order.push(`${name} mark`); }, rollback: async () => {} }); return { d, tools: d.with([{ name: "edit", handler: async () => { await busy; return { ok: true, affectedIds: ["lamp"] }; } }]) }; };
		const a = of("a");
		await a.d.handler({ request: "x" }, {});
		const editing = a.tools[0].handler({}, {}); // a call of the turn holds the scene
		go(); await tick();
		await a.d.unfinished({ failed: true }); // the turn is stopped while the install waits behind that call
		free(); await editing; await tick(); await tick();
		assert.deepEqual(order, ["a mark"], "the install did not run in the turn that ended (only that turn's own call marked)");
		const b = of("b");
		assert.equal((await b.tools.find(tool => tool.name === "motion_result").handler({}, {})).installed, true);
		assert.deepEqual(order, ["a mark", "b mark", "install"]);
	}
	// the user's Stop reaches the door at once (stopped); the run winds down later (unfinished). A writer that ends in
	// between installs nothing in the stopped turn
	{
		const between = new Map(), ran = [], stopping = new AbortController();
		let end;
		const slow = async ({ onScene, exclusive }) => { onScene({ characters: { c1: "c1" }, props: {} }); await new Promise(resolve => { end = resolve; }); return exclusive(async () => { ran.push("install"); return { report: "Done.", frames: 24, characterIds: ["c1"], objectIds: [], switched: [], installed: true, undo: ["r1"] }; }); };
		const held = createMotionDoor({ background: true, key: "conv-s", jobs: between, run: slow, mark: async () => { ran.push("mark 1"); }, rollback: async () => {}, stopped: stopping.signal });
		await held.handler({ request: "x" }, {});
		stopping.abort();
		end(); await tick(); await tick();
		assert.deepEqual(ran, [], "the writer ended between the Stop and the end of the run: nothing installed");
		assert.equal(await held.unfinished({ failed: true }), null);
		const next = createMotionDoor({ background: true, key: "conv-s", jobs: between, run: slow, mark: async () => { ran.push("mark 2"); }, rollback: async () => {} });
		assert.equal((await next.with([]).find(tool => tool.name === "motion_result").handler({}, {})).installed, true);
		assert.deepEqual(ran, ["mark 2", "install"]);
	}
	// without a place to keep it (a door with no key) a stop still stops the motion, as before
	aborted = false;
	const plain = createMotionDoor({ background: true, run, mark: async () => {}, rollback: async () => {} });
	await plain.handler({ request: "x" }, {});
	await plain.unfinished({ failed: true });
	assert.equal(aborted, true);
	// a motion installed in a turn that was then stopped before it collected the result: the next turn is told it is in
	const quick = new Map(), early = createMotionDoor({ background: true, key: "conv-q", jobs: quick, mark: async () => {}, rollback: async () => {},
		run: async ({ onScene, exclusive }) => { onScene({ characters: { c1: "c1" }, props: {} }); await tick(); return exclusive(async () => ({ report: "Done.", frames: 24, characterIds: ["c1"], objectIds: [], switched: [], installed: true, undo: ["r1"] })); } });
	await early.handler({ request: "x" }, {});
	await tick(); await tick();
	await early.unfinished({ failed: true });
	const after = createMotionDoor({ background: true, key: "conv-q", jobs: quick, run, mark: async () => {}, rollback: async () => {} });
	assert.equal(after.note(), "Studio motion observation: a motion that an earlier turn of this conversation started was installed in that turn; motion_result answers its result.");
	const told = await after.with([]).find(tool => tool.name === "motion_result").handler({}, {});
	assert.deepEqual([told.installed, told.undo], [true, undefined], "its receipts were that turn's edits: undo_edit refuses them in a later turn, so they are not handed on");
	// the user's panel: a stopped turn whose motion no motion_result answered says the motion was not stopped with it
	const steps = [{ kind: "tool", name: "motion", status: "done", result: { ok: true, started: true } }], NOTE = /The motion this turn started was not stopped: nothing more of it is installed until a later message of yours asks for it or asks to stop it\.$/;
	assert.match(stoppedNote({ steps }), NOTE);
	assert.match(stoppedNote({ steps: [...steps, { kind: "tool", name: "motion_result", status: "done", result: { ok: true, draft: true } }] }), NOTE, "a motion_result that answered the draft did not answer the motion");
	assert.match(stoppedNote({ steps: [...steps, { kind: "tool", name: "motion_result", status: "cancelled" }] }), NOTE, "nor one the stop cut");
	assert.doesNotMatch(stoppedNote({ steps: [...steps, { kind: "tool", name: "motion_result", status: "done", result: { ok: true, installed: true } }] }), NOTE);
	assert.doesNotMatch(stoppedNote({ steps: [...steps, { kind: "tool", name: "motion_result", status: "failed" }] }), NOTE);
	assert.doesNotMatch(stoppedNote({ steps: [{ kind: "tool", name: "motion", status: "done", result: { ok: true, refit: [] } }] }), NOTE, "a call that started no writer says nothing of one");
	console.log("PASS outlive: a stopped turn leaves the motion running; the next turn is told, collects and installs it; stop and install on request");
}

// --- 2b. the same through the real runner: the user's Stop of a turn (session abort) while the writer works ---
{
	const { fauxAssistantMessage, fauxText, fauxToolCall } = await import("@earendil-works/pi-ai/providers/faux");
	const { createAgentRunner } = await import("../../bin/agent/agent-runner.mjs");
	const { createFakeModel } = await import("../fixtures/fake-model.mjs");
	const { mkdtempSync } = await import("node:fs"), { tmpdir } = await import("node:os"), { join } = await import("node:path");
	process.env.COZYCLAY_AGENT_SESSIONS_DIR = mkdtempSync(join(tmpdir(), "cozyclay-motion-install-"));
	const jobs = new Map(), log = [];
	let release, writerStopped = false, stopNow;
	const run = async ({ signal, onScene, exclusive }) => {
		signal.addEventListener("abort", () => { writerStopped = true; }, { once: true });
		onScene({ characters: { c1: "c1" }, props: {} });
		await new Promise(resolve => { release = resolve; });
		return exclusive(async () => { log.push("install"); return { report: "She sits.\nMissing: none", missing: "none", frames: 96, characterIds: ["c1"], objectIds: [], switched: [], installed: true, undo: ["r1"] }; });
	};
	const doorOf = name => createMotionDoor({ background: true, key: "conv-runner", jobs, run, mark: async () => { log.push(`${name} mark`); }, rollback: async () => {} });
	const fake = createFakeModel(), runner = createAgentRunner({ models: fake.models, fauxProvider: fake.fauxProvider });
	const session = await runner.openSession("install-stop");
	fake.fauxProvider.setResponses([
		async () => fauxAssistantMessage([fauxToolCall("motion", { request: "c1 sits" }, { id: "m1" })]),
		async () => { stopNow(); await new Promise(resolve => setTimeout(resolve, 50)); return fauxAssistantMessage([fauxText("still working")]); },
		async () => fauxAssistantMessage([fauxToolCall("motion_result", {}, { id: "r1" })]),
		async () => fauxAssistantMessage([fauxText("She sits.")]),
	]);
	const first = doorOf("t1"), frames = [];
	const stopped = new Promise(resolve => { stopNow = () => { void session.abort("studio stop"); resolve(); }; });
	for await (const frame of session.start({ text: "she sits", model: "faux/scripted", tools: first.with([]), unfinished: first.unfinished })) frames.push(frame);
	await stopped;
	assert.equal(writerStopped, false, "the user's Stop of the turn does not stop the writer");
	release();
	await tick(); await tick();
	assert.deepEqual(log, [], "the writer ended after the stop: nothing installed while no turn runs");
	const second = doorOf("t2"), again = [];
	assert.match(second.note(), /has ended and nothing of it is installed/);
	for await (const frame of session.start({ text: "and?", model: "faux/scripted", tools: second.with([]), unfinished: second.unfinished })) again.push(frame);
	await runner.close();
	const result = again.find(frame => frame.type === "tool.done" && frame.callId === "r1");
	assert.deepEqual([result?.ok, result?.result?.installed, log], [true, true, ["t2 mark", "install"]], `the next turn installs it: ${JSON.stringify(result)}`);
	console.log("PASS outlive (runner): a Stop of the turn leaves the writer running; the next turn's motion_result installs it");
}

// --- 2c. an edit of the user's last message cuts that turn: the motion it started is dropped, an earlier turn's stays ---
{
	const proxy = createServer((req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ data: [{ id: "claude-opus-5-5" }] })); });
	await new Promise(resolve => proxy.listen(0, "127.0.0.1", resolve));
	const env = { CLIPROXY_BASE_URL: `http://127.0.0.1:${proxy.address().port}`, CLIPROXY_API_KEY: "test" }, stopped = [];
	const deps = { studioScene: () => ({ scene: { characters: [{ id: "c1", at: [0, 0], heading: 0 }], props: [], others: [] }, ids: { characters: { c1: "c1" }, props: {}, switch: [] } }), readClip: () => null, installClip: async () => ({ ok: true }),
		runScene: ({ signal, request }) => new Promise(resolve => signal.addEventListener("abort", () => { stopped.push(/USER'S WORDS[^\n]*\n([^\n]*)/.exec(request)[1]); resolve({ wallMs: 0, compiles: 0, finished: false, endedBy: "stop reason aborted", report: null, missing: null, final: null }); }, { once: true })) };
	const turn = (sessionId, turnId, extra = {}) => turnMotionDoor({ value: { sessionId, turnId, text: `words of ${turnId}`, context: { host: { workspaceHandle: "ws" } }, ...extra }, env, hub: { command: async () => ({}) },
		tools: { internal: { invoke: async () => ({}) } }, transaction: { mark: async () => null, rollback: async () => null }, signal: new AbortController().signal, deps });
	const EDIT = { editNote: "<edited-message>The user edited their last message.</edited-message>" }, RUNNING = /is still being written and nothing of it is installed/;
	try {
		// turn a1 starts a motion and is stopped; a2 leaves it; the user edits a2's message: the motion is a1's and stays
		const a1 = await turn("conv-a", "a1");
		assert.deepEqual(await a1.handler({ request: "she waves" }, {}), { ok: true, started: true });
		await a1.unfinished({ failed: true });
		const a2 = await turn("conv-a", "a2");
		assert.match(a2.note(), RUNNING);
		await a2.unfinished({ failed: true });
		const a3 = await turn("conv-a", "a3", EDIT);
		assert.match(a3.note(), RUNNING, "an edit of a later message leaves an earlier turn's motion");
		assert.deepEqual(stopped, []);
		// turn b1 starts a motion and is stopped; the user edits b1's message: its writer is stopped, nothing is told or kept
		const b1 = await turn("conv-b", "b1");
		await b1.handler({ request: "he jumps" }, {});
		await b1.unfinished({ failed: true });
		const b2 = await turn("conv-b", "b2", EDIT);
		await tick();
		assert.deepEqual([b2.note(), stopped], [null, ["words of b1"]], "the motion of the message the user replaced is stopped");
		await assert.rejects(b2.with([]).find(tool => tool.name === "motion_result").handler({}, {}), error => error.code === "NO_MOTION");
		assert.deepEqual(await b2.handler({ request: "he hops" }, {}), { ok: true, started: true }, "and the corrected message starts its own");
		await b2.with([]).find(tool => tool.name === "motion_result").handler({ stop: true }, {}).catch(() => {});
		await a3.with([]).find(tool => tool.name === "motion_result").handler({ stop: true }, {}).catch(() => {});
	} finally { proxy.close(); }
	console.log("PASS edit: the motion of a message the user replaced is stopped and dropped; an earlier turn's motion stays");
}

// --- 3. a place on a bone set after an install stays ---
{
	// a recording Studio: objects as rows, an attach writes the bone-frame numbers on the row, a take keeps its source
	const rows = new Map(), takes = new Map(), steps = [];
	let n = 0;
	const studio = {
		read: () => ({ characters: [{ id: "a", model: "x-bot-tpose", x: 0, z: 0, rot: 0, scale: 1 }], objects: [...rows.values()], document: { activeSceneId: "s", scenes: [{ id: "s", stage: { characters: [{ id: "a", ...(takes.has("a") ? { motionTake: { spec: takes.get("a") ? { lowvis: takes.get("a") } : {} } } : {}) }] } }] } }),
		invoke: async (action, args) => {
			steps.push([action, args]);
			if (action === "object.sculpt" || action === "object.add") { const id = `obj-${++n}`; rows.set(id, { id, name: args.name, renderer: "cube", x: args.placement.x, y: args.placement.y, z: args.placement.z, rot: args.placement.rot ?? 0, footprint: { width: 0.08, depth: 0.08 }, height: 0.1 }); return { receiptId: `r${n}`, affectedIds: [id], authored: true }; }
			if (action === "object.attach") rows.set(args.objectId, { ...rows.get(args.objectId), ...args.local, attach: { characterId: args.characterId, bone: args.bone } });
			if (action === "object.update") rows.set(args.id, { ...rows.get(args.id), ...args.patch });
			if (action === "motion.v4.install") takes.set(args.characterId, args.lowvis);
			return { receiptId: `r${++n}`, affectedIds: [args.objectId ?? args.id ?? args.characterId], authored: true };
		},
	};
	const scene = { frames: 72, characters: [{ id: "a", at: [0, 0], heading: 0 }], props: [{ id: "cup", size: [0.08, 0.1, 0.08], at: [0.2, 0.85, 0.25], moves: true }] };
	const spec = extra => ({ a: [[0, "hold", { prop: "cup", hand: "R" }], [20, "pose", { R: [0.1, 0.45, 0.35], over: 18 }], ...extra] });
	const write = (sceneOf, specOf) => { const clip = JSON.parse(serializeClip(buildClip(structuredClone({ demo: "x", ...specOf }), sceneOf).clip)); return { clip, final: { clip: "c.json", scene: sceneOf, spec: specOf, frames: 72 } }; };
	let next = write(scene, spec([])), request = null;
	const motion = () => runMotion({ words: "x", memoryKey: "conv-r", hub: { command: async () => studio.read() }, workspaceHandle: "ws", env: {}, invoke: studio.invoke,
		deps: { studioScene, installClip, placeSetLater, eulerXYZ, readClip: () => next.clip, runScene: async options => { request = options.request; return { wallMs: 0, compiles: 1, finished: true, report: "Done.\nMissing: none", missing: "none", final: next.final }; } } });
	let done = await motion();
	const cup = done.attached?.[0]?.id;
	assert.ok(cup && done.attached[0].bone === "rightHand", `the cup rides the right hand: ${JSON.stringify(done.attached)}`);
	const clipPlace = { ...rows.get(cup) };
	assert.deepEqual(takes.get("a").attached.map(entry => [entry.id, entry.bone, entry.at]), [[cup, "rightHand", [clipPlace.x, clipPlace.y, clipPlace.z]]], "the take keeps what its install put on the bone");
	// the next motion, not edited: the cup takes that clip's place again (an attach step)
	next = write(scene, spec([[50, "pose", { L: [-0.1, 0.4, 0.3], over: 10 }]]));
	steps.length = 0;
	done = await motion();
	assert.equal(steps.filter(([a, args]) => a === "object.attach" && args.objectId === cup).length, 1, "unedited: attached again at the clip's place");
	assert.equal(done.attached[0].kept, undefined);
	const r3 = v => Math.round(v * 1000) / 1000;
	assert.ok(request.includes("cup (size [0.08,0.1,0.08]) on a's rightHand. A prop of your scene"), "a place the install set is the clip's own: the writer is told no numbers of it");
	assert.doesNotMatch(request, /set by hand/);
	// someone moves the cup in the hand (object.attach { local } / arrange_objects space parent write these numbers)
	const edited = { x: clipPlace.x + 0.02, y: clipPlace.y - 0.09, z: clipPlace.z + 0.01, rotX: 10, rot: 25, rotZ: -5 };
	rows.set(cup, { ...rows.get(cup), ...edited });
	next = write(scene, spec([[50, "pose", { L: [-0.1, 0.45, 0.3], over: 10 }]]));
	steps.length = 0;
	done = await motion();
	assert.equal(steps.filter(([, args]) => [args.objectId, args.id].includes(cup)).length, 0, "edited: no step touches the cup");
	assert.equal(done.attached[0].kept, true, "and the answer says it kept its place");
	assert.deepEqual(["x", "y", "z", "rotX", "rot", "rotZ"].map(k => rows.get(cup)[k]), ["x", "y", "z", "rotX", "rot", "rotZ"].map(k => edited[k]), "the place and turn someone set stay");
	assert.ok(request.includes(`cup (size [0.08,0.1,0.08]) on a's rightHand at [${[edited.x, edited.y, edited.z].map(r3).join(", ")}] m, turned [10, 25, -5] degrees in that bone's frame (set by hand). A prop of your scene`), `the writer is told the place set by hand, as the Studio has it: ${request}`);
	assert.ok(request.includes(" One set by hand keeps that place and turn while your clip keeps it on that bone: your clip's place for it is not drawn."));
	// a refit to another size keeps it too (the same install, from the kept spec)
	steps.length = 0;
	const read = studio.read();
	read.characters[0].scale = 0.8;
	const refit = await refitMotion({ hub: { command: async () => read }, workspaceHandle: "ws", invoke: studio.invoke, env: {}, deps: { createCompileTool, installClip, studioScene, readClip: file => JSON.parse(readFileSync(file, "utf8")) } });
	assert.equal(refit.refit.length, 1, JSON.stringify(refit));
	assert.ok(refit.undo?.length > 0, "a refit names its receipts too");
	assert.equal(steps.filter(([, args]) => [args.objectId, args.id].includes(cup)).length, 0, "a refit leaves the place someone set");
	assert.deepEqual(["x", "y", "z"].map(k => rows.get(cup)[k]), ["x", "y", "z"].map(k => edited[k]));
	// a detach resets it: the next motion attaches the cup at its clip's place again
	rows.set(cup, (({ attach: _a, ...row }) => ({ ...row, x: 0.2, y: 0.8, z: 0.25, rotX: 0, rot: 0, rotZ: 0 }))(rows.get(cup)));
	next = write(scene, spec([[50, "pose", { L: [-0.1, 0.5, 0.3], over: 10 }]]));
	steps.length = 0;
	done = await motion();
	assert.equal(steps.filter(([a, args]) => a === "object.attach" && args.objectId === cup).length, 1, "after a detach the clip's place is taken");
	assert.equal(done.attached[0].kept, undefined);
	// set by hand again, and the next clip carries it in the other hand: the place on the right hand no longer applies
	rows.set(cup, { ...rows.get(cup), ...edited });
	const left = n => ({ a: [[0, "hold", { prop: "cup", hand: "L" }], [20, "pose", { L: [-0.1, 0.45, 0.35], over: 18 }], [50, "pose", { R: [0.1, 0.4 + 0.01 * n, 0.3], over: 10 }]] });
	next = write(scene, left(0));
	steps.length = 0;
	done = await motion();
	const onLeft = steps.filter(([a, args]) => a === "object.attach" && args.objectId === cup);
	assert.deepEqual([onLeft.length, onLeft[0]?.[1].bone, done.attached[0].bone, done.attached[0].kept], [1, "leftHand", "leftHand", undefined], "another bone: attached there at the clip's place");
	assert.notEqual(rows.get(cup).x, edited.x);
	// a take that does not say what its install attached (made before that was kept, or by another tool): the clip's place
	// is taken, as before, although the numbers differ from any record
	rows.set(cup, { ...rows.get(cup), ...edited });
	for (const [n, bare] of [{ name: "agent-old", scene: takes.get("a").scene, spec: takes.get("a").spec }, null].entries()) {
		takes.set("a", bare);
		next = write(scene, left(n + 1));
		steps.length = 0;
		assert.equal((await motion()).attached[0].kept, undefined);
		assert.equal(steps.filter(([a, args]) => a === "object.attach" && args.objectId === cup).length, 1, `a take that ${bare ? "keeps a source without the list" : "keeps no source"}: the clip's place`);
		rows.set(cup, { ...rows.get(cup), ...edited });
	}
	// an object the user attached to a character that plays no take yet was put there by hand: it stays
	takes.delete("a");
	next = write(scene, left(3));
	steps.length = 0;
	done = await motion();
	assert.deepEqual([steps.filter(([, args]) => [args.objectId, args.id].includes(cup)).length, done.attached[0].kept], [0, true]);
	console.log("PASS attached place: an edit after an install stays across the next install and a refit; an unedited or detached one, another bone and a take without the list take the clip's place; the writer is told a place set by hand");
}

// --- 4. the size a take was made for (the Character panel's note when the body has another scale) ---
{
	const raw = scale => ({ spec: { raw: scale === 1 ? {} : { scale } } });
	assert.equal(takeScaleOf(raw(1), "x-bot-tpose", null), 1, "a take of the rig's own body under the block look: scale 1");
	assert.equal(takeScaleOf(raw(0.81), "x-bot-tpose", "cube"), 1, "the cube look's body is scale 1 there");
	assert.equal(takeScaleOf(raw(0.648), "x-bot-tpose", "cube"), 0.8, "a take refit to 0.8 under the cube look");
	assert.equal(takeScaleOf(raw(1.3), "capsule", "cube"), 1.3, "another model has no look body");
	assert.equal(takeScaleOf({ spec: { a1: [[0, "idle"]] } }, "x-bot-tpose", "cube"), null, "a take with no size of its own: no note");
	assert.equal(takeScaleOf(null, "x-bot-tpose", "cube"), null);
	console.log("PASS size: the scale a take was made for, per look");
}
