#!/usr/bin/env node
// An object the agent makes while the motion is written under the id of an object it removed meanwhile (the Studio gives
// a removed object's id to the next object of its kind) is made meanwhile all the same: it takes the prop of its name,
// and no stand-in stands beside it. The removed object is one the motion does not use (tilted or hidden), so its removal
// goes through while the writer works (the plain turn: the door hands runMotion the ids the calls changed meanwhile).
import assert from "node:assert/strict";
import { part, prop, recipe, shapeOf, stage, studioEditor, turn, written } from "./studio-take-harness.mjs";

const chair = recipe(part("seat", [0.5, 0.46, 0.42], [0, 0, 0]));
const unused = [["tilted", [0.5, 0.5, 0.05], { rotX: 20 }], ["hidden", [0.5, 0.5, 0.5], { hidden: true }]];
for (const [label, size, patch] of unused) {
	const studio = studioEditor(), work = written(stage([prop("chair", [0.5, 0.46, 0.42], [1, 0, 2])]), { a1: [[0, "idle"]] });
	const old = (await studio.run("object.sculpt", { name: "old sign", placement: { x: -3, y: 0, z: -3 }, recipe: recipe(part("body", size, [0, 0, 0])) })).affectedIds[0];
	await studio.run("object.update", { id: old, patch });
	let made;
	const { answer } = await turn({ studio, work, building: ["chair"], meanwhile: async tools => {
		await tools.remove({ ids: [old] });
		made = (await tools.sculpt({ name: "chair", placement: { x: 4, y: 0, z: 4 }, recipe: chair })).affectedIds[0];
	} });
	assert.equal(made, old, `${label}: the chair has the removed object's id`);
	assert.equal(studio.named("chair").length, 1, `${label}: one chair, no stand-in beside it`);
	assert.deepEqual(shapeOf(studio.row(made)).base, [1, 0, 2], `${label}: at the prop's base`);
	assert.deepEqual(answer.propsSet, [`chair (${made}), made meanwhile, took the motion's prop chair: base [1, 0, 2] (was [4, 0, 4]).`], label);
}
console.log("PASS an object made meanwhile under a removed object's id takes the prop of its name: after a tilted or a hidden object");
