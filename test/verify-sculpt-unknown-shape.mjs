#!/usr/bin/env node
// buildSculptGroup is the render path's entry into sculpt-geometry.js (shared-sculpt.js for props, sculpt-thumb.js
// for shelf thumbnails). A part whose shape has no builder (a recipe from a newer build, or one that skipped
// normalizeSculptRecipe) is skipped with a console.warn; the rest of the sculpt draws and nothing reaches the window.
import assert from "node:assert/strict";
import { buildSculptGroup, disposeSculptGroup } from "../src/sculpt-geometry.js";

const warnings = [];
console.warn = (...args) => { warnings.push(args.join(" ")); };
const part = (id, shape, extra = {}) => ({ id, shape, size: [1, 1, 1], position: [0, 0.5, 0], rotation: [0, 0, 0], color: "#c8b8a0", ...extra });

const recipe = { version: 1, parts: [part("body", "box"), part("wing", "hologram"), part("hole", "spline", { parent: "body", op: "subtract" })] };
let group;
assert.doesNotThrow(() => { group = buildSculptGroup(recipe); }, "an unknown shape does not throw out of buildSculptGroup");
assert.deepEqual(group.children.map((mesh) => mesh.name), ["body"], "the known part still draws; the unknown ones are skipped");
assert.equal(warnings.filter((line) => line.includes("hologram")).length, 1, "the skipped drawn part is warned once");
assert.equal(warnings.filter((line) => line.includes("spline")).length, 1, "the skipped cutter is warned once");
disposeSculptGroup(group);
console.log("PASS an unknown sculpt shape is skipped with a warning; the rest of the sculpt draws");
console.log("verify-sculpt-unknown-shape: all behavioral checks passed");
