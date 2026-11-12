#!/usr/bin/env node
// composeMatrix (src/sculpt-matrix.js) is the one sink every sculpt rotation reaches: expandSculptParts (part.rotation)
// and repeatCopies (repeat.turn). normalizeSculptRecipe refuses a rotation that is not [x, y, z], but a recipe that
// skipped it must still draw instead of throwing `rotationDeg.map is not a function` at the window.
import assert from "node:assert/strict";
import { composeMatrix } from "../src/sculpt-matrix.js";
import { expandSculptParts } from "../src/sculpt-recipe.js";
import { buildSculptGroup, disposeSculptGroup } from "../src/sculpt-geometry.js";

const unrotated = composeMatrix([1, 2, 3], [0, 0, 0]);
for (const rotation of [{ x: 0, y: 90, z: 0 }, "0,90,0", null, undefined, 90]) {
	const label = JSON.stringify(rotation) ?? "undefined";
	assert.doesNotThrow(() => composeMatrix([1, 2, 3], rotation), `composeMatrix accepts rotation ${label}`);
	assert.deepEqual(composeMatrix([1, 2, 3], rotation), unrotated, `rotation ${label} reads as no rotation`);
}
console.log("PASS composeMatrix reads a rotation that is not an array as no rotation");

const recipe = { version: 1, parts: [{ id: "body", shape: "box", size: [1, 1, 1], position: [0, 0.5, 0], rotation: { x: 0, y: 45, z: 0 }, color: "#c8b8a0" }] };
assert.doesNotThrow(() => expandSculptParts(recipe), "an un-normalized recipe expands");
const group = buildSculptGroup(recipe);
assert.equal(group.children.length, 1, "the part with the bad rotation is still drawn");
disposeSculptGroup(group);
console.log("PASS a recipe that skipped normalization draws instead of throwing");
console.log("verify-sculpt-matrix-rotation: all behavioral checks passed");
