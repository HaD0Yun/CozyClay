// Demo "duo" as motion3 specs: two figures walk up, shake hands, talk, a pushes b, b staggers back.
import { SCHEMA, standSet, world, linesOf } from "../author.js";
import { DEMOS } from "../../demos.js";

export function duo(B) {
	const def = DEMOS.duo, A = [1.1, 0], Q = [1.9, 0], both = (name, v) => ({ [`${name}_l`]: v, [`${name}_r`]: v });
	// the handshake: both right palms at one point between them; the same heights on both sides keep the hands together
	const shakeY = [[86, 1.08], [93, 1.13], [99, 1.04], [105, 1.12], [111, 1.05], [118, 1.08]];
	const shake = (x, lean) => [
		{ f: 72, set: { armw_r: 0, spine_pitch: 0 } },
		...shakeY.map(([f, y]) => ({ f, set: { armw_r: 1, hand_r: [x, y, 0], elbow_r: [-0.3, -1, -0.3], spine_pitch: lean, head_pitch: 4 } })),
		{ f: 130, set: { armw_r: 0, aswing_r: 0, abend_r: 0, spine_pitch: 0, head_pitch: 0 } },
	];
	const sway = (at, h, l, dy = 0.012) => { const w = world(at, h, [l, 0, 0]); return [w[0], B.hipsY - dy, w[2]]; };
	const a = {
		schema: SCHEMA, fps: 24, frames: def.frames,
		use: [
			{ skill: "standIdle", f0: 0, args: { at: [0, 0], heading: 90 } },
			{ skill: "walkTo", f0: 0, args: { to: A, steps: 3, period: 12 } },
		],
		keys: [
			...shake(1.5 - 0.09, 6),
			// f132-204: talk (FK arms: two open-hand gestures, the weight goes from foot to foot)
			{ f: 134, set: { root: sway(A, 90, 0), roll: 0, aswing_r: 0, abend_r: 0, wtwist_r: 0, aswing_l: 0, abend_l: 0, wtwist_l: 0, spine_yaw: 0 } },
			{ f: 148, set: { root: sway(A, 90, -0.03), roll: 1.5, aswing_r: 38, abend_r: 78, wtwist_r: 55, spine_yaw: 5, head_pitch: -3 } },
			{ f: 160, set: { aswing_r: 30, abend_r: 60, wtwist_r: 55 } },
			{ f: 170, set: { root: sway(A, 90, 0.03), roll: -1.5, aswing_r: 5, abend_r: 15, wtwist_r: 0, aswing_l: 36, abend_l: 80, wtwist_l: -55, spine_yaw: -5, head_pitch: 2 } },
			{ f: 184, set: { aswing_l: 28, abend_l: 62, wtwist_l: -55 } },
			{ f: 200, set: { root: sway(A, 90, 0), roll: 0, aswing_l: 0, abend_l: 0, wtwist_l: 0, aswing_r: 0, abend_r: 0, spine_yaw: 0, head_pitch: 0, ...both("armw", 0), pitch: 0, foot_l: standSet(B, A, 90).foot_l, fpitch_l: 0 } },
			// f204-240: step in with the left foot and push b's chest with both hands, contact at f228
			{ f: 212, set: { foot_l: world(A, 90, [0.09, B.ankleY + 0.06, 0.14]), root: sway([A[0] + 0.07, 0], 90, -0.02, 0.02), ...both("armw", 0.5), hand_l: [1.38, 1.24, -0.16], hand_r: [1.38, 1.24, 0.16], elbow_l: [0.7, -0.7, -0.3], elbow_r: [-0.7, -0.7, -0.3] } },
			{ f: 220, set: { foot_l: world(A, 90, [0.09, B.ankleY, 0.32]), fpitch_l: 0, root: sway([A[0] + 0.16, 0], 90, 0, 0.03), pitch: 4, ...both("armw", 1), hand_l: [1.5, 1.3, -0.13], hand_r: [1.5, 1.3, 0.13], fpitch_r: 10 } },
			{ f: 228, set: { root: sway([A[0] + 0.22, 0], 90, 0, 0.035), pitch: 9, spine_pitch: 6, hand_l: [1.71, 1.32, -0.1], hand_r: [1.71, 1.32, 0.1], fpitch_r: 25 } },
			{ f: 234, set: { root: sway([A[0] + 0.27, 0], 90, 0, 0.04), pitch: 13, spine_pitch: 8, hand_l: [1.86, 1.3, -0.1], hand_r: [1.86, 1.3, 0.1], fpitch_r: 35, foot_r: standSet(B, A, 90).foot_r } },
			// f240-360: lower the arms, bring the right foot up, stand
			{ f: 250, set: { root: sway([A[0] + 0.24, 0], 90, 0, 0.03), pitch: 6, spine_pitch: 2, ...both("armw", 0.6), hand_l: [1.7, 1.15, -0.16], hand_r: [1.7, 1.15, 0.16] } },
			{ f: 262, set: { ...both("armw", 0), ...both("aswing", 0), ...both("abend", 0), foot_r: world(A, 90, [-0.09, B.ankleY + 0.05, 0.2]), fpitch_r: 15 } },
			{ f: 272, set: standSet(B, [A[0] + 0.29, 0], 90) },
			{ f: 359, set: standSet(B, [A[0] + 0.29, 0], 90) },
		],
	};
	// b staggers back: three steps (right, left, right), each foot's lift keyed between its plants; the trunk is thrown
	// back by the push, then over-corrects forward as the last step catches the weight
	const end = [2.92, 0], endFeet = standSet(B, end, 270), up = (p, dy = 0.06) => [p[0], p[1] + dy, p[2]];
	const start = standSet(B, Q, 270), r1 = world([2.42, 0], 270, [-0.1, B.ankleY, 0]);
	const mid = (p, q) => up(p.map((v, i) => (v + q[i]) / 2));
	const b = {
		schema: SCHEMA, fps: 24, frames: def.frames,
		anchors: { hipL: { kind: "body", p: [0.19, 0.0, 0.03] }, hipR: { kind: "body", p: [-0.19, 0.0, 0.03] } },
		use: [
			{ skill: "standIdle", f0: 0, args: { at: [3.0, 0], heading: 270 } },
			{ skill: "walkTo", f0: 0, args: { to: Q, steps: 3, period: 12 } },
		],
		keys: [
			{ f: 0, set: { w_hipL_l: 0, w_hipR_r: 0 } },
			...shake(1.5 + 0.09, 6),
			// f132-204: listen, the hands on the hips, two nods
			{ f: 134, set: { ...both("armw", 0), w_hipL_l: 0, w_hipR_r: 0, head_pitch: 0 } },
			{ f: 148, set: { ...both("armw", 1), w_hipL_l: 1, w_hipR_r: 1, elbow_l: [1, -0.25, -0.6], elbow_r: [-1, -0.25, -0.6] } },
			...[[152, 0], [158, 11], [164, 0], [176, 0], [182, 11], [188, 0]].map(([f, v]) => ({ f, set: { head_pitch: v } })),
			{ f: 222, set: { ...both("armw", 1), w_hipL_l: 1, w_hipR_r: 1, ...start, pitch: 0, spine_pitch: 0, arm_rest: 72 } },
			// f228-300: pushed at f228; stagger back to about [2.9, 0] and catch the balance
			{ f: 228, set: { root: start.root, pitch: 0, spine_pitch: 0, head_pitch: 0, foot_r: start.foot_r, foot_l: start.foot_l } },
			{ f: 232, set: { root: [Q[0] + 0.08, B.hipsY - 0.02, 0], pitch: -5, spine_pitch: -14, head_pitch: 14, ...both("armw", 0.3), foot_r: up(start.foot_r, 0.03), fpitch_l: -8 } },
			{ f: 236, set: { foot_r: mid(start.foot_r, r1) } },
			{ f: 241, set: { root: [Q[0] + 0.3, B.hipsY - 0.05, -0.02], pitch: -11, spine_pitch: -10, head_pitch: 6, foot_r: r1, fpitch_r: 0, foot_l: start.foot_l, fpitch_l: -12,
				...both("armw", 0), w_hipL_l: 0, w_hipR_r: 0, arm_rest: 46, ...both("aswing", 34), ...both("abend", 25) } },
			{ f: 247, set: { foot_l: mid(start.foot_l, endFeet.foot_l), fpitch_l: 0 } },
			{ f: 253, set: { root: [Q[0] + 0.66, B.hipsY - 0.06, 0.02], pitch: -5, spine_pitch: -2, foot_l: endFeet.foot_l, foot_r: r1, fpitch_r: -10, arm_rest: 50, ...both("aswing", 20), ...both("abend", 35) } },
			{ f: 259, set: { foot_r: mid(r1, endFeet.foot_r) } },
			{ f: 266, set: { root: [end[0] - 0.05, B.hipsY - 0.085, 0], pitch: 12, spine_pitch: 10, head_pitch: -6, foot_r: endFeet.foot_r, fpitch_r: 0, foot_l: endFeet.foot_l, arm_rest: 58, ...both("aswing", 28), ...both("abend", 30) } },
			{ f: 282, set: { root: [end[0], B.hipsY - 0.04, 0], pitch: 4, spine_pitch: 3, head_pitch: 0, arm_rest: 68, ...both("aswing", 6), ...both("abend", 12) } },
			// f300-360: stand up straight, look at a
			{ f: 300, set: { ...standSet(B, end, 270), arm_rest: 72 } },
			{ f: 359, set: { ...standSet(B, end, 270), arm_rest: 72 } },
		],
	};
	return {
		characters: { a, b },
		lines: linesOf(duo),
		notes: [
			"handshake, talk, listen, push and stagger have no motion3 skill: hand-written keys (motion3's hitReaction skill was not used: it reacts to a keyed hit, it does not stage two bodies)",
			"each figure is compiled alone: neither knows where the other is, so the shaking hands and the pushing palms meet only because both specs name the same world points",
			"b's stagger is three keyed steps with the trunk thrown back; nothing computes a loss of balance",
		],
	};
}
