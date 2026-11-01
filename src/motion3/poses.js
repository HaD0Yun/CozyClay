// Named key poses for MotionBricks fills: a key { f, pose: "sit_floor", at?: [x, z], face?: deg, set? } stands for the
// channels below, fitted to the rig (heights scale with its rest hips, the ankle sits at its own height), turned by face
// and moved by at; set overrides single channels. MotionBricks generates everything between the keys, so a fill needs
// a few readable poses, not hand-typed ones: an agent writes "sit_floor" instead of fifteen numbers it would have to
// guess (and repair). Lying, sitting knees-up and hands-on-knees are left out: no version held clean on both rigs or filled clean. Every pose holds QA-clean on Y Bot and X Bot with every fix off (as written, not as the compiler would correct it) (test/motion3/verify-motion3-poses.mjs).
const bad = msg => { throw new Error(`MOTION_SPEC_INVALID: ${msg}`); };

const Y_HIPS = 0.99792, Y_ANKLE = 0.10492; // Y Bot rest hips and ankle height: the poses are written on it
const FK_ARMS = { armw_l: 0, armw_r: 0 };
const legs = (x, y, z, kx, ky, kz) => ({ foot_l: [x, y, z], foot_r: [-x, y, z], knee_l: [kx, ky, kz], knee_r: [-kx, ky, kz] });
const armsDown = (bend, swing = 0) => ({ ...FK_ARMS, abend_l: bend, abend_r: bend, aswing_l: swing, aswing_r: swing });
const handsAt = (x, y, z) => ({ armw_l: 1, armw_r: 1, hand_l: [x, y, z], hand_r: [-x, y, z] });

/** name -> { says, set } in Y Bot units (metres, character space, +Z forward). */
export const POSES = Object.freeze({
	stand: { says: "standing, arms down", set: { root: [0, 0.99, 0], ...legs(0.1, 0.105, 0, 0.1, 0, 1), ...armsDown(10) } },
	ready: { says: "athletic stance, knees bent (before a run, a jump, a catch)", set: { root: [0, 0.9, -0.03], ...legs(0.14, 0.105, 0.02, 0.15, 0.1, 1), spine_pitch: 10, ...armsDown(35, 10) } },
	crouch: { says: "half squat, hips at knee height", set: { root: [0, 0.6, -0.1], ...legs(0.13, 0.105, 0.05, 0.08, 0.29, 0.96), spine_pitch: 20, ...armsDown(20, -25) } },
	squat: { says: "deep squat, heels down", set: { root: [0, 0.42, -0.12], ...legs(0.16, 0.105, 0.05, 0.25, 0.3, 0.92), spine_pitch: 30, ...armsDown(40, 20) } },
	sit_floor: { says: "sitting on the floor, legs out, hands on the floor behind", set: { root: [0, 0.16, -0.1], ...legs(0.19, 0.105, 0.6, 0.06, 0.29, 0.96), spine_pitch: 5, ...handsAt(0.3, 0.1, -0.28) } },
	kneel: { says: "kneeling on both knees, upright, knees on the floor", set: { root: [0, 0.5, 0], ...legs(0.12, 0.11, -0.42, 0.1, -0.6, 0.8), ...armsDown(15) } },
	kneel_one: { says: "on the right knee (on the floor), left foot forward", set: { root: [0, 0.52, -0.05], foot_l: [0.13, 0.105, 0.32], foot_r: [-0.13, 0.11, -0.42], knee_l: [0.1, 0.3, 1], knee_r: [-0.1, -0.6, 0.8], ...armsDown(20) } },
	lunge: { says: "lunge, left foot forward", set: { root: [0, 0.72, 0], foot_l: [0.12, 0.105, 0.4], foot_r: [-0.12, 0.17, -0.45], knee_l: [0.1, 0.2, 1], knee_r: [-0.1, -0.2, 1], fpitch_r: 30, spine_pitch: 5, ...armsDown(20) } },
});
export const POSE_NAMES = Object.keys(POSES);

const turn = ([x, y, z], deg) => { const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a); return [x * c + z * s, y, -x * s + z * c]; };
// every body channel a pose leaves out is its neutral value: a fill key's leftover (a foot pitch, a spine turn) never holds past the pose
const NEUTRAL = { pitch: 0, roll: 0, spine_yaw: 0, spine_pitch: 0, spine_roll: 0, head_yaw: 0, head_pitch: 0, head_roll: 0, fyaw_l: 0, fyaw_r: 0, fpitch_l: 0, fpitch_r: 0 };
// positions are world metres (turned by face, moved by at); knee and elbow poles are body-frame (they turn with the root yaw already)
const POINTS = new Set(["root", "foot_l", "foot_r", "hand_l", "hand_r"]);

/** The channels of a named pose on this rig ({ restWorldPos, index }), turned by face (deg) and moved by at [x, z]. */
export function poseChannels(name, sk, { at = [0, 0], face = 0 } = {}) {
	const pose = POSES[name] ?? bad(`pose "${name}" is not a pose (poses: ${POSE_NAMES.join(", ")})`);
	const hips = sk?.restWorldPos?.[sk.index?.Hips]?.[1] ?? Y_HIPS, ankle = sk?.restWorldPos?.[sk.index?.LeftFoot]?.[1] ?? Y_ANKLE, k = hips / Y_HIPS;
	const out = {};
	for (const [ch, v] of Object.entries({ ...NEUTRAL, ...pose.set })) {
		if (POINTS.has(ch)) {
			const y = /^foot_/.test(ch) ? ankle + (v[1] - 0.105) * k : v[1] * k;
			const p = turn([v[0] * k, y, v[2] * k], face);
			out[ch] = [p[0] + at[0], p[1], p[2] + at[1]].map(n => +n.toFixed(4));
		} else out[ch] = ch === "yaw" ? v + face : v;
	}
	if (out.yaw === undefined) out.yaw = face;
	return out;
}

/** A spec whose keys name poses, with each such key's channels written out (the pose's, then key.set over them); others as sent. */
export function expandPoses(spec, sk) {
	if (!Array.isArray(spec?.keys) || !spec.keys.some(k => k && typeof k.pose === "string")) return spec;
	return { ...spec, keys: spec.keys.map(k => {
		if (!k || typeof k.pose !== "string") return k;
		const { pose, at, face, set, ...rest } = k;
		// fyaw is a world heading: a key that turns the body with set.yaw turns the feet with it unless it keys them (an agent turning
		// a carry by 180 deg left the feet facing back, and both knees bent backward for 95 frames)
		const feet = Number.isFinite(set?.yaw) ? Object.fromEntries(["l", "r"].filter(s => set[`fyaw_${s}`] === undefined).map(s => [`fyaw_${s}`, set.yaw])) : {};
		return { ...rest, set: { ...poseChannels(pose, sk, { at, face }), ...feet, ...(set ?? {}) } };
	}) };
}
