#!/usr/bin/env node
// A recipe slip with one obvious reading is read that way instead of refused: every refusal costs the agent the
// whole recipe again. Anything ambiguous is still refused.
import assert from "node:assert/strict";
import { normalizeSculptRecipe, patchSculptRecipe } from "../src/sculpt-recipe.js";
import { sculptBuildReport } from "../src/sculpt-report.js";

const part = extra => ({ id: "a", shape: "box", size: [1, 1, 1], position: [0, 0.5, 0], ...extra });
const one = extra => normalizeSculptRecipe({ parts: [part(extra)] }).recipe?.parts?.[0] ?? normalizeSculptRecipe({ parts: [part(extra)] }).parts?.[0];

// camelCase and underscore ids are kept as written, so a later edit can name them
assert.equal(one({ id: "fenderF" }).id, "fenderF");
assert.equal(one({ id: "branch_side" }).id, "branch_side");
// common shape names
const ball = one({ shape: "sphere" });
assert.equal(ball.shape, "blob"); assert.equal(ball.roundness, 0);
assert.equal(one({ shape: "sphere", roundness: 0.4 }).roundness, 0.4);
const cone = one({ shape: "cone" });
assert.equal(cone.shape, "cylinder"); assert.equal(cone.taper, 1);
assert.equal(one({ shape: "cube" }).shape, "box");
// detail.scale outside 1..12 is clamped
assert.equal(one({ detail: { amount: 0.3, scale: 0.15 } }).detail.scale, 1);
assert.equal(one({ detail: { amount: 0.3, scale: 40 } }).detail.scale, 12);
// still refused: an unknown shape, an id with a space
for (const bad of [{ shape: "pyramid" }, { id: "front bar" }]) {
	const refused = (() => { try { const result = normalizeSculptRecipe({ parts: [part(bad)] }); return result?.ok === false || !!result?.error; } catch { return true; } })();
	assert.ok(refused, JSON.stringify(bad));
}
// an edit that names a camelCase id finds it
const base = { version: 1, parts: [part({ id: "frontBar" })] };
const patched = patchSculptRecipe(base, [{ set: "frontBar", size: [2, 1, 1] }]);
assert.equal((patched.recipe ?? patched).parts[0].size[0], 2);
// the box check says when the whole prop hangs above its base
const recipeOf = parts => { const result = normalizeSculptRecipe({ parts }); return result.recipe ?? result; };
assert.match(sculptBuildReport(recipeOf([part({ position: [0, 0.8, 0] })])), /lowest point is 0\.3 m above the base/);
assert.doesNotMatch(sculptBuildReport(recipeOf([part({})])), /above the base/);
console.log("sculpt forgive: ok");
