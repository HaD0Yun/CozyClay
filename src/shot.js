// Pure math + string assembly. No three.js, no React.
// This file is the entire "brain" of a blocking tool: it turns 3D geometry
// into film vocabulary, then turns film vocabulary into a prompt.

export const SUBJECT_HEIGHT_M = 1.8;

// Framing distance is measured to the subject's centre of mass, not to the
// midpoint of their bounding box. A camera craned to the floor is still close
// to the body it is pointing at, and only this pivot reports that honestly.
export const FRAMING_PIVOT_Y = 1.3;

// App-owned filmback presets, in millimetres. These are format/gate sizes,
// not claims about every digital camera sold under the same family name.
// Keeping the dimensions here makes lens vocabulary one shared contract for
// the studio, camera-move interpolation and MCP. The object keys/ids are wire
// identifiers persisted in scene metadata and exported to USD; do not rename
// them without a document migration.
export const SENSOR_FORMATS = Object.freeze({
	super16: Object.freeze({ id: "super16", label: "Super 16", widthMm: 12.52, heightMm: 7.41 }),
	super35: Object.freeze({ id: "super35", label: "Super 35", widthMm: 24.89, heightMm: 18.66 }),
	fullFrame: Object.freeze({ id: "fullFrame", label: "Full Frame", widthMm: 36, heightMm: 24 }),
	"65mm": Object.freeze({ id: "65mm", label: "65mm", widthMm: 52.63, heightMm: 23.01 }),
});

export const DEFAULT_SENSOR_FORMAT = "fullFrame";
export const DEFAULT_ASPECT_RATIO = 16 / 9;
export const SHOT_ASPECT_RATIOS = Object.freeze({
	"16:9": 16 / 9,
	"2.39:1": 2.39,
	"9:16": 9 / 16,
	"1:1": 1,
	"4:3": 4 / 3,
	"12:7": 12 / 7,
	// Fal H3 480P renders 832x480 (1.733:1, 2.5 % narrower than 16:9). Composing
	// the A/B reference through this ratio makes the viewport show exactly the
	// canvas the generated clip will have.
	"fal 480P": 832 / 480,
});

export function shotAspectRatio(value) {
	return SHOT_ASPECT_RATIOS[value] ?? DEFAULT_ASPECT_RATIO;
}

/** The vertical gate left after the output aspect crops the sensor. Narrower
 * outputs use the full sensor height and crop the sides; wider outputs crop
 * top and bottom. Invalid inputs repair to the studio defaults. */
export function usedSensorHeightMm(sensorId = DEFAULT_SENSOR_FORMAT, aspectRatio = DEFAULT_ASPECT_RATIO) {
	const sensor = SENSOR_FORMATS[sensorId] ?? SENSOR_FORMATS[DEFAULT_SENSOR_FORMAT];
	const aspect = Number.isFinite(aspectRatio) && aspectRatio > 0 ? aspectRatio : DEFAULT_ASPECT_RATIO;
	return Math.min(sensor.heightMm, sensor.widthMm / aspect);
}

/** vertical FOV (radians) -> focal length in mm on the cropped filmback */
export function fovToFocalMm(fovRad, sensorId = DEFAULT_SENSOR_FORMAT, aspectRatio = DEFAULT_ASPECT_RATIO) {
	return usedSensorHeightMm(sensorId, aspectRatio) / (2 * Math.tan(fovRad / 2));
}

/** focal length in mm -> vertical FOV in radians on the cropped filmback */
export function focalMmToFov(mm, sensorId = DEFAULT_SENSOR_FORMAT, aspectRatio = DEFAULT_ASPECT_RATIO) {
	return 2 * Math.atan(usedSensorHeightMm(sensorId, aspectRatio) / (2 * mm));
}

// A crew does not carry a 47 mm lens. Reporting the nearest prime from a real
// set is both more honest and more useful to an image model, which has seen far
// more captions saying "35mm" than "47mm".
export const PRIME_SET = [14, 18, 24, 28, 35, 50, 85, 100, 135];

export function nearestPrime(fovRad, sensorId = DEFAULT_SENSOR_FORMAT, aspectRatio = DEFAULT_ASPECT_RATIO) {
	const exact = fovToFocalMm(fovRad, sensorId, aspectRatio);
	return PRIME_SET.reduce((best, mm) => (Math.abs(mm - exact) < Math.abs(best - exact) ? mm : best));
}

// screenFraction = subject height / visible frame height at the subject.
// 1.0 means the figure exactly fills the frame top to bottom.
const SIZE_TABLE = [
	[2.8, "extreme close-up", "ultra-realistic skin texture with visible pores and micro-detail, tack-sharp eyes, shallow depth of field"],
	[1.6, "close-up", "ultra-realistic skin texture and fine facial detail, soft background blur, shallow depth of field"],
	[1.15, "medium close-up", "natural skin and fabric texture, clear facial detail, shallow depth of field"],
	[0.8, "medium shot", "balanced detail on the subject and the surrounding space, moderate depth of field"],
	[0.52, "medium-wide shot", "the full figure with the environment clearly visible, deep focus"],
	[0.3, "wide shot", "full body in a richly detailed environment, deep focus"],
	[0, "extreme wide shot", "a small figure within a vast, highly detailed environment, epic sense of scale, deep focus"],
];

// A crew names the level by where the lens physically sits, not by the angle it
// subtends: "put it at hip level" is an instruction, "-27 degrees" is not.
// Thresholds are camera height above the floor, in metres.
const LEVEL_TABLE = [
	[2.5, "overhead", "a directly overhead bird's-eye view looking down at the subject"],
	[1.8, "high angle", "a high angle looking down at the subject"],
	[1.5, "eye level", "eye level"],
	[1.25, "chest level", "chest level"],
	[0.95, "hip level", "a low hip-level angle"],
	[0.45, "knee level", "a low knee-level angle looking up at the subject"],
	[Number.NEGATIVE_INFINITY, "ground level", "a dramatic ground-level angle looking up at the subject"],
];

const pick = (table, value) => table.find(([threshold]) => value >= threshold) ?? table[table.length - 1];

/**
 * Derive film vocabulary from raw scene geometry.
 * @param {{x:number,y:number,z:number}} cameraPos    camera world position (metres)
 * @param {{x:number,z:number,rot:number}} subject     subject ground position + facing in degrees
 * @param {number} fovRad                              vertical field of view
 * @param {number} height                              subject height in metres
 * @param {{sensorId?:string,aspectRatio?:number}} filmback
 */
export function deriveShot(cameraPos, subject, fovRad, height = SUBJECT_HEIGHT_M, filmback = {}) {
	const sensorId = filmback.sensorId ?? DEFAULT_SENSOR_FORMAT;
	const aspectRatio = filmback.aspectRatio ?? DEFAULT_ASPECT_RATIO;
	const dx = cameraPos.x - subject.x;
	const dz = cameraPos.z - subject.z;
	const dy = cameraPos.y - FRAMING_PIVOT_Y;
	const horizontal = Math.hypot(dx, dz);
	const distance = Math.max(Math.hypot(horizontal, dy), 1e-6);

	// how much of the frame height the subject occupies
	const screenFraction = height / (2 * distance * Math.tan(fovRad / 2));
	const [, sizeLabel, sizeContext] = pick(SIZE_TABLE, screenFraction);

	// Level is simply how high off the floor the lens rides.
	const [, levelLabel, levelPhrase] = pick(LEVEL_TABLE, cameraPos.y);
	const elevationDeg = (Math.atan2(cameraPos.y - height * 0.94, Math.max(horizontal, 1e-6)) * 180) / Math.PI;

	// Which side of the subject the camera sits on. The sign of the cross product
	// tells us camera-right from camera-left, which the phrasing needs.
	const facingRad = (subject.rot * Math.PI) / 180;
	const facing = { x: Math.sin(facingRad), z: Math.cos(facingRad) };
	const toCamera = { x: dx / Math.max(horizontal, 1e-6), z: dz / Math.max(horizontal, 1e-6) };
	const alignment = facing.x * toCamera.x + facing.z * toCamera.z;
	const side = facing.x * toCamera.z - facing.z * toCamera.x >= 0 ? "right" : "left";
	const initial = side === "right" ? "R" : "L";

	let viewShort;
	let viewPhrase;
	if (alignment > 0.85) {
		viewShort = "front";
		viewPhrase = "seen from the front, the face toward the camera";
	} else if (alignment < -0.85) {
		viewShort = "back";
		viewPhrase = "seen from directly behind, the back of the head toward the camera";
	} else if (alignment > 0.34) {
		viewShort = `front ¾ ${initial}`;
		viewPhrase = `a three-quarter front view from the ${side}`;
	} else if (alignment < -0.34) {
		viewShort = `rear ¾ ${initial}`;
		viewPhrase = `a three-quarter rear view from the ${side}`;
	} else {
		viewShort = `${side} profile`;
		viewPhrase = `a ${side}-side profile view`;
	}

	return {
		sizeLabel,
		sizeContext,
		levelLabel,
		levelPhrase,
		viewShort,
		viewPhrase,
		focalMm: nearestPrime(fovRad, sensorId, aspectRatio),
		exactFocalMm: fovToFocalMm(fovRad, sensorId, aspectRatio),
		sensorId: SENSOR_FORMATS[sensorId]?.id ?? DEFAULT_SENSOR_FORMAT,
		usedSensorHeightMm: usedSensorHeightMm(sensorId, aspectRatio),
		distance,
		screenFraction,
		elevationDeg,
	};
}

/** the burned-in slate line, e.g. "MEDIUM SHOT · FRONT · EYE LEVEL · 45MM" */
export function slateLine(shot) {
	return [shot.sizeLabel, shot.viewShort, shot.levelLabel, `${shot.focalMm}mm`]
		.map((part) => part.toUpperCase())
		.join(" · ");
}

// `numericLens` models respond to an explicit aperture; `audio` models accept a
// sound instruction that would be dead weight in a silent image prompt.
export const IMAGE_MODELS = [
	{ id: "nano_banana_pro", label: "Nano Banana Pro" },
	{ id: "nano_banana_2", label: "Nano Banana 2" },
	{ id: "gpt_image_2", label: "GPT Image 2" },
	{ id: "seedream_5", label: "Seedream 5.0" },
	{ id: "flux_2", label: "Flux 2", numericLens: true, flavor: "fine film grain, high micro-detail" },
];

// Video model names are prompt vocabulary for MCP/render_prompt handoff only.
// Provider credentials and in-app API generation were removed; keep this list
// free of bridge/provider metadata so it cannot be mistaken for a live adapter.
export const VIDEO_MODELS = [
	{ id: "seedance_2", label: "Seedance 2.0", flavor: "one continuous shot" },
	{ id: "kling_3", label: "Kling 3.0", flavor: "one continuous shot" },
	{ id: "veo_3_1", label: "Veo 3.1", audio: true },
	{ id: "wan_2_7", label: "Wan 2.7" },
	{ id: "hailuo", label: "Minimax Hailuo", flavor: "natural physics and subtle facial emotion" },
	{ id: "grok_1_5", label: "Grok Imagine 1.5" },
];

export const CUSTOM_MOVE = "Custom…";

export const CAMERA_MOVES = [
	"Static / locked-off",
	"Push-in (dolly in)",
	"Pull-out (dolly out)",
	"Pan left",
	"Pan right",
	"Tilt up",
	"Tilt down",
	"Tracking / follow",
	"Orbit / arc",
	"Crane up",
	"Crane down",
	"Handheld",
	"Crash zoom in",
	"Dolly-zoom (vertigo)",
	"Whip pan",
	"Aerial / drone",
	CUSTOM_MOVE,
];

// The subject count is spelled out up to ten ("Two subjects."), then written in digits.
const COUNT_WORDS = ["Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];

/**
 * Assemble the final prompt.
 *
 * The whole trick of a blocking tool is this paragraph. The attached frame is
 * geometrically correct but visually worthless — grey clay in a grey box — so
 * the prompt has to claim the geometry and disown the appearance in the same
 * breath. Anything vaguer and the model paints grey mannequins.
 *
 * `subjects` is the cast in the order the prompt describes it: one
 * { description, posePhrase } per visible character (#1213).
 */
export function composePrompt({
	mode = "image",
	model,
	shot,
	subjects = [],
	environment,
	style,
	cameraMove = CAMERA_MOVES[0],
	customMove = "",
	hasCharSheet = false,
	hasEnvSheet = false,
}) {
	// a numeric-lens model wants glass it can reason about; the rest want the word
	const lens = model?.numericLens ? `${shot.focalMm}mm lens at f/2.2` : `${shot.focalMm}mm lens`;

	const opening =
		mode === "video"
			? `Cinematic ${shot.sizeLabel} at ${lens}, ${shot.levelPhrase}, ${shot.viewPhrase}.`
			: `Photorealistic cinematic film still, ${shot.sizeLabel} at ${lens}, ${shot.levelPhrase}, ${shot.viewPhrase}.`;

	const withPose = ({ description, posePhrase }) => (posePhrase ? `${description}, ${posePhrase}` : description);
	// An empty list is never sent by a caller; it reads as one neutral subject.
	const cast = subjects.length ? subjects : [{ description: "a person", posePhrase: "" }];

	let castLine;
	if (hasCharSheet) {
		castLine = cast.length === 1
			? "The subject is the character from the attached character sheet, exactly matching the body pose and placement shown in the blocking frame."
			: `${cast.length === 2 ? "Both" : "All"} subjects are the characters from the attached character sheet. Each one exactly matches their own body pose and placement shown in the blocking frame.`;
	} else if (cast.length === 1) {
		castLine = `Subject: ${withPose(cast[0])}, exactly matching the body pose and placement shown in the blocking frame.`;
	} else {
		const listed = cast.map((entry, i) => `Subject ${i + 1}: ${withPose(entry)}.`).join(" ");
		castLine = `${COUNT_WORDS[cast.length] ?? cast.length} subjects. ${listed} Each subject exactly matches their own body pose and placement shown in the blocking frame.`;
	}

	const place = hasEnvSheet
		? "The setting is the location from the attached environment sheet."
		: `Environment: ${environment}.`;

	const move = cameraMove === CUSTOM_MOVE ? customMove.trim() || "static, locked-off shot" : cameraMove.toLowerCase();

	const guide =
		"Use the attached blocking frame ONLY as a camera and staging guide — it fixes the exact framing, this camera angle, the lens, and the subject placement. Its floor grid is a measuring aid that encodes distance and scale: read the subject's depth and size from it, but do NOT draw the grid itself. Replace the entire setting with the described environment and render real people; do NOT reproduce its grey mannequins, grey box set, measurement grid, or flat lighting.";

	const parts = [
		opening,
		castLine,
		place,
		`${style}, ${shot.sizeContext}.`,
		mode === "video" ? `Camera move: ${move}.` : null,
		guide,
		model?.flavor ?? null,
		mode === "video" && (model?.audio || model?.capabilities?.audio) ? "Include natural ambient sound." : null,
		"16:9.",
	];

	return parts.filter(Boolean).join(" ");
}
