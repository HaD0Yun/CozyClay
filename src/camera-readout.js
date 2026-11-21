import { sampleAt } from "./sample-at.js";
import { shotAtFrame } from "./cuts.js";
import { deriveShot, SUBJECT_HEIGHT_M } from "./shot.js";

export function sampleCameraReadout({ scene, shots, frame }) {
	const camera = sampleAt(scene, shotAtFrame(shots, frame), frame).camera;
	return camera ? { ...camera, rollDeg: camera.rollDeg ?? 0 } : null;
}

function cameraReadoutAt({ scene, shots, frame, filmback, subjectAt, fallback }) {
	const camera = sampleCameraReadout({ scene, shots, frame });
	if (!camera) return fallback;
	const subject = subjectAt(shotAtFrame(shots, frame), frame) ?? { x: 0, y: 0, z: 0, rot: 0 };
	const derived = deriveShot(camera.pos, subject, (camera.fovDeg * Math.PI) / 180, SUBJECT_HEIGHT_M, filmback);
	return {
		shot: { ...derived, focalMm: camera.focalMm },
		transform: { x: camera.pos.x, y: camera.pos.y, z: camera.pos.z, pitch: camera.pitch * 180 / Math.PI, yaw: camera.yaw * 180 / Math.PI, roll: camera.rollDeg },
		camera,
	};
}

export function createCameraReadout({ scene, shots, filmback, subjectAt, fallback }) {
	return frame => cameraReadoutAt({ scene, shots, frame, filmback, subjectAt, fallback });
}
