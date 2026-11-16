// "Does this prop hide the character from this camera" reads the prop's drawn shape (solid-shape.js) and the posed body's
// points, not one box around the prop and the centre of the character's box. A sculpt stair, an arch and a model with an
// opening are mostly air inside their boxes: a character plainly seen past or through them is not OCCLUDED. A wall, a
// closed sculpt box and a thick pillar in the same place still are, and so are the frames the motion visual reads.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createSceneObject, createSculptObject } from "../src/scene-objects.js";
import { createCharacterEntry } from "../src/scenes.js";
import { framingChecks } from "../src/studio-agent-commands.js";
import { occludersOf } from "../src/studio-geometry-facts.js";
import { motionScene } from "../src/motion3/scene.js";
import { blockersAt } from "../src/motion3/sightline.js";
import { solidOf, solidsOf } from "../src/solid-shape.js";
import { loadMeshScene } from "../src/scene-mesh-cache.js";

const box = (id, size, position) => ({ id, shape: "box", size, position });
const STAIRS = { parts: [0, 1, 2, 3, 4].map(i => box(`step${i}`, [1, 0.15 * (i + 1), 0.3], [0, 0.075 * (i + 1), -0.6 + 0.3 * i])) };
const ARCH = { parts: [box("postL", [0.3, 2.2, 0.3], [-0.8, 1.1, 0]), box("postR", [0.3, 2.2, 0.3], [0.8, 1.1, 0]), box("lintel", [1.9, 0.3, 0.3], [0, 2.35, 0])] };
const BLOCK = { parts: [box("block", [1.9, 2.5, 0.3], [0, 1.25, 0])] };
const sculpt = (recipe, at = {}) => ({ ...createSculptObject({ recipe }).object, id: "set", ...at });
const primitive = (kind, at) => ({ ...createSceneObject(kind), id: "set", ...at });

// A 1.8 m figure as the editor's bounds port hands it over: its box and its posed bones.
const JOINTS = [[0, 0.08, 0.05], [0.1, 0.08, 0], [-0.1, 0.08, 0], [0.1, 0.5, 0], [-0.1, 0.5, 0], [0.1, 0.95, 0], [-0.1, 0.95, 0], [0, 1.0, 0], [0, 1.2, 0], [0, 1.4, 0],
	[0.2, 1.45, 0], [-0.2, 1.45, 0], [0.3, 1.15, 0], [-0.3, 1.15, 0], [0.35, 0.9, 0], [-0.35, 0.9, 0], [0, 1.55, 0], [0, 1.7, 0]];
const portsWith = (extra = []) => ({ bounds: ({ entity }) => {
	const y = entity.y ?? 0, points = [...JOINTS, ...extra].map(([x, dy, z]) => ({ x: entity.x + x, y: y + dy, z: entity.z + z }));
	return { min: { x: entity.x - 0.35, y, z: entity.z - 0.15 }, max: { x: entity.x + 0.35, y: y + 1.8, z: entity.z + 0.15 }, points };
} });
function occluded(set, at, camera, ports = portsWith()) {
	const state = { frame: 0, frameCount: 24, objects: [set], characters: [createCharacterEntry({ id: "ann", subject: "Ann", ...at })], shotDocument: { shots: [] },
		camera: { position: camera, lookAt: { x: at.x, y: 1, z: at.z }, focalMm: 35, sensorId: "fullFrame" }, filmback: { sensorId: "fullFrame", aspectRatio: 16 / 9 } };
	return framingChecks(["ann"], state, ports).occluded;
}
const FRONT = { x: 0, y: 1.4, z: 5 };

test("a hollow sculpt is not OCCLUDED where its box would be (fails on the one-box check)", () => {
	assert.equal(occluded(sculpt(STAIRS), { x: -1.2, z: 0 }, { x: 2.5, y: 0.5, z: 0 }), false, "a figure beside low stairs, a low camera across the steps");
	assert.equal(occluded(sculpt(ARCH, { z: 1.5 }), { x: 0, z: 0 }, FRONT), false, "a figure seen through an arch");
	assert.equal(occluded(sculpt(ARCH, { x: 1.5, rot: 90, scaleX: 1.2, scaleY: 1.2, scaleZ: 1.2 }), { x: 0, z: 0 }, { x: 5, y: 1.4, z: 0 }), false, "turned and scaled: the opening turns and grows with it");
});

test("a wall, a closed sculpt and a thick pillar between the camera and the figure stay OCCLUDED", () => {
	assert.equal(occluded(primitive("cube", { z: 1.5, scaleX: 1.9, scaleY: 2.5, scaleZ: 0.3 }), { x: 0, z: 0 }, FRONT), true, "a wall");
	assert.equal(occluded(sculpt(BLOCK, { z: 1.5 }), { x: 0, z: 0 }, FRONT), true, "a closed sculpt box");
	assert.equal(occluded(primitive("cylinder", { z: 1.5, scaleX: 0.9, scaleY: 2.5, scaleZ: 0.9 }), { x: 0, z: 0 }, FRONT), true, "a thick pillar");
	assert.equal(occluded(sculpt(ARCH, { x: 1.5, rot: 90 }), { x: 0, z: 0.8 }, { x: 5, y: 1.4, z: 0.8 }), true, "the turned arch's post in front of the figure");
});

test("a hidden figure names the prop nearest the camera on each sight line, not the steps behind the wall", () => {
	const objects = [{ ...sculpt(STAIRS), id: "stairs" }, { ...sculpt(BLOCK, { x: 1.4, rot: 90 }), id: "wall" }];
	const state = { frame: 0, objects, characters: [createCharacterEntry({ id: "ann", subject: "Ann", x: -1.2, z: 0 })] };
	assert.deepEqual(occludersOf(state.characters[0], { x: 2.5, y: 0.5, z: 0 }, state, portsWith()).map(o => o.byObjectId), ["wall"]);
});

test("the body counts by share: a hand's many bones are one point, so a small box over the hand hides nothing", () => {
	const fingers = Array.from({ length: 30 }, (_, i) => [0.35 + (i % 5) * 0.01, 0.9 - Math.floor(i / 5) * 0.01, 0]);
	const crate = primitive("cube", { x: 0.33, z: 1, scaleX: 0.15, scaleY: 1, scaleZ: 0.15 });
	assert.equal(occluded(crate, { x: 0, z: 0 }, FRONT, portsWith(fingers)), false);
});

test("an imported model's loaded mesh is its shape; before it loads its box stands in", async () => {
	// A gate: two posts and a beam, 2 x 2.5 x 0.3, as OBJ text.
	const quads = [[-1, -0.7, 0, 2.2], [0.7, 1, 0, 2.2], [-1, 1, 2.2, 2.5]];
	const v = [], f = [];
	for (const [x0, x1, y0, y1] of quads) {
		const b = v.length;
		for (const x of [x0, x1]) for (const y of [y0, y1]) for (const z of [-0.15, 0.15]) v.push(`v ${x} ${y} ${z}`);
		for (const [a, c, d, e] of [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]]) f.push(`f ${b + a + 1} ${b + c + 1} ${b + d + 1} ${b + e + 1}`);
	}
	const gate = { ...createSceneObject("cube"), id: "set", renderer: "mesh", assetId: "mesh-occlusion-gate", footprint: { width: 2, depth: 0.3 }, height: 2.5, z: 1.5 };
	assert.equal(solidOf(gate), null, "not loaded: no shape of its own");
	assert.equal(occluded(gate, { x: 0, z: 0 }, FRONT), true, "its box stands in");
	await loadMeshScene(gate.assetId, { id: gate.assetId, type: "model/obj", bytes: new TextEncoder().encode([...v, ...f].join("\n")) });
	assert.equal(occluded({ ...gate }, { x: 0, z: 0 }, FRONT), false, "loaded: seen through the gate");
	assert.equal(occluded({ ...gate, x: 0.85 }, { x: 0, z: 0 }, FRONT), true, "loaded: a post in front of the figure");
});

test("blockersAt reads the same shapes: an arch hides nothing, a closed sculpt hides the body", () => {
	const joints = JOINTS.map(([x, y, z]) => [x, y, z]), eye = [FRONT.x, FRONT.y, FRONT.z];
	const share = set => { const scene = motionScene([set]); return blockersAt({ f0: 0, frames: [{ s: { P: joints } }], ctx: { objectsAt: () => scene.objects } }, eye, 0, [], solidsOf([set])).share; };
	assert.equal(share(sculpt(ARCH, { z: 1.5 })), 0);
	assert.ok(share(sculpt(BLOCK, { z: 1.5 })) >= 0.9);
	const scene = motionScene([sculpt(ARCH, { z: 1.5 })]);
	assert.ok(blockersAt({ f0: 0, frames: [{ s: { P: joints } }], ctx: { objectsAt: () => scene.objects } }, eye, 0).share >= 0.9, "without solids the box is the shape, as before");
});
