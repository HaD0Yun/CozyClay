#!/usr/bin/env node
import assert from "node:assert/strict";
import * as THREE from "three";
import { createCameraBlock, updateCameraBlock, removeCameraRail } from "../src/camera-block.js";
import { buildShotCameraTracks } from "../src/camera-direction.js";
import { sampleAt } from "../src/sample-at.js";
import { createShotAuthoringDocument, serializeShotAuthoring, loadShotAuthoring } from "../src/shot-authoring.js";
import { serializeUsdCamera } from "../src/usd-camera.js";
import { createShot, cutAtFrame, duplicateShot, reorderShot, resizeShot } from "../src/cuts.js";

const tolerance = 1e-9;
const near = (a, b, message) => assert.ok(Math.abs(a - b) <= tolerance, `${message}: ${a} != ${b}`);
const samples = Array.from({ length: 24 }, (_, i) => ({ yaw: 0.3 + Math.sin(i / 4) * 0.4, pitch: -0.1 + i * 0.008 }));
const base = createShotAuthoringDocument({ frameCount: 144, shots: [{
	id: "rail-shot", name: "Rail take", startFrame: 12, endFrame: 59,
	cameraKeys: [0, 47].map((offset, i) => ({ id: `key-${i}`, frame: 12 + offset,
		framing: { pos: { x: i, y: 2, z: 6 }, yaw: 0, pitch: -0.2, fovDeg: 45 } })),
	camera: { mode: "rail", cameraRail: [{ x: -3, z: 5 }, { x: 3, z: 5 }],
		craneHeight: { points: [{ t: 0, height: 1.8 }, { t: 1, height: 2.4 }] },
		railFollow: { mode: "range", startFrame: 10, endFrame: 33 }, focalMm: 40, rollDeg: 17 },
}] });
const shot = base.shots[0], take = { startFrame: 10, samples };
const recorded = { ...shot, camera: updateCameraBlock(shot.camera, { aimTake: take }) };
const subjectTrack = Array.from({ length: 144 }, () => ({ x: 0, y: 0, z: 0 }));
const scene = { frameCount: 144, fps: 24, filmback: { sensorId: "fullFrame", aspectRatio: 16 / 9 },
	subjectTrack, cameraTrack: buildShotCameraTracks({ shots: [shot], subjectTrack, fps: 24 }) };

// The real sampler, shared by the live rig, frame/video export and USD,
// reproduces every production frame rather than easing between sparse keys.
for (let i = 0; i < samples.length; i++) {
	const frame = 22 + i, actual = sampleAt(scene, recorded, frame).camera;
	const original = sampleAt(scene, shot, frame).camera;
	near(actual.yaw, samples[i].yaw, `frame ${frame} yaw`);
	near(actual.pitch, samples[i].pitch, `frame ${frame} pitch`);
	assert.deepEqual(actual.pos, original.pos, "recording cannot move the dolly");
	near(actual.fovDeg, original.fovDeg, "authored lens");
	assert.equal(actual.rollDeg, 17, "authored roll");
}
for (const frame of [12, 21, 46, 59]) {
	assert.deepEqual(sampleAt(scene, recorded, frame), sampleAt(scene, shot, frame), "outside the rail take stays unchanged");
}
console.log("PASS every recorded aim sample reproduces within 1e-9 radians; rail, lens, roll and outside keys unchanged");

const saved = loadShotAuthoring(serializeShotAuthoring({ ...base, shots: [recorded] })).shots[0];
assert.deepEqual(saved, recorded, "scene serialization retains the entire take");
const replacement = { startFrame: 10, samples: samples.map(s => ({ yaw: s.yaw - 0.6, pitch: s.pitch + 0.2 })) };
const again = { ...saved, camera: updateCameraBlock(saved.camera, { aimTake: replacement }) };
const withoutTake = row => ({ ...row, camera: updateCameraBlock(row.camera, { aimTake: null }) });
assert.deepEqual(withoutTake(again), shot, "re-recording replaces only the take");
assert.deepEqual(withoutTake(saved), shot, "discard restores the original shot byte-for-byte");
near(sampleAt(scene, again, 34).camera.yaw, replacement.samples[12].yaw, "second take wins");
assert.deepEqual(duplicateShot([recorded], recorded.id, 144)[1].camera.aimTake, take, "duplicated shot owns a local take");
const moved = reorderShot([recorded], recorded.id, 72, 144)[0];
const movedScene = { ...scene, cameraTrack: buildShotCameraTracks({ shots: [moved], subjectTrack, fps: 24 }) };
near(sampleAt(movedScene, moved, 82).camera.yaw, samples[0].yaw, "local take travels with the shot");
assert.notEqual(createCameraBlock(recorded.camera).aimTake.samples, recorded.camera.aimTake.samples, "clones never share sample arrays");
assert.equal("aimTake" in removeCameraRail(recorded.camera), false, "no rail means no rail take");
console.log("PASS save/reload, replace-only-take, discard, duplicate and shot movement");

for (const offset of [0, 7]) {
	const editSamples = Array.from({ length: offset ? 38 : 60 }, (_, i) => ({ yaw: i / 100, pitch: -i / 200 }));
	const source = createShot("Edit take", 10, 69,
		shot.cameraKeys.map((key, i) => ({ ...key, frame: i ? 69 : 10 })), {
		...shot.camera,
		railFollow: { mode: "range", startFrame: offset, endFrame: offset + editSamples.length - 1 },
		aimTake: { startFrame: offset, samples: editSamples },
	});
	const editScene = { ...scene, cameraTrack: buildShotCameraTracks({ shots: [withoutTake(source)], subjectTrack, fps: 24 }) };
	const first = source.startFrame + offset, last = first + editSamples.length - 1;
	const check = (rows, label) => {
		for (const row of rows) {
			for (let frame = row.startFrame; frame <= row.endFrame; frame++) {
				const actual = sampleAt(editScene, row, frame).camera;
				if (frame >= first && frame <= last) {
					assert.ok(row.camera.aimTake, `${label}: retained recording is not deleted`);
					assert.ok(actual, `${label}: retained frame ${frame} has a camera`);
					const expected = editSamples[frame - first];
					near(actual.yaw, expected.yaw, `${label}: retained frame ${frame} yaw`);
					near(actual.pitch, expected.pitch, `${label}: retained frame ${frame} pitch`);
					const original = sampleAt(editScene, source, frame).camera;
					assert.deepEqual(actual.pos, original.pos, `${label}: retained rail position`);
					near(actual.fovDeg, original.fovDeg, `${label}: retained lens`);
					assert.equal(actual.rollDeg, original.rollDeg, `${label}: retained roll`);
				} else {
					assert.deepEqual(actual, sampleAt(editScene, withoutTake(row), frame).camera,
						`${label}: frame ${frame} outside the recording stays unmodified`);
				}
			}
		}
	};
	const verifyEdit = (rows, label) => {
		check(rows, label);
		const reloaded = loadShotAuthoring(serializeShotAuthoring({ ...base, shots: rows })).shots;
		check(reloaded, `${label} after save/reload`);
		const rebuiltScene = { ...editScene, cameraTrack: buildShotCameraTracks({ shots: reloaded, subjectTrack, fps: 24 }) };
		for (const row of reloaded) {
			for (let frame = Math.max(row.startFrame, first); frame <= Math.min(row.endFrame, last); frame++) {
				const actual = sampleAt(rebuiltScene, row, frame).camera;
				assert.ok(actual, `${label}: rebuilt track retains frame ${frame}`);
				near(actual.yaw, editSamples[frame - first].yaw, `${label}: rebuilt yaw`);
				near(actual.pitch, editSamples[frame - first].pitch, `${label}: rebuilt pitch`);
			}
		}
	};
	for (const frame of [40, 11, 20, 60, 69]) {
		const split = cutAtFrame([source], source.id, frame, sampleAt(editScene, source, frame).camera);
		assert.equal(split.length, 2, `offset ${offset} split at ${frame} creates both halves`);
		verifyEdit(split, `offset ${offset} split at ${frame}, both halves`);
	}
	for (const frame of [0, 12, 17, 30, 54, 60, 69]) {
		verifyEdit(resizeShot([source], source.id, "start", frame, 144), `offset ${offset} trim start to ${frame}`);
	}
	for (const frame of [10, 19, 30, 54, 60]) {
		verifyEdit(resizeShot([source], source.id, "end", frame, 144), `offset ${offset} trim end to ${frame}`);
	}
	const short = resizeShot([source], source.id, "end", 10, 144)[0];
	const off = { ...short, camera: updateCameraBlock(short.camera, { railFollow: { mode: "off" } }) };
	assert.deepEqual(sampleAt(editScene, off, 10), sampleAt(editScene, withoutTake(off), 10), "short retained takes respect explicit rail off");
	const trimmed = resizeShot([source], source.id, "start", 30, 144)[0];
	const movedTrim = reorderShot([trimmed], trimmed.id, 80, 144)[0];
	const copiedTrim = duplicateShot([trimmed], trimmed.id, 144).find(row => row.id !== trimmed.id);
	for (const row of [movedTrim, copiedTrim]) {
		assert.deepEqual(row.camera.aimTake, trimmed.camera.aimTake, "move and duplicate retain the edited local take");
		const frame = row.startFrame + row.camera.aimTake.startFrame;
		const travelScene = { ...editScene, cameraTrack: buildShotCameraTracks({ shots: [withoutTake(row)], subjectTrack, fps: 24 }) };
		near(sampleAt(travelScene, row, frame).camera.yaw, trimmed.camera.aimTake.samples[0].yaw, "edited take travels with its shot");
	}
	assert.deepEqual(source.camera.aimTake, { startFrame: offset, samples: editSamples }, "edits never mutate the source take");
}
console.log("PASS split halves, nonzero offsets, trim boundaries, save/reload and edited take movement");

for (const bad of [
	{ startFrame: -1, samples }, { startFrame: 0.5, samples }, { startFrame: 0, samples: [] },
	{ startFrame: 0, samples: [{ yaw: NaN, pitch: 0 }] }, { startFrame: 0, samples: [{ yaw: 0, pitch: Infinity }] },
]) assert.equal("aimTake" in createCameraBlock({ ...shot.camera, aimTake: bad }), false, "malformed take is rejected");

// Export the actual orientation and compare it with an independently built
// camera quaternion, including the rail's authored roll.
const usda = serializeUsdCamera(scene, saved);
const orient = usda.split("quatf xformOp:orient.timeSamples = {")[1].split("}")[0];
for (const i of [0, 12, 23]) {
	const frame = 22 + i;
	const match = orient.match(new RegExp(`\\n\\s*${frame}: \\(([^)]+)\\)`));
	assert.ok(match, `export has frame ${frame}`);
	const [w, x, y, z] = match[1].split(",").map(Number);
	const expected = new THREE.Quaternion().setFromEuler(new THREE.Euler(samples[i].pitch, samples[i].yaw, 17 * Math.PI / 180, "YXZ"));
	near(w, expected.w, "export quaternion w"); near(x, expected.x, "export quaternion x");
	near(y, expected.y, "export quaternion y"); near(z, expected.z, "export quaternion z");
}
console.log("PASS exported start/middle/end orientations reproduce the saved take and authored roll");
