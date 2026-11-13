// Which Mixamo bone drives each poser joint, plus adapters from CozyClay's rig JSON and stage placement to the plain
// character data that rig.js reads.
import yBotRig from "../motion3/rigs/y-bot-tpose.json" with { type: "json" };
import { axisAngle } from "./mat3.js";

/** Poser joint -> Mixamo bone (without the `mixamorig:` prefix); null where Mixamo rigs have no such bone. */
const MIXAMO_JOINTS = Object.freeze({
	hips: "Hips", spine: "Spine", spine_mid: "Spine1", chest: "Spine2", neck: "Neck", neck_top: null, head: "Head",
	jaw: null, eye_l: null, eye_r: null,
	shoulder_l: "LeftShoulder", uarm_l: "LeftArm", farm_l: "LeftForeArm", hand_l: "LeftHand", thumb_tip_l: null, middle_tip_l: null,
	shoulder_r: "RightShoulder", uarm_r: "RightArm", farm_r: "RightForeArm", hand_r: "RightHand", thumb_tip_r: null, middle_tip_r: null,
	thigh_l: "LeftUpLeg", shin_l: "LeftLeg", foot_l: "LeftFoot", toe_l: "LeftToeBase",
	thigh_r: "RightUpLeg", shin_r: "RightLeg", foot_r: "RightFoot", toe_r: "RightToeBase",
});

/** The correspondence for a rig's actual bone names (`mixamorig:Hips` or `Hips`), matched on the part after `:`. */
export function mixamoJointToBone(boneNames) {
	const byShort = new Map(boneNames.map((name) => [name.split(":").pop(), name]));
	return Object.fromEntries(Object.entries(MIXAMO_JOINTS).map(([joint, bone]) => [joint, bone ? byShort.get(bone) ?? null : null]));
}

/** Rotation matrix (row-major) of a quaternion [x, y, z, w]. */
function quatToRows([x, y, z, w]) {
	return [
		[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
		[2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
		[2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
	];
}

/**
 * Character data from CozyClay rig JSON (`src/motion3/rigs/*-tpose.json`: cm, Y up, faces +Z). `scale` is the
 * character's stage scale; the rig group carries 0.01 per cm, so metres per armature unit = 0.01 * scale. The
 * rig files stand the soles on y = 0, so the floor height defaults to 0.
 */
export function characterFromRigJson(rig = yBotRig, { scale = 1, floorHeight = 0 } = {}) {
	return {
		bones: rig.bones.map((b) => ({ name: b.name, parent: b.parent, head: b.worldPos, rest: quatToRows(b.worldQuat) })),
		scale: 0.01 * scale,
		frame: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
		floorHeight,
	};
}

/**
 * Stage placement `{ x, y, z, rot (degrees about +Y), scale }` <-> the poser's world frame (metres, Y up, the
 * character facing +Z at the origin of its own floor). Rotations convert by conjugation with the same turn.
 */
export function placementFrame({ x = 0, y = 0, z = 0, rot = 0 } = {}) {
	const turn = axisAngle(new Float64Array(9), 0, 0, 1, 0, (rot * Math.PI) / 180), c = turn[0], s = turn[2];
	return {
		toPoser: (p) => { const dx = p[0] - x, dz = p[2] - z; return [c * dx - s * dz, p[1] - y, s * dx + c * dz]; },
		toStage: (p) => [c * p[0] + s * p[2] + x, p[1] + y, -s * p[0] + c * p[2] + z],
	};
}
