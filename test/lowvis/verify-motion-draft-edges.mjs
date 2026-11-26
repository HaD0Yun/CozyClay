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
	let refusing = true;
	const studio = studioEditor({ refuse: action => how === "refused" && refusing && action === "motion.v4.install" });
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
	else { await writer.step(); error = await t.result().then(answer => answer, e => e); }
	await tick();
	assert.deepEqual(studio.rows().map(row => row.id), [bench], `${how}: the shaped bench stays, the untouched crate is gone`);
	assert.equal(boxesOf(`fail-${how}`).size, 0, `${how}: the draft's boxes are dropped with it`);
	// a proxy that fails after a compile: nothing is installed and the answer says so, with what exists (rule 7)
	if (how === "infra") {
		assert.equal(error.installed, false);
		assert.ok(error.notInstalled.startsWith("The motion writer failed (the proxy failed) before its report, so its last compiled motion (compile "), error.notInstalled);
		assert.ok(error.notInstalled.endsWith(` The draft's stand-ins: removed ${crate} (not changed since the draft); left ${bench} (changed meanwhile).`), error.notInstalled);
		// installed on request, that motion takes the stand-in the agent shaped as its prop (no second bench) and adds the crate again
		const put = await t.door.with([]).find(tool => tool.name === "motion_result").handler({ install: true });
		assert.equal(put.installed, true);
		assert.deepEqual([studio.named("bench").map(row => row.id), studio.named("crate").length, studio.rows().length], [[bench], 1, 2], `the offered install uses the shaped stand-in: ${JSON.stringify(studio.rows().map(row => row.name))}`);
	} else if (error) {
		assert.equal(error.code, "studio");
		assert.ok(error.message.endsWith(` The draft's stand-ins: removed ${crate} (not changed since the draft); left ${bench} (changed meanwhile). The compiled motion is kept: motion_result with install: true installs it.`), error.message);
		// the refused install keeps its compiled motion offered: once the Studio takes it, it goes in without the writer
		refusing = false;
		const put = await t.door.with([]).find(tool => tool.name === "motion_result").handler({ install: true });
		assert.equal(put.installed, true, "the kept motion installs on request");
		assert.deepEqual([studio.named("bench").map(row => row.id), studio.named("crate").length], [[bench], 1], "on the stand-in the agent shaped");
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

// at the install: a stand-in removed meanwhile, one put in a group (the prop, moved as any object), an untouched one whose final box is another kind
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
	const [bench] = studio.named("bench"), board = studio.named("board")[0];
	assert.ok(studio.named("bench").length === 1 && board && board.id !== ids.board && board.renderer === "cube", "new stand-ins for the removed and the other kind");
	assert.equal(studio.row(ids.board), undefined, "the untouched board of another kind is removed");
	assert.deepEqual(studio.named("crate").map(row => [row.id, row.parent]), [[ids.crate, group]], "the grouped crate is the motion's crate and stays in its group: one object");
	assert.ok(done.used.includes(`${ids.crate} (crate)`), done.used);
	const line = (row, why) => `${row.name} (${row.id}): the motion added it as a stand-in, ${box(shapeOf(row).size)}, base ${list(shapeOf(row).base)}; ${why}.`;
	assert.deepEqual(done.propsSet, [
		line(bench, `the draft's stand-in ${ids.bench} is no longer in the scene`),
		line(board, `it replaces the draft's stand-in ${ids.board}, removed: the final box needs another kind of object`),
	]);
}
console.log("PASS draft edges: a removed or other-kind stand-in gets a new one, with a line each; a grouped one is the motion's prop");

// an edit sent while the install holds the scene runs after it: the result's motionFit is the scene after that edit,
// its propsSet what the install itself set
{
	const studio = studioEditor({ slow: action => (action === "motion.v4.install" ? 60 : 0) }), writer = scriptedWriter([two]), t = turn({ studio, writer, key: "queued" });
	await t.call;
	await writer.step();
	await t.result();
	const bench = studio.named("bench")[0].id;
	await t.tools.sculpt({ id: bench, recipe: recipe(part("seat", [1.2, 0.05, 0.4], [0, 0.3, 0]), part("legA", [0.05, 0.3, 0.4], [-0.55, 0, 0])) });
	while (!writer.release) await tick();
	await tick();
	writer.release();
	while (!studio.calls.some(call => call.action === "motion.v4.install")) await new Promise(resolve => setImmediate(resolve));
	const fixed = t.tools.sculpt({ id: bench, recipe: look }); // the install is still running: this edit waits for it
	const done = await t.result();
	assert.equal((await fixed).motionFit.fits, true, "the queued edit fits");
	assert.equal(done.motionFit, undefined, "the result measures the scene after the queued edit: nothing differs");
	assert.equal(done.propsSet, undefined, "the install changed nothing since the draft");
}
console.log("PASS draft edges: an edit queued behind the install is in the result's motionFit");

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

// the writer's first scene, streamed whole before its compile: its stand-ins are made ahead and the agent is not told;
// the first compile answers the draft with them (its contacts and floor, as without a scene ahead), and its facts once;
// a later tool answer carries the motion's state when it changed; the result names its compile and what differs since
{
	const studio = studioEditor(), writer = scriptedWriter([two, written(stage([prop("bench", [1.2, 0.45, 0.4], [1.3, 0, 1]), prop("crate", [0.5, 0.3, 0.4], [-1, 0, 1])]), idle)], { scenes: true }), t = turn({ studio, writer, key: "scene-first" });
	assert.deepEqual((await t.call).held, ["a1"]);
	let draft = null;
	const early = t.result().then(value => { draft = value; });
	await writer.step();
	const ahead = studio.rows().map(row => row.id);
	assert.deepEqual([studio.rows().map(row => row.name), draft], [["bench", "crate"], null], "the stand-ins are in the scene; no draft is answered before a compile");
	await writer.step();
	await early;
	assert.deepEqual([draft.compile, draft.standIns.map(line => line.split(" (")[0]), studio.rows().map(row => row.id)], [1, ["bench", "crate"], ahead], "the first compile answers the draft with the stand-ins made ahead");
	assert.match(draft.used, /The bodies cross the floor within/);
	assert.deepEqual([draft.facts.compile, /^f0 hips \[.+\] facing \d+; f59 hips \[/.test(draft.facts.bodies.a1), draft.facts.rows], [1, true, undefined], "with that compile's facts");
	const bench = studio.named("bench")[0].id;
	assert.equal((await t.tools.sculpt({ id: bench, recipe: look })).motion, undefined, "nothing new to tell: the draft said the state");
	await writer.step(); await writer.step();
	assert.deepEqual((await t.tools.sculpt({ id: bench, recipe: look })).motion, { state: "being written, not installed: compile 2 went through" }, "the state, when it changed; the facts were told");
	assert.equal((await t.tools.sculpt({ id: bench, recipe: look })).motion, undefined, "told once until the state changes");
	await writer.step();
	const done = await t.result();
	assert.deepEqual([done.installed, done.facts, done.factsSince], [true, { compile: 2 }, { compile: 1, same: true }], "the bench moved, the body did not: the facts are not told again");
	assert.equal(studio.rows().length, 2, "no second stand-in of either prop");
}
// a first call whose compile is rejected, then another scene: the draft is the first compile's, as without a scene
// ahead: a stand-in made ahead that is no longer that compile's box is made again, one whose prop is gone is removed,
// and one another caller changed meanwhile stays as it is
for (const touch of [false, true]) {
	const first = stage([prop("bench", [1.2, 0.45, 0.4], [1, 0, 1]), prop("crate", [0.5, 0.3, 0.4], [-1, 0, 1]), prop("post", [0.1, 1, 0.1], [2, 0, 2])]);
	const second = written(stage([prop("bench", [1.6, 0.5, 0.4], [1, 0, 1]), prop("crate", [0.5, 0.3, 0.4], [-1, 0, 1]), prop("mat", [0.6, 0.02, 0.4], [0, 0, -1])]), idle);
	const studio = studioEditor(), writer = scriptedWriter([{ scene: first }, second], { scenes: true }), t = turn({ studio, writer, key: `scene-rejected-${touch}` });
	await t.call;
	let draft = null;
	const early = t.result().then(value => { draft = value; });
	await writer.step(); await writer.step();
	assert.deepEqual([studio.rows().map(row => row.name), draft], [["bench", "crate", "post"], null], "a rejected call answers no draft");
	const crate = studio.named("crate")[0].id, bench = studio.named("bench")[0].id;
	if (touch) studio.outside(rows => rows.map(row => (row.id === bench ? { ...row, color: "#123456" } : row)));
	await writer.step(); await writer.step();
	await early;
	const size = name => shapeOf(studio.named(name)[0]).size.map(r2);
	assert.deepEqual([draft.compile, studio.rows().map(row => row.name).sort(), studio.named("crate")[0].id, size("bench")], [2, ["bench", "crate", "mat"], crate, touch ? [1.2, 0.45, 0.4] : [1.6, 0.5, 0.4]], `touched ${touch}: the draft is compile 2's: ${JSON.stringify(draft.standIns)}`);
	assert.ok(draft.standIns.some(line => line.startsWith("bench (") && line.includes(touch ? "1.2 x 0.45 x 0.4 m" : "1.6 x 0.5 x 0.4 m")), "and names each stand-in as the Studio holds it");
	await writer.step();
	assert.equal((await t.result()).installed, true);
	assert.deepEqual(studio.rows().map(row => row.name).sort(), ["bench", "crate", "mat"], "one stand-in of each prop of the motion");
}
// a tool call of the agent that runs while the first compile goes through, after stand-ins were made ahead: it ends,
// and so does the motion (the watch of the stand-ins never waits for the draft's own steps)
{
	const studio = studioEditor({ slow: action => (action === "object.update" ? 30 : 0) }), writer = scriptedWriter([two, two], { scenes: true }), t = turn({ studio, writer, key: "scene-busy" });
	await t.call;
	await writer.step();
	const slow = t.tools.update({ id: studio.named("crate")[0].id, patch: { name: "crate" } });
	await writer.step();
	const ended = await Promise.race([slow.then(() => "ended"), new Promise(resolve => setTimeout(() => resolve("hangs"), 2000))]);
	assert.equal(ended, "ended", "the call in flight at the first compile returns");
	assert.equal((await t.result()).compile, 1);
	await writer.step(); await writer.step(); await writer.step();
	assert.equal((await t.result()).installed, true);
}
{
	const studio = studioEditor(), writer = scriptedWriter([written(stage([]), idle)], { scenes: true }), t = turn({ studio, writer, key: "scene-none" });
	await t.call;
	await writer.step();
	assert.equal(studio.rows().length, 0);
	await writer.step();
	assert.equal((await t.result()).compile, 1, "a scene of no new prop: nothing is made ahead");
}
// a motion that ends before any compile owns what was made ahead: the stand-ins not changed since are removed and named
{
	const studio = studioEditor(), writer = scriptedWriter([{ scene: two.scene }], { scenes: true, end: "infra" }), t = turn({ studio, writer, key: "scene-fail" });
	await t.call;
	await writer.step();
	const ids = studio.rows().map(row => row.id);
	await writer.step(); await writer.step();
	const error = await t.result().then(answer => answer, e => e);
	assert.deepEqual([error.code, error.message, studio.rows().length], ["upstream", `The model or the proxy failed: the proxy failed. The draft's stand-ins: removed ${ids.join(", ")} (not changed since the draft).`, 0]);
}
console.log("PASS draft edges: the first scene's stand-ins are made ahead and the first compile answers the draft with them; a rejected first call, a call in flight and an early failure leave what the baseline leaves; state and facts reach the agent once");
