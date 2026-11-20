#!/usr/bin/env node
// The draft's stand-ins at the install, on the real door, runMotion, installClip and the Studio's own reducers
// (bin/agent/motion-draft.mjs, motion-door.mjs, motion-run.mjs): a stand-in removed and its id given to another object
// (in one script, or removed by another caller) is not taken as the prop; a grouped stand-in the agent shaped is the
// prop, at the final place and turn; motion_result first called once the writer has ended answers the result; an edit
// queued behind the install, the object's first, is in the result's motionFit.
import assert from "node:assert/strict";
import * as O from "../../src/scene-objects.js";
import { part, prop, recipe, scriptedWriter, shapeOf, stage, studioEditor, tick, turn, written } from "./studio-draft-harness.mjs";

const sit = { a1: [[0, "idle"], [10, "sit", { on: "bench" }]] };
const first = written(stage([prop("bench", [1.2, 0.45, 0.4], [0.2, 0, -0.7])]), sit);
const moved = written(stage([prop("bench", [1.4, 0.5, 0.4], [0.5, 0, -0.9], { turn: 15 })]), sit);
const taller = written(stage([prop("bench", [1.2, 0.55, 0.4], [0.2, 0, -0.7])]), sit);
const lampLook = recipe(part("pole", [0.1, 1.5, 0.1], [0, 0, 0]), part("shade", [0.4, 0.3, 0.4], [0, 1.5, 0]));
const lampAt = { x: 3, y: 0, z: -3 };
const r3 = v => Math.round(v * 1000) / 1000;

// another object under a removed stand-in's id: the agent's own script, or another caller's removal before the agent's call
for (const how of ["script", "outside"]) {
	const studio = studioEditor(), writer = scriptedWriter([first, moved]), t = turn({ studio, writer, key: `ids-${how}` });
	await t.call;
	await writer.step();
	await t.result();
	const bench = studio.named("bench")[0].id;
	let lamp;
	if (how === "script") lamp = (await t.tools.script({ steps: [["object.remove", { ids: [bench] }], ["object.sculpt", { name: "lamp", placement: lampAt, recipe: lampLook }]] })).calls[1].affectedIds[0];
	else {
		studio.outside(rows => O.removeSceneObject(rows, bench));
		lamp = (await t.tools.sculpt({ name: "lamp", placement: lampAt, recipe: lampLook })).affectedIds[0];
	}
	assert.equal(lamp, bench, `${how}: the Studio gives the removed id to the lamp`);
	await writer.step(); await writer.step();
	const done = await t.result();
	assert.deepEqual(shapeOf(studio.row(lamp)).base, [3, 0, -3], `${how}: the lamp stays where the agent put it`);
	assert.equal(studio.named("bench").length, 1, `${how}: the motion's bench is a new stand-in`);
	assert.ok(!done.propsSet.some(line => line.startsWith("lamp")), `${how}: no line calls the lamp the draft's stand-in`);
	assert.match(done.propsSet[0], new RegExp(`the draft's stand-in ${bench} is no longer in the scene\\.$`));
}
console.log("PASS draft ids: a removed stand-in's id given to another object (one script, another caller) is not taken as the prop");

// a removal undone by another caller (the stand-in back under the record it had, after an edit of it or not): the draft's
// again, at the install (one object, its look kept, at the final place) and at a failure (removed when untouched, named)
for (const [shaped, end] of [[true, "report"], [false, "report"], [false, "infra"], [true, "infra"]]) {
	const studio = studioEditor(), writer = scriptedWriter([first, moved], { end }), t = turn({ studio, writer, key: `undone-${shaped}-${end}` });
	await t.call;
	await writer.step();
	await t.result();
	const bench = studio.named("bench")[0].id;
	if (shaped) await t.tools.sculpt({ id: bench, recipe: recipe(part("seat", [1.2, 0.05, 0.4], [0, 0.4, 0]), part("leg", [0.1, 0.4, 0.4], [0, 0, 0])) });
	let before;
	studio.outside(rows => { before = rows; return O.removeSceneObject(rows, bench); });
	await t.tools.add({ kind: "cube", name: "backdrop", placement: { x: 4, y: 0, z: 4 } });
	studio.outside(() => before);
	await writer.step(); await writer.step();
	const label = `undone ${shaped ? "shaped" : "untouched"} ${end}`;
	if (end === "infra") {
		const error = await t.result().then(() => null, failure => failure);
		assert.ok(error, `${label}: the motion fails`);
		if (shaped) assert.deepEqual([studio.named("bench").length, error.message.includes(`left ${bench} (changed meanwhile)`)], [1, true], `${label}: ${error.message}`);
		else assert.deepEqual([studio.named("bench").length, error.message.includes(`removed ${bench} (not changed since the draft)`)], [0, true], `${label}: ${error.message}`);
		continue;
	}
	const done = await t.result(), row = studio.row(bench);
	assert.equal(studio.named("bench").length, 1, `${label}: one object for the prop`);
	assert.deepEqual([shapeOf(row).base.map(r3), r3(row.rot), row.recipe?.parts?.length ?? 1], [[0.5, 0, -0.9], 15, shaped ? 2 : 1], `${label}: the stand-in at the final place and turn`);
	assert.ok(!(done.propsSet ?? []).some(line => line.includes("no longer in the scene")), `${label}: ${JSON.stringify(done.propsSet)}`);
}
console.log("PASS draft ids: a stand-in whose removal was undone is the draft's again, at the install and at a failure");

// a shaped stand-in in a group: the motion's prop, set to the final place and turn, one object
{
	const studio = studioEditor(), writer = scriptedWriter([first, moved]), t = turn({ studio, writer, key: "grouped" });
	await t.call;
	await writer.step();
	await t.result();
	const bench = studio.named("bench")[0].id, holder = (await t.tools.add({ kind: "cube", name: "holder", placement: { x: 3, y: 0, z: 3 } })).affectedIds[0];
	await t.tools.sculpt({ id: bench, recipe: recipe(part("seat", [1.2, 0.05, 0.4], [0, 0.4, 0]), part("leg", [0.1, 0.4, 0.4], [0, 0, 0])) });
	await t.tools.group({ parent: holder, children: [bench] });
	await writer.step(); await writer.step();
	const done = await t.result();
	const row = studio.row(bench);
	assert.equal(studio.named("bench").length, 1, "one object for the prop");
	assert.deepEqual([shapeOf(row).base.map(r3), r3(row.rot), row.parent, row.recipe.parts.length], [[0.5, 0, -0.9], 15, holder, 2], "final place and turn, in its group, its look kept");
	assert.ok(done.used.includes(`${bench} (bench)`), done.used);
}
console.log("PASS draft ids: a shaped stand-in in a group is the motion's prop at the final place and turn");

// motion_result first called after the writer has ended answers the installed result, not the draft
{
	const studio = studioEditor(), writer = scriptedWriter([first, moved]), t = turn({ studio, writer, key: "late" });
	await t.call;
	await writer.step(); await writer.step(); await writer.step();
	const done = await t.result();
	assert.equal(done.draft, undefined, "no draft answer once the writer has ended");
	assert.match(done.used, /bench/);
}
console.log("PASS draft ids: motion_result first called after the writer ended answers the result");

// the first edit of a stand-in, sent while the install holds the scene, is in the result's motionFit
{
	const studio = studioEditor({ slow: action => (action === "motion.v4.install" ? 60 : 0) }), writer = scriptedWriter([first, taller]), t = turn({ studio, writer, key: "queued-first" });
	await t.call;
	await writer.step();
	await t.result();
	const bench = studio.named("bench")[0].id;
	await writer.step(); await writer.step();
	while (!studio.calls.some(call => call.action === "motion.v4.install")) await tick();
	const own = await t.tools.sculpt({ id: bench, recipe: recipe(part("seat", [1.2, 0.05, 0.4], [0, 0.4, 0]), part("leg", [0.1, 0.4, 0.4], [0, 0, 0])) });
	const done = await t.result();
	assert.equal(own.motionFit.fits, false, "the edit's own answer: the top is not at the final box's");
	assert.ok(done.motionFit?.objects?.some(entry => entry.id === bench), `the result's motionFit names it: ${JSON.stringify(done.motionFit)}`);
}
console.log("PASS draft ids: an edit queued behind the install, the object's first, is in the result's motionFit");
