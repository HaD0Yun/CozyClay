#!/usr/bin/env node
import assert from "node:assert/strict";
import { placementAt, resolveCharacterPlacement, sampleRootPath } from "../src/root-path.js";

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
}), { x: 4, z: 5, rot: 33, posture: "lie", pose: { name: "shot" } });
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
