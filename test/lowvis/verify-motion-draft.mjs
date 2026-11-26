#!/usr/bin/env node
// The draft of a motion (bin/agent/motion-draft.mjs) on the real door, runMotion, installClip, turnFitView and the Studio's
// own object reducers and tops.js, with a scripted writer whose compiles the real engine builds:
//  1. a compile that fails adds nothing; the first that goes through adds its new props as the install's stand-ins and
//     motion_result (called before) answers the draft then, with numbers equal to the scene by this test's arithmetic;
//  2. the agent shapes a stand-in in the draft (several parts, a part above the top, one with no flat top at the box's
//     height); each edit answers motionFit against the draft's box, computed here again;
//  3. later compiles change a prop's size, place and turn, drop one, add one; at the install an untouched stand-in takes
//     the final size, place and turn, a shaped one keeps its parts and takes the final place and turn, a dropped untouched
//     one is removed, a dropped shaped one is kept, a new one is a stand-in; propsSet says what changed with the scene's numbers;
//  4. the writer reads the same request as without a draft; a call that waits adds nothing early.
import assert from "node:assert/strict";
import { part, prop, recipe, scriptedWriter, shapeOf, stage, studioEditor, tick, turn, written } from "./studio-draft-harness.mjs";

const r2 = v => Math.round(v * 100) / 100;
const list = v => `[${v.map(r2).join(", ")}]`;
const box = v => `${v.map(r2).join(" x ")} m`;
const near = (a, b, e = 1e-6) => a.every((v, k) => Math.abs(v - b[k]) <= e);
/** The base and turn of a clip prop at frame 0 by this test's own arithmetic (upright props). */
const frame0 = p => { const h = p.shape === "sphere" ? p.size[0] : p.size[1]; return { base: [p.pos[0], p.pos[1] - h / 2, p.pos[2]], turn: r2(2 * Math.atan2(p.quat[1], p.quat[3]) * 180 / Math.PI) }; };
const sizeOf = p => (p.shape === "sphere" ? [p.size[0], p.size[0], p.size[0]] : p.size);

// --- 1 to 3: a plain turn ---
{
	const studio = studioEditor();
	const first = written(stage([prop("stool", [0.4, 0.45, 0.4], [1, 0, 1]), prop("crate", [0.5, 0.3, 0.4], [-1, 0, 1], { turn: 30 }), prop("ball", [0.3], [0, 0, 2], { shape: "sphere" }), prop("mat", [0.6, 0.02, 0.4], [0, 0, -1])]), { a1: [[0, "idle"]] });
	const later = written(stage([prop("stool", [0.45, 0.5, 0.42], [1.2, 0, 0.8], { turn: 20 }), prop("crate", [0.55, 0.3, 0.4], [-1, 0, 1.1], { turn: 30 }), prop("mat", [0.6, 0.02, 0.4], [0, 0, -1]), prop("rail", [1.2, 0.9, 0.1], [0, 0, 3])]), { a1: [[0, "idle"]] });
	const writer = scriptedWriter([null, first, later]);
	const t = turn({ studio, writer });
	assert.deepEqual(await t.call, { ok: true, started: true, held: ["a1"] });
	let draft = null;
	const early = t.result().then(value => { draft = value; });
	await writer.step(); // compile 1 fails
	assert.equal(draft, null, "no draft before a compile goes through");
	assert.equal(studio.rows().length, 0, "a failed compile adds nothing");
	await writer.step(); // compile 2: the draft
	await early;
	assert.equal(draft.draft, true);
	assert.equal(draft.installed, false);
	assert.equal(draft.compile, 2);
	const ids = Object.fromEntries(first.clip.props.map(p => [p.id, studio.named(p.id)[0]?.id]));
	assert.equal(studio.rows().length, 4, "one stand-in per new prop");
	// the stand-in lines and every number, from the records and the clip by this test's arithmetic
	for (const p of first.clip.props) {
		const row = studio.row(ids[p.id]), shape = shapeOf(row), want = frame0(p);
		assert.ok(near(shape.base, want.base, 1e-4) && Math.abs(((shape.turn - want.turn) % 360 + 540) % 360 - 180) < 0.01, `${p.id} stands at the compile's frame 0`);
		assert.ok(near(shape.size, sizeOf(p), 1e-6), `${p.id} has the box's size`);
		assert.equal(row.renderer, p.shape === "sphere" ? "sphere" : p.size[1] < 0.05 ? "cube" : "sculpt");
	}
	const lineOf = (pid, row) => { const s = shapeOf(row); return `${pid} (${row.id}): ${box(s.size)}, base ${list(s.base)}${r2(s.turn) ? `, turn ${r2(s.turn)}°` : ""}`; };
	assert.deepEqual(draft.standIns, first.clip.props.map(p => lineOf(p.id, studio.row(ids[p.id]))));
	assert.match(draft.used, /^The motion uses these objects as boxes/);
	for (const p of first.scene.props) assert.ok(draft.used.includes(`${ids[p.id]} (${p.id}): ${sizeOf(p.size.length === 1 ? { ...p, shape: "sphere" } : p).map(r2).join(" x ")}`), `${p.id} in used`);
	assert.match(draft.note, /not installed/);

	// 2. the agent shapes the stool (seat and four legs, a back above the seat) and the ball (a box sculpt: no top the size of a ball)
	const legs = [[-0.17, -0.17], [0.17, -0.17], [-0.17, 0.17], [0.17, 0.17]].map(([x, z], k) => part(`leg${k}`, [0.04, 0.41, 0.04], [x, 0, z]));
	const stoolLook = recipe(part("seat", [0.4, 0.04, 0.4], [0, 0.41, 0]), ...legs, part("back", [0.4, 0.4, 0.04], [0, 0.45, -0.18]));
	const shaped = await t.tools.sculpt({ id: ids.stool, recipe: stoolLook });
	// the box check of the draft's box, by this test's arithmetic: base, turn as the draft placed it, so only the top and the floor
	const stoolRow = studio.row(ids.stool), tops = studio.topsOf(stoolRow);
	const covers = tops.some(top => Math.abs(top.y - 0.45) <= 0.02 && Math.max(0, Math.min(top.x1, 0.2) - Math.max(top.x0, -0.2)) * Math.max(0, Math.min(top.z1, 0.2) - Math.max(top.z0, -0.2)) >= 0.5 * 0.4 * 0.4);
	assert.equal(covers, true, "the seat at 0.45 m covers the box's top");
	assert.deepEqual(shaped.motionFit, { fits: true, ids: [ids.stool] }, "a seat at the box's top height fits the draft's box");
	const lowSeat = await t.tools.sculpt({ id: ids.stool, recipe: recipe(part("seat", [0.4, 0.04, 0.4], [0, 0.36, 0]), ...legs.map(l => ({ ...l, size: [0.04, 0.36, 0.04], position: [l.position[0], 0.18, l.position[2]] }))) });
	const lowTops = studio.topsOf(studio.row(ids.stool));
	assert.deepEqual(lowSeat.motionFit.objects, [{ id: ids.stool, name: "stool", differs: [`no flat top at the box's top (0.45 m over its base, within 0.02 m) over half its footprint; its flat tops (height over its base: width x depth m): ${lowTops.map(top => `${r2(top.y)}: ${r2(top.x1 - top.x0)} x ${r2(top.z1 - top.z0)}`).join(", ")}`] }], "a seat 0.05 m low is told against the draft's box");
	await t.tools.sculpt({ id: ids.stool, recipe: stoolLook });
	await t.tools.sculpt({ id: ids.ball, recipe: recipe(part("lump", [0.3, 0.3, 0.3], [0, 0, 0])) });
	const ballRow = studio.row(ids.ball), stoolBefore = structuredClone(studio.row(ids.stool));

	await writer.step(); // compile 3
	await writer.step(); // the end
	const done = await t.result();
	assert.equal(done.draft, undefined, "the next motion_result is the installed result");
	// every final prop is one object at its frame-0 place and turn
	for (const p of later.clip.props) {
		const rows = studio.named(p.id);
		assert.equal(rows.length, 1, `one ${p.id}`);
		const shape = shapeOf(rows[0]), want = frame0(p);
		assert.ok(near(shape.base, want.base, 1e-4), `${p.id} at the final base`);
		assert.ok(Math.abs(((shape.turn - want.turn) % 360 + 540) % 360 - 180) < 0.01, `${p.id} at the final turn`);
	}
	// the shaped stool keeps its parts and size; the untouched crate took the final size; the ball shaped and dropped is kept; the untouched mat stays
	const stool = studio.row(ids.stool), crate = studio.row(ids.crate), rail = studio.named("rail")[0];
	assert.deepEqual(stool.recipe, stoolBefore.recipe, "the look given in the draft is kept");
	assert.ok(near(shapeOf(stool).size, shapeOf(stoolBefore).size), "a shaped stand-in is not resized");
	assert.ok(near(shapeOf(crate).size, [0.55, 0.3, 0.4], 1e-6), "an untouched stand-in takes the final size");
	assert.deepEqual(studio.row(ids.ball).recipe, ballRow.recipe, "a shaped stand-in whose prop the final motion lacks is kept as it is");
	assert.equal(studio.row(ids.mat).id, ids.mat, "the mat the final motion keeps stays the draft's");
	assert.equal(studio.rows().length, 5, "stool, crate, ball, mat and the new rail");
	// propsSet: the changes since the draft, each number from the records before and after the install
	const was = (row, k) => shapeOf(row)[k];
	const stoolBase = list(shapeOf(stool).base), stoolWas = list(was(stoolBefore, "base"));
	assert.deepEqual(done.propsSet, [
		`stool (${ids.stool}), the draft's stand-in of stool, changed meanwhile and keeping its look: base ${stoolBase} (was ${stoolWas}), turn ${r2(stool.rot)}° (was ${r2(stoolBefore.rot)}°).`,
		`crate (${ids.crate}), the draft's stand-in of crate: base ${list(shapeOf(crate).base)} (was [-1, 0, 1]), size ${box(shapeOf(crate).size)} (was 0.5 x 0.3 x 0.4 m).`,
		`rail (${rail.id}): the motion added it as a stand-in, ${box(shapeOf(rail).size)}, base ${list(shapeOf(rail).base)}; the draft did not have it.`,
		`ball (${ids.ball}): the final motion does not have the draft's prop ball; it stays as it was changed meanwhile, and the motion does not use it.`,
	]);
	// motionFit: the shaped stool against the final box (0.5 m top over 0.45 x 0.42 m) and the kept ball where the feet go, by this test's arithmetic
	const finalTops = studio.topsOf(stool), want = [];
	if (!finalTops.some(top => Math.abs(top.y - 0.5) <= 0.02 && Math.max(0, Math.min(top.x1, 0.225) - Math.max(top.x0, -0.225)) * Math.max(0, Math.min(top.z1, 0.21) - Math.max(top.z0, -0.21)) >= 0.5 * 0.45 * 0.42)) want.push(`no flat top at the box's top (0.5 m over its base, within 0.02 m) over half its footprint; its flat tops (height over its base: width x depth m): ${finalTops.map(top => `${r2(top.y)}: ${r2(top.x1 - top.x0)} x ${r2(top.z1 - top.z0)}`).join(", ")}`);
	assert.equal(want.length, 1);
	assert.deepEqual(done.motionFit.objects.find(entry => entry.id === ids.stool)?.differs, want, "the shaped stool is told against the final box with both numbers");
	assert.ok(done.objects.includes(ids.stool) && done.objects.includes(ids.crate) && done.objects.includes(rail.id) && done.objects.includes(ids.mat));
	console.log("PASS draft: a failed compile adds nothing; the first good one adds stand-ins and answers the draft; the install sets the final boxes, keeps the agent's look, removes or keeps dropped ones and says what changed");
}

// --- 4: the writer reads the same request; a call that waits adds nothing early ---
{
	const scene = written(stage([prop("box1", [0.4, 0.4, 0.4], [1, 0, 1])]), { a1: [[0, "idle"]] });
	const plain = scriptedWriter([scene]), waits = scriptedWriter([scene]);
	const a = studioEditor(), b = studioEditor();
	const ta = turn({ studio: a, writer: plain, key: "c-plain" }), tb = turn({ studio: b, writer: waits, key: "c-wait", background: false });
	await ta.call;
	await plain.step();
	await waits.started();
	await waits.step();
	assert.equal(a.rows().length, 1, "the plain turn's draft added the stand-in");
	assert.equal(b.rows().length, 0, "a call that waits adds nothing before the install");
	await plain.step(); await waits.step();
	await ta.result(); await ta.result();
	const answer = await tb.call;
	assert.equal(answer.propsSet, undefined, "a call that waits answers as the baseline: no propsSet");
	assert.equal(plain.requests[0].replace(/c-plain/g, ""), waits.requests[0].replace(/c-wait/g, ""), "the writer reads the same request");
	assert.deepEqual(a.rows().map(row => [row.name, row.renderer, shapeOf(row)]), b.rows().map(row => [row.name, row.renderer, shapeOf(row)]), "the same stand-in at the end");
	await tick();
	console.log("PASS draft: the writer reads the same request; a call that waits adds nothing early and ends with the same scene");
}
