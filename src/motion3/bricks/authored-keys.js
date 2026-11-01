// Pose-mode keys -> the authored motion spec motion.fill fills. A keyed frame is a compiler frame state { P, R } (the
// posed rig read in the character's own space, motion/pose-fill.js) placed at its placement key; its channels come from
// the same two conversions the fill uses (reverse: X Bot frame -> SOMA pose, forward: SOMA joints -> channels), so a key
// reads back as the pose the user made. A gap longer than one model call (46 frames) gets the preview pose at its middle
// as one more authored key, again until every gap fits.
import { mul, apply, add, ry } from "../compiler/math.js";
import { somaPose } from "./reverse.js";
import { toCozyPoint } from "./soma.js";
import { frameChannels, roundChannels } from "./forward.js";

const FILL_GAP_MAX = 46;

/** A frame state in the character's space, placed at { x, z, rot } (the character's own frame: spec space). */
export function placeState(s, { x, z, rot }) {
	const Y = ry(rot);
	return { P: s.P.map(p => add(apply(Y, p), [x, 0, z])), R: s.R.map(R => mul(Y, R)) };
}

/** One placed frame state -> the channels of an authored key (whole body; hands on IK). */
export function authoredChannels(sk, s) {
	const ch = roundChannels(frameChannels(somaPose(sk, s).P.map(toCozyPoint)));
	return { ...ch, armw_l: 1, armw_r: 1 };
}

/** The keyed frames plus the middles a long gap needs (frames only; poseAt reads them). */
export function authoredFrames(keyed) {
	const out = [...new Set(keyed)].sort((a, b) => a - b);
	for (let i = 1; i < out.length; i++) {
		if (out[i] - out[i - 1] <= FILL_GAP_MAX) continue;
		out.splice(i, 0, Math.round((out[i - 1] + out[i]) / 2));
		i--;
	}
	return out;
}

/** frames: the timeline length; keys: [{ f, set }] in frame order. */
export const authoredSpec = (frames, keys, label = "pose keys (MotionBricks fill)") =>
	({ schema: "cozyclay.motion-spec.v1", fps: 24, frames, label, flow: false, keys: keys.map(({ f, set }) => ({ f, set })) });
