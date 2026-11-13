// Whole-pose actions of the Auto Pose tool over plain data: flip left and right, copy and paste, and back to T-pose. Poses are the read-back shape of retarget.js readPose: skeleton-frame `{ L, G, P, root }`. Every
// action returns the bone transforms to write (retarget.js writePose's `bones`).
import { mul, mulTA, mulTB, mulTVec, mulVec, sub } from "../mat3.js";
import { quatOf, writePose } from "../retarget.js";
import { fk, poseBuffers, restLayout } from "../skeleton.js";

/** Joint index of each joint's twin: the `_l` / `_r` suffix swapped; centre joints are their own twin. */
export function twinTable(sk) {
	const swap = { l: "r", r: "l" };
	return sk.names.map((name, j) => {
		const side = /_([lr])$/.exec(name)?.[1], other = side ? `${name.slice(0, -1)}${swap[side]}` : null;
		return other && other in sk.index ? sk.index[other] : j;
	});
}

/** Locals from globals: L_j = G_parentᵀ G_j. */
function localsOf(sk, G) {
	const L = new Float64Array(9 * 30);
	L.set(G.subarray(0, 9), 0);
	for (let j = 1; j < 30; j += 1) mulTA(L, 9 * j, G, 9 * sk.parents[j], G, 9 * j);
	return L;
}

/** FK on the character's own (measured) lengths: locals + root -> `{ L, G, P, root }`. */
export function poseFromLocals(sk, rig, L, root) {
	const pose = poseBuffers();
	pose.L.set(L);
	pose.root.set(root);
	fk(sk, pose.L, pose.root, restLayout(sk, rig.measured), pose.G, pose.P);
	return pose;
}

/**
 * Flip left and right across the body's own side-to-side plane (normal: the hips' +X axis). Each joint takes its twin's
 * global rotation reflected in that plane and mirrored back into a proper rotation; the root stays. Returns the pose.
 */
export function flipPose(sk, rig, pose) {
	const twin = twinTable(sk), G = pose.G;
	const n = [G[0], G[3], G[6]], len = Math.hypot(n[0], n[1], n[2]) || 1;
	for (let a = 0; a < 3; a += 1) n[a] /= len;
	const S = new Float64Array(9);
	for (let r = 0; r < 3; r += 1) for (let c = 0; c < 3; c += 1) S[3 * r + c] = (r === c ? 1 : 0) - 2 * n[r] * n[c];
	const M = Float64Array.of(-1, 0, 0, 0, 1, 0, 0, 0, 1), flipped = new Float64Array(9 * 30), tmp = new Float64Array(9);
	for (let j = 0; j < 30; j += 1) {
		mul(tmp, 0, S, 0, G, 9 * twin[j]);
		mul(flipped, 9 * j, tmp, 0, M, 0);
	}
	return poseFromLocals(sk, rig, localsOf(sk, flipped), pose.root);
}

/** Rest height of the character's hips in the skeleton frame (metres), for pasting between characters. */
function hipsRestHeight(rig) {
	const head = rig.bones[rig.boneOf[0]].head;
	return mulVec([0, 0, 0], 0, rig.R, 0, head, 0)[1] * rig.s;
}

/** Copy: the 30 local rotations and the root, with where they came from. */
export function copyPose(rig, pose, source) {
	return { L: Float64Array.from(pose.L), root: Array.from(pose.root), source, hipsHeight: hipsRestHeight(rig) };
}

/**
 * Paste onto a character whose current pose is `current`. From another character the root is scaled by the
 * ratio of rest hips heights. `reversed` flips the pasted pose. `stayInPlace` (default on) keeps the current root
 * X and Z. `faceAsNow` (default off) turns the root about Y by the heading difference.
 */
export function pastePose(sk, rig, clip, current, { reversed = false, stayInPlace = true, faceAsNow = false, source = null } = {}) {
	const ratio = clip.source === source ? 1 : hipsRestHeight(rig) / (clip.hipsHeight || 1);
	const root = clip.root.map((v) => v * ratio), L = Float64Array.from(clip.L);
	if (stayInPlace) { root[0] = current.root[0]; root[2] = current.root[2]; }
	if (faceAsNow) {
		const heading = (G) => Math.atan2(G[2], G[8]), turn = heading(current.G) - heading(L);
		const c = Math.cos(turn), s = Math.sin(turn), Ry = Float64Array.of(c, 0, s, 0, 1, 0, -s, 0, c);
		mul(L, 0, Ry, 0, Float64Array.from(L.subarray(0, 9)), 0);
	}
	const pasted = poseFromLocals(sk, rig, L, root);
	return reversed ? flipPose(sk, rig, pasted) : pasted;
}

/**
 * Joints whose bones no IK key can store (the upper chest, Mixamo Spine2, and the toes) with their parent joint. A
 * release keys the pose, and playback then puts those bones back to what the take or the static pose says; so Auto
 * Pose holds them at that local rotation while it writes, and the pose on screen is the pose that gets keyed.
 */
export const HELD_JOINTS = Object.freeze([[3, 2], [25, 24], [29, 28]]);

/**
 * Globals `G` (skeleton frame, relative to rest) with each held joint turned so its bone's local rotation equals
 * `keep.get(joint)` (flat row-major 3x3, three.js parent-relative): `Rarm_j = Rarm_parent keep`, then
 * `G_j = R Rarm_j E_jᵀ Rᵀ` (the inverse of how writing turns globals into bone rotations). Other joints keep theirs.
 */
export function holdUnkeyed(rig, G, keep) {
	const out = Float64Array.from(G), t1 = new Float64Array(9), t2 = new Float64Array(9), arm = new Float64Array(9);
	for (const [j, p] of HELD_JOINTS) {
		const local = keep?.get(j), bj = rig.boneOf[j], bp = rig.boneOf[p];
		if (!local || !rig.written[j] || !rig.written[p] || rig.bones[bj]?.parent !== bp) continue;
		mulTA(t1, 0, rig.R, 0, out, 9 * p);
		mul(t2, 0, t1, 0, rig.R, 0);
		mul(arm, 0, t2, 0, rig.E, 9 * p); // Rarm_parent
		mul(t1, 0, arm, 0, local, 0); // Rarm_j
		mul(t2, 0, rig.R, 0, t1, 0);
		mulTB(t1, 0, t2, 0, rig.E, 9 * j);
		mulTB(out, 9 * j, t1, 0, rig.R, 0);
	}
	return out;
}

/** Bone transforms that put a pose on the character (no limb fit, no held handles), held joints kept. */
export function bonesForPose(rig, pose, keep = null) {
	return writePose(rig, { joints: pose.P, G: keep ? holdUnkeyed(rig, pose.G, keep) : pose.G }, []).bones;
}

/**
 * Back to T-pose: every written bone, and the bones held between them, back to its rest local transform. The
 * held joints' bones (see HELD_JOINTS) are left out with `skipHeld`, so they keep what playback gives them.
 */
export function restBones(rig, { skipHeld = false } = {}) {
	const held = new Set(skipHeld ? HELD_JOINTS.map(([j]) => rig.boneOf[j]) : []);
	const own = new Set([...rig.boneOf.filter((b, j) => b >= 0 && rig.written[j] && !held.has(b)), ...rig.between]);
	return [...own].sort((a, b) => a - b).map((b) => {
		const bone = rig.bones[b], parent = bone.parent >= 0 ? rig.bones[bone.parent] : null;
		const R = parent ? mulTA(new Float64Array(9), 0, parent.rest, 0, bone.rest, 0) : Float64Array.from(bone.rest);
		const t = parent ? mulTVec([0, 0, 0], 0, parent.rest, 0, sub(bone.head, parent.head), 0) : [...bone.head];
		return { name: bone.name, quaternion: quatOf(R), position: t };
	});
}
