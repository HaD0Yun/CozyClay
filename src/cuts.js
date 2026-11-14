// Pure optional Shot-overlay model. Shots are camera ownership cards placed
// on a timeline: gaps are valid free-camera time, overlaps are rejected.

import { cameraMoveAt } from "./camera-move.js";
import { cloneCameraBlock, createCameraBlock } from "./camera-block.js";
import {
	createStableItemId,
	normalizeStableItems,
	removeStableItem,
	requireStableItem,
	updateStableItem,
} from "./stable-items.js";

const DEFAULT_SHOT_FRAMES = 40;

const frameNumber = (value, fallback = 0) => Number.isFinite(value) ? Math.round(value) : fallback;

function cloneFraming(framing) {
	return framing ? { ...framing, pos: framing.pos ? { ...framing.pos } : framing.pos } : framing;
}

function uniqueKeys(keys, min = -Infinity, max = Infinity) {
	const byFrame = new Map();
	for (const key of normalizeStableItems(keys, "camera-key")) {
		if (!Number.isFinite(key.frame) || !key.framing) continue;
		const frame = Math.max(min, Math.min(max, Math.round(key.frame)));
		byFrame.set(frame, { id: key.id, frame, framing: cloneFraming(key.framing) });
	}
	return [...byFrame.values()].sort((a, b) => a.frame - b.frame);
}

function shotExtras(shot) {
	return {
		...(shot.subjectIds?.length ? { subjectIds: [...shot.subjectIds] } : {}),
		...(shot.optics ? { optics: structuredClone(shot.optics) } : {}),
		...(shot.review ? { review: structuredClone(shot.review) } : {}),
	};
}

function rebaseRecordedAim(camera, delta) {
	if (!camera?.aimTake || delta === 0) return camera;
	const startFrame = camera.aimTake.startFrame - delta;
	return createCameraBlock({
		...camera,
		aimTake: {
			startFrame: Math.max(0, startFrame),
			samples: camera.aimTake.samples.slice(Math.max(0, -startFrame)),
		},
		railFollow: camera.railFollow?.mode === "range" ? {
			...camera.railFollow,
			startFrame: Math.max(0, camera.railFollow.startFrame - delta),
			endFrame: Math.max(0, camera.railFollow.endFrame - delta),
		} : camera.railFollow,
	});
}

function shotById(shots, shotId) {
	return requireStableItem(shots, shotId, "shots");
}

function shotIndexById(shots, shotId) {
	shotById(shots, shotId);
	return shots.findIndex((shot) => shot.id === shotId);
}

export function createShot(name = "Shot", startFrame = 0, endFrame = startFrame + DEFAULT_SHOT_FRAMES - 1, cameraKeys = [], camera = null) {
	const start = Math.max(0, frameNumber(startFrame));
	const end = Math.max(start, frameNumber(endFrame, start));
	return {
		id: createStableItemId("shot"),
		name: typeof name === "string" && name.trim() ? name.trim() : "Shot",
		startFrame: start,
		endFrame: end,
		cameraKeys: uniqueKeys(cameraKeys, start, end),
		camera: createCameraBlock(camera),
		// v5 shot-document defaults, so a fresh shot already has the shape the
		// document normalizer gives it (and an undo restores).
		kind: "clip",
		caption: "",
		cast: {},
		stylizedAssetId: null,
	};
}

/** New documents begin without an implicit camera owner. */
export function initialShots() {
	return [];
}

export function shotIndexAtFrame(shots, frame) {
	if (!Array.isArray(shots) || !shots.length) return -1;
	const target = Math.max(0, frameNumber(frame));
	let low = 0;
	let high = shots.length - 1;
	while (low <= high) {
		const middle = Math.floor((low + high) / 2);
		const shot = shots[middle];
		if (target < shot.startFrame) high = middle - 1;
		else if (target > shot.endFrame) low = middle + 1;
		else return middle;
	}
	return -1;
}

export function shotAtFrame(shots, frame) {
	const index = shotIndexAtFrame(shots, frame);
	return index < 0 ? null : shots[index];
}

function overlaps(shots, startFrame, endFrame, ignoredShotId = null) {
	return shots.some((shot) => shot.id !== ignoredShotId && startFrame <= shot.endFrame && endFrame >= shot.startFrame);
}

/** Split the named Shot at the frame. Gap frames remain gaps. */
export function cutAtFrame(shots, shotId, frame, currentFraming) {
	if (!Array.isArray(shots) || !currentFraming) return shots;
	const source = shotById(shots, shotId);
	const index = shotIndexById(shots, shotId);
	const cutFrame = frameNumber(frame);
	if (cutFrame <= source.startFrame || cutFrame > source.endFrame) return shots;
	const upstream = {
		...source,
		endFrame: cutFrame - 1,
		cameraKeys: uniqueKeys(source.cameraKeys, source.startFrame, cutFrame - 1),
		camera: cloneCameraBlock(source.camera),
	};
	const downstream = { ...createShot(`Shot ${shots.length + 1}`, cutFrame, source.endFrame, [
		...source.cameraKeys.filter((key) => key.frame >= cutFrame),
		{ id: createStableItemId("camera-key"), frame: cutFrame, framing: currentFraming },
	], rebaseRecordedAim(source.camera, cutFrame - source.startFrame)), ...shotExtras(source) };
	return [...shots.slice(0, index), upstream, downstream, ...shots.slice(index + 1)];
}

/** Add a 2-second Shot without editing an existing one. */
export function addShotAtFrame(shots, frame, frameCount, currentFraming, duration = DEFAULT_SHOT_FRAMES) {
	const list = Array.isArray(shots) ? shots : [];
	const count = Math.max(1, frameNumber(frameCount, 1));
	const target = Math.max(0, Math.min(count - 1, frameNumber(frame)));
	const inside = shotIndexAtFrame(list, target);
	if (inside >= 0) {
		const source = list[inside];
		const length = Math.max(1, frameNumber(duration, DEFAULT_SHOT_FRAMES));
		const startFrame = freeStart(list, length, count, source.endFrame + 1);
		if (startFrame === undefined) return list;
		const keys = currentFraming ? [{ id: createStableItemId("camera-key"), frame: startFrame, framing: currentFraming }] : [];
		return [...list, createShot(`Shot ${list.length + 1}`, startFrame, startFrame + length - 1, keys)].sort((a, b) => a.startFrame - b.startFrame);
	}
	const nextStart = list.find((shot) => shot.startFrame > target)?.startFrame ?? count;
	const endFrame = Math.min(count - 1, nextStart - 1, target + Math.max(1, frameNumber(duration, DEFAULT_SHOT_FRAMES)) - 1);
	if (endFrame < target || overlaps(list, target, endFrame)) return list;
	const keys = currentFraming ? [{ id: createStableItemId("camera-key"), frame: target, framing: currentFraming }] : [];
	return [...list, createShot(`Shot ${list.length + 1}`, target, endFrame, keys)].sort((a, b) => a.startFrame - b.startFrame);
}

/** Add Shot when the take has no free time left: the take grows by one default
 * shot at its end and the new shot fills that, so the button never silently does
 * nothing. Existing shots are untouched. Null past maxFrameCount. */
export function appendShotGrowingTake(shots, frameCount, currentFraming, maxFrameCount) {
	const list = Array.isArray(shots) ? shots : [];
	const startFrame = Math.max(frameNumber(frameCount, 1), ...list.map((shot) => shot.endFrame + 1));
	const grownCount = startFrame + DEFAULT_SHOT_FRAMES;
	if (grownCount > maxFrameCount) return null;
	return { shots: addShotAtFrame(list, startFrame, grownCount, currentFraming), frameCount: grownCount };
}

export function resizeShot(shots, shotId, edge, rawFrame, frameCount) {
	const shot = shotById(shots, shotId);
	if (edge !== "start" && edge !== "end") return shots;
	const count = Math.max(1, frameNumber(frameCount, 1));
	const frame = Math.max(0, Math.min(count - 1, frameNumber(rawFrame, edge === "start" ? shot.startFrame : shot.endFrame)));
	const startFrame = edge === "start" ? Math.min(frame, shot.endFrame) : shot.startFrame;
	const endFrame = edge === "end" ? Math.max(frame, shot.startFrame) : shot.endFrame;
	if ((startFrame === shot.startFrame && endFrame === shot.endFrame) || overlaps(shots, startFrame, endFrame, shotId)) return shots;
	return updateStableItem(shots, shotId, (entry) => ({
		...entry, startFrame, endFrame,
		camera: rebaseRecordedAim(entry.camera, startFrame - entry.startFrame),
		cameraKeys: uniqueKeys(entry.cameraKeys, startFrame, endFrame),
	}), "shots")
		.sort((a, b) => a.startFrame - b.startFrame);
}

export function removeShot(shots, shotId) {
	return removeStableItem(shots, shotId, "shots");
}

export function renameShot(shots, shotId, name) {
	shotById(shots, shotId);
	if (typeof name !== "string" || !name.trim()) return shots;
	return updateStableItem(shots, shotId, (shot) => ({ ...shot, name: name.trim() }), "shots");
}

/** Move a named card in absolute time. Duration and local camera instruction travel together. */
export function reorderShot(shots, shotId, rawStartFrame, frameCount) {
	const shot = shotById(shots, shotId);
	const count = Math.max(1, frameNumber(frameCount, 1));
	const duration = shot.endFrame - shot.startFrame + 1;
	const startFrame = Math.max(0, Math.min(count - duration, frameNumber(rawStartFrame, shot.startFrame)));
	const endFrame = startFrame + duration - 1;
	if (startFrame === shot.startFrame || overlaps(shots, startFrame, endFrame, shotId)) return shots;
	return updateStableItem(shots, shotId, (entry) => ({
		...entry,
		startFrame,
		endFrame,
		cameraKeys: uniqueKeys(entry.cameraKeys.map((key) => ({ ...key, frame: key.frame + startFrame - entry.startFrame })), startFrame, endFrame),
	}), "shots").sort((a, b) => a.startFrame - b.startFrame);
}

function freeStart(shots, duration, frameCount, preferred) {
	const candidates = [preferred, 0, ...shots.map((shot) => shot.endFrame + 1)];
	return candidates.find((start) => start >= 0 && start + duration <= frameCount && !overlaps(shots, start, start + duration - 1));
}

export function duplicateShot(shots, shotId, frameCount) {
	const source = shotById(shots, shotId);
	const duration = source.endFrame - source.startFrame + 1;
	const startFrame = freeStart(shots, duration, Math.max(1, frameNumber(frameCount, 1)), source.endFrame + 1);
	if (startFrame === undefined) return shots;
	const delta = startFrame - source.startFrame;
	const duplicate = { ...createShot(`${source.name} copy`, startFrame, startFrame + duration - 1,
		source.cameraKeys.map((key) => ({ ...key, id: createStableItemId("camera-key"), frame: key.frame + delta })), source.camera), ...shotExtras(source) };
	return [...shots, duplicate].sort((a, b) => a.startFrame - b.startFrame);
}

export function moveCameraKey(keys, keyId, frame) {
	requireStableItem(keys, keyId, "cameraKeys");
	if (keys.some((key) => key.id !== keyId && key.frame === frame)) return keys;
	return updateStableItem(keys, keyId, (key) => ({ ...key, frame }), "cameraKeys").sort((a, b) => a.frame - b.frame);
}

export function removeCameraKey(keys, keyId) {
	return removeStableItem(keys, keyId, "cameraKeys");
}

/** Gaps deliberately return null; the caller interprets null as free camera. */
export function cameraAtFrame(shots, anchor, frame, filmback = {}) {
	const shot = shotAtFrame(shots, frame);
	return shot ? cameraMoveAt(shot.cameraKeys, anchor, frame, filmback) : null;
}
