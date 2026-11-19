#!/usr/bin/env node
// The draft's edges (bin/agent/motion-draft.mjs) on the real door, runMotion, installClip and the Studio's own reducers:
// a motion that fails, is stopped or is refused after the draft removes only its untouched stand-ins and says so; before
// the draft it is the baseline's; a stand-in removed, grouped or of another kind at the end; a refused draft; a second
// motion in the same scene; an object of the agent's where a prop goes; the turn ending between the draft and the install.
import assert from "node:assert/strict";
import { boxesOf } from "../../bin/agent/motion-fit.mjs";
import { part, prop, recipe, scriptedWriter, shapeOf, stage, studioEditor, tick, turn, written } from "./studio-draft-harness.mjs";

const r2 = v => Math.round(v * 100) / 100;
const list = v => `[${v.map(r2).join(", ")}]`;
const box = v => `${v.map(r2).join(" x ")} m`;
const idle = { a1: [[0, "idle"]] };
const two = written(stage([prop("bench", [1.2, 0.45, 0.4], [1, 0, 1]), prop("crate", [0.5, 0.3, 0.4], [-1, 0, 1])]), idle);
const look = recipe(part("seat", [1.2, 0.05, 0.4], [0, 0.4, 0]), part("legA", [0.05, 0.4, 0.4], [-0.55, 0, 0]), part("legB", [0.05, 0.4, 0.4], [0.55, 0, 0]));

// a motion that fails after the draft: the proxy, a stop, the Studio's refusal of the install
for (const how of ["infra", "stop", "refused"]) {
	const studio = studioEditor({ refuse: action => how === "refused" && action === "motion.v4.install" });
	const writer = scriptedWriter([two], { end: how === "infra" ? "infra" : "report" });
	const t = turn({ studio, writer, key: `fail-${how}` });
	await t.call;
	await writer.step();
	const draft = await t.result();
	const bench = studio.named("bench")[0].id, crate = studio.named("crate")[0].id;
	assert.ok(draft.draft && boxesOf(`fail-${how}`).has(bench), `${how}: the draft's boxes are kept`);
	await t.tools.sculpt({ id: bench, recipe: look });
	let error;
	if (how === "stop") { assert.equal(await t.door.unfinished({ failed: true }), null); }
	else { await writer.step(); error = await t.result().then(() => null, e => e); }
	await tick();
	assert.deepEqual(studio.rows().map(row => row.id), [bench], `${how}: the shaped bench stays, the untouched crate is gone`);
	assert.equal(boxesOf(`fail-${how}`).size, 0, `${how}: the draft's boxes are dropped with it`);
	if (error) {
		assert.equal(error.code, how === "infra" ? "upstream" : "studio");
		assert.ok(error.message.endsWith(` The draft's stand-ins: removed ${crate} (not changed since the draft); left ${bench} (changed meanwhile).`), error.message);
	}
}
console.log("PASS draft edges: a motion that fails, is stopped or is refused after the draft removes its untouched stand-ins and says what it removed and left");

// a motion that fails before the draft: nothing added, the error as in the baseline
{
	const studio = studioEditor(), writer = scriptedWriter([null], { end: "infra" });
	const t = turn({ studio, writer, key: "early-fail" });
	await t.call;
	await writer.step(); await writer.step();
	const error = await t.result().then(() => null, e => e);
	assert.equal(error.message, "The model or the proxy failed: the proxy failed");
	assert.equal(studio.rows().length, 0);
	const none = scriptedWriter([null], { end: "report" }), s2 = studioEditor(), t2 = turn({ studio: s2, writer: none, key: "no-scene" });
	await t2.call; await none.step(); await none.step();
	assert.deepEqual([(await t2.result()).frames, s2.rows().length], [0, 0], "a report without a scene: frames 0, nothing added");
}
console.log("PASS draft edges: before the draft a failure adds nothing and answers as before");

// at the install: a stand-in removed meanwhile, one put in a group, an untouched one whose final box is another kind
{
	const studio = studioEditor();
	const first = written(stage([prop("bench", [1.2, 0.45, 0.4], [1, 0, 1]), prop("crate", [0.5, 0.3, 0.4], [-1, 0, 1]), prop("board", [0.6, 0.2, 0.3], [0, 0, 2])]), idle);
	const last = written(stage([prop("bench", [1.2, 0.45, 0.4], [1, 0, 1]), prop("crate", [0.5, 0.3, 0.4], [-1, 0, 1]), prop("board", [0.6, 0.03, 0.3], [0, 0, 2])]), idle);
	const writer = scriptedWriter([first, last]), t = turn({ studio, writer, key: "ends" });
	await t.call;
	await writer.step();
	await t.result();
	const ids = Object.fromEntries(["bench", "crate", "board"].map(name => [name, studio.named(name)[0].id]));
	const group = (await t.tools.add({ kind: "cube", name: "holder", placement: { x: 3, y: 0, z: 3 } })).affectedIds[0];
	await t.tools.remove({ ids: [ids.bench] });
	await t.tools.group({ parent: group, children: [ids.crate] });
	// the next sculpt gets the removed bench's id: it is the agent's lamp, not the draft's stand-in
	const lamp = (await t.tools.sculpt({ name: "lamp", placement: { x: 3, y: 0, z: -3 }, recipe: recipe(part("pole", [0.1, 1.5, 0.1], [0, 0, 0])) })).affectedIds[0];
	assert.equal(lamp, ids.bench, "the Studio reuses the removed id");
	await writer.step(); await writer.step();
	const done = await t.result();
	assert.deepEqual(shapeOf(studio.row(lamp)).base, [3, 0, -3], "the lamp under the reused id stays where the agent put it");
	assert.equal(studio.row(lamp).name, "lamp");
	const [bench] = studio.named("bench"), crate = studio.named("crate").find(row => row.id !== ids.crate), board = studio.named("board")[0];
	assert.ok(studio.named("bench").length === 1 && crate && board && board.id !== ids.board && board.renderer === "cube", "new stand-ins for the removed, the grouped and the other kind");
	assert.equal(studio.row(ids.board), undefined, "the untouched board of another kind is removed");
	assert.equal(studio.row(ids.crate).parent, group, "the grouped crate stays where the agent put it");
	const line = (row, why) => `${row.name} (${row.id}): the motion added it as a stand-in, ${box(shapeOf(row).size)}, base ${list(shapeOf(row).base)}; ${why}.`;
	assert.deepEqual(done.propsSet, [
		line(bench, `the draft's stand-in ${ids.bench} is no longer in the scene`),
		line(crate, `the draft's stand-in ${ids.crate} is in a group and stays as it is`),
		line(board, `it replaces the draft's stand-in ${ids.board}, removed: the final box needs another kind of object`),
	]);
}
console.log("PASS draft edges: a removed, grouped or other-kind stand-in gets a new one, with a line each");

// a refused draft: no draft answer, the install makes the stand-ins as before
{
	let once = true;
	const studio = studioEditor({ refuse: (action, args) => { if (action === "object.sculpt" && args.name === "crate" && once) { once = false; return true; } return false; } });
	const writer = scriptedWriter([two]), t = turn({ studio, writer, key: "refused-draft" });
	await t.call;
	const early = t.result();
	await writer.step();
	assert.equal(studio.rows().length, 0, "the draft's bench is rolled back with the refused crate");
	await writer.step();
	const done = await early;
	assert.equal(done.draft, undefined, "no draft: motion_result answers the result");
	assert.deepEqual(studio.rows().map(row => row.name).sort(), ["bench", "crate"]);
	assert.equal(done.propsSet, undefined, "no draft, no propsSet");
}
console.log("PASS draft edges: a refused draft is rolled back and the motion installs as before");

// a second motion in the same scene; an object of the agent's made before the draft where a prop goes; never collected
{
	const studio = studioEditor(), key = "again";
	const w1 = scriptedWriter([two]), t1 = turn({ studio, writer: w1, key });
	await t1.call;
	const lamp = (await t1.tools.sculpt({ name: "lamp", placement: { x: 1, y: 0, z: 1 }, recipe: recipe(part("pole", [0.1, 1.5, 0.1], [0, 0, 0])) })).affectedIds[0];
	await w1.step();
	assert.deepEqual(studio.row(lamp) && shapeOf(studio.row(lamp)).base, [1, 0, 1], "the agent's object made before the draft is not moved");
	await w1.step();
	const handed = await t1.door.unfinished();
	assert.match(handed, /^Studio motion observation: the motion started in this turn has ended\. Its result, as motion_result answers it:\n\{"ok":true/, "never collected: the installed result is handed over");
	assert.ok(!/"draft":true/.test(handed));
	const ids = studio.rows().map(row => row.id);
	const w2 = scriptedWriter([written(stage([prop("bench", [1.2, 0.45, 0.4], [1, 0, 1]), prop("crate", [0.5, 0.3, 0.4], [-1, 0, 1]), prop("step", [0.4, 0.2, 0.3], [0, 0, 2])]), idle)]);
	const t2 = turn({ studio, writer: w2, key });
	await t2.call;
	await w2.step();
	const draft = await t2.result();
	assert.equal(draft.standIns.length, 1, "the second motion's draft adds only what the scene lacks");
	assert.match(draft.standIns[0], /^step \(/);
	assert.match(w2.requests[0], /"id":"bench"/, "the second writer reads the first motion's stand-ins as scene props");
	await w2.step();
	await t2.result();
	assert.deepEqual(studio.rows().map(row => row.id).sort(), [...ids, studio.named("step")[0].id].sort());
}
console.log("PASS draft edges: a second motion drafts only what the scene lacks; the agent's earlier object is not moved; an uncollected motion hands over the installed result");
