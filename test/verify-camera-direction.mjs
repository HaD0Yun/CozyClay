// Rail shots that aim and carry a lens, and the camera-key stops the agent hears about.
import assert from "node:assert/strict";
import { createCameraBlock, updateCameraBlock, removeCameraRail } from "../src/camera-block.js";
import { buildShotCameraTracks, cameraKeyStops, cameraKeyWarnings, castAimPoint, followSubjectTrack } from "../src/camera-direction.js";
import { createShotAuthoringDocument } from "../src/shot-authoring.js";
import { focalMmToFov, SUBJECT_HEIGHT_M } from "../src/shot.js";

const DEG = Math.PI / 180;
const key = (frame, x, z, extra = {}) => ({ id: `camera-key-${frame}`, frame, framing: { pos: { x, y: 1.6, z }, yaw: 0, pitch: 0, fovDeg: 40, ...extra } });

// A move keyed through its middle keys stops at each of them.
const orbit = [0, 48, 96, 144, 192].map((frame, index) => key(frame, 5 * Math.sin((40 - index * 7) * DEG), 5 * Math.cos((40 - index * 7) * DEG)));
assert.deepEqual(cameraKeyStops(orbit), [48, 96, 144], "an orbit keyed every 48 frames halts at every inner key");
assert.deepEqual(cameraKeyStops([key(336, 3.8, -0.9), key(384, 3.6, -0.7), key(431, 3.4, -0.5)]), [384], "a three-key push-in halts halfway");
assert.deepEqual(cameraKeyStops([key(0, 0, 5), key(48, 0, 5), key(120, 2, 5)]), [], "a hold, then a move, is a stop the shot means");
assert.deepEqual(cameraKeyStops([key(0, 0, 5), key(48, 2, 5), key(96, 0, 5)]), [], "a reversal is meant too");
assert.deepEqual(cameraKeyStops([key(0, 0, 5), key(96, 2, 5)]), [], "two keys never stop mid-move");
assert.deepEqual(cameraKeyStops([key(0, 0, 5), key(24, 0, 5, { yaw: 0.3 }), key(48, 0, 5, { yaw: 0.6 })]), [24], "a pan keyed through its middle stops too");
const [warning] = cameraKeyWarnings({ id: "shot-1", cameraKeys: [...orbit, key(240, 0.5, 5), key(288, 0.2, 5)] });
assert.equal(warning.code, "CAMERA_KEY_STOPS");
assert.equal(warning.id, "shot-1");
assert(warning.message.length <= 120 && /rail/.test(warning.message), warning.message);
assert.deepEqual(cameraKeyWarnings({ id: "shot-1", cameraKeys: orbit.slice(0, 2) }), []);

// The aim and lens ride the rail: kept with it, dropped without it, and left
// out of a block that never had them so older shots stay byte-stable.
const rail = [{ x: -2, z: 4 }, { x: 2, z: 4 }];
const aimed = updateCameraBlock({ mode: "rail", cameraRail: rail }, { aim: { ids: ["char-a", "char-b"] }, focalMm: 35 });
assert.deepEqual([aimed.aim, aimed.focalMm], [{ ids: ["char-a", "char-b"] }, 35]);
assert.deepEqual(updateCameraBlock(aimed, { aim: { point: { x: 0, y: 1, z: 0 } } }).aim, { point: { x: 0, y: 1, z: 0 } });
assert.equal("aim" in updateCameraBlock(aimed, { aim: null, focalMm: null }), false, "null clears the aim");
assert.equal("aim" in removeCameraRail(aimed) || "focalMm" in removeCameraRail(aimed), false, "no rail, no aim or lens");
assert.equal("aim" in createCameraBlock({ mode: "keys" }), false);
const stored = createShotAuthoringDocument({ frameCount: 48, shots: [{ id: "shot-1", name: "Dolly", startFrame: 0, endFrame: 47, cameraKeys: [], camera: aimed }] }).shots[0].camera;
assert.deepEqual([stored.aim, stored.focalMm], [{ ids: ["char-a", "char-b"] }, 35], "persistence keeps the aim and the lens");

// A rail shot with an aim point travels its rail end to end and holds the point; the lens is its own.
const frames = 48, subjectTrack = Array.from({ length: frames }, () => ({ x: 9, z: 9 }));
const filmback = { sensorId: "super35", aspectRatio: 16 / 9 };
const shot = { id: "shot-1", startFrame: 0, endFrame: frames - 1, cameraKeys: [], camera: updateCameraBlock({ mode: "rail", cameraRail: rail }, { aim: { point: { x: 0, y: 1, z: 0 } }, focalMm: 35, craneHeight: { points: [{ t: 0, height: 2 }, { t: 1, height: 2 }] } }) };
const track = buildShotCameraTracks({ shots: [shot], subjectTrack, fps: 24, filmback });
const first = track[0], last = track[frames - 1];
assert(Math.hypot(first.pos.x + 2, first.pos.z - 4) < 0.05, `starts on the rail's head: ${JSON.stringify(first.pos)}`);
assert(last.pos.x > 1.2, `travels the rail on schedule, no distance pull back toward the subject: ${JSON.stringify(last.pos)}`);
assert.equal(first.pos.y, 2);
const aimYaw = (pos) => Math.atan2(-(0 - pos.x), -(0 - pos.z));
for (const sample of [first, last]) assert(Math.abs(sample.yaw - aimYaw(sample.pos)) < 0.05, `the head holds the aim point, not the subject at (9, 9): ${sample.yaw} vs ${aimYaw(sample.pos)}`);
assert(Math.abs(first.pitch - Math.atan2(1 - 2, Math.hypot(first.pos.x, first.pos.z))) < 0.02, "and tilts to its height");
assert(Math.abs(first.fovDeg - focalMmToFov(35, filmback.sensorId, filmback.aspectRatio) / DEG) < 1e-9, "the rail's lens rides each sample");
const risingShot = { ...shot, camera: updateCameraBlock(shot.camera, { aim: { ids: ["prop"] } }) };
const rising = buildShotCameraTracks({ shots: [risingShot], subjectTrack, fps: 24, aimAt: (_id, frame) => ({ x: 0, y: 0.3 + 1.3 * frame / (frames - 1), z: 0 }) });
for (let i = 0; i < frames; i += 1) {
 const sample = rising[i], y = 0.3 + 1.3 * i / (frames - 1);
 assert(Math.abs(sample.pitch - Math.atan2(y - sample.pos.y, Math.hypot(sample.pos.x, sample.pos.z))) < 1e-9);
}
assert(rising.at(-1).pitch > rising[0].pitch);
// Without an aim the rail still follows the subject, exactly as before.
const followed = buildShotCameraTracks({ shots: [{ ...shot, camera: createCameraBlock({ mode: "rail", cameraRail: rail }) }], subjectTrack, fps: 24, filmback });
assert(Math.abs(followed[0].yaw - Math.atan2(-(9 - followed[0].pos.x), -(9 - followed[0].pos.z))) < 0.05);
assert.equal(followed[0].fovDeg, undefined, "no lens of its own: the scene lens applies");
// A missing cast member falls back to the follow subject rather than aiming at nothing.
const lost = buildShotCameraTracks({ shots: [{ ...shot, camera: updateCameraBlock(shot.camera, { aim: { ids: ["gone"] } }) }], subjectTrack, fps: 24, aimAt: () => null, filmback });
assert(Math.abs(lost[0].yaw - Math.atan2(-(9 - lost[0].pos.x), -(9 - lost[0].pos.z))) < 0.05);
assert.equal(buildShotCameraTracks({ shots: [{ ...shot, camera: createCameraBlock({ mode: "keys" }) }], subjectTrack, fps: 24 })[0], null, "a keyed shot has no track");

// Cast aim points: a character's chest where it stands, an object's middle.
const characters = [{ id: "char-a", x: 1, z: 2, rot: 0, scale: 1 }];
const objects = [{ id: "chair", x: 0, y: 0, z: 0, height: 0.9, scaleY: 1 }];
assert.deepEqual(castAimPoint("char-a", 0, { characters, objects }), { x: 1, y: 0.75 * SUBJECT_HEIGHT_M, z: 2 });
assert.deepEqual(castAimPoint("chair", 0, { characters, objects }), { x: 0, y: 0.45, z: 0 });
assert.equal(castAimPoint("gone", 0, { characters, objects }), null);
const two = buildShotCameraTracks({ shots: [{ ...shot, camera: updateCameraBlock(shot.camera, { aim: { ids: ["char-a", "chair"] } }) }], subjectTrack, fps: 24, filmback,
	aimAt: (id, frame) => castAimPoint(id, frame, { characters, objects }) });
assert(Math.abs(two[0].yaw - Math.atan2(-(0.5 - two[0].pos.x), -(1 - two[0].pos.z))) < 0.05, "two ids aim at their middle");
const lowered = buildShotCameraTracks({ shots: [{ ...shot, camera: updateCameraBlock(shot.camera, { aim: { ids: ["char-a"], height: 0.9 } }) }], subjectTrack, fps: 24, filmback,
	aimAt: (id, frame) => castAimPoint(id, frame, { characters, objects }) });
assert(Math.abs(lowered[0].pitch - Math.atan2(0.9 - 2, Math.hypot(1 - lowered[0].pos.x, 2 - lowered[0].pos.z))) < 0.02, "an aim height replaces the chest");

// A take v3 carries the walk in its hips, in the character's placement frame: the aim and a
// follow subject ride it there (turned by the character's yaw), not at the standing spot.
const take = { frameCount: 3, hips: new Float32Array([0, 1, 0, 0, 1, 1, 0, 0.6, 2]) };
const walker = { characters: [{ id: "walker", x: -4, z: 0, rot: 90, scale: 1 }], clipOf: () => take };
const walked = castAimPoint("walker", 2, walker);
assert(Math.abs(walked.x + 2) < 1e-9 && Math.abs(walked.z) < 1e-9 && Math.abs(walked.y - 0.95) < 1e-6, `a turned walker two metres on: ${JSON.stringify(walked)}`);
const path = followSubjectTrack([{ x: -4, z: 0 }, { x: -4, z: 0 }, { x: -4, z: 0 }], "walker", walker);
assert.deepEqual(path.map((point) => Math.round(point.x)), [-4, -3, -2], "the follow subject walks with the take");
const still = [{ x: 1, z: 2 }];
assert.equal(followSubjectTrack(still, "char-a", { characters, clipOf: () => null }), still, "no take v3: the subject keeps its path");

console.log("camera direction: ok");
