#!/usr/bin/env node
import assert from "node:assert/strict";
import { placementAt, resolveCharacterPlacement, sampleRootPath } from "../src/root-path.js";
import { characterGizmoView } from "../src/stage-gizmo.js";

const character = {
	id: "proxy",
	x: 0,
	z: 0,
	rot: 12,
	posture: "stand",
	pose: null,
	layer: { waypoints: [
		{ id: "one", frame: 24, x: 2, z: 0, heading: null },
		{ id: "two", frame: 48, x: 2, z: 2, heading: null },
	] },
};
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
near(sampleRootPath(character, 0).x, 0);
near(sampleRootPath(character, 12).x, 1);
near(sampleRootPath(character, 12).z, 0);
near(sampleRootPath(character, 36).x, 2);
near(sampleRootPath(character, 36).z, 1);
near(sampleRootPath(character, 100).x, 2);
near(sampleRootPath(character, 100).z, 2);
near(sampleRootPath(character, 12).heading, 90);
near(sampleRootPath(character, 36).heading, 0);
near(sampleRootPath({ ...character, layer: { waypoints: [{ frame: 24, x: 2, z: 0, heading: 90 }] } }, 12).heading, 90);
assert.equal(sampleRootPath({ ...character, layer: { waypoints: [] } }, 12), null);

const placementCharacter = { ...character, x: 1, z: 1, rot: 10, posture: "sit", pose: { name: "base" }, layer: { waypoints: [] } };
assert.deepEqual(resolveCharacterPlacement(placementCharacter, 12), { x: 1, z: 1, rot: 10, posture: "sit", pose: { name: "base" } });
const shotAt = frame => {
	assert.equal(frame, 12);
	return { cast: { proxy: { x: 4, z: 5, rot: 33 } } };
};
const pathCharacter = { ...placementCharacter, layer: character.layer };
assert.equal(resolveCharacterPlacement(pathCharacter, 12, { shotAt }).x, 1.5);
assert.deepEqual(resolveCharacterPlacement(pathCharacter, 12, { shotAt, takeRoot: { x: 8, z: 9, rot: 77 } }),
	{ x: 8, z: 9, rot: 77, posture: "sit", pose: { name: "base" } });
assert.deepEqual(resolveCharacterPlacement({ ...placementCharacter, layer: { waypoints: [] } }, 12, {
	shotAt: () => ({ cast: { proxy: { x: 4, z: 5, rot: 33, posture: "lie", pose: { name: "shot" } } } }),
}), { x: 1, z: 1, rot: 10, posture: "sit", pose: { name: "base" } }, "an old shot's per-shot cast override no longer places a character");
assert.deepEqual(sampleRootPath(character, -10), { x: 0, z: 0, heading: 12 });
assert.deepEqual(sampleRootPath(character, 12, { fps: 48 }), sampleRootPath(character, 12));
const stationary = { ...character, layer: { waypoints: [{ frame: 24, x: 0, z: 0, heading: null }] } };
assert.equal(sampleRootPath(stationary, 12).heading, 12);
const rigged = { ...pathCharacter, model: "y-bot-tpose" };
assert.deepEqual(placementAt(rigged, 12, {
	shotAt: () => ({ kind: "clip", cast: { proxy: { x: 4, z: 5, rot: 33 } } }),
}), rigged);
assert.deepEqual(placementAt(rigged, 12, {
	shotAt: () => ({ kind: "still", cast: { proxy: { x: 4, z: 5, rot: 33 } } }),
}), rigged, "an old still's per-shot cast override no longer moves a character");
assert.equal(placementAt({ ...pathCharacter, model: "proxy-figure" }, 12, {
	shotAt: () => ({ kind: "clip", cast: { proxy: { x: 4, z: 5, rot: 33 } } }),
}).x, 1.5);
console.log("PASS root path interpolation, heading, hold, null, and placement priority");

// The selected character's gizmo (stage-gizmo.js): with a take it stands at the take's body (the hips across the
// floor, turned with the character) at the playhead, and `offset` maps a drag back to the character's own place.
const walker = { id: "walker", model: "x-bot-tpose", x: 1, z: 2, rot: 90, scale: 1 };
const hips = new Float32Array(3 * 3); hips.set([0, 1, 0, 0, 1, 1.5, 0.5, 1, 3]); // frame 0 at the start, then 1.5 m and 3 m ahead
const take = { frames: 3, hips };
const view = frame => characterGizmoView({ selected: true, characters: [walker], activeCharacterId: "walker", activeCharacter: walker, motion: take, shots: [], activeId: "walker", frame });
const nearAll = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-6);
assert.ok(nearAll(view(0).position, [1, 0, 2]), "frame 0: the gizmo is at the take's start");
assert.ok(nearAll(view(1).position, [2.5, 0, 2]), `frame 1: 1.5 m ahead, turned 90 degrees to +X (${view(1).position})`);
assert.ok(nearAll(view(2).position, [4, 0, 1.5]), `frame 2: at the body, not at the start (${view(2).position})`);
assert.ok(nearAll(view(2).offset, [3, -0.5]), "the offset is the body's distance from the character's place");
const dragged = { x: view(2).position[0] + 0.25, z: view(2).position[2] };
assert.ok(nearAll([dragged.x - view(2).offset[0], dragged.z - view(2).offset[1]], [1.25, 2]), "a 0.25 m drag moves the character (the whole take) by 0.25 m");
const still = { ...walker, id: "still" };
assert.ok(nearAll(characterGizmoView({ selected: true, characters: [still], activeCharacterId: "still", activeCharacter: still, motion: null, shots: [], activeId: "still", frame: 2 }).position, [1, 0, 2]), "without a take the gizmo stays on the character");
console.log("PASS the character gizmo follows a take's body at the playhead");
