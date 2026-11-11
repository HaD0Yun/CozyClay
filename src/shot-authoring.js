/**
 * Shot-authoring persistence. Like the scene store, the version lives in the
 * key and body. Bad bytes are identified for quarantine by the caller, while
 * future bytes are left in place for the newer app that understands them.
 */

import { createTiming, timingIsFlat } from "./speed-envelope.js";
import { createShot } from "./cuts.js";
import { cameraRoll, railShotFields } from "./camera-block.js";
import { normalizeStableItems } from "./stable-items.js";
import { VIDEO_MODEL_PRESETS } from "./model-presets.js";
import { elementByPath } from "./studio-elements.js"; import { WORLD } from "./world-scale.js";
import { isImageAssetId } from "./scene-assets.js";
import { createCharacterEntry } from "./scenes.js";
import { repairOptics } from "./camera-optics.js";
import { repairReview } from "./shot-review.js";
import { toTimelineFrame } from "./timeline-fps.js";

const VIDEO_MODEL_IDS = new Set(VIDEO_MODEL_PRESETS.map((preset) => preset.id));
const CAMERA_KEY_LIMITS = elementByPath("shot.cameraKeys");

export const SHOT_AUTHORING_VERSION = 6;
export const SHOT_AUTHORING_KEY = "cozyclay.shot-authoring.v6";
// The single-key alias points at the newest legacy body for older callers.
// New readers should walk the list so a user can still arrive directly from v1.
export const SHOT_AUTHORING_LEGACY_KEY = "cozyclay.shot-authoring.v5";
export const SHOT_AUTHORING_LEGACY_KEYS = Object.freeze([
	SHOT_AUTHORING_LEGACY_KEY,
	"cozyclay.shot-authoring.v4",
	"cozyclay.shot-authoring.v3",
	"cozyclay.shot-authoring.v2",
	"cozyclay.shot-authoring.v1",
]);
export const SHOT_AUTHORING_QUARANTINE_KEY = "cozyclay.shot-authoring.v6.quarantine";

/** A still holds one picture for `endFrame - startFrame + 1` frames (24 fps). */
export const STILL_HOLD_DEFAULT = 48;
export const STILL_HOLD_MAX = 240;
export const shotHold = (shot) => shot.endFrame - shot.startFrame + 1;

/** Lay the stills end to end from frame 0 in their array order, each keeping
 * its hold; camera keys travel with their still. Clip shots are untouched.
 * The result is sorted by startFrame, the order the document stores. */
export function reflowStillShots(shots) {
	let cursor = 0;
	return shots.map((shot) => {
		if (shot.kind !== "still") return shot;
		const hold = shotHold(shot), delta = cursor - shot.startFrame;
		cursor += hold;
		if (!delta) return shot;
		return { ...shot, startFrame: shot.startFrame + delta, endFrame: shot.endFrame + delta,
			cameraKeys: shot.cameraKeys.map((key) => ({ ...key, frame: key.frame + delta })) };
	}).sort((a, b) => a.startFrame - b.startFrame);
}

/** The timeline length a reflowed document needs, unclamped so a caller can
 * refuse a storyboard past STILL_FRAME_COUNT_MAX instead of truncating it. */
export function stillFrameCount(shots) {
	return Math.max(DEFAULT_FRAME_COUNT, ...shots.map((shot) => shot.endFrame + 1));
}

const SHOT_KINDS = new Set(["clip", "still"]);
const CAPTION_MAX = 500;
// Mirrors the cast posture vocabulary (POSTURES in src/scenes.js once the
// proxy-figure work lands); kept local so this module does not wait on it.
const POSTURES = new Set(["stand", "sit", "lie"]);

/** clip length sanity bounds, frames @ 24 fps: 1 s .. 20 min */
const FRAME_COUNT_MIN = 24;
const FRAME_COUNT_MAX = 28800;
const DEFAULT_FRAME_COUNT = 144;
export const STILL_FRAME_COUNT_MAX = FRAME_COUNT_MAX;
const RAIL_MAX_POINTS = 512;
const finite = Number.isFinite;

/** v3 and older bodies counted frames on ARDY's 20 fps clock; v4 counts them
 * on the 24 fps production clock. Every frame-bearing number is multiplied so
 * a saved roll keeps its DURATION: a 300-frame clip was 15 s and stays 15 s as
 * 360 frames. Reinterpreting instead would silently shorten it to 12.5 s. */
const rescaleFrame = (value) => (finite(value) ? toTimelineFrame(value) : value);
const rescaleKeys = (entries) => (Array.isArray(entries)
	? entries.map((key) => (key && typeof key === "object" ? { ...key, frame: rescaleFrame(key.frame) } : key))
	: entries);
const rescaleRailFollow = (value) => (value && typeof value === "object" && !Array.isArray(value)
	? { ...value, startFrame: rescaleFrame(value.startFrame), endFrame: rescaleFrame(value.endFrame) }
	: value);

/** Retime a whole parsed body before the ordinary repair runs, so the version
 * migrations below only ever see production-clock numbers. Rail geometry,
 * follow gains and framings carry no frames and are passed through. */
function rescaleShotAuthoringFrames(parsed) {
	const next = { ...parsed, frameCount: rescaleFrame(parsed.frameCount) };
	if (Array.isArray(parsed.cameraKeys)) next.cameraKeys = rescaleKeys(parsed.cameraKeys);
	if (Array.isArray(parsed.waypoints)) next.waypoints = rescaleKeys(parsed.waypoints);
	if (parsed.railFollow !== undefined) next.railFollow = rescaleRailFollow(parsed.railFollow);
	if (Array.isArray(parsed.shots)) {
		next.shots = parsed.shots.map((shot) => {
			if (!shot || typeof shot !== "object") return shot;
			const moved = { ...shot, startFrame: rescaleFrame(shot.startFrame), endFrame: rescaleFrame(shot.endFrame) };
			if (Array.isArray(shot.cameraKeys)) moved.cameraKeys = rescaleKeys(shot.cameraKeys);
			if (shot.camera && typeof shot.camera === "object" && !Array.isArray(shot.camera)) {
				moved.camera = { ...shot.camera, railFollow: rescaleRailFollow(shot.camera.railFollow) };
			}
			return moved;
		});
	}
	return next;
}

const FOLLOW_BOUNDS = {
	distance: [0.5, 15],
	height: [0.2, Number.POSITIVE_INFINITY],
	response: [0.1, 3],
	lead: [0, 1],
	maxDollySpeed: [0.2, WORLD.dollySpeed],
	pitchOffsetDeg: [-170, 170],
	orbitOffsetDeg: [-180, 180],
};
const FOLLOW_DEFAULTS = {
	distance: 3,
	height: 1.6,
	response: 0.7,
	lead: 0.25,
	railStartMode: "head",
	maxDollySpeed: 4,
	pitchOffsetDeg: 0,
	orbitOffsetDeg: 0,
};
const CAMERA_MODES = new Set(["keys", "follow", "rail"]);

function validFraming(framing) {
	return (
		!!framing && typeof framing === "object" && !!framing.pos &&
		finite(framing.pos.x) && finite(framing.pos.y) && finite(framing.pos.z) &&
		finite(framing.yaw) && finite(framing.pitch) && finite(framing.fovDeg)
	);
}

function repairFrameCount(value) {
	return finite(value) ? Math.max(FRAME_COUNT_MIN, Math.min(FRAME_COUNT_MAX, Math.round(value))) : null;
}

function repairKeys(entries, minFrame, maxFrame, ids = new Set()) {
	const byFrame = new Map();
	const firstFrame = Math.max(minFrame, CAMERA_KEY_LIMITS.frameMin);
	for (const key of normalizeStableItems(entries, "camera-key", ids)) {
		if (!finite(key.frame) || !validFraming(key.framing)) continue;
		const frame = Math.max(firstFrame, Math.min(maxFrame, Math.round(key.frame)));
		byFrame.set(frame, {
			id: key.id,
			frame,
			framing: {
				pos: { x: key.framing.pos.x, y: key.framing.pos.y, z: key.framing.pos.z },
				yaw: key.framing.yaw,
				pitch: key.framing.pitch,
				fovDeg: key.framing.fovDeg, ...(cameraRoll(key.framing.rollDeg) ? { rollDeg: cameraRoll(key.framing.rollDeg) } : {}),
			},
		});
	}
	return [...byFrame.values()].sort((a, b) => a.frame - b.frame);
}

function repairShots(entries, frameCount, inheritedCamera = null, ids = new Set()) {
	const candidates = [];
	for (const entry of Array.isArray(entries) ? entries : []) {
		if (!entry || typeof entry !== "object" || !finite(entry.startFrame)) continue;
		const startFrame = Math.max(0, Math.min(frameCount - 1, Math.round(entry.startFrame)));
		candidates.push({ entry, startFrame });
	}
	candidates.sort((a, b) => a.startFrame - b.startFrame);
	if (!candidates.length) return [];

	// One boundary per frame. The later stored entry wins, just like re-keying.
	const byStart = new Map(candidates.map((candidate) => [candidate.startFrame, candidate.entry]));
	const ordered = normalizeStableItems(
		[...byStart.entries()].sort((a, b) => a[0] - b[0]).map(([startFrame, entry]) => ({ ...entry, startFrame })),
		"shot",
		ids,
	);
	return ordered.map((entry, index) => {
		const startFrame = entry.startFrame;
		// Which video model this cut is aimed at. Absent unless the shot names
		// one, so an untargeted body round-trips byte-identical; an unknown id
		// from a newer build is dropped rather than kept, because the badge must
		// never cite a preset this build cannot describe.
		const targetModel = VIDEO_MODEL_IDS.has(entry.targetModel) ? { targetModel: entry.targetModel } : null;
		const optics = repairOptics(entry.optics);
		const nextStart = ordered[index + 1]?.startFrame ?? frameCount;
		// Pre-overlay v3 bodies had no endFrame and were gapless by definition.
		// Infer their old boundary exactly; new bodies persist an explicit end.
		const storedEnd = finite(entry.endFrame) ? Math.round(entry.endFrame) : nextStart - 1;
		const endFrame = Math.max(startFrame, Math.min(frameCount - 1, nextStart - 1, storedEnd));
		const review = repairReview(entry.review, { startFrame, endFrame });
		return {
			id: entry.id,
			name: typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : `Shot ${index + 1}`,
			startFrame,
			endFrame,
			cameraKeys: repairKeys(entry.cameraKeys, startFrame, endFrame, ids),
			camera: repairCamera(inheritedCamera ?? entry.camera),
			...targetModel,
			...(optics ? { optics } : {}),
			...(review ? { review } : {}),
			kind: SHOT_KINDS.has(entry.kind) ? entry.kind : "clip",
			caption: repairCaption(entry.caption),
			cast: repairCast(entry.cast),
			stylizedAssetId: isImageAssetId(entry.stylizedAssetId) ? entry.stylizedAssetId : null,
		};
	});
}

function repairCaption(value) {
	return typeof value === "string" ? Array.from(value.trim()).slice(0, CAPTION_MAX).join("") : "";
}

/** Per-shot placement overrides keyed by character id. An entry without a
 * usable id or a finite x/z/rot is dropped; its valid siblings survive. */
function repairCast(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const rows = [];
	for (const [characterId, entry] of Object.entries(value)) {
		if (!characterId.trim() || !entry || typeof entry !== "object" || Array.isArray(entry)) continue;
		if (!finite(entry.x) || !finite(entry.z) || !finite(entry.rot)) continue;
		const row = { x: entry.x, z: entry.z, rot: entry.rot };
		if (POSTURES.has(entry.posture)) row.posture = entry.posture;
		const pose = createCharacterEntry({ pose: entry.pose }).pose;
		if (pose) row.pose = pose;
		rows.push([characterId, row]);
	}
	// fromEntries defines own properties, so a "__proto__" id stays data.
	return Object.fromEntries(rows);
}

function repairWaypoints(entries, ids = new Set()) {
	const byFrame = new Map();
	for (const waypoint of normalizeStableItems(entries, "waypoint", ids)) {
		if (!finite(waypoint.frame) || waypoint.frame < 0 || !finite(waypoint.x) || !finite(waypoint.z)) continue;
		const frame = Math.round(waypoint.frame);
		byFrame.set(frame, { id: waypoint.id, frame, x: waypoint.x, z: waypoint.z, heading: finite(waypoint.heading) ? waypoint.heading : null });
	}
	return [...byFrame.values()].sort((a, b) => a.frame - b.frame);
}

function repairFollowCam(value) {
	const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
	const followCam = { ...FOLLOW_DEFAULTS };
	followCam.railStartMode = source.railStartMode === "nearest" ? "nearest" : FOLLOW_DEFAULTS.railStartMode;
	for (const [key, [min, max]] of Object.entries(FOLLOW_BOUNDS)) {
		if (finite(source[key])) followCam[key] = Math.max(min, Math.min(max, source[key]));
	}
	return followCam;
}

function repairRail(value) {
	if (!Array.isArray(value)) return null;
	const points = value.filter((point) => point && finite(point.x) && finite(point.z))
		.slice(0, RAIL_MAX_POINTS).map((point) => ({ x: point.x, z: point.z }));
	return points.length >= 2 ? points : null;
}

function repairRailFollow(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	if (value.mode === "off") return { mode: "off" };
	if (value.mode !== "range" || !finite(value.startFrame) || !finite(value.endFrame)) return null;
	const startFrame = Math.max(0, Math.round(value.startFrame));
	const endFrame = Math.max(0, Math.round(value.endFrame));
	return startFrame <= endFrame ? { mode: "range", startFrame, endFrame } : null;
}

/** The crane axis rides the rail's arc; mirrors camera-block.js's normalization. */
function repairCraneHeight(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const raw = Array.isArray(value.points)
		? value.points
		: finite(value.start) && finite(value.end)
			? [{ t: 0, height: value.start }, { t: 1, height: value.end }]
			: null;
	if (!raw) return null;
	const cleaned = raw
		.filter((point) => point && finite(point.t) && finite(point.height))
		.map((point) => ({ t: Math.max(0, Math.min(1, point.t)), height: Math.max(0.1, point.height) }))
		.sort((a, b) => a.t - b.t)
		.filter((point, i, arr) => i === arr.length - 1 || arr[i + 1].t - point.t > 1e-6)
		.slice(0, 8);
	if (cleaned.length < 2) return null;
	cleaned[0] = { ...cleaned[0], t: 0 };
	cleaned[cleaned.length - 1] = { ...cleaned[cleaned.length - 1], t: 1 };
	return { points: cleaned };
}

function repairCamera(value) {
	const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
	const cameraRail = repairRail(source.cameraRail);
	let mode = CAMERA_MODES.has(source.mode) ? source.mode : "keys";
	// A rail block without a usable two-point rail behaves like ordinary
	// follow, never like a mysteriously enabled but motionless dolly.
	if (mode === "rail" && !cameraRail) mode = "follow";
	return {
		mode,
		followCam: repairFollowCam(source.followCam),
		cameraRail,
		railFollow: repairRailFollow(source.railFollow),
		// A crane cannot outlive the rail it rides.
		craneHeight: cameraRail ? repairCraneHeight(source.craneHeight) : null,
		// The dolly's speed curve rides the rail the same way; the envelope
		// module owns its repair (parse-don't-validate, flat heals to null).
		dollyTiming: cameraRail ? repairDollyTiming(source.dollyTiming) : null,
		...railShotFields(source, cameraRail),
	};
}

function repairDollyTiming(value) {
	const timing = createTiming(value);
	return timingIsFlat(timing) ? null : timing;
}

function migratedCamera(followCam, cameraRail, railFollow = null) {
	const rail = repairRail(cameraRail);
	const enabled = followCam?.enabled === true;
	return repairCamera({ mode: enabled ? (rail ? "rail" : "follow") : "keys", followCam, cameraRail: rail, railFollow });
}

function repairShared(parsed, frameCount, ids) {
	return {
		frameCount,
		waypoints: repairWaypoints(parsed.waypoints, ids),
	};
}

/**
 * Build a transport-neutral shot document. It can live at the root today or
 * be nested under a future Scene document without changing its schema.
 */
export function createShotAuthoringDocument({ shots = [], waypoints = [], frameCount = null } = {}) {
	const repairedFrameCount = repairFrameCount(frameCount);
	const effectiveFrameCount = repairedFrameCount ?? DEFAULT_FRAME_COUNT;
	const ids = new Set();
	return {
		version: SHOT_AUTHORING_VERSION,
		frameCount: repairedFrameCount,
		waypoints: repairWaypoints(waypoints, ids),
		shots: repairShots(shots, effectiveFrameCount, null, ids),
	};
}

/** Pure object reader; storage adapters decide how bytes become this object. */
export function readShotAuthoringDocument(raw) {
	if (raw === undefined) return { status: "absent", state: null };
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { status: "corrupt", state: null };
	const version = raw.version === undefined ? 1 : raw.version;
	if (!Number.isInteger(version) || version < 1) return { status: "corrupt", state: null };
	if (version > SHOT_AUTHORING_VERSION) return { status: "future", state: null };

	// One conversion at the door: everything below reads one clock.
	const parsed = version < 4 ? rescaleShotAuthoringFrames(raw) : raw;
	const frameCount = repairFrameCount(parsed.frameCount);
	const effectiveFrameCount = frameCount ?? DEFAULT_FRAME_COUNT;
	if (version === 1) {
		const ids = new Set();
		const keys = repairKeys(parsed.cameraKeys, 0, effectiveFrameCount - 1, ids);
		const camera = migratedCamera(parsed.followCam, parsed.cameraRail, parsed.railFollow);
		// v1 was one whole-timeline camera roll even when it had no keys.
		const shots = [createShot("Shot 1", 0, effectiveFrameCount - 1, keys, repairCamera(camera))];
		return {
			status: "migrated",
			state: { ...repairShared(parsed, frameCount, ids), shots },
		};
	}
	if (!Array.isArray(parsed.shots)) return { status: "corrupt", state: null };
	if (version === 2) {
		const ids = new Set();
		const camera = migratedCamera(parsed.followCam, parsed.cameraRail, parsed.railFollow);
		return {
			status: "migrated",
			state: { ...repairShared(parsed, frameCount, ids), shots: repairShots(parsed.shots, effectiveFrameCount, camera, ids) },
		};
	}
	const ids = new Set();
	return {
		// Older bodies were authored on another clock or lack newer shot fields;
		// all are rewritten, so they report as migrated, not valid.
		status: version < SHOT_AUTHORING_VERSION ? "migrated" : "valid",
		state: { ...repairShared(parsed, frameCount, ids), shots: repairShots(parsed.shots, effectiveFrameCount, null, ids) },
	};
}

/** JSON compatibility adapters used by App and older model callers. */
export function serializeShotAuthoring(state) {
	return JSON.stringify(createShotAuthoringDocument(state));
}

export function readShotAuthoring(raw) {
	if (raw === null || raw === undefined || raw === "") return { status: "absent", state: null };
	try {
		return readShotAuthoringDocument(JSON.parse(raw));
	} catch {
		return { status: "corrupt", state: null };
	}
}

/** Compatibility-shaped convenience for model callers and tests. */
export function loadShotAuthoring(raw) {
	return readShotAuthoring(raw).state;
}
