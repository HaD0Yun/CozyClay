// Turning the network's answer into a pose (locals, root and joint positions around the handle centroid), and the
// finished pose back into the caller's world frame.
import { decode6d, to6d } from "./mat3.js";
import { JOINT_COUNT, fk, poseBuffers } from "./skeleton.js";

/** `draft[90]`, `rot6d[180]` (any numeric arrays) and a rest layout -> `{ L, G, P, root }` (Float64Array). */
export function decodePose(sk, draft, rot6d, rest) {
	const pose = poseBuffers();
	for (let j = 0; j < JOINT_COUNT; j += 1) decode6d(pose.L, 9 * j, rot6d, 6 * j);
	pose.root[0] = draft[0]; pose.root[1] = draft[1]; pose.root[2] = draft[2];
	fk(sk, pose.L, pose.root, rest, pose.G, pose.P);
	return pose;
}

/**
 * World output: joints `P + c` raised by the floor shift, the root likewise, global rotations as 6D, plus two checks:
 * `errAfterCm` (weighted position error, denominator floor 1e-6) and `belowFloorCm` (centred floor y = 0).
 */
export function outputPose(pose, centroid, shift, rows) {
	const joints = new Float64Array(3 * JOINT_COUNT), rot6dGlobal = new Float64Array(6 * JOINT_COUNT);
	let lowest = Infinity;
	for (let j = 0; j < JOINT_COUNT; j += 1) {
		joints[3 * j] = pose.P[3 * j] + centroid[0];
		joints[3 * j + 1] = pose.P[3 * j + 1] + shift;
		joints[3 * j + 2] = pose.P[3 * j + 2] + centroid[2];
		lowest = Math.min(lowest, pose.P[3 * j + 1]);
		to6d(rot6dGlobal, 6 * j, pose.G, 9 * j);
	}
	const root = [pose.root[0] + centroid[0], pose.root[1] + shift, pose.root[2] + centroid[2]];
	let num = 0, den = 0;
	for (const row of rows) {
		if (row.type !== 0) continue;
		const w = 1 / Math.max(row.tol, 1e-3), j = row.joint;
		num += w * Math.hypot(pose.P[3 * j] - row.target[0], pose.P[3 * j + 1] - row.target[1], pose.P[3 * j + 2] - row.target[2]);
		den += w;
	}
	return { joints, root, rot6dGlobal, errAfterCm: (100 * num) / Math.max(den, 1e-6), belowFloorCm: 100 * Math.min(0, lowest) };
}
