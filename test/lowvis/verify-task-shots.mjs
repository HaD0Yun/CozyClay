#!/usr/bin/env node
// Tasks that run beside each other through the real command bus: a camera task makes its shot (shot.create in free
// frames needs no key: the shot joins the task) and frames it while a dress task changes an object it holds; two
// shot-creating tasks at once leave shots that do not overlap and a frame count nobody changed; a create that must
// lengthen the take writes timeline, which a task without it is refused and cannot get while another task is open.
import assert from "node:assert/strict";
import { objectsFixture } from "../bus/objects-fixture.mjs";
import { commandKeys } from "../../src/bus-task-scopes.js";

const ok = receipt => { assert.equal(receipt.ok, true, JSON.stringify(receipt)); return receipt; };
const refused = (receipt, code) => { assert.equal(receipt.ok, false, JSON.stringify(receipt)); assert.equal(receipt.code, code, receipt.message); return receipt; };

// the key a create writes, read from the state alone
{
	assert.deepEqual(commandKeys("shot.create", {}, { shots: [], frameCount: 48 }), [], "an empty timeline has free frames");
	assert.deepEqual(commandKeys("shot.create", {}, { shots: [{ id: "s1", startFrame: 0, endFrame: 47 }], frameCount: 48, view: { frame: 10 } }), ["timeline"], "a full timeline must grow");
	const two = { shots: [{ id: "s1", startFrame: 0, endFrame: 47 }, { id: "s2", startFrame: 100, endFrame: 147 }], frameCount: 240 };
	assert.deepEqual(commandKeys("shot.setRange", { shotId: "s1", range: { startFrame: 0, endFrameExclusive: 100 } }, two), ["shot:s1"], "a range over free frames writes the shot alone");
	assert.deepEqual(commandKeys("shot.setRange", { shotId: "s1", range: { startFrame: 0, endFrameExclusive: 101 } }, two), ["timeline"], "into another shot's frames");
	assert.deepEqual(commandKeys("shot.setRange", { shotId: "s1", range: { startFrame: 0, endFrameExclusive: 241 } }, two), ["timeline"], "past the frame count");
	for (const id of ["shot.setRange", "shot.remove", "shot.reorder", "shot.setTimeline", "shot.split", "shot.duplicate"]) assert.deepEqual(commandKeys(id, { shotId: "s1" }, { shots: [] }), ["timeline"], id);
	console.log("PASS commandKeys: shot.create in free frames needs no key; one that grows the take, and every re-timing, writes timeline");
}

{
	const f = objectsFixture();
	try {
		const run = taskId => (action, args = {}) => f.run(action, args, "agent", { taskId, expectedRevision: 0 });
		const state = () => f.actual.readStudioState();
		const cube = f.store.current.objects.find(o => o.renderer === "cube").id;
		ok(f.run("shot.setTimeline", { frameCount: 240 }, "ui")); // room for several shots
		ok(run("task-dress")("task.begin", { taskId: "task-dress", scope: [`object:${cube}`] }));
		ok(run("task-cam")("task.begin", { taskId: "task-cam", scope: [] }));
		ok(run("task-cam2")("task.begin", { taskId: "task-cam2", scope: [] }));
		const frames = state().frameCount, before = state().shots.length;
		// the camera task and the dress task interleave
		const shot = ok(run("task-cam")("shot.create")).affectedIds[0];
		ok(run("task-dress")("object.set", { id: cube, set: { name: "Dressed" } }));
		ok(run("task-cam")("shot.rename", { shotId: shot, name: "Wide" }));
		ok(run("task-dress")("object.set", { id: cube, set: { position: { x: 1, y: 0, z: 0 } } }));
		refused(run("task-cam2")("shot.rename", { shotId: shot, name: "Mine" }), "SCOPE_DENIED");
		const own = state().shots.find(s => s.id === shot), next = state().shots.filter(s => s.startFrame > own.endFrame).map(s => s.startFrame);
		const end = Math.min(state().frameCount, ...next);
		ok(run("task-cam")("shot.setRange", { shotId: shot, range: { startFrame: own.startFrame, endFrameExclusive: end } }));
		assert.equal(state().shots.find(s => s.id === shot).endFrame, end - 1, "the camera task stretched its shot over the free frames");
		ok(run("task-cam")("shot.setRange", { shotId: shot, range: { startFrame: own.startFrame, endFrameExclusive: own.endFrame + 1 } }));
		console.log("PASS a camera task makes and names its shot while a dress task edits its object; the shot is the camera task's");
		// a second creator beside the first: shots never overlap, the frame count stays, until no free frames are left
		let made = 1, guard = 0;
		while (!commandKeys("shot.create", {}, state()).length && guard++ < 20) { ok(run(made % 2 ? "task-cam2" : "task-cam")("shot.create")); made++; }
		const shots = [...state().shots].sort((a, b) => a.startFrame - b.startFrame);
		assert.equal(shots.length, before + made);
		assert.ok(made >= 3, `both tasks made shots (${made})`);
		for (let i = 1; i < shots.length; i++) assert.ok(shots[i].startFrame > shots[i - 1].endFrame, `shots ${shots[i - 1].id} and ${shots[i].id} overlap`);
		assert.ok(shots.every(s => s.endFrame < frames), "every shot inside the frame count");
		assert.equal(state().frameCount, frames, "no task changed the frame count");
		// the timeline is full: the next create would lengthen the take, which only a task holding timeline may do
		refused(run("task-cam")("shot.create"), "SCOPE_DENIED");
		refused(run("task-cam")("task.requestScope", { taskId: "task-cam", scope: ["timeline"] }), "SCOPE_BUSY");
		for (const id of ["task-dress", "task-cam2"]) ok(run(id)("task.finish", { taskId: id }));
		ok(run("task-cam")("task.requestScope", { taskId: "task-cam", scope: ["timeline"] }));
		ok(run("task-cam")("shot.create"));
		assert.ok(state().frameCount > frames, "with timeline it grows the take");
		ok(run("task-cam")("task.finish", { taskId: "task-cam" }));
		console.log(`PASS two shot-creating tasks: ${made} shots without overlap in ${frames} frames; growing the take waits for timeline alone`);
	} finally { f.dispose(); }
}
