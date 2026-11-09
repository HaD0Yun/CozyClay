#!/usr/bin/env node
// Camera roll: a key's framing.rollDeg and a rail's camera.rollDeg turn the
// shot camera about its lens axis. Level stays the default and stays absent
// from stored keys and blocks, so every older shot is byte-stable.
import assert from "node:assert/strict";
import * as THREE from "three";
import { cameraRoll, createCameraBlock, updateCameraBlock } from "../src/camera-block.js";
import { buildShotCameraTracks } from "../src/camera-direction.js";
import { captureFraming, interpolateFraming } from "../src/camera-move.js";
import { sampleAt } from "../src/sample-at.js";
import { createShotAuthoringDocument } from "../src/shot-authoring.js";
import { studioActionDeclaration } from "../src/studio-actions.js";
import { STUDIO_PATCH_SET_SCHEMAS, validateStudioSchema } from "../src/studio-agent-protocol.js";
import { serializeUsdCamera } from "../src/usd-camera.js";

const near = (a, b, tolerance = 1e-9) => Math.abs(a - b) <= tolerance;

// The angle wraps to -180..180 and anything but a number is level.
assert.deepEqual([0, 30, -30, 180, -180, 190, -190, 540].map(cameraRoll), [0, 30, -30, 180, -180, -170, 170, 180]);
assert.deepEqual([undefined, null, "15", NaN, Infinity].map(cameraRoll), [0, 0, 0, 0, 0]);

// Keys keep a roll and drop a level one; it eases between keys with the rest of the framing.
const framing = (x, rollDeg) => captureFraming({ pos: { x, y: 1.6, z: 4 }, yaw: 0, pitch: 0, fovDeg: 40, rollDeg });
assert.equal("rollDeg" in framing(0, 0), false, "a level framing has no roll field");
assert.equal(framing(0, 20).rollDeg, 20);
const shot = { id: "dutch", name: "Dutch", startFrame: 0, endFrame: 24,
	cameraKeys: [{ id: "a", frame: 0, framing: framing(0, 0) }, { id: "b", frame: 24, framing: framing(1, 190) }], camera: { mode: "keys" } };
const [stored] = createShotAuthoringDocument({ shots: [shot], frameCount: 48 }).shots;
assert.equal("rollDeg" in stored.cameraKeys[0].framing, false);
assert.equal(stored.cameraKeys[1].framing.rollDeg, -170, "a stored key's roll is wrapped");
const anchor = { x: 0, z: 0 };
assert.ok(near(interpolateFraming(framing(0, 0), framing(1, 40), anchor, 0.5).rollDeg, 20), "half way eases to half the roll");
assert.equal("rollDeg" in interpolateFraming(framing(0, 0), framing(1, 0), anchor, 0.5), false, "a level move stays level");
const scene = { frameCount: 48, subject: anchor, filmback: { sensorId: "fullFrame", aspectRatio: 16 / 9 } };
assert.equal(sampleAt(scene, stored, 24).camera.rollDeg, -170, "playback samples the key's roll");
assert.equal("rollDeg" in sampleAt(scene, stored, 0).camera, false);
console.log("PASS camera keys carry, wrap and ease a roll; level keys stay as they were");

// A rail carries one roll for its whole run; a block without a rail (or at 0) carries none.
const railed = updateCameraBlock({ mode: "rail" }, { cameraRail: [{ x: -2, z: 4 }, { x: 2, z: 4 }], rollDeg: 12 });
assert.equal(railed.rollDeg, 12);
assert.equal("rollDeg" in updateCameraBlock(railed, { rollDeg: 0 }), false, "rolling back to level removes the field");
assert.equal("rollDeg" in createCameraBlock({ mode: "follow", rollDeg: 12 }), false, "no rail, no roll");
const railShot = { id: "rail", name: "Rail", startFrame: 0, endFrame: 23, cameraKeys: [], camera: railed };
const [storedRail] = createShotAuthoringDocument({ shots: [railShot], frameCount: 24 }).shots;
assert.equal(storedRail.camera.rollDeg, 12, "the rail roll survives a save");
const subjectTrack = Array.from({ length: 24 }, () => ({ x: 0, y: 0, z: 0 }));
const track = buildShotCameraTracks({ shots: [storedRail], subjectTrack, fps: 24 });
assert.ok(track.every((sample) => sample.rollDeg === 12), "every rail sample holds the roll");
assert.equal(sampleAt({ ...scene, frameCount: 24, cameraTrack: track }, storedRail, 10).camera.rollDeg, 12);
console.log("PASS a rail rolls its camera for the whole run and saves the roll with the block");

// Authoring: an agent writes a roll on a key or on the rail.
const keysSchema = STUDIO_PATCH_SET_SCHEMAS.shot.properties.cameraKeys;
validateStudioSchema(keysSchema, [{ frame: 0, framing: { pos: { x: 0, y: 1.6, z: 4 }, yaw: 0, pitch: 0, fovDeg: 40, rollDeg: 15 } }]);
assert.throws(() => validateStudioSchema(keysSchema, [{ frame: 0, framing: { pos: { x: 0, y: 1.6, z: 4 }, yaw: 0, pitch: 0, fovDeg: 40, rollDeg: 400 } }]));
const setRail = studioActionDeclaration("shot.setCameraRail").input;
validateStudioSchema(setRail, { shotId: "rail", points: [{ x: 0, z: 0 }, { x: 1, z: 0 }], rollDeg: -15 });
assert.throws(() => validateStudioSchema(setRail, { shotId: "rail", points: [{ x: 0, z: 0 }, { x: 1, z: 0 }], rollDeg: 200 }), /rollDeg|180/);
console.log("PASS shot.cameraKeys and shot.setCameraRail take a roll in degrees");

// The USD camera turns about its own view axis by the roll, as three's YXZ Euler does.
const rolled = { pos: { x: 1, y: 2, z: 3 }, yaw: Math.PI / 6, pitch: Math.PI / 9, rollDeg: 25, fovDeg: 40, focalMm: 50, sensorId: "fullFrame" };
const usda = serializeUsdCamera({ frameCount: 1, cameraTrack: [rolled], filmback: { sensorId: "fullFrame", aspectRatio: 16 / 9 } },
	{ name: "Dutch", startFrame: 0, endFrame: 0, camera: { mode: "follow" } });
const [w, x, y, z] = usda.match(/quatf xformOp:orient = \(([^)]*)\)/)[1].split(",").map(Number);
const expected = new THREE.Quaternion().setFromEuler(new THREE.Euler(rolled.pitch, rolled.yaw, (rolled.rollDeg * Math.PI) / 180, "YXZ"));
assert.ok([[w, expected.w], [x, expected.x], [y, expected.y], [z, expected.z]].every(([a, b]) => near(a, b, 1e-6)), `USD orient ${[w, x, y, z]} vs ${expected.toArray()}`);
console.log("PASS the USD camera's orientation includes the roll");
