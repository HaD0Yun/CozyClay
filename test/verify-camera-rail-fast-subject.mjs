#!/usr/bin/env node
// A rail camera beside a fast subject keeps up: the dolly rides the speed the
// shot asks (rail length over the shot's time), a stored old default cap of
// 4 m/s is read as no cap, and a cap someone sets is measured as metres of lag.
import assert from "node:assert/strict";
import { FOLLOW_DEFAULTS, buildRail, buildRailFollowTrack } from "../src/camera-follow.js";
import { createCameraBlock } from "../src/camera-block.js";
import { cappedSpringStep } from "../src/dolly-spring.js";
import { readShotAuthoringDocument } from "../src/shot-authoring.js";
import { railDollyLag } from "../src/rail-dolly-lag.js";
import { WORLD } from "../src/world-scale.js";

const FPS = 24;
const FRAMES = 96; // 4 s
const SPEED = 8; // m/s, a vehicle in town
const subject = Array.from({ length: FRAMES }, (_, f) => ({ x: (SPEED * f) / FPS, y: 1, z: 0 }));
const railPoints = [{ x: 0, z: 4 }, { x: (SPEED * (FRAMES - 1)) / FPS, z: 4 }];
const rail = buildRail(railPoints);

const body = (version, maxDollySpeed) => ({
	version,
	frameCount: FRAMES,
	waypoints: [],
	shots: [{ id: "shot-a", name: "Beside", startFrame: 0, endFrame: FRAMES - 1,
		camera: { mode: "rail", cameraRail: railPoints, followCam: { distance: 4, height: 1.2, response: 0.7, lead: 0.25, railStartMode: "head", maxDollySpeed, pitchOffsetDeg: 0, orbitOffsetDeg: 0 } } }],
});
const capOf = (version, cap) => readShotAuthoringDocument(body(version, cap)).state.shots[0].camera.followCam.maxDollySpeed;

// Defaults: no cap below the world's own bound, and none in the pure math.
assert.equal(FOLLOW_DEFAULTS.maxDollySpeed, Infinity);
assert.equal(createCameraBlock({}).followCam.maxDollySpeed, WORLD.dollySpeed);
// Every body before v8 stored 4 as its default: read as no cap. Another stored cap, or a 4 in a v8 body, is a choice and stays.
for (const version of [4, 6, 7]) assert.equal(capOf(version, 4), WORLD.dollySpeed, `v${version}: the old default 4 m/s cap is lifted`);
assert.equal(capOf(7, 2.5), 2.5, "a cap someone chose stays");
assert.equal(capOf(8, 4), 4, "a v8 body's 4 m/s is a choice");
assert.equal(readShotAuthoringDocument(body(7, 4)).status, "migrated");

// The camera of the read shot stays beside the subject the whole shot.
const followCam = readShotAuthoringDocument(body(7, 4)).state.shots[0].camera.followCam;
const planar = (track) => track.map((sample, f) => Math.hypot(sample.pos.x - subject[f].x, sample.pos.z - subject[f].z));
const kept = planar(buildRailFollowTrack(subject, FPS, rail, followCam));
const lagged = planar(buildRailFollowTrack(subject, FPS, rail, { ...followCam, maxDollySpeed: 4 }));
const worst = (values) => Math.max(...values);
assert.ok(worst(kept) < 6, `uncapped: the camera stays within ${worst(kept).toFixed(2)} m of the subject (rail 4 m to the side)`);
assert.ok(worst(lagged) > 12, `a 4 m/s cap falls ${worst(lagged).toFixed(2)} m behind an 8 m/s subject`);

// A set cap is measured as lag along the rail; no cap measures none.
const capped = railDollyLag(rail, FRAMES, FPS, { ...followCam, maxDollySpeed: 4 });
assert.ok(capped.behindM > 10 && capped.endShortM > 10 && capped.frame > 0, JSON.stringify(capped));
assert.deepEqual(railDollyLag(rail, FRAMES, FPS, followCam), { behindM: 0, frame: 0, endShortM: 0 });
assert.deepEqual(railDollyLag(null, FRAMES, FPS, followCam), { behindM: 0, frame: 0, endShortM: 0 });

// A slow rail never reached the old cap: its track is the same with or without it.
const walk = Array.from({ length: FRAMES }, (_, f) => ({ x: (1.2 * f) / FPS, y: 1, z: 0 }));
const walkRail = buildRail([{ x: 0, z: 3 }, { x: (1.2 * (FRAMES - 1)) / FPS, z: 3 }]);
assert.deepEqual(buildRailFollowTrack(walk, FPS, walkRail, { maxDollySpeed: 4 }), buildRailFollowTrack(walk, FPS, walkRail));
// A cap that is not a number stops the dolly, as before; null is no cap.
assert.equal(buildRailFollowTrack(walk, FPS, walkRail, { maxDollySpeed: Number.NaN }).at(-1).s, 0);
assert.deepEqual(buildRailFollowTrack(walk, FPS, walkRail, { maxDollySpeed: null }), buildRailFollowTrack(walk, FPS, walkRail));

// The stiffest response the schema allows (0.1 s) stays stable at 24 fps: no one-frame lurch and stall.
const stiffRail = buildRail([{ x: 0, z: 3 }, { x: (2 * (FRAMES - 1)) / FPS, z: 3 }]);
const stiff = buildRailFollowTrack(Array.from({ length: FRAMES }, (_, f) => ({ x: (2 * f) / FPS, y: 1, z: 0 })), FPS, stiffRail, { response: 0.1 });
const stiffSpeeds = stiff.slice(1).map((sample, f) => (sample.s - stiff[f].s) * FPS);
assert.ok(Math.max(...stiffSpeeds) < 2 * 1.5, `a 2 m/s rail at response 0.1 peaks at ${Math.max(...stiffSpeeds).toFixed(2)} m/s`);
assert.ok(stiffSpeeds.slice(0, FRAMES - 12).every((speed) => speed > 1), `no stalled frame inside the move: ${stiffSpeeds.slice(0, 8).map((v) => v.toFixed(2))}`);
// At omega * dt <= 0.5 (every response from 0.39 s at 24 fps) the step is the single semi-implicit step it always was.
const omega = 4.6 / 0.7, dt = 1 / FPS, acc = omega * omega * (3 - 1) - 2 * omega * 0.5, vel = 0.5 + acc * dt;
assert.deepEqual(cappedSpringStep(1, 0.5, 3, omega, dt, 40), [1 + vel * dt, vel]);

console.log(`verify-camera-rail-fast-subject: ok (8 m/s subject: widest gap ${worst(kept).toFixed(2)} m uncapped vs ${worst(lagged).toFixed(2)} m at a 4 m/s cap; cap lag ${capped.behindM.toFixed(1)} m, ${capped.endShortM.toFixed(1)} m short)`);
