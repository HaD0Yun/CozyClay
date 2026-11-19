#!/usr/bin/env node
// The case of the review's one-object-two-props under the take with no fit gate: the motion adds props Box
// (0.4 x 0.4 x 0.4 m at [1, 0, 1]) and box (0.6 x 0.2 x 0.3 m at [-1, 0, 1]); the agent names box in building and makes one
// object box of 0.5 x 0.5 x 0.5 m meanwhile. Box gets a stand-in of its own box; the agent's box takes prop box: the
// prop's place and turn, its own size (no scale); motionFit of the same answer gives the top it lacks with the box's
// and the object's numbers, each equal to the scene. One line per object, no object stands for two props.
import assert from "node:assert/strict";
import { part, prop, recipe, shapeOf, stage, studioEditor, turn, written } from "./studio-take-harness.mjs";

const studio = studioEditor(), work = written(stage([prop("Box", [0.4, 0.4, 0.4], [1, 0, 1]), prop("box", [0.6, 0.2, 0.3], [-1, 0, 1])]), { a1: [[0, "idle"]] });
let id;
const { answer } = await turn({ studio, work, building: ["box"], meanwhile: async tools => { id = (await tools.sculpt({ name: "box", placement: { x: 4, y: 0, z: 4 }, recipe: recipe(part("body", [0.5, 0.5, 0.5], [0, 0, 0])) })).affectedIds[0]; } });
const mine = shapeOf(studio.row(id)), stand = studio.named("Box");
assert.equal(stand.length, 1, "Box has its own stand-in");
assert.deepEqual(shapeOf(stand[0]).base, [1, 0, 1]);
assert.deepEqual(shapeOf(stand[0]).size.map(v => Math.round(v * 1000) / 1000), [0.4, 0.4, 0.4]);
assert.equal(studio.named("box").length, 1, "one object box: no stand-in beside the agent's");
assert.deepEqual(mine.base, [-1, 0, 1], "the agent's box at prop box's base");
assert.equal(mine.turn, 0);
assert.deepEqual(mine.scale, [1, 1, 1], "no scale");
assert.deepEqual(mine.size, [0.5, 0.5, 0.5], "its own size");
assert.equal(new Set(answer.objects).size, answer.objects.length, "no object stands for two props");
const tops = studio.topsOf(studio.row(id));
assert.equal(tops.length, 1);
const t = tops[0], r2 = v => Math.round(v * 100) / 100;
assert.deepEqual(answer.motionFit.objects, [{ id, name: "box", differs: [`no flat top at the box's top (0.2 m over its base, within 0.02 m) over half its footprint; its flat tops (height over its base: width x depth m): ${r2(t.y)}: ${r2(t.x1 - t.x0)} x ${r2(t.z1 - t.z0)}`] }]);
assert.equal(r2(t.y), 0.5, "the object's top is 0.5 m: the scene's own");
assert.deepEqual(answer.propsSet, [`Box (${stand[0].id}): the motion added it as a stand-in, 0.4 x 0.4 x 0.4 m, base [1, 0, 1]; no object made meanwhile took it.`, `box (${id}), made meanwhile, took the motion's prop box: base [-1, 0, 1] (was [4, 0, 4]).`]);
console.log("PASS two props spelled alike: a stand-in for Box, the agent's box takes box at its own size, the top told with the scene's numbers");
