#!/usr/bin/env node
import assert from "node:assert/strict";
import { buildShotCameraTracks } from "../src/camera-direction.js";
import { sampleCameraReadout } from "../src/camera-readout.js";

const shot = {
	id: "rail-readout",
	name: "Rail readout",
	startFrame: 0,
	endFrame: 23,
	cameraKeys: [],
	camera: {
		mode: "rail",
		cameraRail: [{ x: -2, z: 4 }, { x: 2, z: 4 }],
		focalMm: 40,
		rollDeg: 17,
	},
};
const scene = {
	frameCount: 24,
	filmback: { sensorId: "fullFrame", aspectRatio: 16 / 9 },
	subjectTrack: Array.from({ length: 24 }, () => ({ x: 0, y: 0, z: 0 })),
};
scene.cameraTrack = buildShotCameraTracks({ shots: [shot], subjectTrack: scene.subjectTrack, fps: 24, filmback: scene.filmback });

const camera = sampleCameraReadout({ scene, shots: [shot], frame: 12 });
assert.ok(camera, "the readout source returns the rendered camera");
assert.equal(camera.focalMm, 40, "readouts use the rail lens");
assert.equal(camera.rollDeg, 17, "readouts use the rail roll");
console.log("PASS camera readout source returns the rendered rail lens and roll");
