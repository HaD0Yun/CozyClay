// The MotionBricks model's 30-joint SOMA skeleton and how it sits against the X Bot (motion3 rig).
// SOMA model space is Y up and faces +X with +Z on the right; CozyClay faces +Z with +X on the left,
// so a SOMA point (x, y, z) is (-z, y, x) here. Both directions also scale the body (SOMA hips stand
// 1.0128 m, the X Bot's 1.03 m) and lift it so a planted ankle stands where the X Bot's does.
import { apply, mul, T } from "../compiler/math.js";

export const SOMA_JOINTS = ["Hips", "Spine1", "Spine2", "Chest", "Neck1", "Neck2", "Head", "Jaw", "LeftEye", "RightEye",
	"LeftShoulder", "LeftArm", "LeftForeArm", "LeftHand", "LeftHandThumbEnd", "LeftHandMiddleEnd",
	"RightShoulder", "RightArm", "RightForeArm", "RightHand", "RightHandThumbEnd", "RightHandMiddleEnd",
	"LeftLeg", "LeftShin", "LeftFoot", "LeftToeBase", "RightLeg", "RightShin", "RightFoot", "RightToeBase"];
export const SID = Object.fromEntries(SOMA_JOINTS.map((n, i) => [n, i]));
/** Nearest model joint above each joint (the thumb and middle tips ride the hand: SOMA's finger joints are not model joints). */
export const SOMA_PARENT = [-1, 0, 1, 2, 3, 4, 5, 6, 6, 6, 3, 10, 11, 12, 13, 13, 3, 16, 17, 18, 19, 19, 0, 22, 23, 24, 0, 26, 27, 28];
/** Each joint's offset from its parent in the parent's frame (m, SOMA rig; the finger tips with the fingers at rest). */
export const SOMA_OFFSET = [[0, 0, 0], [0.05004, -0.00037, -0.00014], [0.07125, 0, 0], [0.07594, 0, 0], [0.26313, -0.0046, -0.00182],
	[0.08046, 0, 0], [0.06433, 0, 0], [0.00109, 0.03129, 0.00003], [0.04452, 0.08166, 0.03206], [0.04437, 0.08136, -0.03222],
	[0.23219, 0.05196, 0.01622], [0.15902, 0, 0], [0.28739, 0, 0], [0.27094, 0, 0], [0.11841, 0.03503, 0.04782], [0.16599, 0.00293, 0.05824],
	[0.23162, 0.05296, -0.0138], [-0.16027, 0, 0], [-0.28737, 0, 0], [-0.27134, 0, 0], [-0.11938, -0.04084, -0.04284], [-0.1733, -0.00382, -0.04847],
	[-0.08443, 0.02568, 0.10043], [0.43229, 0, 0], [0.42299, 0, 0], [0.14166, 0, 0], [-0.08304, 0.02593, -0.10047], [-0.4337, 0, 0], [-0.42261, 0, 0], [-0.14222, 0, 0]];
/** The X Bot bone whose rotation each SOMA joint follows (soma-calib.js holds the constant frame offset between the two). */
export const XBOT_BONE = ["Hips", "Spine", "Spine1", "Spine2", "Neck", "Neck", "Head", "Head", "Head", "Head",
	"LeftShoulder", "LeftArm", "LeftForeArm", "LeftHand", "LeftHand", "LeftHand",
	"RightShoulder", "RightArm", "RightForeArm", "RightHand", "RightHand", "RightHand",
	"LeftUpLeg", "LeftLeg", "LeftFoot", "LeftToeBase", "RightUpLeg", "RightLeg", "RightFoot", "RightToeBase"];

const AXES = [[0, 0, -1], [0, 1, 0], [1, 0, 0]];
const BODY_SCALE = 1.03 / 1.01282;
/** Ankle lift (m): SOMA's planted ankle stands about 0.0645 m (x scale 0.0656), the X Bot's 0.087 m. */
const LIFT = 0.0214;

/** SOMA point -> CozyClay point (scaled, lifted). */
export const toCozyPoint = p => { const q = apply(AXES, p); return [q[0] * BODY_SCALE, q[1] * BODY_SCALE + LIFT, q[2] * BODY_SCALE]; };
export const toSomaPoint = q => apply(T(AXES), [q[0] / BODY_SCALE, (q[1] - LIFT) / BODY_SCALE, q[2] / BODY_SCALE]);
/** A joint's world frame in CozyClay space (columns = its local axes) -> the same frame in SOMA space. */
export const toSomaRot = R => mul(T(AXES), R);

/** Forward kinematics on the SOMA rig: root position + 30 world rotations (SOMA space) -> 30 world positions. */
export function somaFK(root, R) {
	const P = [root.slice()];
	for (let j = 1; j < SOMA_JOINTS.length; j++) {
		const p = SOMA_PARENT[j], o = apply(R[p], SOMA_OFFSET[j]);
		P.push([P[p][0] + o[0], P[p][1] + o[1], P[p][2] + o[2]]);
	}
	return P;
}
