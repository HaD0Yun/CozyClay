#!/usr/bin/env node
import assert from "node:assert/strict";
import { buildShotCameraTracks } from "../src/camera-direction.js";
import { createCameraReadout, sampleCameraReadout } from "../src/camera-readout.js";
import { focalMmToFov, fovToFocalMm } from "../src/shot.js";

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

// The readouts write the lens to a tenth of a millimetre (#1347): a lens that comes back from a field of view carries
// the arithmetic's tail, which the viewport bar printed in full ("28.000000000000004mm") and the lens menu's check
// mark missed. The camera the readout hands on keeps the exact value.
{
	const readoutFor = (focalMm) => {
		const lensShot = { ...shot, id: "lens", camera: { ...shot.camera, focalMm } };
		const lensScene = { ...scene };
		lensScene.cameraTrack = buildShotCameraTracks({ shots: [lensShot], subjectTrack: scene.subjectTrack, fps: 24, filmback: scene.filmback });
		return createCameraReadout({ scene: lensScene, shots: [lensShot], filmback: scene.filmback, subjectAt: () => ({ x: 0, y: 0, z: 0, rot: 0 }) })(12);
	};
	// a 28 mm prime through the field of view and back, on a filmback where the round trip leaves a tail
	const tailed = [["fullFrame", 16 / 9], ["fullFrame", 2.39], ["super35", 16 / 9], ["super35", 2.39], ["fullFrame", 4 / 3]]
		.map(([sensorId, aspectRatio]) => fovToFocalMm(focalMmToFov(28, sensorId, aspectRatio), sensorId, aspectRatio)).find((mm) => mm !== 28) ?? 28.000000000000004;
	assert.notEqual(tailed, 28, "the fixture is a lens with an arithmetic tail");
	const prime = readoutFor(tailed);
	assert.equal(prime.shot.focalMm, 28, "a prime with a tail reads as the prime");
	assert.equal(`${prime.shot.focalMm}mm`, "28mm", "and its label is short");
	assert.equal(prime.camera.focalMm, tailed, "the camera keeps the exact lens");
	assert.equal(readoutFor(31.74).shot.focalMm, 31.7, "a lens between primes reads to a tenth");
	assert.equal(readoutFor(40).shot.focalMm, 40, "a whole lens is untouched");
	console.log("PASS camera readouts write the lens to a tenth of a millimetre");
}
