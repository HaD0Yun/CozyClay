// Demo "sit" as a motion3 spec: walk to a chair, sit, stand, walk to a mat, kneel and lie down on the back.
import { SCHEMA, standSet, turnOnSpot, arcTo, world, linesOf } from "../author.js";
import { boxRecord } from "../scene.js";
import { DEMOS } from "../../demos.js";

export function sit(B) {
	const S = [0, 1.15], M = [2.0, 0.4], seat = 0.45, mat = 0.1, at = (v, h = 180) => world(S, h, v);
	// the walk to the mat: one arc from the chair (heading 180) that ends at M; what is left of the turn to heading 0
	// is made while kneeling
	const toMat = { ...arcTo(S, 180, M, 5, -1), period: 8 }, E = 204 + 16 + toMat.steps * toMat.period + 18, hM = toMat.heading[1];
	const seated = { root: at([0, seat + 0.11, -0.35]), pitch: 4, spine_pitch: 4, head_pitch: 0, armw_l: 1, armw_r: 1,
		hand_l: at([0.11, seat + 0.21, -0.12]), hand_r: at([-0.11, seat + 0.21, -0.12]), elbow_l: [0.5, -0.8, -0.4], elbow_r: [-0.5, -0.8, -0.4] };
	const lying = { root: [2.0, mat + 0.105, 1.62], yaw: 180, pitch: -88, roll: 0, spine_pitch: 0, head_pitch: 0,
		foot_l: [1.9, mat + 0.075, 0.68], foot_r: [2.1, mat + 0.075, 0.68], fyaw_l: 180, fyaw_r: 180, fpitch_l: -40, fpitch_r: -40, knee_l: [0, 1, 0.2], knee_r: [0, 1, 0.2],
		armw_l: 1, armw_r: 1, hand_l: [1.7, mat + 0.05, 1.54], hand_r: [2.3, mat + 0.05, 1.54], elbow_l: [0.8, 0, -0.2], elbow_r: [-0.8, 0, -0.2] };
	const keys = [
		// f58-82: turn the back to the chair (no skill: keys)
		...turnOnSpot(B, { f0: 58, f1: 82, at: S, h0: 0, h1: 180 }),
		{ f: 82, set: standSet(B, S, 180) },
		// f82-118: sit down (no skill for a plain seat: keys). The hips go back and down, the trunk leans to stay over the feet
		{ f: 96, set: { root: at([0, 0.86, -0.14]), pitch: 28, spine_pitch: 10, head_pitch: -15, aswing_l: 15, aswing_r: 15, abend_l: 30, abend_r: 30 } },
		{ f: 108, set: { root: at([0, seat + 0.16, -0.32]), pitch: 22, spine_pitch: 8, armw_l: 0.6, armw_r: 0.6, hand_l: seated.hand_l, hand_r: seated.hand_r, elbow_l: seated.elbow_l, elbow_r: seated.elbow_r } },
		{ f: 118, set: seated },
		// f120-156: sit still, hands on the thighs
		{ f: 156, set: seated },
		// f156-204: stand up
		{ f: 168, set: { root: at([0, seat + 0.15, -0.3]), pitch: 30, spine_pitch: 10, head_pitch: -12, armw_l: 1, armw_r: 1, hand_l: seated.hand_l, hand_r: seated.hand_r } },
		{ f: 184, set: { root: at([0, 0.88, -0.1]), pitch: 20, spine_pitch: 6, armw_l: 0, armw_r: 0, aswing_l: 10, aswing_r: 10, abend_l: 20, abend_r: 20 } },
		{ f: 200, set: standSet(B, S, 180) },
		// kneel on the mat's near end, turn over the hip to sit, lie back (no skill: keys)
		{ f: E + 18, set: { root: [2.0, 0.66, 0.7], yaw: 0, pitch: 12, spine_pitch: 10, foot_l: [2.09, 0.11, 0.3], foot_r: [1.91, 0.11, 0.3], fyaw_l: 0, fyaw_r: 0, fpitch_l: 65, fpitch_r: 65,
			knee_l: [0.05, 0, 1], knee_r: [-0.05, 0, 1], armw_l: 1, armw_r: 1, hand_l: [2.25, 0.45, 1.0], hand_r: [1.75, 0.45, 1.0], elbow_l: [0.5, -0.8, -0.3], elbow_r: [-0.5, -0.8, -0.3] } },
		{ f: E + 36, set: { root: [2.0, mat + 0.12, 1.25], yaw: 90, pitch: -8, spine_pitch: 12, foot_l: [1.95, mat + 0.09, 0.78], foot_r: [2.12, mat + 0.09, 0.7], fyaw_l: 150, fyaw_r: 150, fpitch_l: 0, fpitch_r: 0,
			knee_l: [1, 0.8, 0.2], knee_r: [1, 0.8, 0.2], hand_l: [2.15, mat + 0.05, 0.95], hand_r: [2.2, mat + 0.05, 1.58] } },
		{ f: E + 52, set: { root: [2.0, mat + 0.115, 1.55], yaw: 180, pitch: -40, spine_pitch: 6, foot_l: [1.9, mat + 0.09, 0.9], foot_r: [2.1, mat + 0.09, 0.9], fyaw_l: 180, fyaw_r: 180, fpitch_l: -10, fpitch_r: -10,
			knee_l: [0, 1, 0.2], knee_r: [0, 1, 0.2], hand_l: [1.72, mat + 0.05, 1.72], hand_r: [2.28, mat + 0.05, 1.72], elbow_l: [0.6, 0, -0.6], elbow_r: [-0.6, 0, -0.6] } },
		{ f: E + 68, set: lying },
		{ f: 383, set: lying },
	];
	const a = {
		schema: SCHEMA, fps: 24, frames: 384,
		use: [
			{ skill: "standIdle", f0: 0, args: { at: [0, 0], heading: 0 } },
			{ skill: "walkTo", f0: 0, args: { to: S, steps: 3, period: 8 } },
			{ skill: "walkTo", f0: 204, args: toMat },
		],
		keys,
	};
	return {
		objects: DEMOS.sit.props.map(boxRecord),
		characters: { a },
		lines: linesOf(sit),
		notes: [
			"sit down, sit still, stand up, kneel and lie down have no motion3 skill for a plain chair or a mat (sitInSeat is a car seat with a wheel): hand-written keys",
			"the walk to the chair ends at f58 (walkTo: 16 frames to start, 18 to settle), so the turn runs f58-82 and the sit-down f82-118, 10 frames inside the sit-down beat",
			`the walk to the mat is one arc that ends at heading ${Math.round(hM)}, not 0: the rest of the turn is made while kneeling (f${E}-${E + 18})`,
			"lying down goes kneel, side-sit, lie back: the legs sweep across the mat while the hips turn 180 degrees, and the hands are only placed on the mat, they do not carry weight",
		],
	};
}
