// Pure playback sampling boundary. Renderers apply this value; they never
// advance simulation state. That makes a frame an address, not a side effect.

import { createCameraBlock } from "./camera-block.js";
import { railCameraOwner, resolveRailSchedule, isRailUsable, RAIL_OWNER_KEYS, RAIL_OWNER_RAIL, RAIL_SCHEDULE_TOO_SHORT } from "./camera-rail-schedule.js";
import { cameraMoveAt } from "./camera-move.js";
import { DEFAULT_SENSOR_FORMAT, SENSOR_FORMATS, fovToFocalMm } from "./shot.js";

const clamp = (value, min, max) => Math.max(min, Math.min(value, max));
const cleanZero = (value) => (Math.abs(value) < 1e-12 ? 0 : value);

function copyPoint(point) {
	return point ? { x: point.x, z: point.z } : null;
}

function sharedCamera(camera, scene) {
	if (!camera?.pos) return null;
	const requestedSensor = camera.sensorId ?? scene.sensorId ?? scene.filmback?.sensorId;
	const sensorId = SENSOR_FORMATS[requestedSensor]?.id ?? DEFAULT_SENSOR_FORMAT;
	const aspectRatio = scene.filmback?.aspectRatio;
	const fovDeg = Number.isFinite(camera.fovDeg)
		? camera.fovDeg
		: Number.isFinite(scene.fovDeg) ? scene.fovDeg : 45;
	const focalMm = Number.isFinite(camera.focalMm)
		? camera.focalMm
		: fovToFocalMm((fovDeg * Math.PI) / 180, sensorId, aspectRatio);
	// Deliberately spell out the shared contract. Integrator-only fields such
	// as rail arc position must not leak into render/export consumers.
	return {
		pos: { x: camera.pos.x, y: camera.pos.y, z: camera.pos.z },
		yaw: camera.yaw,
		pitch: camera.pitch,
		fovDeg,
		focalMm,
		sensorId,
		...(camera.rollDeg ? { rollDeg: camera.rollDeg } : {}),
	};
}

function pointOnTrack(track, frame) {
	if (!Array.isArray(track) || track.length === 0) return null;
	const at = clamp(frame, 0, track.length - 1);
	const lo = Math.floor(at);
	const hi = Math.min(lo + 1, track.length - 1);
	const weight = at - lo;
	if (!track[lo]) return null;
	if (!weight) return copyPoint(track[lo]);
	if (!track[hi]) return null;
	return {
		x: track[lo].x + (track[hi].x - track[lo].x) * weight,
		z: track[lo].z + (track[hi].z - track[lo].z) * weight,
	};
}

function rootAt(motion, frame) {
	if (!motion || !motion.rootPos || !Number.isFinite(motion.frames) || motion.frames < 1) return null;
	const sampled = clamp(frame, 0, motion.frames - 1);
	const anchorFrame = clamp(Number.isFinite(motion.anchorFrame) ? motion.anchorFrame : 0, 0, motion.frames - 1);
	const lo = Math.floor(sampled);
	const hi = Math.min(lo + 1, motion.frames - 1);
	const weight = sampled - lo;
	const root = (index, axis) => motion.rootPos[index * 3 + axis];
	const dx = root(lo, 0) + (root(hi, 0) - root(lo, 0)) * weight - root(anchorFrame, 0);
	const dz = root(lo, 2) + (root(hi, 2) - root(lo, 2)) * weight - root(anchorFrame, 2);
	const radians = ((Number.isFinite(motion.rotationDeg) ? motion.rotationDeg : 0) * Math.PI) / 180;
	return {
		x: (Number.isFinite(motion.anchorX) ? motion.anchorX : 0) + cleanZero(dx * Math.cos(radians) + dz * Math.sin(radians)),
		z: (Number.isFinite(motion.anchorZ) ? motion.anchorZ : 0) + cleanZero(-dx * Math.sin(radians) + dz * Math.cos(radians)),
	};
}

function cameraOnTrack(track, frame, scene) {
	if (!Array.isArray(track) || track.length === 0) return null;
	// Follow integration emits production frames. Playback addresses those
	// exact samples; fractional key-preview frames remain the key model's job.
	return sharedCamera(track[clamp(Math.round(frame), 0, track.length - 1)], scene);
}

/**
 * Return the complete playback-facing state for one absolute timeline frame.
 * `scene` is a sealed runtime envelope: { frameCount, subject, motion,
 * subjectTrack, cameraTrack, cameraAnchor, fovDeg, sensorId/filmback }.
 * Camera is always { pos, yaw, pitch, fovDeg, focalMm, sensorId }, plus
 * rollDeg when it is rolled about the lens axis.
 * Nothing in either input is
 * mutated and every returned nested value is independently owned.
 */
export function sampleAt(scene, shot, frame) {
	const source = scene && typeof scene === "object" ? scene : {};
	const maxFrame = Number.isFinite(source.frameCount)
		? Math.max(0, Math.round(source.frameCount) - 1)
		: Math.max(0, (source.subjectTrack?.length ?? source.cameraTrack?.length ?? 1) - 1);
	const sampledFrame = clamp(Number.isFinite(frame) ? frame : 0, 0, maxFrame);
	const subject = pointOnTrack(source.subjectTrack, sampledFrame)
		?? rootAt(source.motion, sampledFrame)
		?? copyPoint(source.subject);

	let camera = null;
	if (shot) {
		// The document boundary owns validation and cloning of the dense take.
		// Sampling must not copy a whole recording for every addressed frame.
		const { aimTake, ...instruction } = shot.camera ?? {};
		const block = createCameraBlock(instruction);
		const keyedCamera = () => sharedCamera(cameraMoveAt(
			shot.cameraKeys,
			source.cameraAnchorTrack ? pointOnTrack(source.cameraAnchorTrack, sampledFrame) ?? { x: 0, z: 0 } : source.cameraAnchor ?? source.subject ?? { x: 0, z: 0 },
			sampledFrame,
			source.filmback,
		), source);
		if (block.mode === "keys") {
			camera = keyedCamera();
		} else if (block.mode === "rail") {
			const startFrame = Number.isFinite(shot.startFrame) ? shot.startFrame : 0;
			const frameCount = Number.isFinite(shot.endFrame)
				? Math.max(0, Math.round(shot.endFrame - startFrame) + 1)
				: maxFrame + 1;
			const schedule = resolveRailSchedule({
				railFollow: block.railFollow,
				cameraRail: block.cameraRail,
				frameCount,
			});
			const owner = railCameraOwner({
				followEnabled: true,
				railUsable: isRailUsable(block.cameraRail),
				schedule,
				frame: sampledFrame - startFrame,
			});
			camera = owner === RAIL_OWNER_KEYS
				? keyedCamera()
				: cameraOnTrack(source.cameraTrack, sampledFrame, source);
			const aim = aimTake?.samples?.[Math.round(sampledFrame - startFrame) - aimTake.startFrame];
			// A cut can retain fewer frames than a newly authored rail requires.
			const retainedTake = schedule.kind === RAIL_SCHEDULE_TOO_SHORT && block.railFollow?.mode !== "off";
			if (camera && (owner === RAIL_OWNER_RAIL || retainedTake) && aim) camera = { ...camera, yaw: aim.yaw, pitch: aim.pitch };
		} else {
			camera = cameraOnTrack(source.cameraTrack, sampledFrame, source);
		}
	}

	return {
		frame: sampledFrame,
		motionFrame: source.motion?.frames > 0
			? clamp(Math.round(sampledFrame), 0, source.motion.frames - 1)
			: Math.round(sampledFrame),
		subject,
		camera,
	};
}
