import { sampleAt } from "./sample-at.js";
import { shotAtFrame } from "./cuts.js";
import { deriveShot, SUBJECT_HEIGHT_M } from "./shot.js";

export function sampleCameraReadout({ scene, shots, frame }) {
	const camera = sampleAt(scene, shotAtFrame(shots, frame), frame).camera;
	return camera ? { ...camera, rollDeg: camera.rollDeg ?? 0 } : null;
}

// The lens as the readouts write it: to a tenth of a millimetre. A lens that comes back from a field of view carries
// the arithmetic's tail (a 28 mm prime reads 28.000000000000004), which a label prints in full and a comparison with
// a prime misses. The camera itself (`camera` below) keeps the exact value. The viewport bar, four characters wide,
// writes whole millimetres (ViewportToolbar.jsx); Details and the preview header write the tenth.
const readoutMm = (mm) => (Number.isFinite(mm) ? Math.round(mm * 10) / 10 : mm);

function cameraReadoutAt({ scene, shots, frame, filmback, subjectAt, fallback }) {
	const camera = sampleCameraReadout({ scene, shots, frame });
	if (!camera) return fallback;
	const subject = subjectAt(shotAtFrame(shots, frame), frame) ?? { x: 0, y: 0, z: 0, rot: 0 };
	const derived = deriveShot(camera.pos, subject, (camera.fovDeg * Math.PI) / 180, SUBJECT_HEIGHT_M, filmback);
	return {
		shot: { ...derived, focalMm: readoutMm(camera.focalMm) },
		transform: { x: camera.pos.x, y: camera.pos.y, z: camera.pos.z, pitch: camera.pitch * 180 / Math.PI, yaw: camera.yaw * 180 / Math.PI, roll: camera.rollDeg },
		camera,
	};
}

export function createCameraReadout({ scene, shots, filmback, subjectAt, fallback }) {
	return frame => cameraReadoutAt({ scene, shots, frame, filmback, subjectAt, fallback });
}
