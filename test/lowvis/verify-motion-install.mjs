#!/usr/bin/env node
// What the motion tool installs, when, and what survives it (bin/agent/motion-run.mjs, motion-door.mjs, motion-job.mjs,
// src/lowvis/studio/install.js):
//  1. only a motion the writer answered for with its report is installed: a run stopped at a limit, a report with the
//     line "Install: no" and a motion that is the one that plays install nothing and say why; the last compiled motion
//     can then be installed on request; an install answers the receipt ids that undo exactly it, newest first
//  2. a plain turn's motion outlives a stopped turn: the writer is not stopped, nothing is installed while no turn runs,
//     the next turn's agent is told, and its motion_result installs it under that turn's mark; stop: true stops it
//  3. a place on a bone that someone set after an install stays across the next install and a refit of the same
//     carrier; an unedited one takes the new clip's place; the writer is told the place as it is
// Every scene and spec here is made up for this test.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runMotion } from "../../bin/agent/motion-run.mjs";
import { createMotionDoor } from "../../bin/agent/motion-door.mjs";
import { refitMotion } from "../../bin/agent/motion-refit.mjs";
import { buildClip } from "../../src/lowvis/engine-simple/engine.js";
import { serializeClip } from "../../src/lowvis/clip.js";
import { studioScene } from "../../src/lowvis/studio/scene.js";
import { installClip, placeSetLater } from "../../src/lowvis/studio/install.js";
import { eulerXYZ } from "../../src/lowvis/studio/attach.js";
import { createCompileTool } from "../../src/lowvis/pi/compile-tool.mjs";
import { stoppedNote } from "../../src/workflow/agent-turn.js";

const tick = () => new Promise(resolve => setTimeout(resolve, 2));

// --- 1. what the writer answered for ---
{
	const SCENE = { characters: [{ id: "c1", at: [0, 0] }], props: [] }, SPEC = { c1: [[0, "idle"]] };
	const DESCRIBE = { characters: [{ id: "c1", model: "x-bot-tpose", x: 0, z: 0, rot: 0, scale: 1 }], objects: [] };
	const shots = [{ n: 1, status: "ok" }, { n: 2, status: "problems" }, { n: 3, status: "ok" }];
	const ask = async (record, { playing = null } = {}) => {
		const installs = [], read = playing ? { ...DESCRIBE, document: { activeSceneId: "s", scenes: [{ id: "s", stage: { characters: [{ id: "c1", motionTake: { spec: { lowvis: playing } } }] } }] } } : DESCRIBE;
		let n = 0;
		const done = await runMotion({ words: "x", memoryKey: "conv", hub: { command: async () => read }, workspaceHandle: "ws", env: {},
			invoke: async action => ({ receiptId: `r${++n}-${action}`, affectedIds: [] }),
			deps: { studioScene, readClip: () => ({ frameCount: 48, characters: [{ id: "c1" }], props: [] }),
				installClip: async (clip, run, options) => { installs.push(options); await run("character.clearWaypoints", {}); await run("motion.v4.install", {}); return { characterIds: [], objectIds: [], switched: [], ok: true }; },
				runScene: async () => ({ wallMs: 1800_000, compiles: 3, final: { clip: "c.json", scene: SCENE, spec: SPEC, frames: 48 }, calls: { shots }, report: null, missing: null, ...record }) } });
		return { done, installs };
	};
	// a run that hit the time limit with no report (the study's 1800 s run): nothing goes in, and the agent is told
	let { done, installs } = await ask({ finished: false, endedBy: "safety limit (time)" });
	assert.equal(installs.length, 0, "a run stopped at its time limit installs nothing");
	assert.equal(done.installed, false);
	assert.equal(done.notInstalled, "The motion writer ended at safety limit (time) before its report, so its last compiled motion (compile 3, 48 frames) is not installed.");
	assert.equal(done.frames, 48, "what exists is told: the last compiled motion's length");
	assert.equal(typeof done.install, "function", "and it can be installed on request");
	const later = await done.install();
	assert.deepEqual([later.installed, later.undo], [true, ["r2-motion.v4.install", "r1-character.clearWaypoints"]], "installed on request: its receipts, newest first");
	// a report that says not to install
	({ done, installs } = await ask({ finished: true, report: "The hands still slip.\nInstall: no (the grip is not fixed yet)\nMissing: none", missing: "none" }));
	assert.deepEqual([installs.length, done.installed, typeof done.install], [0, false, "function"]);
	assert.equal(done.notInstalled, "The motion writer's report says not to install its last compiled motion (compile 3, 48 frames) (Install: no).");
	// a report with the scene and spec of the motion that plays: nothing new, nothing to offer
	({ done, installs } = await ask({ finished: true, report: "Nothing was changed.\nMissing: none", missing: "none" }, { playing: { name: "agent-20260101-000000-aaaa", scene: SCENE, spec: SPEC } }));
	assert.deepEqual([installs.length, done.installed, done.install, done.kept?.name], [0, false, undefined, "agent-20260101-000000-aaaa"]);
	assert.equal(done.notInstalled, "The motion writer ended with the scene and spec the Studio plays already: nothing new was installed.");
	// an answered run installs, and its answer names the receipts that undo it
	({ done, installs } = await ask({ finished: true, report: "He waves.\nMissing: none", missing: "none" }));
	assert.deepEqual([installs.length, done.installed, done.undo], [1, true, ["r2-motion.v4.install", "r1-character.clearWaypoints"]]);
	console.log("PASS install: only an answered motion goes in; a limit, Install: no and the playing motion are told; receipts newest first");
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
	assert.match(second.door.note(), /^Studio motion observation: a motion that an earlier turn of this conversation started has ended; its result is not collected and nothing of it is installed\. motion_result answers it/);
	await assert.rejects(second.door.handler({ request: "now jump" }), error => error.code === "MOTION_RUNNING", "a new motion waits for that one");
	const frames = [], answer = await second.result.handler({}, { toolCallId: "r1", emit: frame => frames.push(frame) });
	assert.deepEqual([answer.installed, answer.undo, log], [true, ["r2", "r1"], ["t2 mark", "install"]], "the next turn's motion_result installs it under that turn's mark");
	assert.equal(second.door.note(), null, "collected: nothing more to tell");
	// a writer the user asks to stop: stop: true answers what it has, not installed; install: true installs it then
	const third = turn("t3");
	await third.door.handler({ request: "she bows" }, { toolCallId: "m3", emit: () => {} });
	await third.door.unfinished({ failed: true });
	const fourth = turn("t4");
	assert.match(fourth.door.note(), /is still being written \(1 compile so far\)/);
	const stopped = await fourth.result.handler({ stop: true }, {});
	assert.deepEqual([aborted, stopped.installed, /stopped on request/.test(stopped.notInstalled)], [true, false, true]);
	// the offer stays with the conversation: a later turn is told of it and installs it on the user's word
	const fifth = turn("t5");
	assert.match(fifth.door.note(), /answered installed false with a compiled motion; motion_result \{ install: true \} installs it/);
	assert.deepEqual(await fifth.result.handler({ install: true }, {}), { ok: true, report: undefined, missing: undefined, frames: undefined, clipSeconds: undefined, tookSeconds: undefined, compiles: undefined, characters: undefined, objects: undefined, switched: undefined, used: null, installed: true, undo: ["r9"] });
	await assert.rejects(fifth.result.handler({ install: true }, {}), error => error.code === "NO_OFFER");
	assert.equal(turn("t6").door.note(), null, "installed: nothing more to tell");
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
	assert.equal(after.note(), "Studio motion observation: a motion that an earlier turn of this conversation started was installed in that turn; its result (with the receipts that undo it) is not collected; motion_result answers it.");
	assert.deepEqual((await after.with([]).find(tool => tool.name === "motion_result").handler({}, {})).undo, ["r1"]);
	// the user's panel: a stopped turn whose motion no motion_result answered says it is still being written
	const steps = [{ kind: "tool", name: "motion", status: "done", result: { ok: true, started: true } }];
	assert.match(stoppedNote({ steps }), /The motion is still being written: nothing of it is installed until your next message/);
	assert.doesNotMatch(stoppedNote({ steps: [...steps, { kind: "tool", name: "motion_result", status: "done", result: { ok: true } }] }), /still being written/);
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
	assert.match(second.note(), /has ended; its result is not collected/);
	for await (const frame of session.start({ text: "and?", model: "faux/scripted", tools: second.with([]), unfinished: second.unfinished })) again.push(frame);
	await runner.close();
	const result = again.find(frame => frame.type === "tool.done" && frame.callId === "r1");
	assert.deepEqual([result?.ok, result?.result?.installed, log], [true, true, ["t2 mark", "install"]], `the next turn installs it: ${JSON.stringify(result)}`);
	console.log("PASS outlive (runner): a Stop of the turn leaves the writer running; the next turn's motion_result installs it");
}

// --- 3. a place on a bone set after an install stays ---
{
	// a recording Studio: objects as rows, an attach writes the bone-frame numbers on the row, a take keeps its source
	const rows = new Map(), takes = new Map(), steps = [];
	let n = 0;
	const studio = {
		read: () => ({ characters: [{ id: "a", model: "x-bot-tpose", x: 0, z: 0, rot: 0, scale: 1 }], objects: [...rows.values()], document: { activeSceneId: "s", scenes: [{ id: "s", stage: { characters: [{ id: "a", ...(takes.has("a") ? { motionTake: { spec: { lowvis: takes.get("a") } } } : {}) }] } }] } }),
		invoke: async (action, args) => {
			steps.push([action, args]);
			if (action === "object.sculpt" || action === "object.add") { const id = `obj-${++n}`; rows.set(id, { id, name: args.name, renderer: "cube", x: args.placement.x, y: args.placement.y, z: args.placement.z, rot: args.placement.rot ?? 0, footprint: { width: 0.08, depth: 0.08 }, height: 0.1 }); return { receiptId: `r${n}`, affectedIds: [id] }; }
			if (action === "object.attach") rows.set(args.objectId, { ...rows.get(args.objectId), ...args.local, attach: { characterId: args.characterId, bone: args.bone } });
			if (action === "object.update") rows.set(args.id, { ...rows.get(args.id), ...args.patch });
			if (action === "motion.v4.install") takes.set(args.characterId, args.lowvis);
			return { receiptId: `r${++n}`, affectedIds: [args.objectId ?? args.id ?? args.characterId] };
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
	assert.ok(request.includes(`cup (size [0.08,0.1,0.08]) on a's rightHand at [${[clipPlace.x, clipPlace.y, clipPlace.z].map(r3).join(", ")}] m, turned [`), "the writer is told the place on the bone as it is");
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
	assert.match(request, /\(set by hand\)/, "the writer is told the place was set by hand");
	assert.match(request, /One set there by hand \(after the motion that attached it, or attached in the Studio\) keeps that place and turn on the bone when your clip keeps it on that bone; your clip's place for it is not drawn\./);
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
	console.log("PASS attached place: an edit after an install stays across the next install and a refit; unedited and detached ones take the clip's place; the writer is told");
}
