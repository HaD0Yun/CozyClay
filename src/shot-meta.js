/**
 * What a framing capture SAYS about the shot it came from.
 *
 * A PNG on its own is just pixels: an agent handing it to a video model still
 * has to know the lens, the delivery aspect, who is in frame and which model
 * the shot is aimed at. This module answers that in one pure object, so both
 * capture paths (the live `capture_framing_png` command and the embed-mode
 * message handler) describe a pull the same way.
 *
 * Pure data: no DOM, no React, no three.js — it runs in node tests and in the
 * browser unchanged. Everything is read defensively because callers pass live
 * editor state, where a shot can be missing entirely (no shots authored yet).
 */
import { characterName } from "./character-name.js";

const finite = (value) => (Number.isFinite(value) ? value : null);

/**
 * @param {object} input
 * @param {object|null} input.shot         the shot the captured frame lands in
 * @param {object|null} input.stage        { keyLight } — the stage envelope
 * @param {Array}       input.cast         characters array ({ name, model })
 * @param {number}      input.fps          timeline frames per second
 * @param {string}      input.aspectKey    delivery aspect label, e.g. "16:9"
 * @param {object}      input.size         { width, height } of the capture
 * @param {number}      input.frame        the captured frame number
 * @param {number}      [input.shotIndex]  the shot's index in the shot list
 * @param {object}      [input.lens]       { focalMm, fovDeg } of the live shot
 *   camera, used when the shot's own camera block carries no lens — the block
 *   stores the MOVE (rail, crane, follow), while the lens lives on the stage.
 */
export function shotCaptureMeta({ shot = null, stage = null, cast = [], fps = null, aspectKey = null, size = null, frame = null, shotIndex = null, lens = null } = {}) {
	const camera = shot?.camera ?? null;
	return {
		focalMm: finite(camera?.focalMm) ?? finite(lens?.focalMm),
		fovDeg: finite(camera?.fovDeg) ?? finite(lens?.fovDeg),
		aspect: typeof aspectKey === "string" && aspectKey ? aspectKey : null,
		size: {
			width: finite(size?.width),
			height: finite(size?.height),
		},
		// Which instruments the move actually uses, not which ones were once
		// switched on: a stored-but-empty envelope is no dolly move.
		cameraMove: {
			dolly: Boolean(camera?.dollyTiming),
			crane: Boolean(camera?.craneHeight),
			rail: Boolean(camera?.railFollow) && camera.railFollow.mode !== "off",
		},
		keyLight: stage?.keyLight ?? null,
		// A cast member's name: what the operator typed for it (its subject), else
		// its model-built display name (character-name.js).
		cast: (Array.isArray(cast) ? cast : []).map((entry) => ({
			name: entry?.name ?? (entry ? characterName(entry) : null),
			model: entry?.model ?? null,
		})),
		frameRange: {
			start: finite(shot?.startFrame),
			end: finite(shot?.endFrame),
		},
		fps: finite(fps),
		shotIndex: Number.isInteger(shotIndex) && shotIndex >= 0 ? shotIndex : null,
		shotTitle: typeof shot?.name === "string" && shot.name ? shot.name : null,
		targetModel: shot?.targetModel ?? null,
		frame: finite(frame),
	};
}
