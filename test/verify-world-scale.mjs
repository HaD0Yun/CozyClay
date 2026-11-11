#!/usr/bin/env node
// World scale: "room" keeps every bound the studio has always had, "large"
// widens position, scale, path, rail height, lens and dolly speed together.
// The scale is read once at load, so each scale is checked in its own process.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const probe = async () => {
	const { WORLD, WORLD_SCALE } = await import("../src/world-scale.js");
	const { elementByPath } = await import("../src/studio-elements.js");
	const { normalizeSceneObject } = await import("../src/scene-objects.js");
	const { createObjectPath } = await import("../src/object-path.js");
	const { createShotAuthoringDocument } = await import("../src/shot-authoring.js");
	const { studioActionDeclaration } = await import("../src/studio-actions.js");
	const { validateStudioSchema } = await import("../src/studio-agent-protocol.js");
	const far = WORLD.position * 10;
	const object = normalizeSceneObject({ id: "tower", renderer: "cube", x: far, y: far, z: -far, scaleX: far, scaleY: far, scaleZ: far });
	const path = createObjectPath({ points: [{ x: -far, y: far, z: 0 }, { x: far, y: 0, z: 0 }] });
	const shot = { id: "s", name: "S", startFrame: 0, endFrame: 47, cameraKeys: [], camera: { mode: "rail", followCam: { maxDollySpeed: far } } };
	const [authored] = createShotAuthoringDocument({ shots: [shot] }).shots;
	const rail = studioActionDeclaration("shot.setCameraRail").input;
	const railAccepts = (height) => { try { validateStudioSchema(rail, { shotId: "s", points: [{ x: 0, z: 0 }, { x: 1, z: 0 }], height, aimHeight: height }); return true; } catch { return false; } };
	return {
		scale: WORLD_SCALE, world: WORLD,
		character: elementByPath("character.position").max, objectMax: elementByPath("object.position").max, scaleMax: elementByPath("object.scale").max.x,
		object: { x: object.x, y: object.y, z: object.z, scaleX: object.scaleX },
		path: path.points.map(({ x, y }) => ({ x, y })),
		dolly: authored.camera.followCam.maxDollySpeed,
		railAt: [WORLD.railHeight, WORLD.railHeight + 1].map(railAccepts),
	};
};

if (process.argv[2] === "--probe") {
	const query = process.argv[3];
	if (query) globalThis.location = { search: `?world=${query}` };
	console.log(JSON.stringify(await probe()));
	process.exit(0);
}

const run = (...args) => JSON.parse(execFileSync(process.execPath, [fileURLToPath(import.meta.url), "--probe", ...args], { encoding: "utf8" }));

// The room is the studio as it was: every number below predates the setting.
const room = run();
assert.equal(room.scale, "room", "no stored choice and no query is the room");
assert.deepEqual(room.world, { position: 240, scale: 100, pathHeight: 60, railHeight: 30, cameraFar: 100, horizon: { near: 55, far: 95 }, dollySpeed: 40 });
assert.deepEqual(room.character, { x: 240, y: 240, z: 240 });
assert.deepEqual(room.objectMax, { x: 240, y: 240, z: 240 });
assert.equal(room.scaleMax, 100);
assert.deepEqual(room.object, { x: 240, y: 240, z: -240, scaleX: 100 }, "an object past the room is clamped back into it");
assert.deepEqual(room.path, [{ x: -240, y: 60 }, { x: 240, y: 0 }], "a travel path stays on the 240 m floor, 60 m up at most");
assert.equal(room.dolly, 40, "the rail dolly tops out at 40 m/s");
assert.deepEqual(room.railAt, [true, false], "a rail rides 30 m high at most");
console.log("PASS the room scale keeps every bound the studio had");

// Large widens every bound at once, so one scene can hold an exterior at full size.
const large = run("large");
assert.equal(large.scale, "large");
assert.deepEqual(large.object, { x: 3000, y: 3000, z: -3000, scaleX: 3000 });
assert.deepEqual(large.path, [{ x: -3000, y: 3000 }, { x: 3000, y: 0 }]);
assert.equal(large.dolly, 1000);
assert.deepEqual(large.railAt, [true, false], "a rail rides 600 m high at most");
assert.equal(large.world.railHeight, 600);
assert.ok(large.world.horizon.far < large.world.cameraFar, "the export horizon stays inside the far plane");
console.log("PASS the large scale widens position, scale, path, rail, lens and dolly bounds together");

// Anything else in the query is ignored rather than trusted.
assert.equal(run("planet").scale, "room");
console.log("PASS an unknown world scale falls back to the room");
