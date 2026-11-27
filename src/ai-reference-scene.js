// What each shot's picture holds, read from the scene for the AI video
// reference prompt (ai-reference-prompt.js): who and what is in frame, where
// in the picture, how big, when it enters or leaves, and which way it moves.
//
// The reference video is blurred on purpose, so a video model cannot read
// these back from it; the engine owns them. The engine states only what it
// can measure (screen position, size, entry and exit times, movement across
// the picture and toward or away from the lens). What a character is doing
// stays in the shot caption, which the operator or the agent writes.
//
// Pure: samplers in, facts out. No three, no DOM; runs in node tests.

import { screenBox } from "./camera-hold-body.js";

/** A thing shorter than this share of the frame height is too small to name. */
export const MIN_HEIGHT_SHARE = 0.05;
/** Samples per second of the shot. */
const SAMPLES_PER_SECOND = 6;
/** World metres a thing must travel inside a shot to count as moving. */
const MOVE_M = 0.3;
/** Distance ratio (end over start) that reads as toward or away from the lens. */
const TOWARD = 0.75, AWAY = 1 / TOWARD;

const round2 = (value) => Math.round(value * 100) / 100;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function sampleOne(camera, points, aspect) {
	if (!camera || !points?.length) return null;
	const tanV = Math.tan(((camera.fovDeg ?? 45) * Math.PI) / 360);
	const box = screenBox(camera, points, { tanV, aspect });
	if (!box) return null;
	const x0 = clamp(box.xMin, -1, 1), x1 = clamp(box.xMax, -1, 1), y0 = clamp(box.yMin, -1, 1), y1 = clamp(box.yMax, -1, 1);
	const share = x1 > x0 && y1 > y0 ? (y1 - y0) / 2 : 0;
	const centre = points.reduce((sum, [x, y, z]) => [sum[0] + x, sum[1] + y, sum[2] + z], [0, 0, 0]).map((v) => v / points.length);
	const distance = Math.hypot(centre[0] - camera.pos.x, centre[1] - camera.pos.y, centre[2] - camera.pos.z);
	return { share, x: (x0 + x1) / 2, rawX: (box.xMin + box.xMax) / 2, rawY: (box.yMin + box.yMax) / 2, distance, centre };
}

const third = (x) => (x < -1 / 3 ? "left" : x > 1 / 3 ? "right" : "centre");
const sizeWord = (share) => (share >= 0.5 ? "large" : share >= 0.2 ? "mid-size" : "small");

/** Which picture edge a thing outside the frame lies past, or null when it was behind the lens or hidden. */
function edgeOf(sample) {
	if (!sample) return null;
	const { rawX, rawY } = sample;
	if (Math.abs(rawX) >= Math.abs(rawY)) return rawX < 0 ? "left" : "right";
	return rawY < 0 ? "bottom" : "top";
}

/**
 * @param {object} input
 * @param {number} input.startFrame
 * @param {number} input.endFrame
 * @param {number} input.fps
 * @param {number} input.aspect                          output width / height
 * @param {(frame: number) => ({ pos, yaw, pitch, fovDeg } | null)} input.cameraAt
 * @param {Array<{ id: string, name: string, kind: "character" | "object", pointsAt: (frame: number) => Array<[number, number, number]> | null }>} input.entities
 * @returns {Array<object>} one entry per thing seen in the shot, characters first, then by size
 */
export function shotScene({ startFrame, endFrame, fps = 24, aspect = 16 / 9, cameraAt, entities = [] }) {
	const step = Math.max(1, Math.round(fps / SAMPLES_PER_SECOND));
	const frames = [];
	for (let frame = startFrame; frame < endFrame; frame += step) frames.push(frame);
	frames.push(endFrame);
	const cameras = frames.map((frame) => cameraAt(frame));
	const seen = [];
	for (const entity of entities) {
		const samples = frames.map((frame, index) => sampleOne(cameras[index], entity.pointsAt(frame), aspect));
		const inFrame = samples.map((sample) => !!sample && sample.share >= MIN_HEIGHT_SHARE);
		if (!inFrame.some(Boolean)) continue;
		const spans = [];
		for (let i = 0; i < frames.length; i += 1) {
			if (!inFrame[i]) continue;
			let j = i;
			while (j + 1 < frames.length && inFrame[j + 1]) j += 1;
			const first = samples[i], last = samples[j];
			const travel = Math.hypot(last.centre[0] - first.centre[0], last.centre[2] - first.centre[2]);
			const moving = travel >= MOVE_M;
			const ratio = first.distance > 1e-6 ? last.distance / first.distance : 1;
			spans.push({
				fromS: round2(frames[i] / fps),
				toS: round2((j + 1 < frames.length ? frames[j + 1] : endFrame + 1) / fps),
				enters: i > 0 ? edgeOf(samples[i - 1]) ?? "appears" : null,
				leaves: j + 1 < frames.length ? edgeOf(samples[j + 1]) ?? "disappears" : null,
				from: third(first.x),
				to: third(last.x),
				size: sizeWord(Math.max(...samples.slice(i, j + 1).map((sample) => sample.share))),
				moving,
				// Crossing means from one side of the picture to the other one.
				across: moving && third(first.x) !== "centre" && third(last.x) !== "centre" && third(first.x) !== third(last.x) ? (last.x > first.x ? "left-to-right" : "right-to-left") : null,
				depth: moving ? (ratio <= TOWARD ? "toward" : ratio >= AWAY ? "away" : null) : null,
			});
			i = j;
		}
		const peak = Math.max(...samples.filter(Boolean).map((sample) => sample.share));
		seen.push({ id: entity.id, name: entity.name, kind: entity.kind, peak: round2(peak), spans });
	}
	return seen.sort((a, b) => (a.kind === b.kind ? b.peak - a.peak : a.kind === "character" ? -1 : 1));
}

const where = (third) => (third === "centre" ? "in the centre of the frame" : `on the ${third} of the frame`);
const sentence = (text) => `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;

/** One span as a sentence: what the thing does in the picture, in time order. */
function spanClause(name, span, whole) {
	const verbs = [];
	if (span.enters) verbs.push(span.enters === "appears" ? `appears at ${span.fromS} s` : `enters from the ${span.enters} at ${span.fromS} s`);
	if (span.across) verbs.push(`moves across the frame from ${span.across === "left-to-right" ? "left to right" : "right to left"}`);
	else if (span.moving && span.from !== span.to) verbs.push(`moves from the ${span.from} to the ${span.to} of the frame`);
	else if (!span.enters) verbs.push(`is ${where(span.from)}${whole && !span.moving ? `, ${span.size} in frame, for the whole shot` : ""}`);
	if (span.depth) verbs.push(span.depth === "toward" ? "comes toward the camera" : "moves away from the camera");
	if (span.leaves) verbs.push(span.leaves === "disappears" ? `is gone at ${span.toS} s` : `leaves on the ${span.leaves} at ${span.toS} s`);
	const body = verbs.length > 1 ? `${verbs.slice(0, -1).join(", ")} and ${verbs[verbs.length - 1]}` : verbs[0];
	return `${name} ${body}`;
}

/**
 * The shot's picture in sentences: every character and every moving or
 * entering thing gets its own sentence; things that only stand there are
 * listed once at the end.
 * @param {ReturnType<typeof shotScene>} scene
 */
export function shotSceneText(scene = []) {
	const lines = [];
	const still = [];
	for (const entry of scene) {
		const whole = entry.spans.length === 1 && !entry.spans[0].enters && !entry.spans[0].leaves;
		if (entry.kind === "object" && whole && !entry.spans[0].moving) {
			still.push(entry.name);
			continue;
		}
		lines.push(...entry.spans.map((span) => sentence(spanClause(entry.name, span, whole))));
	}
	const named = [...new Set(still)];
	if (named.length) lines.push(`Also in frame: ${named.join(", ")}.`);
	return lines.join(" ");
}
