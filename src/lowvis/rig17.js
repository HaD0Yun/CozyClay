// The low-vis figure: 17 joints. Everything here is in METRES, Y up, the figure at rest stands at the origin
// facing +Z with +X on its left (the motion3 convention). No three.js: this runs in Node and in the browser.
//
// Clip convention (clip.js): a joint's world quaternion is its rotation FROM REST. At rest every joint has the
// identity quaternion, whatever the source rig's bone axes are. So a body part drawn at rest follows its joint by
// p_world = pos[j] + rotate(quat[j], p_rest - REST[j]).
import rig from "./rig17.json" with { type: "json" };

const CM = 0.01;

/** Joint names in clip order. */
export const JOINTS = Object.freeze(rig.bones.map(b => b.name));
export const JOINT_COUNT = JOINTS.length;
export const INDEX = Object.freeze(Object.fromEntries(JOINTS.map((n, i) => [n, i])));
/** Parent joint index, -1 for Hips. Parents come before children. */
export const PARENT = Object.freeze(rig.bones.map(b => b.parent));
/** Rest world position of every joint (m). */
export const REST = Object.freeze(rig.bones.map(b => Object.freeze(b.worldPos.map(v => v * CM))));
/** Rest world position (m) of the far end of the parts that end the chain: head top, fingertips, toe tips. */
export const TIPS = Object.freeze(Object.fromEntries(Object.entries(rig.tips).map(([k, p]) => [k, Object.freeze(p.map(v => v * CM))])));
/** Rest offset of each joint from its parent (m); the Hips entry is its rest position. */
export const OFFSET = Object.freeze(REST.map((p, j) => Object.freeze(PARENT[j] < 0 ? p.slice() : p.map((v, k) => v - REST[PARENT[j]][k]))));
/** Ankle joint height over the sole at rest (m). */
export const ANKLE_HEIGHT = REST[INDEX.LeftFoot][1];
/** The source rig's rest world quaternion per joint [x,y,z,w] (Mixamo bone axes); only motion3 interop needs it. */
export const SOURCE_REST_QUAT = Object.freeze(rig.bones.map(b => Object.freeze(b.worldQuat.slice())));
/** The rig JSON in x-bot-tpose.json's shape (centimetres), for motion3's registerRig. */
export const RIG17_JSON = rig;

export const qIdentity = () => [0, 0, 0, 1];
export const qConj = q => [-q[0], -q[1], -q[2], q[3]];
export const qMul = (a, b) => [
	a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
	a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
	a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
	a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
export const qRotate = (q, v) => { const r = qMul(qMul(q, [v[0], v[1], v[2], 0]), qConj(q)); return [r[0], r[1], r[2]]; };
/** Quaternion of `angle` radians about unit axis [x,y,z]. */
export const qAxisAngle = (axis, angle) => { const s = Math.sin(angle / 2); return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)]; };

/**
 * Forward kinematics. `local[j]` is joint j's rotation relative to its parent, from rest (identity = rest);
 * `hips` is the Hips world position (m). Returns { pos: number[17][3], quat: number[17][4] } in the clip convention.
 */
export function fk(hips, local) {
	const pos = [], quat = [];
	for (let j = 0; j < JOINT_COUNT; j++) {
		const p = PARENT[j], q = local?.[j] ?? qIdentity();
		if (p < 0) { quat[j] = q; pos[j] = hips.slice(); continue; }
		quat[j] = qMul(quat[p], q);
		const o = qRotate(quat[p], OFFSET[j]);
		pos[j] = [pos[p][0] + o[0], pos[p][1] + o[1], pos[p][2] + o[2]];
	}
	return { pos, quat };
}
