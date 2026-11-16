#!/usr/bin/env node
// A sculpt call with some bad parts lands the good ones and names each refused one (sculpt-recipe-partial.js,
// commands/object-sculpt.js). Each check shows the old whole refusal beside the new per-item report.
import assert from "node:assert/strict";
import { objectsFixture } from "./bus/objects-fixture.mjs";
import { SCULPT_KIND } from "../src/scene-objects.js";
import { normalizeSculptRecipe, patchSculptRecipe } from "../src/sculpt-recipe.js";
import { normalizeSculptRecipeKeeping, patchSculptRecipeKeeping } from "../src/sculpt-recipe-partial.js";

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
const blob = (id, extra = {}) => ({ id, shape: "blob", size: [0.3, 0.3, 0.3], position: [0, 0.15, 0], ...extra });
const ids = (recipe) => recipe.parts.map((part) => part.id);

await check("a recipe with one bad size: whole refusal before, the other parts now", () => {
	const recipe = { parts: [blob("base"), blob("peak", { size: [0.0005, 1, 1] }), blob("top", { position: [0, 0.4, 0] })] };
	assert.equal(normalizeSculptRecipe(recipe).ok, false, "before: the whole recipe is refused");
	const kept = normalizeSculptRecipeKeeping(recipe);
	assert.equal(kept.ok, true);
	assert.deepEqual(ids(kept.recipe), ["base", "top"]);
	assert.equal(kept.skipped.length, 1);
	assert.equal(kept.skipped[0].id, "peak");
	assert.match(kept.skipped[0].error, /parts\[peak\]\.size\[0\]: extent must be 0\.001-240 m, got 0\.0005/);
});

await check("a repeat jitter given as a vector: that part is named, the rest lands", () => {
	const recipe = { parts: [blob("post"), { ...blob("g1"), repeat: { count: 3, step: [0.2, 0, 0], jitter: { position: [0, 0, 0.012] } } }] };
	assert.equal(normalizeSculptRecipe(recipe).ok, false);
	const kept = normalizeSculptRecipeKeeping(recipe);
	assert.deepEqual(ids(kept.recipe), ["post"]);
	assert.match(kept.skipped[0].error, /parts\[g1\]\.repeat\.jitter\.position: must be a number from 0 to 0\.5/);
});

await check("a part under a refused part is left out with it; a bad id is named by its index", () => {
	const recipe = { parts: [blob("body"), blob("arm", { size: [0.3, 0, 0.3] }), blob("hand", { parent: "arm" }), blob("bad id!")] };
	const kept = normalizeSculptRecipeKeeping(recipe);
	assert.deepEqual(ids(kept.recipe), ["body"]);
	assert.deepEqual(kept.skipped.map((item) => item.id).sort(), ["arm", "bad id!", "hand"]);
	assert.match(kept.skipped.find((item) => item.id === "hand").error, /left out with its parent arm/);
	assert.match(kept.skipped.find((item) => item.id === "bad id!").error, /parts\[3\]\.id: must be/);
});

await check("a refusal no single part causes, or one where every part is bad, stays whole", () => {
	const many = { parts: Array.from({ length: 49 }, (_, i) => blob(`p${i}`)) };
	const tooMany = normalizeSculptRecipeKeeping(many);
	assert.equal(tooMany.ok, false);
	assert.match(tooMany.error, /the limit is 48/);
	const allBad = normalizeSculptRecipeKeeping({ parts: [blob("a", { size: [0, 1, 1] }), blob("b", { size: [1, 0, 1] })] });
	assert.equal(allBad.ok, false);
	assert.equal(allBad.skipped.length, 2);
});

await check("the 0.001-240 m part bound: a 34 m mountain part is drawn, 400 m is refused with the range", () => {
	assert.equal(normalizeSculptRecipe({ parts: [blob("peakMain", { size: [34, 12, 30], position: [0, 6, 0] })] }).ok, true);
	assert.match(normalizeSculptRecipe({ parts: [blob("peakMain", { size: [400, 1, 1] })] }).error, /extent must be 0\.001-240 m, got 400/);
	assert.equal(normalizeSculptRecipe({ parts: [{ id: "label", shape: "box", size: [0.3, 0.004, 0.2] }] }).ok, true, "a 4 mm label");
});

await check("edits: one bad edit refused the list before; now the others land, and order does not matter", () => {
	const base = normalizeSculptRecipe({ parts: [blob("head"), blob("body")] }).recipe;
	const edits = [{ add: blob("pupil", { parent: "eye" }) }, { set: "head", color: "#336677" }, { set: "body", size: [0.3, -1, 0.3] }, { add: blob("eye") }];
	assert.equal(patchSculptRecipe(base, edits).ok, false, "before: the whole edit list is refused");
	const kept = patchSculptRecipeKeeping(base, edits);
	assert.equal(kept.ok, true);
	assert.deepEqual(ids(kept.recipe).sort(), ["body", "eye", "head", "pupil"]);
	assert.equal(kept.recipe.parts.find((part) => part.id === "head").color, "#336677");
	assert.deepEqual(kept.skipped.map((item) => [item.index, item.id]), [[2, "body"]]);
	assert.match(kept.skipped[0].error, /parts\[body\]\.size\[1\]: extent must be/);
});

await check("object.sculpt over the bus: the good parts land as one undo, each left-out part is a PART_REFUSED warning", () => {
	const f = objectsFixture();
	try {
		const recipe = { parts: [blob("base"), blob("peakA", { size: [0.0005, 1, 1] }), blob("peakB", { size: [0.3, 0.0004, 0.3] }), blob("top", { position: [0, 0.4, 0] })] };
		const receipt = f.run("object.sculpt", { recipe, name: "Hill" });
		assert.equal(receipt.ok, true, JSON.stringify(receipt));
		const row = f.objects.read().find((entry) => entry.id === receipt.affectedIds[0]);
		assert.deepEqual(ids(row.recipe), ["base", "top"]);
		assert.match(receipt.summary, /Left out 2 parts: peakA, peakB\./);
		const refused = receipt.warnings.filter((warning) => warning.code === "PART_REFUSED");
		assert.deepEqual(refused.map((warning) => warning.id), ["peakA", "peakB"]);
		assert.match(refused[0].message, /^Left out parts\[peakA\]\.size\[0\]: extent must be 0\.001-240 m, got 0\.0005$/);
		assert.equal(f.run("edit.undo", { receiptId: receipt.receiptId }).status, "undone");
		assert.equal(f.objects.read().some((entry) => entry.id === row.id), false);
	} finally {
		f.dispose();
	}
});

await check("object.sculpt with a cube's id: refused before; now the cube becomes a sculpt keeping id, place, turn, scale and parent", () => {
	const f = objectsFixture();
	try {
		const cube = f.objects.read().find((entry) => entry.renderer === "cube");
		assert.ok(cube, "the fixture has a cube");
		assert.equal(f.run("object.set", { id: cube.id, set: { position: { x: 1.5, y: 0, z: -0.5 }, rotation: { x: 0, y: 30, z: 0 }, scale: 2 } }).ok, true);
		const placed = f.objects.read().find((entry) => entry.id === cube.id);
		assert.deepEqual([placed.x, placed.rot, placed.scaleX], [1.5, 30, 2]);
		const receipt = f.run("object.sculpt", { id: cube.id, recipe: { parts: [blob("rock")] } });
		assert.equal(receipt.ok, true, JSON.stringify(receipt));
		const row = f.objects.read().find((entry) => entry.id === cube.id);
		assert.equal(row.renderer, SCULPT_KIND);
		assert.deepEqual([row.x, row.y, row.z, row.rot, row.scaleX, row.scaleY, row.scaleZ, row.parent, row.name], [placed.x, placed.y, placed.z, placed.rot, placed.scaleX, placed.scaleY, placed.scaleZ, placed.parent, placed.name]);
		assert.match(receipt.summary, /^Sculpted in place .*\(was a cube; id, place, turn, scale 2×2×2, parent and path kept\)/);
		assert.equal(f.objects.read().filter((entry) => entry.id === cube.id).length, 1);
		assert.equal(f.run("edit.undo", { receiptId: receipt.receiptId }).status, "undone");
		assert.equal(f.objects.read().find((entry) => entry.id === cube.id).renderer, "cube");
	} finally {
		f.dispose();
	}
});

await check("digit ids: a refusal by position never takes a valid part whose id equals that position", () => {
	const unknownKey = normalizeSculptRecipeKeeping({ parts: [blob("a"), blob("2"), blob("c", { wobble: 1 }), blob("d")] });
	assert.equal(unknownKey.ok, true);
	assert.deepEqual(ids(unknownKey.recipe), ["a", "2", "d"]);
	assert.deepEqual(unknownKey.skipped.map((item) => [item.id, item.path]), [["c", "parts[2].wobble"]]);
	const noId = normalizeSculptRecipeKeeping({ parts: [{ shape: "blob", size: [0.3, 0.3, 0.3] }, blob("0"), blob("a")] });
	assert.deepEqual(ids(noId.recipe), ["0", "a"]);
	assert.deepEqual(noId.skipped.map((item) => [item.id, item.path]), [[undefined, "parts[0].id"]]);
	const digits = normalizeSculptRecipeKeeping({ parts: [blob("1"), blob("2"), blob("3", { wobble: 1 })] });
	assert.equal(digits.ok, true, JSON.stringify(digits));
	assert.deepEqual(ids(digits.recipe), ["1", "2"]);
	// A bad size names the part by its id; the second part with the same id is the one refused for the size.
	const sameId = normalizeSculptRecipeKeeping({ parts: [blob("a"), blob("a", { size: [0, 1, 1] }), blob("b")] });
	assert.deepEqual(ids(sameId.recipe), ["a", "b"]);
	assert.deepEqual(sameId.skipped.map((item) => item.path), ["parts[a].size[0]"]);
});

await check("a recipe-wide limit after parts were left out: every left-out part is listed, none called 'every part'", () => {
	const f = objectsFixture();
	try {
		const parts = [blob("bad1", { size: [0, 1, 1] }), ...Array.from({ length: 49 }, (_, i) => blob(`p${i}`)), blob("bad2", { size: [0, 1, 1] })];
		const kept = normalizeSculptRecipeKeeping({ parts });
		assert.equal(kept.ok, false);
		assert.equal(kept.allRefused, undefined);
		const receipt = f.run("object.sculpt", { recipe: { parts } });
		assert.equal(receipt.ok, false);
		assert.match(receipt.message, /the limit is 48 Also refused: parts\[bad1\]\.size\[0\]: extent .* \| parts\[bad2\]\.size\[0\]: extent/);
		assert.doesNotMatch(receipt.message, /Every part was refused/);
		const all = f.run("object.sculpt", { recipe: { parts: [blob("a", { size: [0, 1, 1] }), blob("b", { size: [1, 0, 1] })] } });
		assert.match(all.message, /Recipe refused at parts\[a\]\.size\[0\].* Every part was refused; the others: parts\[b\]\.size\[1\]/);
	} finally {
		f.dispose();
	}
});

if (failures) {
	console.log(`\n${failures} check(s) failed`);
	process.exit(1);
}
console.log("\nverify-sculpt-partial: all checks passed");
process.exit(0);
