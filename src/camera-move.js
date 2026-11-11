// Pure math + string assembly. No three.js, no React.
// A camera move is two framings and a duration — nothing else. The authoring
// model is "compose the shot twice": the director frames A, frames B, and this
// module interpolates like a dolly grip instead of a graphics library. It also
// names the move from the geometry, so the prompt claims "push-in" only when
// the camera actually pushes in.

import { aimAngles } from "./camera-follow.js";
import { FRAMING_PIVOT_Y, SUBJECT_HEIGHT_M, deriveShot, focalMmToFov, fovToFocalMm, usedSensorHeightMm } from "./shot.js";

export const CAMERA_PRESETS = Object.freeze({
	"mocapLocomotion": Object.freeze({ id: "mocapLocomotion", label: "Mocap: locomotion", azimuthDeg: 45, height: 2.4, focalMm: 80, subjectFraction: 0.55 }),
	"mocapInteraction": Object.freeze({ id: "mocapInteraction", label: "Mocap: interaction", azimuthDeg: 45, height: 2.4, focalMm: 38, subjectFraction: 0.35 }),
});

/** Build a repeatable camera framing around the current subject. */
export function cameraPresetFraming(id, subject = {}, filmback = {}) {
	const preset = CAMERA_PRESETS[id];
	if (!preset) return null;
	const x = Number.isFinite(subject.x) ? subject.x : 0;
	const z = Number.isFinite(subject.z) ? subject.z : 0;
	const height = Number.isFinite(subject.height) ? subject.height : SUBJECT_HEIGHT_M;
	const sensorId = filmback.sensorId;
	const aspectRatio = filmback.aspectRatio;
	const fovDeg = (focalMmToFov(preset.focalMm, sensorId, aspectRatio) * 180) / Math.PI;
	const distance = height / (2 * preset.subjectFraction * Math.tan((fovDeg * Math.PI) / 360));
	const az = (preset.azimuthDeg * Math.PI) / 180;
	const pos = { x: x + distance * Math.sin(az), y: preset.height, z: z + distance * Math.cos(az) };
	const target = { x, y: height * 0.52, z };
	const { yaw, pitch } = aimAngles(pos, target);
	return { id, pos, yaw, pitch, fovDeg, focalMm: preset.focalMm };
}

/**
 * Snapshot the shot camera as a plain framing record.
 * yaw/pitch follow the YXZ free-look convention in controls.jsx.
 * @param {{pos:{x:number,y:number,z:number}, yaw:number, pitch:number, fovDeg:number}} state
 */
export function captureFraming({ pos, yaw, pitch, fovDeg, rollDeg = 0 }) {
	return { pos: { x: pos.x, y: pos.y, z: pos.z }, yaw, pitch, fovDeg, ...(rollDeg ? { rollDeg } : {}) };
}

// yaw/pitch -> unit forward vector. Mirrors forwardFrom() in controls.jsx,
// re-stated here so this module stays importable without three.js.
function forward(yaw, pitch) {
	const cp = Math.cos(pitch);
	return { x: -Math.sin(yaw) * cp, y: Math.sin(pitch), z: -Math.cos(yaw) * cp };
}

// position + target -> the yaw/pitch that looks at the target. Mirrors aimAt().
const TWO_PI = Math.PI * 2;

/** signed shortest angular distance a -> b, in (-PI, PI] */
export function shortestArc(a, b) {
	let delta = (b - a) % TWO_PI;
	if (delta > Math.PI) delta -= TWO_PI;
	if (delta <= -Math.PI) delta += TWO_PI;
	return delta;
}

const clamp01 = (t) => Math.max(0, Math.min(1, t));
const lerp = (a, b, t) => a + (b - a) * t;

/** the classic film ease: slow out of A, slow into B */
export function easeInOut(t) {
	return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

/**
 * Decompose a framing into subject-centred move coordinates: horizontal
 * distance, azimuth around the subject, lens height, and the world point the
 * lens is aimed at (sampled at the subject's range, so an interpolated orbit
 * keeps looking where the framing did instead of at empty air).
 */
function decompose(framing, anchor, filmback = {}) {
	const dx = framing.pos.x - anchor.x;
	const dz = framing.pos.z - anchor.z;
	const r = Math.max(Math.hypot(dx, dz), 1e-6);
	// pos = anchor + r * (sin az, cos az): the same convention ShotRig presets use
	const azimuth = Math.atan2(dx, dz);
	const range = Math.max(Math.hypot(r, framing.pos.y - FRAMING_PIVOT_Y), 1e-6);
	const dir = forward(framing.yaw, framing.pitch);
	const aim = {
		x: framing.pos.x + dir.x * range,
		y: framing.pos.y + dir.y * range,
		z: framing.pos.z + dir.z * range,
	};
	return {
		r,
		azimuth,
		height: framing.pos.y,
		aim,
		focalMm: fovToFocalMm(
			(framing.fovDeg * Math.PI) / 180,
			filmback.sensorId,
			filmback.aspectRatio,
		),
	};
}

/**
 * The heart of the tool. Interpolating raw positions drives an orbit through
 * the chord — straight at the subject's face — so the blend runs in
 * subject-centred coordinates instead: distance, azimuth, and height each
 * ease independently, and azimuth takes the short way around. The lens
 * interpolates in focal millimetres, which is the space a zoom ring moves in.
 *
 * @param {object} a          start framing (captureFraming record)
 * @param {object} b          end framing
 * @param {{x:number,z:number}} anchor   subject ground position
 * @param {number} t          0..1 along the move
 * @param {(t:number)=>number} ease
 * @param {{sensorId?:string,aspectRatio?:number}} filmback
 * @returns a framing record for time t; t=0 and t=1 reproduce A and B exactly
 */
export function interpolateFraming(a, b, anchor, t, ease = easeInOut, filmback = {}) {
	const k = ease(clamp01(t));
	const A = decompose(a, anchor, filmback);
	const B = decompose(b, anchor, filmback);
	const r = lerp(A.r, B.r, k);
	const azimuth = A.azimuth + shortestArc(A.azimuth, B.azimuth) * k;
	const height = lerp(A.height, B.height, k);
	const pos = {
		x: anchor.x + r * Math.sin(azimuth),
		y: height,
		z: anchor.z + r * Math.cos(azimuth),
	};
	const aim = {
		x: lerp(A.aim.x, B.aim.x, k),
		y: lerp(A.aim.y, B.aim.y, k),
		z: lerp(A.aim.z, B.aim.z, k),
	};
	const { yaw, pitch } = aimAngles(pos, aim);
	const focalMm = lerp(A.focalMm, B.focalMm, k), rollDeg = lerp(a.rollDeg ?? 0, b.rollDeg ?? 0, k);
	return {
		pos,
		yaw,
		pitch,
		fovDeg: (focalMmToFov(focalMm, filmback.sensorId, filmback.aspectRatio) * 180) / Math.PI, ...(rollDeg ? { rollDeg } : {}),
	};
}

const DEG = 180 / Math.PI;

// Below these deltas the camera is, cinematically speaking, not doing that.
const STILL_POS_M = 0.12;
const STILL_ANGLE_DEG = 6;
const DOLLY_M = 0.3;
const CRANE_M = 0.4;
const ORBIT_DEG = 20;
const ZOOM_MM = 10;
const VERTIGO_MM = 8;
const VERTIGO_SIZE_DRIFT = 0.15; // dolly-zoom = distance changes, subject size does not

/**
 * Name the move from the geometry. The CAMERA_MOVES list in shot.js is what a
 * user *claims*; this is what the two framings *prove*. The phrase slots into
 * composePrompt's "Camera move: ${...}." sentence.
 *
 * @param {object} a  start framing
 * @param {object} b  end framing
 * @param {{x:number,z:number,rot:number}} subject
 * @param {{durationS?:number, height?:number, sensorId?:string, aspectRatio?:number}} [opts]
 */
export function classifyMove(a, b, subject, {
	durationS = 3,
	height = SUBJECT_HEIGHT_M,
	sensorId,
	aspectRatio,
} = {}) {
	const anchor = { x: subject.x, z: subject.z };
	const filmback = { sensorId, aspectRatio };
	const A = decompose(a, anchor, filmback);
	const B = decompose(b, anchor, filmback);
	const shotA = deriveShot(a.pos, subject, (a.fovDeg * Math.PI) / 180, height, filmback);
	const shotB = deriveShot(b.pos, subject, (b.fovDeg * Math.PI) / 180, height, filmback);

	const dr = B.r - A.r;
	const dAzDeg = shortestArc(A.azimuth, B.azimuth) * DEG;
	const dh = B.height - A.height;
	const dFocal = B.focalMm - A.focalMm;
	// The move vocabulary's thresholds predate selectable filmbacks and were
	// authored against a 24mm-tall gate. Compare in that stable equivalent
	// space so changing sensor or crop cannot rename the same FOV move.
	const dFocal24mm = dFocal * (24 / usedSensorHeightMm(sensorId, aspectRatio));
	const dYawDeg = shortestArc(a.yaw, b.yaw) * DEG;
	const dPitchDeg = (b.pitch - a.pitch) * DEG;
	const posDelta = Math.hypot(b.pos.x - a.pos.x, b.pos.y - a.pos.y, b.pos.z - a.pos.z);
	const sizeDrift = Math.abs(shotB.screenFraction - shotA.screenFraction) / Math.max(shotA.screenFraction, 1e-6);

	// tempo comes from how far the lens physically travels per second
	const travel = Math.hypot(Math.abs(dr), (Math.abs(dAzDeg) / DEG) * ((A.r + B.r) / 2), dh);
	const speed = travel / Math.max(durationS, 0.1);
	const tempo = travel < STILL_POS_M ? "" : speed < 0.35 ? "slow " : speed > 1.4 ? "fast " : "";

	const still = posDelta < STILL_POS_M;
	const sizes = `from a ${shotA.sizeLabel} to a ${shotB.sizeLabel}`;
	let id;
	let label;
	let phrase;

	if (still && Math.abs(dYawDeg) < STILL_ANGLE_DEG && Math.abs(dPitchDeg) < STILL_ANGLE_DEG && Math.abs(dFocal24mm) < ZOOM_MM) {
		id = "static";
		label = "Static / locked-off";
		phrase = "static, locked-off shot";
	} else if (still && Math.abs(dFocal24mm) >= ZOOM_MM) {
		id = dFocal > 0 ? "zoom-in" : "zoom-out";
		label = dFocal > 0 ? "Zoom in" : "Zoom out";
		phrase = `a ${tempo}zoom ${dFocal > 0 ? "in, tightening" : "out, widening"} ${sizes}`;
	} else if (still) {
		// the tripod stays put; only the head moves
		if (Math.abs(dYawDeg) >= Math.abs(dPitchDeg)) {
			const side = dYawDeg > 0 ? "left" : "right"; // +yaw turns a YXZ camera left
			id = `pan-${side}`;
			label = `Pan ${side}`;
			phrase = `a ${tempo}pan to the ${side}`;
		} else {
			const way = dPitchDeg > 0 ? "up" : "down";
			id = `tilt-${way}`;
			label = `Tilt ${way}`;
			phrase = `a ${tempo}tilt ${way}`;
		}
	} else if (
		Math.abs(dr) >= DOLLY_M &&
		Math.abs(dFocal24mm) >= VERTIGO_MM &&
		Math.sign(dFocal) === Math.sign(dr) &&
		sizeDrift <= VERTIGO_SIZE_DRIFT
	) {
		id = "dolly-zoom";
		label = "Dolly-zoom (vertigo)";
		phrase = `a dolly-zoom (vertigo effect), the camera ${dr < 0 ? "pushing in" : "pulling back"} while the lens compensates to hold the subject's size, the background ${dr < 0 ? "stretching away" : "compressing in"}`;
	} else if (Math.abs(dAzDeg) >= ORBIT_DEG) {
		id = "orbit";
		label = "Orbit / arc";
		const radial = dr <= -DOLLY_M ? ", closing in as it circles" : dr >= DOLLY_M ? ", drifting wider as it circles" : "";
		phrase = `a ${tempo}orbit around the subject, arcing ${Math.round(Math.abs(dAzDeg))} degrees${radial}`;
	} else if (Math.abs(dh) >= CRANE_M && Math.abs(dh) >= Math.abs(dr) * 0.8) {
		const way = dh > 0 ? "up" : "down";
		id = `crane-${way}`;
		label = `Crane ${way}`;
		phrase = `a ${tempo}crane ${way}, the camera ${dh > 0 ? "rising" : "sinking"} from ${shotA.levelLabel} to ${shotB.levelLabel}`;
	} else if (dr <= -DOLLY_M) {
		id = "push-in";
		label = "Push-in (dolly in)";
		const crane = Math.abs(dh) >= CRANE_M ? `, craning ${dh > 0 ? "up" : "down"} as it moves` : "";
		phrase = `a ${tempo}push-in (dolly in) ${sizes}${crane}`;
	} else if (dr >= DOLLY_M) {
		id = "pull-out";
		label = "Pull-out (dolly out)";
		const crane = Math.abs(dh) >= CRANE_M ? `, craning ${dh > 0 ? "up" : "down"} as it moves` : "";
		phrase = `a ${tempo}pull-out (dolly out) ${sizes}${crane}`;
	} else {
		id = "tracking";
		label = "Tracking / follow";
		phrase = `a ${tempo}tracking move`;
	}

	return {
		id,
		label,
		phrase,
		tempo: tempo.trim(),
		from: shotA,
		to: shotB,
		deltas: { dr, dAzDeg, dh, dFocal, dFocal24mm, dYawDeg, dPitchDeg, posDelta, sizeDrift },
	};
}

/** the burned-in move slate, e.g. "MEDIUM SHOT 35MM → CLOSE-UP 85MM · PUSH-IN (DOLLY IN)" */
export function moveSlate(move) {
	const end = [
		`${move.from.sizeLabel} ${move.from.focalMm}mm`,
		`${move.to.sizeLabel} ${move.to.focalMm}mm`,
	].map((part) => part.toUpperCase());
	return `${end[0]} → ${end[1]} · ${move.label.toUpperCase()}`;
}

/**
 * Sample an N-key camera move at a frame. Keys are sorted frame-unique
 * records `{ frame, framing }`. Before the first key and after the last the
 * framing holds; inside a segment it interpolates exactly like A→B.
 * @param {Array<{frame:number, framing:object}>} keys  sorted by frame
 * @param {{x:number,z:number}} anchor  subject ground position
 * @param {number} frame
 * @returns a framing record, or null when there are no keys
 */
export function cameraMoveAt(keys, anchor, frame, filmback = {}) {
	if (!keys.length) return null;
	const first = keys[0];
	const last = keys[keys.length - 1];
	if (frame <= first.frame) return first.framing;
	if (frame >= last.frame) return last.framing;
	for (let i = 0; i < keys.length - 1; i++) {
		const a = keys[i];
		const b = keys[i + 1];
		if (frame <= b.frame) {
			return interpolateFraming(a.framing, b.framing, anchor, (frame - a.frame) / (b.frame - a.frame), easeInOut, filmback);
		}
	}
	return last.framing;
}

/** Chained slate for a classified segment list, e.g.
 * "MEDIUM SHOT 35MM · PUSH-IN (DOLLY IN) → CLOSE-UP 85MM · ORBIT / ARC → WIDE 24MM".
 * One segment renders identically to moveSlate. */
export function moveSequenceSlate(segments) {
	if (!segments.length) return "";
	if (segments.length === 1) return moveSlate(segments[0]);
	const parts = [`${segments[0].from.sizeLabel} ${segments[0].from.focalMm}mm`.toUpperCase()];
	for (const seg of segments) {
		parts.push(`${seg.label.toUpperCase()} → ${`${seg.to.sizeLabel} ${seg.to.focalMm}mm`.toUpperCase()}`);
	}
	return parts.join(" · ");
}

/** Generation phrase for a classified segment list: each segment's proven
 * phrase, chained in time order. */
export function moveSequencePhrase(segments) {
	return segments.map((seg) => seg.phrase).join(", then ");
}
