// OpenTimelineIO cut-list export. OTIO is JSON, so this module deliberately
// has no OTIO dependency: the schema names below are the wire contract.

import { isEffectivelyHidden } from "./scene-objects.js";
import { sampleAt } from "./sample-at.js";
import { TIMELINE_FRAME_FPS } from "./scenes.js";
import { usedSensorHeightMm } from "./shot.js";

const OTIO_TIMELINE_FPS = TIMELINE_FRAME_FPS;
const OTIO_START_TIMECODE = "00:00:00:00";

const finiteOr = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;

function copiedJson(value) {
	if (typeof structuredClone === "function") return structuredClone(value);
	return JSON.parse(JSON.stringify(value));
}

function characterBlocking(scene, character, index, frame) {
	const isActive = character.id === scene.activeCharacterId
		|| (!scene.activeCharacterId && index === 0);
	const sampled = sampleAt({
		frameCount: scene.frameCount,
		subject: character,
		subjectTrack: character.subjectTrack ?? (isActive ? scene.subjectTrack : null),
		motion: character.sessionMotion ?? character.motion ?? (isActive ? scene.motion : null),
	}, null, frame).subject;
	return {
		kind: "character",
		id: typeof character.id === "string" ? character.id : `character-${index + 1}`,
		model: typeof character.model === "string" ? character.model : null,
		subject: typeof character.subject === "string" ? character.subject : null,
		pos: {
			x: finiteOr(sampled?.x, finiteOr(character.x)),
			y: finiteOr(character.y),
			z: finiteOr(sampled?.z, finiteOr(character.z)),
		},
		yawDeg: finiteOr(character.rot),
		scale: finiteOr(character.scale, 1),
	};
}

function objectBlocking(object, index) {
	return {
		kind: "object",
		id: typeof object.id === "string" ? object.id : `object-${index + 1}`,
		name: typeof object.name === "string" ? object.name : null,
		renderer: typeof object.renderer === "string" ? object.renderer : null,
		pos: {
			x: finiteOr(object.x),
			y: finiteOr(object.y),
			z: finiteOr(object.z),
		},
		rotationDeg: {
			x: finiteOr(object.rotX),
			y: finiteOr(object.rot),
			z: finiteOr(object.rotZ),
		},
		scale: {
			x: finiteOr(object.scaleX, 1),
			y: finiteOr(object.scaleY, 1),
			z: finiteOr(object.scaleZ, 1),
		},
	};
}

function blockingAt(scene, frame) {
	if (Array.isArray(scene.blocking)) return copiedJson(scene.blocking);
	const characters = Array.isArray(scene.characters) ? scene.characters : scene.stage?.characters;
	const objects = Array.isArray(scene.objects) ? scene.objects : [];
	return [
		...(Array.isArray(characters) ? characters : [])
			.filter((character) => character && character.hidden !== true)
			.map((character, index) => characterBlocking(scene, character, index, frame)),
		...objects.filter((object) => object && !isEffectivelyHidden(object, objects, Array.isArray(characters) ? characters : [])).map(objectBlocking),
	];
}

function checkedShot(shot, index) {
	if (!shot || !Number.isInteger(shot.startFrame) || !Number.isInteger(shot.endFrame)) {
		throw new TypeError(`Shot ${index + 1} needs integer startFrame/endFrame`);
	}
	if (shot.startFrame < 0 || shot.endFrame < shot.startFrame) {
		throw new RangeError(`Shot ${index + 1} has an invalid frame range`);
	}
	return shot;
}

/**
 * One shared, machine-readable shot record for editorial/package exporters.
 * Camera is sampled at the inclusive start frame and retains sampleAt's exact
 * { pos, yaw, pitch, fovDeg, focalMm, sensorId } contract. The camera field
 * is that single start-frame sample, not a camera animation.
 */
export function shotMetadata(scene, shot) {
	const source = scene && typeof scene === "object" ? scene : {};
	const checked = checkedShot(shot, 0);
	const camera = sampleAt(source, checked, checked.startFrame).camera;
	if (!camera) throw new Error(`Shot ${checked.name || checked.id || "1"} has no camera at frame ${checked.startFrame}`);
	return {
		camera,
		lens: {
			focalMm: camera.focalMm,
			sensorId: camera.sensorId,
			verticalApertureMm: usedSensorHeightMm(camera.sensorId, source.filmback?.aspectRatio),
		},
		range: {
			startFrame: checked.startFrame,
			endFrame: checked.endFrame,
			fps: OTIO_TIMELINE_FPS,
		},
		blocking: blockingAt(source, checked.startFrame),
	};
}

function rationalTime(value) {
	return {
		OTIO_SCHEMA: "RationalTime.1",
		rate: OTIO_TIMELINE_FPS,
		value,
	};
}

function timeRange(startFrame, durationFrames) {
	return {
		OTIO_SCHEMA: "TimeRange.1",
		duration: rationalTime(durationFrames),
		start_time: rationalTime(startFrame),
	};
}

function gap(startFrame, durationFrames) {
	return {
		OTIO_SCHEMA: "Gap.1",
		effects: [],
		markers: [],
		enabled: true,
		metadata: {},
		name: `Gap ${startFrame}-${startFrame + durationFrames - 1}`,
		source_range: timeRange(0, durationFrames),
	};
}

function clip(scene, shot) {
	const metadata = shotMetadata(scene, shot);
	return {
		OTIO_SCHEMA: "Clip.1",
		effects: [],
		markers: [],
		enabled: true,
		media_reference: {
			OTIO_SCHEMA: "MissingReference.1",
			available_range: null,
			metadata: {},
			name: null,
		},
		metadata: { cozyclay: metadata },
		name: typeof shot.name === "string" && shot.name.trim() ? shot.name.trim() : "Shot",
		source_range: timeRange(0, shot.endFrame - shot.startFrame + 1),
	};
}

/** Convert Shot cards into a single-video-track OTIO Timeline. */
export function shotsToOtio(scene, shots, { name } = {}) {
	const source = scene && typeof scene === "object" ? scene : {};
	const ordered = (Array.isArray(shots) ? shots : [])
		.map(checkedShot)
		.slice()
		.sort((a, b) => a.startFrame - b.startFrame);
	const children = [];
	let cursor = 0;
	for (const shot of ordered) {
		if (shot.startFrame < cursor) throw new RangeError(`Shot ${shot.name || shot.id || "?"} overlaps an earlier shot`);
		if (shot.startFrame > cursor) children.push(gap(cursor, shot.startFrame - cursor));
		children.push(clip(source, shot));
		cursor = shot.endFrame + 1;
	}
	const timelineName = typeof name === "string" && name.trim()
		? name.trim()
		: typeof source.name === "string" && source.name.trim() ? source.name.trim() : "CozyClay Cut List";
	return {
		OTIO_SCHEMA: "Timeline.1",
		metadata: {
			cozyclay: {
				metersPerUnit: 1,
				upAxis: "Y",
				fps: OTIO_TIMELINE_FPS,
				startTimecode: OTIO_START_TIMECODE,
			},
		},
		name: timelineName,
		global_start_time: rationalTime(0),
		tracks: {
			OTIO_SCHEMA: "Stack.1",
			children: [{
				OTIO_SCHEMA: "Track.1",
				children,
				effects: [],
				kind: "Video",
				markers: [],
				enabled: true,
				metadata: {},
				name: "Shots",
				source_range: null,
			}],
			effects: [],
			markers: [],
			enabled: true,
			metadata: {},
			name: "tracks",
			source_range: null,
		},
	};
}

export function serializeOtio(scene, shots, options) {
	return `${JSON.stringify(shotsToOtio(scene, shots, options), null, 2)}\n`;
}
