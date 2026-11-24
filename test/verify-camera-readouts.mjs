#!/usr/bin/env node
import assert from "node:assert/strict";
import { buildShotCameraTracks } from "../src/camera-direction.js";
import { createCameraReadout, sampleCameraReadout } from "../src/camera-readout.js";

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
	const subjectAt = () => ({ x: 0, y: 0, z: 0, rot: 0 });
	// The lens is written on the track's samples, which the sampled camera takes as it is: the fixture is the same
	// number wherever the test runs. Whether a round trip through the field of view leaves a tail, and which one,
	// hangs on the platform's tan and atan.
	const readoutFor = (focalMm) => createCameraReadout({
		scene: { ...scene, cameraTrack: scene.cameraTrack.map((sample) => sample && { ...sample, focalMm }) },
		shots: [shot], filmback: scene.filmback, subjectAt,
	})(12);
	const tailed = 28.000000000000004; // the value the bar printed
	assert.notEqual(tailed, 28, "the fixture is a lens with an arithmetic tail");
	const prime = readoutFor(tailed);
	assert.equal(prime.camera.focalMm, tailed, "the camera keeps the exact lens");
	assert.equal(prime.shot.focalMm, 28, "a prime with a tail reads as the prime");
	assert.equal(`${prime.shot.focalMm}mm`, "28mm", "and its label is short");
	assert.equal(readoutFor(27.999999999999996).shot.focalMm, 28, "a tail below the prime reads as the prime too");
	assert.equal(readoutFor(24.44391231902759).shot.focalMm, 24.4, "a lens between primes reads to a tenth");
	assert.equal(readoutFor(40).shot.focalMm, 40, "a whole lens is untouched");
	// and on the path the Studio takes: a 28 mm rail lens through the field of view and back, with or without a tail
	const lensShot = { ...shot, id: "lens", camera: { ...shot.camera, focalMm: 28 } };
	const cameraTrack = buildShotCameraTracks({ shots: [lensShot], subjectTrack: scene.subjectTrack, fps: 24, filmback: scene.filmback });
	const rail = createCameraReadout({ scene: { ...scene, cameraTrack }, shots: [lensShot], filmback: scene.filmback, subjectAt })(12);
	assert.ok(Math.abs(rail.camera.focalMm - 28) < 1e-9, "the rail's lens comes back from the field of view");
	assert.equal(rail.shot.focalMm, 28, "and reads as the prime");
	console.log("PASS camera readouts write the lens to a tenth of a millimetre");
}
