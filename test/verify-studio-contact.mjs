// The placement and framing checks the turn review sends read what the viewport draws and the posed body, not one box per
// record (solid-contact.js). A box is mostly air for a table, a chair, a bench or a counter: a chair tucked under a table,
// a body seated on a bench, a cup on a counter beside the counter's machine touch or rest and are not inside each other,
// and a body fully in frame is not cut by it. Two solids truly inside each other, a body standing in a table, a cup held
// above the counter and a body cut by the frame edge still are flagged. Each first case fails on the one-box checks.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createSceneObject, createSculptObject } from "../src/scene-objects.js";
import { createCharacterEntry } from "../src/scenes.js";
import { framingChecks, placementChecks } from "../src/studio-agent-commands.js";

const box = (id, size, position) => ({ id, shape: "box", size, position });
const sculpt = (id, parts, at) => ({ ...createSculptObject({ recipe: { parts } }).object, id, ...at });
// a 1.2 x 0.75 x 0.8 table: a 4 cm top on four legs; a chair whose seat (0.45 high) fits under the top
const TABLE = [box("top", [1.2, 0.04, 0.8], [0, 0.73, 0]), ...[[-0.55, -0.35], [0.55, -0.35], [-0.55, 0.35], [0.55, 0.35]].map(([x, z], i) => box(`leg${i}`, [0.05, 0.71, 0.05], [x, 0.355, z]))];
const CHAIR = [box("seat", [0.44, 0.04, 0.42], [0, 0.45, 0]), box("back", [0.44, 0.5, 0.04], [0, 0.72, 0.19]), ...[[-0.2, -0.19], [0.2, -0.19], [-0.2, 0.19], [0.2, 0.19]].map(([x, z], i) => box(`leg${i}`, [0.04, 0.43, 0.04], [x, 0.215, z]))];
// a bench: a seat 0.45 high and a backrest to 0.9 m
const BENCH = [box("seat", [1.6, 0.05, 0.45], [0, 0.45, 0]), box("back", [1.6, 0.45, 0.05], [0, 0.7, -0.2]), box("legL", [0.06, 0.43, 0.4], [-0.75, 0.215, 0]), box("legR", [0.06, 0.43, 0.4], [0.75, 0.215, 0])];
// a counter 1.0 high with a 0.4 m machine standing on its top: one sculpt
const COUNTER = [box("body", [2, 1, 0.7], [0, 0.5, 0]), box("machine", [0.4, 0.4, 0.4], [0.6, 1.2, 0])];
const CUP = [{ id: "cup", shape: "cylinder", size: [0.08, 0.1, 0.08], position: [0, 0.05, 0] }];

// A seated and a standing figure as the editor's bounds port hands them over: the box of the drawn body and its posed bones.
const SEATED = [[0, 0.55, 0], [0.1, 0.53, 0.2], [-0.1, 0.53, 0.2], [0.1, 0.52, 0.42], [-0.1, 0.52, 0.42], [0.1, 0.08, 0.45], [-0.1, 0.08, 0.45], [0.1, 0.03, 0.55], [-0.1, 0.03, 0.55],
	[0, 0.75, -0.02], [0, 0.95, -0.03], [0, 1.1, -0.03], [0.2, 1.05, 0], [-0.2, 1.05, 0], [0.25, 0.8, 0.1], [-0.25, 0.8, 0.1], [0.2, 0.62, 0.25], [-0.2, 0.62, 0.25], [0, 1.2, 0], [0, 1.32, 0]];
const STANDING = [[0, 0.95, 0], [0.1, 0.9, 0], [-0.1, 0.9, 0], [0.1, 0.5, 0], [-0.1, 0.5, 0], [0.1, 0.08, 0], [-0.1, 0.08, 0], [0.1, 0.02, 0.12], [-0.1, 0.02, 0.12],
	[0, 1.15, 0], [0, 1.35, 0], [0.2, 1.45, 0], [-0.2, 1.45, 0], [0.3, 1.15, 0], [-0.3, 1.15, 0], [0.35, 0.9, 0], [-0.35, 0.9, 0], [0, 1.55, 0], [0, 1.72, 0]];
// [parent, child] index pairs: legs from the hips, the spine to the head, the arms from the chest
const LEGS = [[0, 1], [0, 2], [1, 3], [2, 4], [3, 5], [4, 6], [5, 7], [6, 8], [0, 9], [9, 10]];
const SEATED_BONES = [...LEGS, [10, 11], [10, 12], [10, 13], [12, 14], [13, 15], [14, 16], [15, 17], [11, 18], [18, 19]];
const STANDING_BONES = [...LEGS, [10, 11], [10, 12], [11, 13], [12, 14], [13, 15], [14, 16], [10, 17], [17, 18]];
const ports = {
	bounds: ({ entity }) => {
		const joints = entity.posture === "sit" ? SEATED : STANDING, points = joints.map(([x, y, z]) => ({ x: entity.x + x, y: (entity.y ?? 0) + y, z: entity.z + z }));
		const bones = entity.posture === "sit" ? SEATED_BONES : STANDING_BONES;
		const pad = 0.08, axis = a => points.map(p => p[a]);
		return { min: { x: Math.min(...axis("x")) - pad, y: entity.y ?? 0, z: Math.min(...axis("z")) - pad }, max: { x: Math.max(...axis("x")) + pad, y: Math.max(...axis("y")) + pad, z: Math.max(...axis("z")) + pad }, points, bones };
	},
};
const scene = (objects, characters = []) => ({ frame: 0, frameCount: 24, objects, characters, shotDocument: { shots: [] } });
const figure = (id, at) => ({ ...createCharacterEntry({ id, subject: id, x: at.x, z: at.z }), ...at });

test("a chair tucked under a table only touches it; a crate sunk into the table top is inside it", () => {
	const table = sculpt("table", TABLE, { x: 0, z: 0 }), chair = sculpt("chair", CHAIR, { x: 0, z: 0.25 });
	assert.deepEqual(placementChecks(["chair"], scene([table, chair]), ports).overlapIds, [], "the seat is under the top, between the legs");
	const crate = { ...createSceneObject("cube"), id: "crate", x: 0.1, y: 0.55, z: 0, scaleX: 0.4, scaleY: 0.4, scaleZ: 0.4 };
	assert.deepEqual(placementChecks(["crate"], scene([table, crate]), ports).overlapIds, ["table"]);
	// a pedestal table whose lathe base has no bottom face, standing 2 cm deep in a floor slab: the slab is not inside the base
	const pedestal = sculpt("pedestal", [{ id: "base", shape: "lathe", size: [0.5, 0.05, 0.5], position: [0, 0.025, 0], profile: [[1, 0], [0.95, 0.6], [0.3, 1], [0, 1]] }, { id: "post", shape: "cylinder", size: [0.07, 0.7, 0.07], position: [0, 0.4, 0] }], { x: 0, z: 0 });
	const slab = { ...createSceneObject("cube"), id: "slab", y: 0.003, scaleX: 4, scaleY: 0.02, scaleZ: 4 };
	assert.deepEqual(placementChecks(["pedestal"], scene([slab, pedestal]), ports).overlapIds, []);
});

test("a cup set on the table top with its base 2 mm into it rests there; one sunk to its middle does not", () => {
	const table = sculpt("table", TABLE, { x: 0, z: 0 });
	assert.deepEqual(placementChecks(["cup"], scene([table, sculpt("cup", CUP, { x: 0.2, y: 0.748, z: 0 })]), ports).overlapIds, []);
	assert.deepEqual(placementChecks(["cup"], scene([table, sculpt("cup", CUP, { x: 0.2, y: 0.69, z: 0 })]), ports).overlapIds, ["table"]);
});

test("a body seated on a bench rests on it; a body standing where the bench is stands inside it", () => {
	const bench = sculpt("bench", BENCH, { x: 0, z: 0 });
	assert.deepEqual(placementChecks(["ann"], scene([bench], [figure("ann", { x: 0, z: -0.05, posture: "sit" })]), ports).overlapIds, []);
	assert.deepEqual(placementChecks(["ann"], scene([bench], [figure("ann", { x: 0, z: 0 })]), ports).overlapIds, ["bench"]);
});

test("a cup on the counter beside the counter's machine is supported; one held 10 cm above the top floats", () => {
	const counter = sculpt("counter", COUNTER, { x: 0, z: 0 });
	assert.deepEqual(placementChecks(["cup"], scene([counter, sculpt("cup", CUP, { x: -0.3, y: 1.0, z: 0 })]), ports).unsupportedIds, [], "the counter's box top is the machine's, above the cup's middle");
	assert.deepEqual(placementChecks(["cup"], scene([counter, sculpt("cup", CUP, { x: -0.3, y: 1.1, z: 0 })]), ports).unsupportedIds, ["cup"]);
	const bench = sculpt("bench", BENCH, { x: 0, z: 0 }), ball = { ...createSceneObject("sphere"), id: "ball", x: 0.3, y: 0.475, z: 0.05, scaleX: 0.08, scaleY: 0.08, scaleZ: 0.08 };
	assert.deepEqual(placementChecks(["ball"], scene([bench, ball]), ports).unsupportedIds, [], "a ball on the bench seat, below the backrest's top");
	// a roof slab on two thin walls at its very edges: a few rays down through the roof's footprint would miss them
	const wall = x => sculpt(`wall${x}`, [box("w", [0.08, 2.46, 1.4], [0, 1.23, 0])], { x, z: 0 }), roof = sculpt("roof", [box("r", [3.5, 0.2, 1.6], [0, 0.1, 0])], { x: 0, y: 2.38, z: 0 });
	assert.deepEqual(placementChecks(["roof"], scene([wall(-1.66), wall(1.66), roof]), ports).unsupportedIds, []);
});

test("a body fully in frame is not CLIPPED by the corners of its box; a body cut by the frame edge is", () => {
	const camera = (z, y) => ({ position: { x: 0, y, z }, lookAt: { x: 0, y: 0.9, z: 0 }, focalMm: 35, sensorId: "fullFrame" });
	const at = (cam, who = figure("ann", { x: 0, z: 0 })) => framingChecks(["ann"], { ...scene([], [who]), camera: cam, filmback: { sensorId: "fullFrame", aspectRatio: 16 / 9 } }, ports);
	// a camera close and low: the box's near top corners land above the frame, the head and hands do not
	const wide = { ...ports, bounds: args => { const b = ports.bounds(args); return { ...b, min: { ...b.min, x: b.min.x - 0.3, z: b.min.z - 0.6 }, max: { ...b.max, x: b.max.x + 0.3, y: b.max.y + 0.1, z: b.max.z + 0.6 } }; } };
	const framed = framingChecks(["ann"], { ...scene([], [figure("ann", { x: 0, z: 0 })]), camera: camera(3.6, 0.9), filmback: { sensorId: "fullFrame", aspectRatio: 16 / 9 } }, wide);
	assert.equal(framed.clipped, false);
	assert.equal(at(camera(1.6, 1.0)).clipped, true, "the feet and the head are out of a close frame");
});
