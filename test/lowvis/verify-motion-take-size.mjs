#!/usr/bin/env node
// The case of check 1's taken-size under the take with no fit gate: one prop crate (0.6 x 0.2 x 0.3 m at [1, 0, 1]),
// one object crate the agent names in building and makes meanwhile at 0.5 x 0.5 x 0.5 m. It takes the prop: the prop's
// place and turn, its own size, scale 1, no second crate. The difference is told in the same answer with numbers equal
// to the scene: the top the box needs (0.2 m) and the tops the object has. On the plain turn and on a call that waits.
// A second crate built of two parts with a narrow top (no flat top the Studio measures) is told unmeasured with the
// box's top height.
import assert from "node:assert/strict";
import { part, prop, recipe, shapeOf, stage, studioEditor, turn, written } from "./studio-take-harness.mjs";

const r2 = v => Math.round(v * 100) / 100;
for (const background of [true, false]) {
	for (const [label, look, top] of [["one box", recipe(part("body", [0.5, 0.5, 0.5], [0, 0, 0])), true], ["a narrow post with a cap", recipe(part("post", [0.08, 0.45, 0.08], [0, 0, 0]), part("cap", [0.1, 0.05, 0.1], [0, 0.45, 0])), false]]) {
		const studio = studioEditor(), work = written(stage([prop("crate", [0.6, 0.2, 0.3], [1, 0, 1], { turn: 25 })]), { a1: [[0, "idle"]] });
		let id;
		const { answer } = await turn({ studio, work, building: ["crate"], background, meanwhile: async tools => { id = (await tools.sculpt({ name: "crate", placement: { x: 4, y: 0, z: 4 }, recipe: look })).affectedIds[0]; } });
		const row = studio.row(id), mine = shapeOf(row), tops = studio.topsOf(row);
		assert.equal(studio.named("crate").length, 1, `${label}: one crate`);
		assert.deepEqual(mine.base, [1, 0, 1], `${label}: the prop's base`);
		assert.ok(Math.abs(mine.turn - 25) < 0.01, `${label}: the prop's turn`);
		assert.deepEqual(mine.scale, [1, 1, 1]);
		assert.deepEqual(answer.propsSet, [`crate (${id}), made meanwhile, took the motion's prop crate: base [1, 0, 1] (was [4, 0, 4]), turn ${r2(mine.turn)}° (was 0°).`]);
		const want = top ? `no flat top at the box's top (0.2 m over its base, within 0.02 m) over its footprint (0.6 x 0.3 m, within 0.02 m on each side); its flat tops (height over its base: width x depth m): ${tops.map(t => `${r2(t.y)}: ${r2(t.x1 - t.x0)} x ${r2(t.z1 - t.z0)}`).join(", ")}` : "top unmeasured (the Studio measured no flat top on it); the box's top is 0.2 m over its base";
		assert.equal(tops.length > 0, top, `${label}: the Studio measures a top: ${top}`);
		assert.deepEqual(answer.motionFit, { fits: false, objects: [{ id, name: "crate", differs: [want] }], note: answer.motionFit.note }, `${label}, ${background ? "plain turn" : "a call that waits"}`);
		if (top) assert.equal(r2(tops[0].y), r2(mine.size[1]), "the told top is the object's own height");
	}
}
console.log("PASS a crate of another size takes the prop at its own size; the top it lacks is told with the scene's numbers, or told unmeasured; plain turn and a call that waits");
