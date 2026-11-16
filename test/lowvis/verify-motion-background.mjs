#!/usr/bin/env node
// A plain turn's motion runs while the agent works (bin/agent/motion-door.mjs background, agent-runner.mjs finishTurn):
// a stub motion writer that takes time, a scripted model on the real runner. The agent sends model requests and runs a
// tool between the motion's start and its end, motion_result answers the full result, a turn that would end first gets
// the result as a message and goes on, and an edit of what the motion was written against is rolled back and refused.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createAgentRunner } from "../../bin/agent/agent-runner.mjs";
import { createMotionDoor } from "../../bin/agent/motion-door.mjs";
import { createFakeModel } from "../fixtures/fake-model.mjs";

process.env.COZYCLAY_AGENT_SESSIONS_DIR = mkdtempSync(join(tmpdir(), "cozyclay-motion-background-"));
const DONE = { report: "She sits on the bench.\nMissing: the hands do not rest on the knees.", missing: "the hands do not rest on the knees.", frames: 96, clipSeconds: 4, tookSeconds: 120, compiles: 3, characterIds: ["c1"], objectIds: ["bench"], switched: [], used: "The motion uses these objects as boxes (bench (bench): 1 x 0.45 x 0.4, [0, 0, 1])." };
const ANSWER = { ok: true, report: DONE.report, missing: DONE.missing, frames: 96, clipSeconds: 4, tookSeconds: 120, compiles: 3, characters: ["c1"], objects: ["bench"], switched: [], used: DONE.used };
const tick = () => new Promise(resolve => setTimeout(resolve, 5));
const until = async test => { for (let i = 0; i < 400 && !test(); i++) await tick(); assert.ok(test(), "timed out"); };

/** A stub motion writer: it reads the scene (onScene), waits for release(), then installs under exclusive. */
function stubMotion({ held = { characters: { c1: "c1" }, props: { bench: { id: "bench" } } }, fail = null } = {}) {
	const log = [], gate = {};
	const run = async ({ signal, onScene, exclusive }) => {
		log.push(["motion.start", performance.now()]);
		onScene?.(held);
		await new Promise((resolve, reject) => { gate.release = resolve; signal?.addEventListener("abort", () => reject(Object.assign(new Error("The turn was stopped."), { code: "aborted" })), { once: true }); });
		const done = await (exclusive ?? (install => install()))(async () => { log.push(["install", performance.now()]); if (fail) throw fail; return DONE; });
		log.push(["motion.end", performance.now()]);
		return done;
	};
	return { run, log, gate };
}
const transaction = () => { const calls = []; return { calls, mark: async () => { calls.push("mark"); return {}; }, rollback: async () => { calls.push("rollback"); return { receiptId: "r" }; } }; };
const collect = async (session, input) => { const frames = []; for await (const frame of session.start(input)) frames.push(frame); return frames; };
const textOf = message => (Array.isArray(message?.content) ? message.content.map(part => part?.text ?? "").join("") : String(message?.content ?? ""));

// 1. The agent works while the motion runs, then collects it with motion_result.
{
	const fake = createFakeModel(), motion = stubMotion(), tx = transaction(), requests = [];
	const door = createMotionDoor({ run: motion.run, mark: tx.mark, rollback: tx.rollback, background: true });
	const light = { name: "add_light", description: "adds a light", parameters: { type: "object", properties: {}, additionalProperties: false }, handler: async () => { motion.log.push(["light", performance.now()]); return { ok: true, affectedIds: ["lamp"] }; } };
	const reply = message => async context => { requests.push({ at: performance.now(), context }); return message; };
	fake.fauxProvider.setResponses([
		reply(fauxAssistantMessage([fauxToolCall("motion", { request: "c1 sits on the bench" }, { id: "m1" })])),
		reply(fauxAssistantMessage([fauxToolCall("add_light", {}, { id: "l1" })])),
		async context => { requests.push({ at: performance.now(), context }); motion.gate.release(); return fauxAssistantMessage([fauxToolCall("motion_result", {}, { id: "r1" })]); },
		reply(fauxAssistantMessage([fauxText("She sits. Missing: the hands do not rest on the knees.")])),
	]);
	const runner = createAgentRunner({ models: fake.models, fauxProvider: fake.fauxProvider });
	const session = await runner.openSession("bg-collect");
	const frames = await collect(session, { text: "she sits on the bench", model: "faux/scripted", tools: door.with([light]), unfinished: door.unfinished });
	await runner.close();
	const at = name => motion.log.find(entry => entry[0] === name)?.[1];
	const inside = requests.filter(request => request.at >= at("motion.start") && request.at <= at("motion.end")).length;
	assert.ok(inside >= 2, `model requests between motion start and end: ${inside}`);
	assert.ok(at("light") > at("motion.start") && at("light") < at("motion.end"), "a tool ran while the motion was written");
	const started = frames.find(frame => frame.type === "tool.done" && frame.callId === "m1"), result = frames.find(frame => frame.type === "tool.done" && frame.callId === "r1");
	assert.deepEqual(started.result, { ok: true, started: true });
	assert.deepEqual(result.result, ANSWER, "motion_result answers what the waiting tool answered");
	assert.ok(frames.at(-1).type === "done" && !frames.some(frame => frame.type === "error"));
	assert.deepEqual(tx.calls, ["mark", "mark"], "the light call and the install each ran under a mark; nothing was rolled back");
	console.log(`PASS background motion: ${inside} model requests and one tool call inside the motion, motion_result answers the full result`);
}

// 2. A turn that would end before collecting gets the result as a message and goes on.
{
	const fake = createFakeModel(), motion = stubMotion(), tx = transaction(), requests = [];
	const door = createMotionDoor({ run: motion.run, mark: tx.mark, rollback: tx.rollback, background: true });
	fake.fauxProvider.setResponses([
		async context => { requests.push({ at: performance.now(), context }); return fauxAssistantMessage([fauxToolCall("motion", { request: "c1 sits" }, { id: "m1" })]); },
		async context => { requests.push({ at: performance.now(), context }); setTimeout(() => motion.gate.release(), 50); return fauxAssistantMessage([fauxText("I am done.")]); },
		async context => { requests.push({ at: performance.now(), context }); return fauxAssistantMessage([fauxText("She sits. Missing: the hands do not rest on the knees.")]); },
	]);
	const runner = createAgentRunner({ models: fake.models, fauxProvider: fake.fauxProvider });
	const session = await runner.openSession("bg-forgot");
	const frames = await collect(session, { text: "she sits", model: "faux/scripted", tools: door.with([]), unfinished: door.unfinished });
	await runner.close();
	assert.equal(requests.length, 3, "the run went on after the model tried to end");
	const handed = requests[2].context.messages.at(-1);
	assert.equal(handed.role, "user");
	assert.equal(textOf(handed), `The motion started in this turn has ended. Its result, as motion_result answers it:\n${JSON.stringify(ANSWER)}`);
	assert.ok(requests[2].at >= motion.log.find(entry => entry[0] === "motion.end")[1], "the last request came after the motion ended");
	assert.equal(await door.unfinished(), null, "nothing is left uncollected");
	assert.ok(frames.at(-1).type === "done");
	console.log("PASS background motion: a turn that would end first is handed the result and cannot end uncollected");
}

// 3. While the motion runs: an edit of an id it was written against is rolled back and refused; others pass; the install
// waits for a running call; a second motion call is refused; a stop or a failed turn stops the motion.
{
	const motion = stubMotion(), tx = transaction();
	const door = createMotionDoor({ run: motion.run, mark: tx.mark, rollback: tx.rollback, background: true });
	let slow;
	const edit = { name: "edit", handler: async ({ id, wait }) => { if (wait) await new Promise(resolve => { slow = resolve; }); return { ok: true, affectedIds: [id] }; } };
	const script = { name: "script", handler: async () => ({ ok: true, calls: [{ ok: true, affectedIds: ["sky"] }, { ok: true, affectedIds: ["c1"] }] }) };
	const [guarded, scripted, , resultTool] = door.with([edit, script]);
	assert.deepEqual(await door.handler({ request: "c1 sits" }), { ok: true, started: true });
	await assert.rejects(door.handler({ request: "again" }), error => error.code === "MOTION_RUNNING");
	await assert.rejects(guarded.handler({ id: "bench" }), error => error.code === "MOTION_RUNNING" && /bench/.test(error.message) && /undone/.test(error.message));
	await assert.rejects(scripted.handler({}), error => error.code === "MOTION_RUNNING" && /c1/.test(error.message));
	assert.deepEqual(await guarded.handler({ id: "lamp" }), { ok: true, affectedIds: ["lamp"] });
	assert.deepEqual(tx.calls, ["mark", "rollback", "mark", "rollback", "mark"]);
	const running = guarded.handler({ id: "ground", wait: true });
	await until(() => slow);
	motion.gate.release();
	await tick(); await tick();
	assert.ok(!motion.log.some(entry => entry[0] === "install"), "the install waits for the call that holds the scene");
	slow();
	await running;
	assert.deepEqual(await resultTool.handler(), ANSWER);
	assert.deepEqual(await guarded.handler({ id: "bench" }), { ok: true, affectedIds: ["bench"] }, "after the install, edits of used objects run (motionFit tells the difference)");
	console.log("PASS background motion: edits of what the motion uses are refused until the install; the install waits its turn");

	const stopped = stubMotion(), door2 = createMotionDoor({ run: stopped.run, mark: tx.mark, rollback: tx.rollback, background: true });
	await door2.handler({ request: "c1 waves" });
	assert.equal(await door2.unfinished({ failed: true }), null);
	assert.ok(!stopped.log.some(entry => entry[0] === "install"), "a failed or stopped turn stops the motion; nothing is installed");

	const refused = stubMotion({ fail: Object.assign(new Error("refused"), { code: "studio" }) }), tx3 = transaction();
	const door3 = createMotionDoor({ run: refused.run, mark: tx3.mark, rollback: tx3.rollback, background: true });
	await door3.handler({ request: "c1 waves" });
	refused.gate.release();
	assert.match(await door3.unfinished(), /studio: refused$/, "a failed motion's error is handed over");
	assert.deepEqual(tx3.calls, ["mark", "rollback"], "the refused install rolls back only its own edits");

	let scene = "s1";
	const moved = stubMotion(), door4 = createMotionDoor({ run: moved.run, mark: tx.mark, rollback: tx.rollback, background: true, sceneOf: () => scene });
	await door4.handler({ request: "c1 waves" });
	scene = "s2";
	moved.gate.release();
	await assert.rejects(door4.with([])[1].handler(), error => error.code === "studio" && /Another scene was opened/.test(error.message));
	console.log("PASS background motion: a stop stops it, a refusal rolls back its own edits, another scene refuses the install");
}

// 4. A task's run (background false) waits for the motion as before and has no motion_result.
{
	const motion = stubMotion(), tx = transaction();
	const door = createMotionDoor({ run: motion.run, mark: tx.mark, rollback: tx.rollback });
	assert.deepEqual(door.with([]).map(tool => tool.name), ["motion"]);
	const pending = door.handler({ request: "c1 sits" });
	await until(() => motion.gate.release);
	motion.gate.release();
	assert.deepEqual(await pending, ANSWER);
	assert.equal(await door.unfinished(), null);
	console.log("PASS a waiting door answers the full result in the call itself");
}
