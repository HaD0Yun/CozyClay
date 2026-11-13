// The poser's own 30-joint skeleton: joint table, rest layout from bone lengths, and forward kinematics.
import SKELETON_JSON from "./skeleton.json" with { type: "json" };
import { mul, mulVec } from "./mat3.js";

export const JOINT_COUNT = 30;

/** Parsed skeleton facts from `skeleton.json`'s shape; derived: rest directions, children, depths. */
export function makeSkeleton(json = SKELETON_JSON) {
	const names = json.jointNames, parents = Int32Array.from(json.parents), n = names.length;
	if (n !== JOINT_COUNT || parents.length !== n) throw new Error(`poser skeleton: expected ${JOINT_COUNT} joints, got ${n}`);
	const rest = Float64Array.from(json.restJoints.flat());
	const dir = new Float64Array(3 * n), depth = new Int32Array(n), children = names.map(() => []);
	for (let j = 1; j < n; j += 1) {
		const q = parents[j];
		if (!(q >= 0 && q < j)) throw new Error(`poser skeleton: parent of joint ${j} must precede it`);
		const dx = rest[3 * j] - rest[3 * q], dy = rest[3 * j + 1] - rest[3 * q + 1], dz = rest[3 * j + 2] - rest[3 * q + 2];
		const len = Math.max(Math.hypot(dx, dy, dz), 1e-8);
		dir[3 * j] = dx / len; dir[3 * j + 1] = dy / len; dir[3 * j + 2] = dz / len;
		depth[j] = depth[q] + 1;
		children[q].push(j);
	}
	return {
		names,
		index: Object.fromEntries(names.map((name, j) => [name, j])),
		parents,
		restJoints: rest,
		dir,
		depth,
		children,
		boneLengthMean: Float64Array.from(json.boneLengthMean),
		boneLengthStd: Float64Array.from(json.boneLengthStd),
		lengthStdFloor: json.lengthStdFloor,
		lengthZMax: json.lengthZMax,
		footJoints: Int32Array.from(json.footJoints),
	};
}

/** Rest layout (30x3, root at the origin) from 29 bone lengths in metres; the mean lengths when none are given. */
export function restLayout(sk, lengths = sk.boneLengthMean, out = new Float64Array(3 * JOINT_COUNT)) {
	out[0] = out[1] = out[2] = 0;
	for (let j = 1; j < JOINT_COUNT; j += 1) {
		const q = sk.parents[j], len = lengths[j - 1];
		for (let a = 0; a < 3; a += 1) out[3 * j + a] = out[3 * q + a] + sk.dir[3 * j + a] * len;
	}
	return out;
}

/**
 * Forward kinematics: locals L[30*9], root[3] (offset `ro`), rest[30*3] -> globals G[30*9], positions
 * P[30*3]. The offset to joint j is turned by its parent's global rotation.
 */
export function fk(sk, L, root, rest, G, P, ro = 0) {
	G.set(L.subarray(0, 9), 0);
	P[0] = root[ro]; P[1] = root[ro + 1]; P[2] = root[ro + 2];
	const off = fkScratch;
	for (let j = 1; j < JOINT_COUNT; j += 1) {
		const q = sk.parents[j];
		mul(G, 9 * j, G, 9 * q, L, 9 * j);
		off[0] = rest[3 * j] - rest[3 * q]; off[1] = rest[3 * j + 1] - rest[3 * q + 1]; off[2] = rest[3 * j + 2] - rest[3 * q + 2];
		mulVec(off, 0, G, 9 * q, off, 0);
		P[3 * j] = P[3 * q] + off[0]; P[3 * j + 1] = P[3 * q + 1] + off[1]; P[3 * j + 2] = P[3 * q + 2] + off[2];
	}
}
const fkScratch = new Float64Array(3);

/** Empty arrays for one pose: locals, globals, joint positions and root. */
export function poseBuffers() {
	return { L: new Float64Array(9 * JOINT_COUNT), G: new Float64Array(9 * JOINT_COUNT), P: new Float64Array(3 * JOINT_COUNT), root: new Float64Array(3) };
}
