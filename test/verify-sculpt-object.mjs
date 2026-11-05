#!/usr/bin/env node
// The sculpt object (#730): a scene record that carries a recipe instead of an
// asset. Its box is measured from the recipe, it round-trips through the scene
// document, it duplicates with its recipe, and object.sculpt creates or
// re-sculpts it as one undoable write — refusing a bad recipe with the reason.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { objectsFixture } from "./bus/objects-fixture.mjs";
import {
	SCULPT_KIND,
	createSceneObject,
	createSculptObject,
	loadScene,
	normalizeSceneObject,
	objectPatchFields,
	serializeScene,
	updateSceneObject,
} from "../src/scene-objects.js";
import { expandSculptParts, sculptStandingBox } from "../src/sculpt-recipe.js";
import { sculptRefusalPath } from "../src/sculpt-refusal-path.js";

let failures = 0;
async function check(name, fn) {
	try {
		await fn();
		console.log(`PASS ${name}`);
	} catch (error) {
		failures += 1;
		console.log(`FAIL ${name} - ${error.stack?.split("\n").slice(0, 3).join(" | ") ?? error.message}`);
	}
}
const ok = (receipt) => {
	assert.equal(receipt.ok, true, JSON.stringify(receipt));
	return receipt;
};
const turtle = JSON.parse(readFileSync(new URL("./fixtures/sculpt-nerd-turtle.json", import.meta.url), "utf8"));
const pillar = { parts: [{ id: "body", shape: "cylinder", size: [0.4, 1.2, 0.4], position: [0, 0.6, 0] }] };

/* -------------------------------------------------------- the record ---- */

await check("a sculpt is minted from a recipe, never from the catalogue", () => {
	assert.equal(createSceneObject(SCULPT_KIND), null);
	const { object, error } = createSculptObject({ recipe: turtle, name: "Nerd turtle" }, [], { x: 1, z: -2, rot: 30 });
	assert.equal(error, undefined);
	assert.equal(object.renderer, SCULPT_KIND);
	assert.equal(object.name, "Nerd turtle");
	assert.deepEqual([object.x, object.z, object.rot], [1, -2, 30]);
	const box = sculptStandingBox(object.recipe);
	assert.deepEqual(object.footprint, box.footprint);
	assert.equal(object.height, box.height);
	assert.ok(object.height > 0.8 && object.height < 1, `the turtle stands ${object.height} m`);
});

await check("a recipe that cannot be drawn comes back as the reason, not a null", () => {
	const { object, error } = createSculptObject({ recipe: { parts: [{ id: "x", shape: "teapot", size: [1, 1, 1] }] } });
	assert.equal(object, undefined);
	assert.match(error, /parts\[x\]\.shape/);
});

await check("ids and names are unique against the scene", () => {
	const first = createSculptObject({ recipe: pillar }).object;
	const second = createSculptObject({ recipe: pillar }, [first]).object;
	assert.deepEqual([first.id, first.name, second.id, second.name], ["sculpt", "Sculpt", "sculpt-2", "Sculpt 2"]);
});

await check("the scene document round-trips a sculpt, and the box is re-measured, not trusted", () => {
	const { object } = createSculptObject({ recipe: turtle });
	const tampered = { ...object, footprint: { width: 9, depth: 9 }, height: 9 };
	const loaded = loadScene(serializeScene([tampered]));
	assert.equal(loaded.dropped, 0);
	assert.deepEqual(loaded.objects[0].recipe, object.recipe);
	assert.deepEqual(loaded.objects[0].footprint, object.footprint);
	assert.equal(loaded.objects[0].height, object.height);
});

await check("a stored sculpt whose recipe cannot be drawn is dropped, like a cutout without its picture", () => {
	const { object } = createSculptObject({ recipe: pillar });
	assert.equal(normalizeSceneObject({ ...object, recipe: undefined }), null);
	assert.equal(normalizeSceneObject({ ...object, recipe: { parts: [{ id: "a", shape: "blob", size: [0, 1, 1] }] } }), null);
	assert.equal(loadScene(serializeScene([{ ...object, recipe: null }])).dropped, 1);
});

await check("recipe is a patch field; a bad recipe patch leaves the sculpt untouched", () => {
	const { object } = createSculptObject({ recipe: pillar });
	assert.ok(objectPatchFields(object).includes("recipe"));
	assert.equal(objectPatchFields(createSceneObject("cube")).includes("recipe"), false);
	const rows = [object];
	assert.equal(updateSceneObject(rows, object.id, { recipe: { parts: [] } }), rows, "nothing changed");
	const taller = { parts: [{ ...pillar.parts[0], size: [0.4, 2, 0.4], position: [0, 1, 0] }] };
	const [patched] = updateSceneObject(rows, object.id, { recipe: taller });
	assert.equal(patched.height, 2);
	assert.equal(patched.recipe.parts[0].size[1], 2);
});

/* --------------------------------------------- the command bus (real) ---- */

await check("object.sculpt creates a sculpt as one undoable write and reports its size", () => {
	const f = objectsFixture();
	try {
		const receipt = ok(f.run("object.sculpt", { recipe: turtle, name: "Nerd turtle", placement: { x: 1.5, z: 0.5, rot: -20 } }));
		const id = receipt.affectedIds[0];
		const row = f.objects.read().find((entry) => entry.id === id);
		assert.equal(row.renderer, SCULPT_KIND);
		assert.equal(row.name, "Nerd turtle");
		assert.deepEqual([row.x, row.z, row.rot], [1.5, 0.5, -20]);
		assert.ok(receipt.summary.includes(`${expandSculptParts(row.recipe).length} parts`));
		assert.match(receipt.summary, /Sculpted Nerd turtle \(sculpt\): 25 parts, .* m tall\./);
		assert.equal(f.run("edit.undo", { receiptId: receipt.receiptId }).status, "undone");
		assert.equal(f.objects.read().some((entry) => entry.id === id), false);
	} finally {
		f.dispose();
	}
});

await check("object.sculpt with an id re-sculpts in place, keeping the transform", () => {
	const f = objectsFixture();
	try {
		const id = ok(f.run("object.sculpt", { recipe: pillar, placement: { x: 2, z: 1 } })).affectedIds[0];
		const resculpt = ok(f.run("object.sculpt", { id, recipe: turtle }));
		assert.equal(resculpt.affectedIds[0], id);
		assert.match(resculpt.summary, /^Re-sculpted/);
		const row = f.objects.read().find((entry) => entry.id === id);
		assert.deepEqual([row.x, row.z], [2, 1]);
		assert.equal(row.recipe.parts.length, turtle.parts.length);
		assert.equal(f.objects.read().filter((entry) => entry.renderer === SCULPT_KIND).length, 1);
		assert.equal(f.run("edit.undo", { receiptId: resculpt.receiptId }).status, "undone");
		assert.equal(f.objects.read().find((entry) => entry.id === id).recipe.parts[0].shape, "cylinder", "undo restores the pillar");
	} finally {
		f.dispose();
	}
});

await check("object.sculpt refuses a bad recipe and a non-sculpt target with the reason", () => {
	const f = objectsFixture();
	try {
		const before = structuredClone(f.objects.read());
		const bad = f.run("object.sculpt", { recipe: { parts: [{ id: "head", shape: "blob", size: [0.4, 40, 0.4] }] } });
		assert.equal(bad.ok, false);
		assert.equal(bad.code, "INVALID_ARGUMENT");
		assert.match(bad.message, /Recipe refused at parts\[head\]\.size\[1\]/);
		// #1042: the failing recipe field reaches telemetry as a schema path; the part id never does.
		assert.equal(sculptRefusalPath("parts[head].size[1]"), "$.args.recipe.parts[].size[]");
		assert.equal(sculptRefusalPath("parts[head].madeUpKey"), "$.args.recipe.parts[]", "a key the caller made up is cut off");
		assert.equal(sculptRefusalPath("edits[2].set"), "$.args.edits[].set");
		const neither = f.run("object.sculpt", {});
		assert.match(neither.message, /give exactly one of recipe .* or edits .*neither was sent/);
		const wrong = f.run("object.sculpt", { id: "cube", recipe: pillar });
		assert.equal(wrong.ok, false);
		assert.match(wrong.message, /cube is a cube, not a sculpt/);
		assert.deepEqual(f.objects.read(), before, "a refusal writes nothing");
	} finally {
		f.dispose();
	}
});

await check("object.sculpt edits patch one part in place as one undo, and are refused without an id", () => {
	const f = objectsFixture();
	try {
		const id = ok(f.run("object.sculpt", { recipe: turtle, placement: { x: 1 } })).affectedIds[0];
		const before = f.objects.read().find((entry) => entry.id === id).recipe;
		const patched = ok(f.run("object.sculpt", { id, edits: [{ set: "head", color: "#336677" }, { remove: "tooth" }] }));
		assert.match(patched.summary, /^Patched head, tooth on Sculpt \(sculpt\)/);
		const after = f.objects.read().find((entry) => entry.id === id).recipe;
		assert.equal(after.parts.find((p) => p.id === "head").color, "#336677");
		assert.equal(after.parts.some((p) => p.id === "tooth"), false);
		assert.equal(after.parts.length, before.parts.length - 1);
		assert.equal(f.run("edit.undo", { receiptId: patched.receiptId }).status, "undone");
		assert.deepEqual(f.objects.read().find((entry) => entry.id === id).recipe, before);
		const noId = f.run("object.sculpt", { edits: [{ remove: "tooth" }] });
		assert.match(noId.message, /edits patch an existing sculpt/);
		const both = f.run("object.sculpt", { id, recipe: pillar, edits: [{ remove: "tooth" }] });
		assert.match(both.message, /exactly one of recipe/);
		const ghost = f.run("object.sculpt", { id, edits: [{ set: "ghost", color: "#000000" }] });
		assert.match(ghost.message, /no part named "ghost"/);
	} finally {
		f.dispose();
	}
});

await check("object.sculpt can hang the new sculpt off a parent", () => {
	const f = objectsFixture();
	try {
		const id = ok(f.run("object.sculpt", { recipe: pillar, parent: "cylinder" })).affectedIds[0];
		assert.equal(f.objects.read().find((entry) => entry.id === id).parent, "cylinder");
	} finally {
		f.dispose();
	}
});

await check("duplicating a sculpt carries its recipe", () => {
	const f = objectsFixture();
	try {
		const id = ok(f.run("object.sculpt", { recipe: turtle })).affectedIds[0];
		const receipt = ok(f.run("object.duplicate", { objectId: id }));
		const copyId = receipt.affectedIds.find((entry) => entry !== id);
		assert.ok(copyId, JSON.stringify(receipt.affectedIds));
		const copy = f.objects.read().find((entry) => entry.id === copyId);
		assert.equal(copy.renderer, SCULPT_KIND);
		assert.deepEqual(copy.recipe, f.objects.read().find((entry) => entry.id === id).recipe);
	} finally {
		f.dispose();
	}
});

if (failures) {
	console.log(`\n${failures} check(s) failed`);
	process.exit(1);
}
console.log("\nverify-sculpt-object: all checks passed");
