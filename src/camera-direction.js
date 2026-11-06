// Pure camera direction helpers shared by playback, export and the agent's
// receipts: the per-frame follow/rail camera of every shot, where a rail
// shot's head aims, and the stops a chain of camera keys makes.

import { createCameraBlock } from "./camera-block.js";
import { buildFollowTrack, buildRail, buildRailFollowTrack } from "./camera-follow.js";
import { shortestArc } from "./camera-move.js";
import { RAIL_SCHEDULE_LEGACY, RAIL_SCHEDULE_RANGE, resolveRailSchedule } from "./camera-rail-schedule.js";
import { shotAtFrame } from "./cuts.js";
import { objectTransformAt } from "./object-path.js";
import { placementAt } from "./root-path.js";
import { sampleAt } from "./sample-at.js";
import { SUBJECT_HEIGHT_M, focalMmToFov } from "./shot.js";
import { takeHips } from "./motion3/take.js";

const DEG = Math.PI / 180;
/** where a character's aim sits on its body: chest height, as a share of its stature, or above a take's hips */
const CHEST = 0.75, HIPS_TO_CHEST = 0.35;

/**
 * The follow and rail cameras of every shot, one sample per timeline frame
 * (null where a shot keys its camera or its rail is off). A rail shot with
 * an aim holds that aim instead of the follow subject and runs its rail on
 * schedule (no distance pull, no pitch offset), with its own lens when the
 * block names one. aimAt(id, frame) answers one cast member's aim point.
 */
export function buildShotCameraTracks({ shots, subjectTrack, fps, yawDeg = 0, aimAt = () => null, filmback = {} }) {
	const combined = new Array(subjectTrack.length).fill(null);
	const initialDir = { x: Math.sin(yawDeg * DEG), z: Math.cos(yawDeg * DEG) };
	for (const shot of shots) {
		const camera = createCameraBlock(shot.camera);
		if (camera.mode === "keys") continue;
		const start = shot.startFrame, subjectSlice = subjectTrack.slice(start, Math.min(subjectTrack.length, shot.endFrame + 1));
		const params = { ...camera.followCam, craneHeight: camera.craneHeight, dollyTiming: camera.dollyTiming, initialDir };
		const rail = camera.mode === "rail" ? buildRail(camera.cameraRail) : null;
		if (!rail) {
			buildFollowTrack(subjectSlice, fps, params).forEach((sample, offset) => { combined[start + offset] = sample; });
			continue;
		}
		const schedule = resolveRailSchedule({ railFollow: camera.railFollow, cameraRail: camera.cameraRail, frameCount: subjectSlice.length });
		if (schedule.kind !== RAIL_SCHEDULE_RANGE && schedule.kind !== RAIL_SCHEDULE_LEGACY) continue;
		const from = start + schedule.startFrame, length = schedule.endFrame - schedule.startFrame + 1;
		const aim = camera.aim ? Array.from({ length }, (_, offset) => railAimPoint(camera.aim, from + offset, aimAt)) : null;
		const aimed = aim?.every(Boolean) ? aim : null;
		const track = aimed
			? buildRailFollowTrack(aimed, fps, rail, { ...params, aimPerFrame: true, distanceInfluence: 0, pitchOffsetDeg: 0 })
			: buildRailFollowTrack(subjectSlice.slice(schedule.startFrame, schedule.endFrame + 1), fps, rail, params);
		const fovDeg = camera.focalMm ? focalMmToFov(camera.focalMm, filmback.sensorId, filmback.aspectRatio) / DEG : null;
		track.forEach((sample, offset) => { combined[from + offset] = fovDeg ? { ...sample, fovDeg } : sample; });
	}
	return combined;
}

/** A rail aim at one frame: its world point, or the middle of its cast (null when one is missing). */
function railAimPoint(aim, frame, aimAt) {
	if (aim.point) return aim.point;
	const points = aim.ids.map((id) => aimAt(id, frame));
	if (points.some((point) => !point)) return null;
	const mean = (axis) => points.reduce((sum, point) => sum + point[axis], 0) / points.length;
	return { x: mean("x"), y: aim.height ?? mean("y"), z: mean("z") };
}

/**
 * One cast member's aim point at a frame: a character's chest where its take
 * (or placement) puts it, an object's middle where its route (or placement)
 * puts it. clipOf(character) is the take the character plays.
 */
export function castAimPoint(id, frame, { characters = [], objects = [], shots = [], clipOf = () => null, frameCount, fps }) {
	const character = characters.find((entry) => entry.id === id);
	if (character) {
		const clip = clipOf(character), scale = character.scale ?? 1, yaw = (character.rot ?? 0) * DEG;
		// A take v3 moves the hips in the character's placement frame (motion3/take.js), not its root.
		if (clip?.hips) {
			const [x, y, z] = takeHips(clip, frame);
			return { x: character.x + (x * Math.cos(yaw) + z * Math.sin(yaw)) * scale, y: (character.y ?? 0) + (y + HIPS_TO_CHEST) * scale, z: character.z + (-x * Math.sin(yaw) + z * Math.cos(yaw)) * scale };
		}
		const at = placementAt(character, frame, { shotAt: (at) => shotAtFrame(shots, at),
			takeRoot: clip ? sampleAt({ frameCount: clip.frames, motion: clip }, null, frame).subject : null });
		return { x: at.x, y: (character.y ?? 0) + CHEST * SUBJECT_HEIGHT_M * (character.scale ?? 1), z: at.z };
	}
	const object = objects.find((entry) => entry.id === id);
	if (!object) return null;
	const at = objectTransformAt(object, frame, { frameCount, fps }) ?? object;
	return { x: at.x, y: at.y + ((object.height ?? 0) * (object.scaleY ?? 1)) / 2, z: at.z };
}

/** The follow subject's path, where its take v3 moves its body rather than its root (a follow or
 * aimless rail camera keeps up with the walk); any other subject keeps the path it has. */
export function followSubjectTrack(subjectTrack, subjectId, cast) {
	const character = cast.characters?.find((entry) => entry.id === subjectId);
	if (!subjectTrack || !character || !cast.clipOf(character)?.hips) return subjectTrack;
	return subjectTrack.map((point, frame) => castAimPoint(subjectId, frame, cast) ?? point);
}

/**
 * The frames of the keys a camera halts at for no reason: an interior key the
 * move runs on through in the same direction. Every key eases in and out, so
 * the camera slows to a stop there; a hold, a reversal or a new direction is
 * a stop the shot means and is not listed.
 */
export function cameraKeyStops(keys = []) {
	const steps = keys.slice(1).map((key, index) => {
		const a = keys[index].framing, b = key.framing;
		return [b.pos.x - a.pos.x, b.pos.y - a.pos.y, b.pos.z - a.pos.z, shortestArc(a.yaw, b.yaw), b.pitch - a.pitch, (b.fovDeg - a.fovDeg) * DEG];
	});
	const length = (step) => Math.hypot(...step);
	return keys.slice(1, -1).filter((_, index) => {
		const u = steps[index], v = steps[index + 1], dot = u.reduce((sum, value, axis) => sum + value * v[axis], 0);
		return length(u) > 0.02 && length(v) > 0.02 && dot > 0.5 * length(u) * length(v);
	}).map((key) => key.frame);
}

/** A receipt warning for a shot whose camera keys halt a move (none when they do not). */
export function cameraKeyWarnings(shot) {
	const stops = cameraKeyStops(shot.cameraKeys);
	if (!stops.length) return [];
	const listed = `${stops.slice(0, 4).join(", ")}${stops.length > 4 ? ` +${stops.length - 4}` : ""}`;
	return [{ code: "CAMERA_KEY_STOPS", id: shot.id, count: stops.length,
		message: `Camera stops at keys ${listed} (keys ease in/out); use a rail (shot.setCameraRail) or 2 keys.`.slice(0, 120) }];
}
