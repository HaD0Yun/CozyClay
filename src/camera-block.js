import { createTiming, timingIsFlat } from "./speed-envelope.js";

// Pure Camera Block model. A shot owns one complete camera instruction, like
// the camera card clipped to a single strip of film.

export const CAMERA_MODES = Object.freeze(["keys", "follow", "rail"]);

const CAMERA_FOLLOW_DEFAULTS = Object.freeze({
	distance: 3,
	height: 1.6,
	response: 0.7,
	lead: 0.25,
	railStartMode: "head",
	maxDollySpeed: 4,
	pitchOffsetDeg: 0,
	orbitOffsetDeg: 0,
});

function cloneRail(points) {
	return Array.isArray(points) ? points.map((point) => ({ x: point.x, z: point.z })) : null;
}

/**
 * The crane axis a rail may carry: height marks along the dolly's arc
 * progress ({ points: [{ t, height }] }, endpoints pinned at t 0 and 1, at
 * most 8 marks). A legacy { start, end } pair reads as its two endpoints.
 * Null = flat rail at the follow height (every pre-crane document). Marks
 * clamp to a 0.1 m floor — a lens below the deck is never authorable.
 */
function cloneCraneHeight(value) {
	if (!value || typeof value !== "object") return null;
	const raw = Array.isArray(value.points)
		? value.points
		: Number.isFinite(value.start) && Number.isFinite(value.end)
			? [{ t: 0, height: value.start }, { t: 1, height: value.end }]
			: null;
	if (!raw) return null;
	const cleaned = raw
		.filter((point) => point && Number.isFinite(point.t) && Number.isFinite(point.height))
		.map((point) => ({ t: Math.max(0, Math.min(1, point.t)), height: Math.max(0.1, point.height) }))
		.sort((a, b) => a.t - b.t)
		// duplicate marks: the later-authored one wins
		.filter((point, i, arr) => i === arr.length - 1 || arr[i + 1].t - point.t > 1e-6)
		.slice(0, 8);
	if (cleaned.length < 2) return null;
	cleaned[0] = { ...cleaned[0], t: 0 };
	cleaned[cleaned.length - 1] = { ...cleaned[cleaned.length - 1], t: 1 };
	return { points: cleaned };
}

function cloneRailFollow(value) {
	if (!value || typeof value !== "object") return null;
	if (value.mode === "off") return { mode: "off" };
	if (value.mode === "range") return {
		mode: "range",
		startFrame: value.startFrame,
		endFrame: value.endFrame,
	};
	return null;
}

/**
 * What a rail shot's head holds: up to 4 cast ids (their middle, frame by
 * frame, at their chest or at a world height) or one world point. Null = the follow subject (every older shot).
 * Like the crane, an aim and a lens of its own (focalMm) ride the rail and
 * are left out of the block without one, so untouched shots stay byte-stable.
 */
function cloneRailAim(value) {
	const ids = Array.isArray(value?.ids) ? value.ids.filter((id) => typeof id === "string" && id).slice(0, 4) : [];
	if (ids.length) return Number.isFinite(value.height) ? { ids, height: value.height } : { ids };
	const point = value?.point;
	return point && [point.x, point.y, point.z].every(Number.isFinite) ? { point: { x: point.x, y: point.y, z: point.z } } : null;
}

/**
 * A camera roll in degrees about the lens axis, wrapped to -180..180; 0 for
 * anything else. Positive turns the camera's top toward screen left (three's
 * rotation.z, like yaw's positive left turn), so the picture tilts clockwise.
 */
export function cameraRoll(value) {
	if (!Number.isFinite(value)) return 0;
	const wrapped = ((((value + 180) % 360) + 360) % 360) - 180;
	return wrapped === -180 && value > 0 ? 180 : wrapped;
}

/** The aim, lens and roll fields a block with a rail carries (none without one). */
export function railShotFields(value, cameraRail) {
	const aim = cameraRail ? cloneRailAim(value.aim) : null;
	const focalMm = cameraRail && Number.isFinite(value.focalMm) && value.focalMm > 0 ? value.focalMm : null;
	const rollDeg = cameraRail ? cameraRoll(value.rollDeg) : 0;
	return { ...(aim ? { aim } : {}), ...(focalMm ? { focalMm } : {}), ...(rollDeg ? { rollDeg } : {}) };
}

/** Build a complete block from a partial or stored camera value. */
export function createCameraBlock(input = {}) {
	const value = input && typeof input === "object" ? input : {};
	const mode = CAMERA_MODES.includes(value.mode) ? value.mode : "keys";
	const followCam = { ...CAMERA_FOLLOW_DEFAULTS, ...(value.followCam ?? {}) };
	const cameraRail = cloneRail(value.cameraRail);
	// The crane is always on for a rail: a stored null (older projects, an
	// explicit "off" patch) normalizes to the flat two-mark profile at the
	// follow height, which is exactly what "no crane" rendered as.
	const craneHeight = cloneCraneHeight(value.craneHeight)
		?? (mode === "rail" && cameraRail
			? { points: [{ t: 0, height: followCam.height }, { t: 1, height: followCam.height }] }
			: null);
	// The dolly's speed curve along the rail — same grammar as a prop path's
	// timing. Flat heals to null so untouched shots stay byte-stable.
	const dollyTiming = createTiming(value.dollyTiming);
	return {
		mode,
		followCam,
		cameraRail,
		railFollow: cloneRailFollow(value.railFollow),
		craneHeight,
		dollyTiming: timingIsFlat(dollyTiming) ? null : dollyTiming,
		...railShotFields(value, cameraRail),
	};
}

/** Camera Blocks must never share nested settings across shots. */
export function cloneCameraBlock(camera) {
	return createCameraBlock(camera);
}

/** Immutable nested update used by both the sidebar and timeline inspector. */
export function updateCameraBlock(camera, patch = {}) {
	const current = createCameraBlock(camera);
	const change = patch && typeof patch === "object" ? patch : {};
	return createCameraBlock({
		...current,
		...change,
		followCam: change.followCam
			? { ...current.followCam, ...change.followCam }
			: current.followCam,
		cameraRail: Object.hasOwn(change, "cameraRail") ? change.cameraRail : current.cameraRail,
		railFollow: Object.hasOwn(change, "railFollow") ? change.railFollow : current.railFollow,
		craneHeight: Object.hasOwn(change, "craneHeight") ? change.craneHeight : current.craneHeight,
		dollyTiming: Object.hasOwn(change, "dollyTiming") ? change.dollyTiming : current.dollyTiming,
	});
}

/** Delete authored rail geometry and return rail mode to free Follow. */
export function removeCameraRail(camera) {
	const current = createCameraBlock(camera);
	return updateCameraBlock(current, {
		mode: current.mode === "rail" ? "follow" : current.mode,
		cameraRail: null,
		railFollow: null,
		craneHeight: null,
	});
}
