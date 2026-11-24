// Pure camera direction helpers shared by playback, export and the agent's
// receipts: the per-frame follow/rail camera of every shot, where a rail
// shot's head aims, and the stops a chain of camera keys makes.

import { createCameraBlock } from "./camera-block.js";
import { buildFollowTrack, buildRail, buildRailFollowTrack } from "./camera-follow.js";
import { shortestArc } from "./camera-move.js";
import { RAIL_SCHEDULE_LEGACY, RAIL_SCHEDULE_RANGE, RAIL_SCHEDULE_TOO_SHORT, resolveRailSchedule } from "./camera-rail-schedule.js";
import { shotAtFrame } from "./cuts.js";
import { objectTransformAt } from "./object-path.js";
import { placementAt } from "./root-path.js";
import { sampleAt } from "./sample-at.js";
import { bodyScale } from "./lowvis/studio/figure.js";
import { SUBJECT_HEIGHT_M, focalMmToFov } from "./shot.js";
import { takeHips } from "./motion3/take.js";
import { skeletonFor } from "./motion3/rigs/index.js";
import { fk } from "./motion3/compiler/skeleton.js";
import { holdBody } from "./camera-hold-body.js";
import { shotSubjects, subjectsCenter } from "./shot-subjects.js";
import { applyRailHead, railTurnAt } from "./camera-rail-head.js";
import { sameData } from "./same-json.js";
import { carriedPointAt, sceneObjectCarryMatrixAt } from "./object-travel.js";

const DEG = Math.PI / 180;
/** where a character's aim sits on its body: chest height, as a share of its stature, or above a take's hips */
const CHEST = 0.75, HIPS_TO_CHEST = 0.35;

/**
 * The follow and rail cameras of every shot, one sample per timeline frame
 * (null where a shot keys its camera or its rail is off). A rail shot with
 * an aim holds that aim instead of the follow subject and runs its rail on
 * schedule (no distance pull, no pitch offset), with its own lens when the
 * block names one. A rail's head (camera-rail-head.js) then adds the angle set
 * by hand, or holds that angle alone when it turns to nothing.
 * aimAt(id, frame) answers one cast member's aim point.
 * bodyAt(frame) answers the shot subjects' posed joints at a frame (or null): a follow camera, and a rail camera
 * that frames the subjects, keep them in the picture of fovDeg (the lens a sample without its own renders with).
 */
export function buildShotCameraTracks({ shots, subjectTrack, fps, yawDeg = 0, yawDegOf = () => yawDeg, aimAt = () => null, filmback = {}, bodyAt = () => null, fovDeg = 45, reuse = null }) {
	const combined = new Array(subjectTrack.length).fill(null);
	const held = (track, from, dolly) => holdBody(track, track.map((_, offset) => bodyAt(from + offset)), { fovDeg, aspect: filmback.aspectRatio, dolly, fps });
	for (const shot of shots) {
		const camera = createCameraBlock(shot.camera);
		if (camera.mode === "keys") continue;
		// reuse (a Map the caller keeps while every other input above stays the same): a shot whose camera changed only
		// in its rail head's angle or its crane marks' turns keeps the samples it was built with, and only the angles
		// are applied again (the marks' heights still rebuild: they move the dolly). What the samples are built from is the
		// shot without those angles, compared value by value with the one they were built from.
		const marks = camera.craneHeight && { points: camera.craneHeight.points.map(({ t, height }) => ({ t, height })) };
		const input = reuse && [{ ...shot, camera: { ...shot.camera, head: undefined, craneHeight: marks } }, camera.head?.follow !== false];
		const kept = reuse?.get(shot.id);
		const built = kept && sameData(kept.input, input) ? kept : { input, ...shotTrack(shot, camera, { subjectTrack, fps, yawDegOf, aimAt, filmback, held }) };
		reuse?.set(shot.id, built);
		if (!built.samples) continue;
		// a crane mark's turn applies where the dolly is on the rail (its arc progress), not by frame
		built.samples.forEach((sample, offset) => { combined[built.from + offset] = built.rail ? applyRailHead(sample, camera.head, railTurnAt(camera.craneHeight, sample.s / built.rail)) : sample; });
	}
	return combined;
}

/** One shot's follow or rail samples before its rail head's angle ({ from, samples, rail: the rail's length or false }), or {} when it has none. */
function shotTrack(shot, camera, { subjectTrack, fps, yawDegOf, aimAt, filmback, held }) {
	const start = shot.startFrame, subjectSlice = subjectTrack.slice(start, Math.min(subjectTrack.length, shot.endFrame + 1));
	const yaw = yawDegOf(shot) * DEG, initialDir = { x: Math.sin(yaw), z: Math.cos(yaw) };
	const params = { ...camera.followCam, craneHeight: camera.craneHeight, dollyTiming: camera.dollyTiming, initialDir };
	const rail = camera.mode === "rail" ? buildRail(camera.cameraRail) : null;
	if (!rail) {
		if (!subjectSlice.length || subjectSlice.some(point => !point)) return {};
		return { from: start, samples: held(buildFollowTrack(subjectSlice, fps, params), start, true), rail: false };
	}
	let schedule = resolveRailSchedule({ railFollow: camera.railFollow, cameraRail: camera.cameraRail, frameCount: subjectSlice.length });
	if (schedule.kind === RAIL_SCHEDULE_TOO_SHORT && camera.aimTake && camera.railFollow?.mode !== "off") {
		const endFrame = Math.min(subjectSlice.length - 1, camera.aimTake.startFrame + camera.aimTake.samples.length - 1);
		if (camera.aimTake.startFrame > endFrame) return {};
		schedule = { kind: RAIL_SCHEDULE_RANGE, startFrame: camera.aimTake.startFrame, endFrame };
	}
	if (schedule.kind !== RAIL_SCHEDULE_RANGE && schedule.kind !== RAIL_SCHEDULE_LEGACY) return {};
	const from = start + schedule.startFrame, length = schedule.endFrame - schedule.startFrame + 1;
	const aim = camera.aim ? Array.from({ length }, (_, offset) => railAimPoint(camera.aim, from + offset, aimAt)) : null;
	const aimed = aim?.every(Boolean) ? aim : null, follows = camera.head?.follow !== false;
	const subject = subjectSlice.slice(schedule.startFrame, schedule.endFrame + 1);
	// A cast aim that lost a member turns to the follow subject, as it always has; a cast the user picked by
	// hand (aim.picked) holds still instead, like a picked subject (shot-subjects.js).
	if (follows && (camera.aim?.picked && !aimed || !aimed && subjectSlice.some(point => !point))) return {};
	// A head that turns to nothing still rides the rail: without a subject the dolly keeps its schedule alone.
	const lone = !aimed && subjectSlice.some(point => !point);
	const track = aimed
		? buildRailFollowTrack(aimed, fps, rail, { ...params, aimPerFrame: true, distanceInfluence: 0, pitchOffsetDeg: 0 })
		: lone ? buildRailFollowTrack(subject.map(() => rail.points[0]), fps, rail, { ...params, distanceInfluence: 0 })
			: buildRailFollowTrack(subject, fps, rail, params);
	const lensDeg = camera.focalMm ? focalMmToFov(camera.focalMm, filmback.sensorId, filmback.aspectRatio) / DEG : null;
	const lens = { ...(lensDeg ? { fovDeg: lensDeg } : {}), ...(camera.rollDeg ? { rollDeg: camera.rollDeg } : {}) };
	// a rail aimed at a cast or a point holds what it was asked to; an aimless following rail frames the subject's body;
	// the hand angle comes last (the caller), so the picture is the one the user turned to
	const framed = track.map((sample) => ({ ...sample, ...lens }));
	return { from, samples: aimed || !follows ? framed : held(framed, from, false), rail: rail.length };
}

/** Sample every named visible member through its own take, placement and parent carry. */
export function createShotSubjectSampler(cast) {
	const objects = new Map(cast.objects.map(object => [object.id, object]));
	return (shot, frame) => shotSubjects(shot, cast.characters, cast.activeId, cast.objects).map(entry => {
		const point = castAimPoint(entry.id, frame, cast);
		const placed = placementAt(entry, frame, { shotAt: at => shotAtFrame(cast.shots, at) });
		const carried = carriedPointAt(objects, entry.parent, { x: point.x, y: entry.y ?? 0, z: point.z }, frame, { frameCount: cast.frameCount, fps: cast.fps });
		return { ...entry, ...placed, ...carried };
	});
}

/** The posed joints of every named subject of the shot at a frame, or null when one of them has no take v3 body. A character
 * that rides an object has its joints carried the way its point on the subject track is (createShotSubjectSampler). */
export function createShotSubjectBodies(cast) {
	const objects = new Map(cast.objects.map(object => [object.id, object])), take = { frameCount: cast.frameCount, fps: cast.fps };
	return frame => {
		const bodies = shotSubjects(shotAtFrame(cast.shots, frame), cast.characters, cast.activeId, cast.objects).map(entry => {
			const points = castBodyPoints(entry.id, frame, cast), e = points && entry.parent ? sceneObjectCarryMatrixAt(objects, entry.parent, frame, take)?.elements : null;
			return e ? points.map(([x, y, z]) => [e[0] * x + e[4] * y + e[8] * z + e[12], e[1] * x + e[5] * y + e[9] * z + e[13], e[2] * x + e[6] * y + e[10] * z + e[14]]) : points;
		});
		return bodies.length && bodies.every(Boolean) ? bodies.flat() : null;
	};
}

/** A camera anchor for each absolute frame; null means no named visible target. */
export function shotSubjectTrack(cast) {
	const subjectsAt = createShotSubjectSampler(cast);
	return Array.from({ length: Math.max(1, cast.frameCount) }, (_, frame) => subjectsCenter(subjectsAt(shotAtFrame(cast.shots, frame), frame)));
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
		const clip = clipOf(character), scale = bodyScale(character), yaw = (character.rot ?? 0) * DEG;
		// A take v3 moves the hips in the character's placement frame (motion3/take.js), not its root.
		if (clip?.hips) {
			const [x, y, z] = takeHips(clip, frame);
			return { x: character.x + (x * Math.cos(yaw) + z * Math.sin(yaw)) * scale, y: (character.y ?? 0) + (y + HIPS_TO_CHEST) * scale, z: character.z + (-x * Math.sin(yaw) + z * Math.cos(yaw)) * scale };
		}
		const at = placementAt(character, frame, { shotAt: (at) => shotAtFrame(shots, at),
			takeRoot: clip ? sampleAt({ frameCount: clip.frames, motion: clip }, null, frame).subject : null });
		return { x: at.x, y: (character.y ?? 0) + CHEST * SUBJECT_HEIGHT_M * scale, z: at.z };
	}
	const object = objects.find((entry) => entry.id === id);
	if (!object) return null;
	const at = objectTransformAt(object, frame, { frameCount, fps }) ?? object;
	return { x: at.x, y: at.y + ((object.height ?? 0) * (object.scaleY ?? 1)) / 2, z: at.z };
}

/** A cast member's joints at a frame, posed by its take v3 and placed where the character stands (null without one). */
export function castBodyPoints(id, frame, { characters = [], clipOf = () => null }) {
	const character = characters.find((entry) => entry.id === id), clip = character && clipOf(character);
	const sk = clip?.hips && clip.rot && Array.isArray(clip.bones) ? skeletonFor(clip.rig ?? character.model) : null;
	if (!sk || sk.names.length !== clip.bones.length) return null;
	const B = clip.bones.length, f = Math.max(0, Math.min(clip.frameCount - 1, Math.round(frame)));
	const quats = Array.from({ length: B }, (_, b) => Array.from(clip.rot.subarray((f * B + b) * 4, (f * B + b) * 4 + 4)));
	const scale = bodyScale(character), yaw = (character.rot ?? 0) * DEG, c = Math.cos(yaw), s = Math.sin(yaw);
	return fk(sk, quats, takeHips(clip, f)).P.filter(Boolean).map(([x, y, z]) => [character.x + (x * c + z * s) * scale, (character.y ?? 0) + y * scale, character.z + (-x * s + z * c) * scale]);
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
 * move runs on through in the same direction. Default easing stops the camera; a hold, a reversal or a new direction is
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
		// Only report a stop when both adjoining segments stop at the key.
		const incoming = keys[index].ease, outgoing = keys[index + 1].ease;
		const endsSlow = !["linear", "easeIn"].includes(incoming), startsSlow = !["linear", "easeOut"].includes(outgoing);
		return endsSlow && startsSlow && length(u) > 0.02 && length(v) > 0.02 && dot > 0.5 * length(u) * length(v);
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
