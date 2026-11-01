import * as THREE from "three";
import { normalizeBoneName, POSE_BONES, DEFAULT_POSE } from "../poses.js";
import { resolveFingers } from "./fingers.js";
import { findBone } from "./find-bone.js";
export { findBone };

/**
 * Frame-based IK layer for direct character posing, following the DCC
 * standard (Blender / Maya / Cascadeur):
 *
 * - Non-destructive: enabling IK never changes the pose. Only a chain the
 *   user actually drags is ever solved; everything else keeps the FK pose.
 * - Manipulation solves: dragging a handle solves the limb backward
 *   (two-bone analytic IK) with BEND CONTINUITY — the elbow/knee keeps its
 *   current side of the bone line, so it never snaps mid-drag.
 * - Keys store FK LOCAL ROTATIONS of the solved chain bones (b0/b1), not
 *   effector targets — Cascadeur's "FK keyframe". Interpolation is plain
 *   quaternion slerp between keys, no re-solve at playback. Because the
 *   stored values are local, a moved or rotated character needs no
 *   re-anchoring at all.
 */

/** Contact radii measured from the bind-pose skinned mesh. The limb/head
 * entries drive floor contact; the Arm/UpLeg/Spine/Neck entries exist so
 * fix-collisions.js can build per-segment capsules from the same measured
 * radii instead of guessing body thickness. */
const CONTACT_JOINTS = [
	"LeftHand", "RightHand", "LeftFoot", "RightFoot",
	"LeftForeArm", "RightForeArm", "LeftLeg", "RightLeg", "Hips", "Head",
	"LeftArm", "RightArm", "LeftUpLeg", "RightUpLeg", "Spine", "Neck",
];
const CONTACT_RADIUS_MIN = 0.01;
const CONTACT_RADIUS_MAX = 0.25;
const CONTACT_RADIUS_FALLBACK = 0.01;
const CONTACT_HEIGHT_MAX = 0.25;
const contactRadiusCache = new WeakMap();
const contactHeightCache = new WeakMap();
// Normalised once: the per-vertex loops below used to re-run the
// normalizeBoneName regex 16 times per vertex, which was most of the cost of
// measuring a rig (#413).
const CONTACT_TARGETS = CONTACT_JOINTS.map((name) => [name, normalizeBoneName(`mixamorig${name}`)]);
const contactJointFor = (normalized) => {
	if (!normalized) return undefined;
	for (const [name, target] of CONTACT_TARGETS) {
		if (normalized === target || normalized.endsWith(target) || target.endsWith(normalized)) return name;
	}
	return undefined;
};

/** Copy one rig's measured contact radii/heights onto another rig that shares
 * its bind pose (a skeleton clone). The measurement reads bind-pose geometry
 * only, so the numbers are identical and re-scanning every skinned vertex per
 * clone is pure waste: studioBounds clones the rig per query (#413). */
export function shareContactMeasurements(from, to) {
	if (!from || !to || from === to) return;
	const radii = contactRadiusCache.get(from);
	const heights = contactHeightCache.get(from);
	if (radii && !contactRadiusCache.has(to)) contactRadiusCache.set(to, radii);
	if (heights && !contactHeightCache.has(to)) contactHeightCache.set(to, heights);
}

function pointSegmentDistance(point, start, end) {
	const segment = end.clone().sub(start);
	const lengthSq = segment.lengthSq();
	if (lengthSq < 1e-12) return point.distanceTo(start);
	const t = Math.max(0, Math.min(1, point.clone().sub(start).dot(segment) / lengthSq));
	return point.distanceTo(start.clone().addScaledVector(segment, t));
}

/*
 * `rig.userData.poseBind` (primed by primeBindPose at clone time) is the only
 * record of the UNTOUCHED skeleton once a clip is playing: ARDY playback writes
 * per-bone translations AND rotations every frame, so "where is this bone"
 * answered off the live matrices is a question about frame 137, not about the
 * rig. Anything that must be pose-INVARIANT — measured capsule radii, the
 * bind-relative collision calibration in fix-collisions.js — reads its
 * endpoints through here instead.
 */

const bindPosition = new THREE.Vector3();
const bindQuaternion = new THREE.Quaternion();

/** True when the rig carries a bind snapshot worth reading. */
export function hasBindPose(rig) {
	return Boolean(rig?.userData?.poseBind?.size);
}

/** One node's LOCAL matrix in the bind pose, optionally pre-multiplied by a
 * pose delta (see restLocalMatrix). Falls back to the node's current local
 * transform for anything the snapshot does not cover (the mesh nodes, and every
 * bone on a rig that was never primed). */
function bindLocalMatrix(rig, node, out, delta = null) {
	const saved = node.isBone ? rig.userData?.poseBind?.get(node) : null;
	if (saved) {
		bindPosition.set(saved.position?.x ?? 0, saved.position?.y ?? 0, saved.position?.z ?? 0);
		bindQuaternion.set(saved.x, saved.y, saved.z, saved.w);
	} else {
		bindPosition.copy(node.position);
		bindQuaternion.copy(node.quaternion);
	}
	if (delta) bindQuaternion.premultiply(delta);
	return out.compose(bindPosition, bindQuaternion, node.scale);
}

/*
 * The bind pose is a T-pose; the pose a character actually STANDS in is
 * DEFAULT_POSE — "arms hanging naturally at their sides" — which poses.js
 * applies as Euler deltas PRE-multiplied onto each bind local rotation. The two
 * are 25 cm apart at the forearm, so anything that reasons about "the pose this
 * character is legitimately in, with nothing wrong" (fix-collisions' proxy
 * calibration) must ask for the rest pose, not the bind pose.
 *
 * REST_BONES is not that pose: it is every joint at [0, 0, 0], i.e. the bind
 * pose itself. It exists to RESET joints before a pose is layered on top, and
 * calibrating against it would be calibrating against bind all over again.
 */

const restDeltaCache = new WeakMap();
const restEuler = new THREE.Euler();

/** Mirrors poses.js's boneMatches: normalised equality or either-direction
 * suffix, so `mixamorig:LeftArm`, `mixamorigLeftArm` and `LeftArm` all match. */
function boneMatchesJoint(normalized, target) {
	return normalized === target || normalized.endsWith(target) || target.endsWith(normalized);
}

function isDescendantOfAny(bone, ancestors) {
	for (let node = bone.parent; node; node = node.parent) if (ancestors.includes(node)) return true;
	return false;
}

/**
 * Bone → DEFAULT_POSE rotation delta, for the handful of joints the rest pose
 * actually moves. Built once per rig.
 *
 * This reproduces applyPose's own selection rules rather than approximating
 * them: the Euler triple is read XYZ, and where a Mixamo FBX nests an identity
 * copy of a bone underneath its control bone, only the outermost match takes
 * the delta — rotating both would double the arm angle.
 */
function restDeltas(rig) {
	const cached = restDeltaCache.get(rig);
	if (cached) return cached;
	// No bind snapshot, no rest pose: the deltas are defined as a rotation FROM
	// bind, and without one the current locals are the only thing to read — so
	// composing on top of them would layer the rest pose onto whatever pose the
	// rig is already in. Fall through to the current pose, as bindWorldPosition
	// does for exactly the same reason.
	if (!hasBindPose(rig)) {
		const none = new Map();
		restDeltaCache.set(rig, none);
		return none;
	}
	const matchesByJoint = new Map();
	rig.traverse((node) => {
		if (!node.isBone) return;
		const normalized = normalizeBoneName(node.name);
		for (const entry of POSE_BONES) {
			if (!boneMatchesJoint(normalized, normalizeBoneName(entry.bone))) continue;
			let list = matchesByJoint.get(entry.id);
			if (!list) matchesByJoint.set(entry.id, (list = []));
			list.push(node);
		}
	});
	const deltas = new Map();
	for (const entry of POSE_BONES) {
		const value = DEFAULT_POSE.bones?.[entry.id];
		if (!Array.isArray(value) || value.length < 3) continue;
		if (!value[0] && !value[1] && !value[2]) continue; // a zero delta IS bind
		const list = matchesByJoint.get(entry.id);
		if (!list) continue;
		const rotated = [];
		for (const bone of list) {
			if (rotated.length && isDescendantOfAny(bone, rotated)) continue;
			rotated.push(bone);
			restEuler.set(value[0], value[1], value[2], "XYZ");
			deltas.set(bone, new THREE.Quaternion().setFromEuler(restEuler));
		}
	}
	restDeltaCache.set(rig, deltas);
	return deltas;
}

function restLocalMatrix(rig, node, out) {
	return bindLocalMatrix(rig, node, out, restDeltas(rig).get(node) ?? null);
}

/** Compose a node's world position from per-node LOCAL matrices, root-downward.
 * Falls back to the node's current world position when it is not a descendant
 * of `rig`. `rig.matrixWorld` must be current — every caller updates it first. */
function composedWorldPosition(rig, node, localOf, out) {
	if (!rig || !node) return null;
	const path = [];
	let cursor = node;
	while (cursor && cursor !== rig) {
		path.push(cursor);
		cursor = cursor.parent;
	}
	if (cursor !== rig) return node.getWorldPosition(out);
	const world = new THREE.Matrix4().copy(rig.matrixWorld);
	const local = new THREE.Matrix4();
	for (let index = path.length - 1; index >= 0; index -= 1) world.multiply(localOf(rig, path[index], local));
	return out.setFromMatrixPosition(world);
}

/** World position a node would have in the rig's BIND (T-) pose. */
export function bindWorldPosition(rig, node, out = new THREE.Vector3()) {
	return composedWorldPosition(rig, node, bindLocalMatrix, out);
}

/** World position a node would have in the rig's REST pose — the bind pose with
 * DEFAULT_POSE composed on, which is what a character actually stands in. */
export function restWorldPosition(rig, node, out = new THREE.Vector3()) {
	return composedWorldPosition(rig, node, restLocalMatrix, out);
}

/**
 * Bind-pose world position of one vertex of a skinned mesh.
 *
 * `geometry.attributes.position` holds the vertices as authored — the bind
 * pose, before any skinning — so the mesh's own world matrix is the whole
 * transform (in the bind pose the skinning matrix is the identity by
 * construction). This is deliberately NOT getVertexPosition, which applies the
 * CURRENT skin matrices and therefore answers a question about the frame the
 * rig happens to be posed at.
 */
function bindVertexPosition(mesh, index, out) {
	out.fromBufferAttribute(mesh.geometry.attributes.position, index);
	return mesh.localToWorld(out);
}

/** Measure each contact joint's capsule radius from dominant (>0.4) bind-pose
 * skin weights. The result is cached on the character object.
 *
 * Both sides of the measurement — segment endpoints and vertices — are read in
 * the SAME pose, or the numbers are meaningless: a bind segment against a posed
 * vertex inflates every rotated limb to the radius clamp. With a primed bind
 * snapshot both come from the bind pose, so the answer no longer depends on
 * which frame happened to be on screen when the first call landed (positional
 * skinning rewrites child translations per frame; a mid-clip first call used to
 * inflate a shortened child's radius by most of a factor). Without a snapshot
 * both come from the current pose, which is what this did before and is still
 * exact at rest. */
export function measureContactRadii(rig) {
	if (!rig) return {};
	const cached = contactRadiusCache.get(rig);
	if (cached) return cached;
	rig.updateMatrixWorld(true);
	const bindPose = hasBindPose(rig);
	const segments = new Map();
	for (const name of CONTACT_JOINTS) {
		const bone = findBone(rig, `mixamorig${name}`);
		if (!bone) continue;
		const start = bindPose ? bindWorldPosition(rig, bone) : bone.getWorldPosition(new THREE.Vector3());
		const child = (name === "Hips" || name === "Head") ? null : bone.children.find((node) => node.isBone);
		const end = child
			? (bindPose ? bindWorldPosition(rig, child) : child.getWorldPosition(new THREE.Vector3()))
			: start.clone();
		segments.set(name, [start, end]);
	}
	// Distances are collected PER MESH: Mixamo-style exports often carry a
	// body mesh plus a joint-sphere debug mesh (Alpha_Surface/Alpha_Joints),
	// and the joint balls inflate every radius to the clamp. The final radius
	// is the MIN of each mesh's 90th percentile — the tightest fit that every
	// mesh agrees on, so fat debug geometry can never fatten the capsules.
	const perMeshDistances = [];
	rig.traverse((mesh) => {
		if (!mesh.isSkinnedMesh || !mesh.skeleton || !mesh.geometry?.attributes?.position) return;
		const indices = mesh.geometry.attributes.skinIndex;
		const weights = mesh.geometry.attributes.skinWeight;
		if (!indices || !weights) return;
		const distances = new Map(CONTACT_JOINTS.map((name) => [name, []]));
		const names = mesh.skeleton.bones.map((bone) => normalizeBoneName(bone.name));
		const vertex = new THREE.Vector3();
		for (let index = 0; index < indices.count; index += 1) {
			let dominant = -1;
			let dominantWeight = 0;
			for (let slot = 0; slot < 4; slot += 1) {
				const weight = weights.getComponent(index, slot);
				if (weight > dominantWeight) {
					dominantWeight = weight;
					dominant = indices.getComponent(index, slot);
				}
			}
			if (dominantWeight <= 0.4) continue;
			const name = contactJointFor(names[dominant]);
			const segment = segments.get(name);
			if (!segment) continue;
			if (bindPose) bindVertexPosition(mesh, index, vertex);
			else { mesh.getVertexPosition(index, vertex); mesh.localToWorld(vertex); }
			distances.get(name).push(pointSegmentDistance(vertex, segment[0], segment[1]));
		}
		perMeshDistances.push(distances);
	});
	// 90th-percentile per mesh, NOT the max: stray weights and props put a
	// few vertices far outside the limb and a max clamps every joint to
	// CONTACT_RADIUS_MAX, fat enough to flag permanent false contacts.
	const radii = {};
	for (const name of CONTACT_JOINTS) {
		let radius = CONTACT_RADIUS_FALLBACK;
		for (const distances of perMeshDistances) {
			const samples = distances.get(name);
			if (!samples.length) continue;
			samples.sort((a, b) => a - b);
			const p90 = samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.9))];
			radius = radius === CONTACT_RADIUS_FALLBACK ? p90 : Math.min(radius, p90);
		}
		radii[name] = Math.max(CONTACT_RADIUS_MIN, Math.min(CONTACT_RADIUS_MAX, radius));
	}
	const result = Object.freeze(radii);
	contactRadiusCache.set(rig, result);
	return result;
}

/** Measure the vertical amount of mesh below each contact bone in the bind
 * pose. Unlike a capsule radius this is the exact quantity needed when a
 * handle is dragged straight down: the bone can reach floorY + height while
 * the weighted mesh rests on the floor.
 *
 * Bone points and vertices are read in the same pose, for the same reason
 * measureContactRadii does: this is cached forever off whichever frame called
 * first, so it must not be able to depend on that frame. */
function measureContactHeights(rig) {
	if (!rig) return {};
	const cached = contactHeightCache.get(rig);
	if (cached) return cached;
	rig.updateMatrixWorld(true);
	const bindPose = hasBindPose(rig);
	const points = new Map();
	for (const name of CONTACT_JOINTS) {
		const bone = findBone(rig, `mixamorig${name}`);
		if (bone) points.set(name, bindPose ? bindWorldPosition(rig, bone) : bone.getWorldPosition(new THREE.Vector3()));
	}
	const drops = new Map(CONTACT_JOINTS.map((name) => [name, 0]));
	rig.traverse((mesh) => {
		if (!mesh.isSkinnedMesh || !mesh.skeleton || !mesh.geometry?.attributes?.position) return;
		const indices = mesh.geometry.attributes.skinIndex;
		const weights = mesh.geometry.attributes.skinWeight;
		if (!indices || !weights) return;
		const names = mesh.skeleton.bones.map((bone) => normalizeBoneName(bone.name));
		const vertex = new THREE.Vector3();
		for (let index = 0; index < indices.count; index += 1) {
			let dominant = -1;
			let dominantWeight = 0;
			for (let slot = 0; slot < 4; slot += 1) {
				const weight = weights.getComponent(index, slot);
				if (weight > dominantWeight) { dominantWeight = weight; dominant = indices.getComponent(index, slot); }
			}
			if (dominantWeight <= 0.4 || !names[dominant]) continue;
			const name = contactJointFor(names[dominant]);
			const point = points.get(name);
			if (!point) continue;
			if (bindPose) bindVertexPosition(mesh, index, vertex);
			else { mesh.getVertexPosition(index, vertex); mesh.localToWorld(vertex); }
			drops.set(name, Math.max(drops.get(name), point.y - vertex.y));
		}
	});
	const heights = {};
	for (const name of CONTACT_JOINTS) {
		heights[name] = Math.max(CONTACT_RADIUS_MIN, Math.min(CONTACT_HEIGHT_MAX, drops.get(name) || CONTACT_RADIUS_FALLBACK));
	}
	const result = Object.freeze(heights);
	contactHeightCache.set(rig, result);
	return result;
}

export const IK_TRACKS = [
	{ id: "leftHand", label: "Left Hand", kind: "arm", side: "Left", visibilityDepth: 0.14 },
	{ id: "rightHand", label: "Right Hand", kind: "arm", side: "Right", visibilityDepth: 0.14 },
	{ id: "leftFoot", label: "Left Foot", kind: "leg", side: "Left", visibilityDepth: 0.14 },
	{ id: "rightFoot", label: "Right Foot", kind: "leg", side: "Right", visibilityDepth: 0.14 },
];

/** Mid-joint position handles: dragging repositions the elbow/knee with
 * BOTH ends pinned (shoulder+wrist / hip+ankle) — the classic mid-chain
 * handle. `chain` links to the IK chain whose bones it edits. */
export const MID_TRACKS = [
	{ id: "leftElbow", label: "Left Elbow", chain: "leftHand", visibilityDepth: 0.12 },
	{ id: "rightElbow", label: "Right Elbow", chain: "rightHand", visibilityDepth: 0.12 },
	{ id: "leftKnee", label: "Left Knee", chain: "leftFoot", visibilityDepth: 0.12 },
	{ id: "rightKnee", label: "Right Knee", chain: "rightFoot", visibilityDepth: 0.12 },
];

/** FK swing handles: dragging swings the part toward the pointer (rotation
 * only, around the joint itself). `child` gives the bone that defines the
 * swing direction; null means use the bone's own +Y (Mixamo head). Colours
 * follow the FK PoseHandles coding: torso yellow, head purple, arms orange,
 * legs blue. */
export const FK_TRACKS = [
	{ id: "hips", label: "Hips", bone: "mixamorigHips", child: "mixamorigSpine", color: "#ffd23d", group: "torso", visibilityDepth: 0.34 },
	{ id: "spine", label: "Spine", bone: "mixamorigSpine", child: "mixamorigSpine1", color: "#ffd23d", group: "torso", visibilityDepth: 0.32 },
	{ id: "chest", label: "Chest", bone: "mixamorigSpine1", child: "mixamorigSpine2", color: "#ffd23d", group: "torso", visibilityDepth: 0.3 },
	{ id: "neck", label: "Neck", bone: "mixamorigNeck", child: "mixamorigHead", color: "#b98cff", group: "head", visibilityDepth: 0.2 },
	{ id: "head", label: "Head", bone: "mixamorigHead", child: null, color: "#b98cff", group: "head", visibilityDepth: 0.24 },
	{ id: "leftShoulder", label: "Left Shoulder", bone: "mixamorigLeftShoulder", child: "mixamorigLeftArm", color: "#ff8a3d", group: "shoulder", visibilityDepth: 0.2 },
	{ id: "rightShoulder", label: "Right Shoulder", bone: "mixamorigRightShoulder", child: "mixamorigRightArm", color: "#ff8a3d", group: "shoulder", visibilityDepth: 0.2 },
];

/** Whether a control centre is close enough to the first visible surface.
 * Centreline controls (torso/head) intentionally have larger allowances than
 * side-specific limbs, so front-facing body controls remain available while
 * the far shoulder/arm/leg is rejected. */
export function ikControlIsExposed(targetDistance, blockerDistance, visibilityDepth) {
	if (!Number.isFinite(targetDistance) || targetDistance <= 0) return false;
	if (!Number.isFinite(blockerDistance)) return true;
	return targetDistance - blockerDistance <= visibilityDepth;
}

/** Bone chains per handle, root → effector. Mixamo spelling; the matcher
 * accepts the `mixamorig:` prefix and prefix-less rigs. Shoulder stays out of
 * the arm chain — clavicle rotation swings the whole shoulder mass and reads
 * wrong for a blocking tool. */
const CHAINS = {
	arm: (side) => [`mixamorig${side}Arm`, `mixamorig${side}ForeArm`, `mixamorig${side}Hand`],
	leg: (side) => [`mixamorig${side}UpLeg`, `mixamorig${side}Leg`, `mixamorig${side}Foot`],
};


/**
 * Resolve the IK rig against a character: the four two-bone chains, plus
 * the FK swing joints. Returns null when any chain is short a bone — the
 * caller then hides IK mode entirely rather than half-posing. Captures
 * per-chain segment lengths and a character-local POLE used ONLY as the
 * bend hint when the chain is perfectly straight. Elbows bend backward-
 * down, knees forward-down.
 */
export function resolveIkRig(rig) {
	if (!rig) return null;
	rig.updateMatrixWorld(true);
	// Character facing, from the toes: the toe sticks out of the foot in the
	// facing direction at any upright pose. Falls back to the group's +Z.
	const charQ = rig.quaternion;
	let forward = null;
	for (const side of ["Left", "Right"]) {
		const foot = findBone(rig, `mixamorig${side}Foot`);
		const toe = findBone(rig, `mixamorig${side}ToeBase`);
		if (foot && toe) {
			const f = foot.getWorldPosition(new THREE.Vector3());
			const t = toe.getWorldPosition(new THREE.Vector3());
			if (f.distanceTo(t) > 1e-6) {
				forward = t.sub(f).normalize();
				break;
			}
		}
	}
	if (!forward) forward = new THREE.Vector3(0, 0, 1).applyQuaternion(charQ);
	const invCharQ = charQ.clone().invert();
	const armPoleLocal = forward.clone().multiplyScalar(-1).add(new THREE.Vector3(0, -0.5, 0)).normalize().applyQuaternion(invCharQ);
	const legPoleLocal = forward.clone().add(new THREE.Vector3(0, -0.2, 0)).normalize().applyQuaternion(invCharQ);

	const contactRadii = measureContactRadii(rig);
	const out = new Map();
	const rootPos = new THREE.Vector3();
	const childPos = new THREE.Vector3();
	for (const track of IK_TRACKS) {
		const names = CHAINS[track.kind](track.side);
		const bones = names.map((n) => findBone(rig, n));
		if (bones.some((b) => !b)) return null;
		const lengths = [];
		for (let i = 0; i < bones.length - 1; i += 1) {
			bones[i].getWorldPosition(rootPos);
			bones[i + 1].getWorldPosition(childPos);
			const len = rootPos.distanceTo(childPos);
			if (len < 1e-6) return null;
			lengths.push(len);
		}
		out.set(track.id, {
			track,
			bones,
			contactRadii,
			contactHeights: measureContactHeights(rig),
			bindPositions: bones.map((bone) => {
				const saved = rig.userData?.poseBind?.get(bone)?.position;
				return saved
					? new THREE.Vector3(saved.x, saved.y, saved.z)
					: bone.position.clone();
			}),
			lengths,
			poleLocal: track.kind === "arm" ? armPoleLocal : legPoleLocal,
			rig,
		});
	}
	// FK swing joints: bone + the child that defines the swing direction. The
	// hips also carries its bind LOCAL position — the body root control
	// (height/lean translation for crouching and lying poses) works in
	// parent-local space, and keys must restore the exact bind spot.
	const fkJoints = new Map();
	for (const track of FK_TRACKS) {
		const bone = findBone(rig, track.bone);
		if (!bone) return null;
		const child = track.child ? findBone(rig, track.child) : null;
		fkJoints.set(track.id, {
			track,
			bone,
			child,
			bindPos: (() => {
				const saved = rig.userData?.poseBind?.get(bone)?.position;
				return saved
					? new THREE.Vector3(saved.x, saved.y, saved.z)
					: bone.position.clone();
			})(),
		});
	}
	return { chains: out, fkJoints, fingers: resolveFingers(rig, fkJoints), contactRadii, contactHeights: measureContactHeights(rig) };
}

/**
 * Two-bone analytic IK for one 3-bone chain (shoulder/hip → elbow/knee →
 * wrist/ankle). `target` is a world-space effector position. The root bone
 * is pinned; the elbow/knee is placed exactly by the law of cosines, so the
 * effector ALWAYS reaches a reachable target in one step.
 *
 * BEND CONTINUITY (the elbow-flip rule): the hinge direction follows the
 * elbow's CURRENT offset from the root→target line whenever one exists, so
 * a dragged limb keeps its own side and never mirror-flips when the target
 * crosses the bone line. Only a perfectly straight chain (no offset to
 * continue) falls back to the character-local pole hint.
 *
 * `maxExtension` (tuned by `softening`, default 0.01) optionally caps the
 * root→effector reach with a soft clamp: past the cap the effector approaches
 * it asymptotically and never exceeds it, so a locked foot cannot straighten
 * the leg past the extension the source pose actually had.
 *
 * `exactHinge` makes the one-step claim hold for a BENT chain too: without it
 * the continuity hinge keeps an along-line component and a solve from a bent
 * pose lands short of a reachable target, converging only over repeated calls.
 */
export function solveIk(chain, targetWorld, { maxExtension = null, softening = 0.01, exactHinge = false } = {}) {
	// Playback owns translations. Measure this frame's lengths rather than
	// resetting to bind, which turns a small target move into length compensation.
	const { bones, poleLocal, rig } = chain;
	const [b0, b1, b2] = bones;
	const p0 = b0.getWorldPosition(new THREE.Vector3());
	const p1cur = b1.getWorldPosition(new THREE.Vector3());
	const t = targetWorld.clone();
	const l0 = p0.distanceTo(p1cur);
	const l1 = p1cur.distanceTo(b2.getWorldPosition(new THREE.Vector3()));
	let d = p0.distanceTo(t);

	const dir = t.clone().sub(p0);
	if (dir.lengthSq() < 1e-12) {
		dir.copy(b2.getWorldPosition(new THREE.Vector3())).sub(p0);
		if (dir.lengthSq() < 1e-12) dir.set(0, -1, 0);
	}
	dir.normalize();

	// Clamp into the annulus [|l0-l1|, l0+l1] so the law of cosines is exact:
	// an unreachable target stretches straight at it, never overshoots.
	const maxD = l0 + l1 - 1e-6;
	const minD = Math.abs(l0 - l1) + 1e-6;
	if (d > maxD) {
		d = maxD;
		t.copy(p0).addScaledVector(dir, d);
	} else if (d < minD) {
		d = minD;
		t.copy(p0).addScaledVector(dir, d);
	}

	// Soft maximum-extension clamp (Holden's TwoBoneInverseKinematics): IK is a
	// minimal modification of the source pose, so a foot locked against floor
	// sliding must not be allowed to straighten the leg PAST the extension that
	// pose had — clamping hard instead of softly would snap the reach at the
	// cap frame-over-frame, where the exponential saturation eases toward it.
	if (Number.isFinite(maxExtension) && maxExtension > 0) {
		const cap = Math.min(maxD, maxExtension);
		if (cap - softening < minD) {
			// No room for the soft curve inside the annulus: fall back to a hard
			// clamp rather than feed the law of cosines a d below minD.
			d = Math.min(d, cap);
			t.copy(p0).addScaledVector(dir, d);
		} else if (d > cap - softening) {
			const saturation = 1 - Math.exp(-Math.max(d - cap + softening, 0) / softening);
			d = cap - softening + softening * saturation;
			t.copy(p0).addScaledVector(dir, d);
		}
	}

	// Law of cosines: the elbow sits at p0 + dir·proj + bend·off.
	const cosA = Math.max(-1, Math.min(1, (l0 * l0 + d * d - l1 * l1) / (2 * l0 * d)));
	const proj = l0 * cosA;
	const off = Math.sqrt(Math.max(0, l0 * l0 - proj * proj));

	const linePoint = p0.clone().addScaledVector(dir, proj);
	// Is the chain currently BENT? Only a bent chain has an elbow side worth
	// continuing — a straight chain's offset from the new target line is an
	// artifact of the line direction, not a hinge, so it must not be reused.
	const seg0 = p1cur.clone().sub(p0).normalize();
	const seg1 = b2.getWorldPosition(new THREE.Vector3()).sub(p1cur).normalize();
	const isBent = seg0.dot(seg1) < 0.999;
	let bend;
	if (isBent) {
		// Legacy continuity: reuse the elbow's current offset from the NEW line.
		// fix-collisions and its fixtures are tuned on this result, but when the
		// line rotates past a near-straight elbow the offset changes sign and
		// the joint reverse-bends.
		bend = p1cur.clone().sub(linePoint);
		// exactHinge keeps the chain's CURRENT hinge axis a = norm(seg0 x seg1)
		// and bends in the plane it spans with dir: bend = dir x a, which is
		// perpendicular to dir, so p1 stays on the l0 sphere. The solved
		// thigh' x shin' = off*d*(a - dir(a.dir)), whose dot with a is
		// off*d*(1 - (a.dir)^2) >= 0, so the bend side cannot flip. When the
		// target lies along a, bend degenerates and the pole fallback runs.
		if (exactHinge) bend = dir.clone().cross(seg0.clone().cross(seg1).normalize());
	}
	if (!bend || bend.lengthSq() < 1e-8) {
		// Straight chain — no side to continue; use the pole hint.
		const poleWorld = poleLocal.clone().applyQuaternion(rig.quaternion);
		bend = poleWorld.clone().addScaledVector(dir, -poleWorld.dot(dir));
		if (bend.lengthSq() < 1e-8) {
			bend = new THREE.Vector3(0, 1, 0).addScaledVector(dir, -dir.y);
			if (bend.lengthSq() < 1e-8) bend = new THREE.Vector3(0, 0, 1).addScaledVector(dir, -dir.z);
		}
	}
	bend.normalize();

	const p1 = linePoint.clone().addScaledVector(bend, off);
	const p2 = p0.clone().addScaledVector(dir, d);
	aimChain(bones, [p0, p1, p2]);
}

/** Re-aim each bone so its bone→child direction points at the solved joint
 * positions. Only b0 and b1 rotate; the effector (b2) keeps its local
 * rotation, so the hand follows the forearm and the foot follows the shin —
 * the same convention for every limb. */
function aimChain(bones, points) {
	const qDeltaWorld = new THREE.Quaternion();
	const qWorld = new THREE.Quaternion();
	const qParentWorldInv = new THREE.Quaternion();
	const currentDir = new THREE.Vector3();
	const wantedDir = new THREE.Vector3();
	const bonePos = new THREE.Vector3();
	const childPos = new THREE.Vector3();
	for (let i = 0; i < bones.length - 1; i += 1) {
		const bone = bones[i];
		bone.updateMatrixWorld(true);
		bone.getWorldPosition(bonePos);
		bones[i + 1].getWorldPosition(childPos);
		currentDir.subVectors(childPos, bonePos);
		if (currentDir.lengthSq() < 1e-10) continue;
		currentDir.normalize();
		wantedDir.subVectors(points[i + 1], points[i]);
		if (wantedDir.lengthSq() < 1e-10) continue;
		wantedDir.normalize();
		qDeltaWorld.setFromUnitVectors(currentDir, wantedDir);
		// New world orientation = delta ⊗ current world, expressed in the
		// parent's frame: qLocal = qParentWorldInv ⊗ qDelta ⊗ qWorld. The
		// parent frame must be the parent's WORLD rotation — on a real Mixamo
		// rig the bind locals are NOT identity (shoulder aims down the arm),
		// and reading parent.quaternion alone drops the ancestors' rotation,
		// which folds the chain instead of aiming it. getWorldQuaternion is
		// safe here: the rig's cm scale is uniform, so decompose extracts a
		// clean rotation, and the parent's matrixWorld is fresh from the
		// previous iteration's updateMatrixWorld.
		bone.getWorldQuaternion(qWorld);
		bone.parent.getWorldQuaternion(qParentWorldInv).invert();
		bone.quaternion.copy(qParentWorldInv.multiply(qDeltaWorld).multiply(qWorld));
		bone.updateMatrixWorld(true);
	}
}

/**
 * Mid-joint drag: reposition the elbow/knee directly. The mid joint sits on
 * the sphere of radius l0 around the pinned root, so the dragged point is
 * clamped radially onto it; the forearm/shin KEEPS ITS CURRENT WORLD
 * DIRECTION and the effector follows (Cascadeur's grab-the-point model:
 * dragging a mid point bends the limb and the end comes along). This always
 * works — crucially on a STRAIGHT chain too, where both-ends-pinned
 * models (and Maya's pole plane) have zero elbow freedom and read as
 * "the elbow doesn't move". Segment lengths are preserved exactly.
 */

/** Clamp a dragged IK position to the floor marker for its effector or
 * mid-joint. Kept pure so the editor and deterministic tests share the rule. */
export function clampIkTargetToFloor(trackId, targetWorld, floorY = 0, contactHeights = null) {
	if (!targetWorld || !Number.isFinite(targetWorld.y)) return targetWorld;
	const key = trackId?.endsWith("Hand")
		? trackId.replace(/^(left|right)/, (_, side) => side[0].toUpperCase() + side.slice(1))
		: trackId?.endsWith("Foot")
			? trackId.replace(/^(left|right)/, (_, side) => side[0].toUpperCase() + side.slice(1))
			: trackId?.endsWith("Elbow")
			? `${trackId.startsWith("left") ? "Left" : "Right"}ForeArm`
			: trackId?.endsWith("Knee")
				? `${trackId.startsWith("left") ? "Left" : "Right"}Leg`
				: null;
	const height = contactHeights?.[key];
	if (!Number.isFinite(height)) return targetWorld;
	return targetWorld.clone().setY(Math.max(targetWorld.y, floorY + height));
}

/** Translate hips to an absolute drag target and keep the measured pelvis
 * extent on the safe side of the floor. The correction is applied in world Y
 * after the normal parent-space translation, so it also works on yawed rigs. */
export function solveHipsTranslateToFloor(joint, worldDelta, startLocalPos, floorY = 0, contactHeights = null) {
	solveHipsTranslate(joint, worldDelta, startLocalPos);
	const height = contactHeights?.Hips;
	if (!Number.isFinite(height)) return;
	const root = joint.bone;
	const y = root.getWorldPosition(new THREE.Vector3()).y;
	if (y >= floorY + height) return;
	const parent = root.parent;
	const localLift = new THREE.Vector3(0, floorY + height - y, 0)
		.applyQuaternion(parent.getWorldQuaternion(new THREE.Quaternion()).invert())
		.divideScalar(parent.getWorldScale(new THREE.Vector3()).x || 1);
	root.position.add(localLift);
	root.updateMatrixWorld(true);
}

export function solveMidJoint(chain, midTargetWorld) {
	const { bones } = chain;
	const [b0, b1, b2] = bones;
	const p0 = b0.getWorldPosition(new THREE.Vector3());
	const p1cur = b1.getWorldPosition(new THREE.Vector3());
	const p2cur = b2.getWorldPosition(new THREE.Vector3());
	// Mid joint at the drag point, clamped to the root sphere (|p0→p1| = l0).
	const dir = midTargetWorld.clone().sub(p0);
	if (dir.lengthSq() < 1e-12) dir.copy(p1cur).sub(p0);
	dir.normalize();
	const p1 = p0.clone().addScaledVector(dir, p0.distanceTo(p1cur));
	// Forearm keeps its current world direction; the wrist/ankle follows.
	const foreDir = p2cur.clone().sub(p1cur);
	if (foreDir.lengthSq() < 1e-12) foreDir.copy(dir);
	foreDir.normalize();
	const p2 = p1.clone().addScaledVector(foreDir, p1cur.distanceTo(p2cur));
	aimChain(bones, [p0, p1, p2]);
	return p1; // the clamped position the caller should snap the handle to
}

/**
 * FK swing drag as a TRACKBALL rotation (three.js TransformControls rotate
 * model): the drag layer supplies a world rotation axis (drag direction ×
 * the joint→camera eye) and an angle (offset · tangent × speed/camDist),
 * and the rotation applies ABSOLUTELY from the drag-start orientation, so
 * repeated pointer moves never compound. Sensitivity is normalised by the
 * camera distance, so every joint responds identically in screen space —
 * the fix for the old aim-at-pointer model, whose sensitivity swung with
 * each joint's child-bone length (hips lurching 1.6 m on a small drag).
 */
export function solveSwingAngle(joint, axisWorld, angleRad, startQuat, startParentQuat) {
	const { bone } = joint;
	if (!Number.isFinite(angleRad) || Math.abs(angleRad) < 1e-9) return;
	if (joint.track.id !== "hips" && joint.bindPos) bone.position.copy(joint.bindPos);
	const qDelta = new THREE.Quaternion().setFromAxisAngle(axisWorld.clone().normalize(), angleRad);
	const qWorldStart = startParentQuat.clone().multiply(startQuat);
	const qParentInv = startParentQuat.clone().invert();
	bone.quaternion.copy(qParentInv.multiply(qDelta).multiply(qWorldStart));
	bone.updateMatrixWorld(true);
}

/**
 * Effector swing: rotate a chain's end bone (the hand/foot) around its own
 * centre — the IK solve positions the wrist/ankle, this orients it. Same
 * absolute-from-drag-start trackball math as solveSwingAngle, but nothing
 * else moves: b0/b1 keep their solved pose, so the limb stays put while the
 * hand or foot tilts, twists and turns.
 */
export function solveEffectorSwing(chain, axisWorld, angleRad, startQuat, startParentQuat) {
	if (!Number.isFinite(angleRad) || Math.abs(angleRad) < 1e-9) return;
	const bone = chain.bones[2];
	const qDelta = new THREE.Quaternion().setFromAxisAngle(axisWorld.clone().normalize(), angleRad);
	const qWorldStart = startParentQuat.clone().multiply(startQuat);
	const qParentInv = startParentQuat.clone().invert();
	bone.quaternion.copy(qParentInv.multiply(qDelta).multiply(qWorldStart));
	bone.updateMatrixWorld(true);
}

/**
 * Body-root translate: set the hips bone's parent-local position to
 * `startLocalPos` plus a world delta (height for crouching/kneeling,
 * lean-shift for lying). Absolute from the drag start, so repeated pointer
 * moves never compound. The whole skeleton follows (legs, spine, arms are
 * children), so this is how flat-on-floor poses become possible at all —
 * the Character blocking (charA) is untouched. The world delta is converted
 * through the parent's yaw and its cm scale (Mixamo rigs are 100× in
 * bone-local units).
 */
export function solveHipsTranslate(joint, worldDelta, startLocalPos) {
	const { bone } = joint;
	const parentInv = bone.parent.getWorldQuaternion(new THREE.Quaternion()).invert();
	// Parent world scale (uniform on a Mixamo rig): world → parent-local
	const scale = bone.parent.getWorldScale(new THREE.Vector3()).x || 1;
	const local = worldDelta.clone().applyQuaternion(parentInv).divideScalar(scale);
	bone.position.copy(startLocalPos).add(local);
	bone.updateMatrixWorld(true);
}

/** Mutable per-rig IK layer state. `targets` are the live handle positions
 * (world space) the handles render at and the solver reaches for. `keys`
 * maps frame → Map(trackId → {q, p}) — FK LOCAL rotations of the solved
 * chain bones (+ hips local position), stored only for parts the user has
 * dragged. `plants` holds the captured ankle positions for foot snapping. */
export function createIkState() {
	// `chains`/`fkJoints` are cached from the owning rig's resolve so a stored
	// state can be EVALUATED while its character is not the active one (#77);
	// `rig` tags which rig instance they were built from, guarding against a
	// reloaded rig being driven through stale bone references.
	return { chains: null, fkJoints: null, rig: null, targets: new Map(), keys: new Map(), tracked: new Set(), plants: new Map() };
}

/** Mark a chain as user-dragged (focused). Only tracked chains are keyed or
 * evaluated — everything else stays on the pure FK pose. */
export function ikTouch(ikState, trackId) {
	ikState.tracked.add(trackId);
}

/** Initialise the live targets from the rig's CURRENT effector positions.
 * Runs when IK mode opens: handles appear exactly on the wrists/ankles and
 * nothing moves. */
export function ikSeedTargets(chains, ikState) {
	const pos = new THREE.Vector3();
	for (const [id, chain] of chains) {
		chain.bones[2].getWorldPosition(pos);
		ikState.targets.set(id, pos.clone());
	}
}

/** Snapshot the current local rotations of every chain and FK bone — plus
 * the hips' LOCAL POSITION (the body root's height/lean) — the pre-IK state
 * restored when IK mode closes. */
export function ikSnapshot(rig, fkJoints) {
	const out = new Map();
	for (const [id, chain] of rig) {
		out.set(id, { quats: chain.bones.map((b) => b.quaternion.clone()), pos: null });
	}
	if (fkJoints) {
		for (const [id, joint] of fkJoints) {
			out.set(id, {
				quats: [joint.bone.quaternion.clone()],
				pos: joint.bindPos ? joint.bone.position.clone() : null,
			});
		}
	}
	return out;
}

/** Restore a snapshot taken by ikSnapshot. */
export function ikRestore(rig, snapshot, fkJoints) {
	if (!snapshot) return;
	for (const [id, saved] of snapshot) {
		const chain = rig.get(id);
		if (chain) {
			chain.bones.forEach((b, i) => {
				if (saved.quats[i]) b.quaternion.copy(saved.quats[i]);
			});
			chain.bones[0].updateMatrixWorld(true);
			continue;
		}
		const joint = fkJoints?.get(id);
		if (joint) {
			if (saved.quats[0]) joint.bone.quaternion.copy(saved.quats[0]);
			if (saved.pos && joint.bindPos) joint.bone.position.copy(saved.pos);
			joint.bone.updateMatrixWorld(true);
		}
	}
}

/**
 * Bake the CURRENT local rotations into the key at `frame`: solved chain bones
 * (b0, b1, b2) for chains, the single bone for FK joints — and the hips' LOCAL
 * POSITION when the body root was moved. Entries are uniform
 * { q: [...quats], p: localPos | null, basePos? }. Local values are
 * character-position independent, so keys need no re-anchoring ever. New chain
 * keys keep clip translations. Absolute keys also capture chainP; delta keys
 * need it only when an earlier layer changed translations at this frame.
 *
 * `onlyIds` (Set or array) bakes EXACTLY those ids instead of the whole tracked
 * set, and touches them into `tracked` on the way. Without it a fix to a leg at
 * frame 40 also re-keys the hand the user dragged at frame 2 — and, run twice,
 * re-bakes the first run's own blend ramp as an authored pose, which is how a
 * 10 cm correction ratcheted to 55 cm. Every automated driver (fix-collisions,
 * auto-physics) therefore names what it actually moved; interactive bakes,
 * where "everything the user has touched" IS the intent, pass nothing and keep
 * the old behaviour exactly.
 *
 * `basePositions` (Map or object, id → Vector3-like) and `baseQuats` (Map or
 * object, id → array of Quaternion-like, one per chain bone) record the pose
 * the key was baked OVER — the CLIP's own local transform for that part at this
 * frame, before any solver or layer touched it. ikEvaluate then applies the key
 * as a DELTA on top of whatever the clip does (see its comment), instead of
 * blending toward this frame's absolute values on the frames either side.
 * Keys without them fall back to the absolute blend, so saved projects and
 * no-motion authoring are unaffected.
 *
 * `baseQuats` MUST be the raw clip's rotations — the pose ikEvaluate will find
 * on the bone before it writes, not the pose that happened to be on screen. The
 * two differ whenever an earlier key is already blending into this frame, and
 * only the raw one makes `clipCurrent ∘ (baseQ⁻¹ ∘ q)` collapse to `q` at the
 * keyed frame.
 */
export function ikBakeKeyframe(rig, ikState, frame, fkJoints, onlyIds = null, basePositions = null, baseQuats = null) {
	let entry = ikState.keys.get(frame);
	const ids = onlyIds ? [...onlyIds] : [...ikState.tracked];
	const read = (source, id) => (typeof source?.get === "function" ? source.get(id) : source?.[id]);
	const readBase = (id) => read(basePositions, id);
	for (const id of ids) {
		if (onlyIds) ikTouch(ikState, id);
		const chain = rig.get(id);
		const joint = fkJoints?.get(id);
		let q = null;
		let p = null;
		let basePos = null;
		let baseQ = null;
		if (chain) {
			q = [chain.bones[0].quaternion.clone(), chain.bones[1].quaternion.clone(), chain.bones[2].quaternion.clone()];
			const bases = read(baseQuats, id);
			if (Array.isArray(bases) && bases.length >= q.length && bases.every(Boolean)) {
				baseQ = bases.slice(0, q.length).map((b) => new THREE.Quaternion(b.x, b.y, b.z, b.w));
			}
		} else if (joint) {
			q = [joint.bone.quaternion.clone()];
			if (joint.bindPos) {
				p = joint.bone.position.clone();
				const base = readBase(id);
				if (base) {
					basePos = new THREE.Vector3(base.x, base.y, base.z);
					// A key with a base pose IS a translation delta over the clip, so
					// it has no business also pinning an absolute rotation: the two
					// claims contradict each other. Storing q here made every frame
					// inside the blend window inherit a share of the keyed frame's
					// hips ORIENTATION — grounded neighbours of a jump tilted by up
					// to 1.2 cm of foot drop that no caller ever asked for. Dropping
					// it makes the key say exactly what it means: move the root, leave
					// the performance alone.
					q = null;
				}
			}
		}
		if (!q && !p) continue;
		if (!entry) ikState.keys.set(frame, (entry = new Map()));
		const key = { q, p };
		if (chain) {
			const clip = chainClipPositions.get(chain);
			// A rotation-only correction must not freeze the keyed frame's bone
			// lengths onto its neighbours. Preserve explicit translations only
			// for absolute authoring or an edit over a translation-changing key.
			if (!baseQ || (clip?.frame === frame && chain.bones.some((bone, i) => !bone.position.equals(clip.positions[i])))) {
				key.chainP = chain.bones.map((bone) => bone.position.clone());
			}
			key.keepTranslations = true;
		}
		if (basePos) key.basePos = basePos;
		if (baseQ && q) key.baseQ = baseQ;
		entry.set(id, key);
	}
}

/** Drop the whole key at `frame`. */
export function ikRemoveKeyframe(ikState, frame) {
	ikState.keys.delete(frame);
}

/** The two leg chains that get planted. */
const LEG_IDS = ["leftFoot", "rightFoot"];

/** Capture the current ankle world positions as the plant points. Called
 * once when a body (hips) drag starts, BEFORE the hips move — the feet
 * then stay exactly here for the whole drag (Cascadeur's always-active
 * ankle controllers / UE's foot-pin, over the existing two-bone solver). */
export function ikPlantFeet(chains, ikState) {
	const pos = new THREE.Vector3();
	for (const id of LEG_IDS) {
		const chain = chains.get(id);
		if (!chain) continue;
		chain.bones[2].getWorldPosition(pos);
		ikState.plants.set(id, pos.clone());
	}
}

/** Re-solve each planted leg chain so its ankle returns to its plant point.
 * Runs after every hips transform while the body drag is active: the hips
 * move, the feet stay, the knees bend. Legs that cannot reach their plant
 * stretch toward it and the foot comes off — the natural reach limit. */
export function ikSolvePlantedFeet(chains, ikState) {
	for (const id of LEG_IDS) {
		const plant = ikState.plants.get(id);
		const chain = chains.get(id);
		if (!plant || !chain) continue;
		solveIk(chain, plant);
	}
}

function liftChainContact(chain, marker, markerName, floorY, heights) {
	if (!chain || !marker) return false;
	const markerPos = new THREE.Vector3();
	const effector = new THREE.Vector3();
	const height = heights[markerName] ?? CONTACT_RADIUS_FALLBACK;
	if (!Number.isFinite(height)) return false;
	let changed = false;
	for (let pass = 0; pass < 3; pass += 1) {
		marker.getWorldPosition(markerPos);
		const penetration = floorY + height - markerPos.y;
		if (penetration <= 1e-7) break;
		chain.bones[2].getWorldPosition(effector);
		effector.y += penetration;
		solveIk(chain, effector);
		changed = true;
	}
	return changed;
}

/** Apply the live chain portion of Body contact during a hips drag. Feet are
 * omitted when requested because the separate planted-foot solve owns them. */
export function applyBodyContact(chains, fkJoints, floorY = 0, { skipFeet = false } = {}) {
	if (!chains || !fkJoints) return false;
	const chain = [...chains.values()][0];
	const rig = chain?.rig;
	if (!rig) return false;
	const heights = chain.contactHeights ?? measureContactHeights(rig);
	let changed = false;
	const contacts = skipFeet
		? [["leftHand", "LeftHand"], ["rightHand", "RightHand"]]
		: [["leftHand", "LeftHand"], ["rightHand", "RightHand"], ["leftFoot", "LeftFoot"], ["rightFoot", "RightFoot"]];
	for (const [id, name] of contacts) {
		const marker = chains.get(id)?.bones[2];
		if (marker && liftChainContact(chains.get(id), marker, name, floorY, heights)) changed = true;
	}
	const mids = skipFeet
		? [["leftHand", "LeftForeArm"], ["rightHand", "RightForeArm"]]
		: [["leftHand", "LeftForeArm"], ["rightHand", "RightForeArm"], ["leftFoot", "LeftLeg"], ["rightFoot", "RightLeg"]];
	for (const [id, name] of mids) {
		const chainForMid = chains.get(id);
		const current = chainForMid?.bones[1];
		if (!current) continue;
		const pos = current.getWorldPosition(new THREE.Vector3());
		const height = heights[name] ?? CONTACT_RADIUS_FALLBACK;
		if (pos.y < floorY + height - 1e-7) {
			solveMidJoint(chainForMid, pos.clone().setY(floorY + height));
			changed = true;
		}
	}
	for (const [id, name] of contacts) {
		const marker = chains.get(id)?.bones[2];
		if (marker && liftChainContact(chains.get(id), marker, name, floorY, heights)) changed = true;
	}
	return changed;
}

/** Frames with an authored key, sorted — the timeline markers. */
export function ikKeyframes(ikState) {
	return [...ikState.keys.keys()].sort((a, b) => a - b);
}

/**
 * Evaluate the IK layer at `frame`: for every TRACKED part with keys,
 * slerp each stored bone's local rotation between the nearest keyed frames
 * and apply it — chain bones (b0, b1) and FK joints alike. No re-solve:
 * playback reproduces exactly what was dragged. Untracked parts, and
 * tracked parts with no keys, are never written.
 *
 * `blendWindow` > 0 turns the layer into a LOCAL correction (used when a
 * generated motion plays underneath): the correction holds full strength
 * across each ISLAND of keys and eases to zero over that many frames outside
 * it, or over an edge key's own `blend` when it stores one (see
 * correctionWeight), blending against whatever pose is already on the
 * bone (the motion). With the default 0 the keys hold forever (constant
 * extrapolation), the no-motion authoring behaviour.
 */
const deltaPos = new THREE.Vector3();
const identityQuat = new THREE.Quaternion();
const easedDelta = new THREE.Quaternion();
// Raw locals under the layer, used when a drag re-keys a legacy bind-space
// correction. Solvers no longer translate, but that existing layer might.
const chainClipPositions = new WeakMap();

export function ikEvaluate(rig, ikState, frame, fkJoints, blendWindow = 0) {
	if (!rig) return;
	for (const chain of rig.values()) {
		chainClipPositions.set(chain, { frame, positions: chain.bones.map((bone) => bone.position.clone()) });
	}
	// "placement" is the whole character's spot (placement-keys.js), no bone
	for (const id of [...ikState.tracked].filter(track => track !== "placement")) {
		const chain = rig.get(id);
		const sampled = sampleChain(ikState.keys, id, frame, chain);
		if (!sampled) continue;
		const joint = fkJoints?.get(id);
		const w = blendWindow > 0 ? correctionWeight(ikState.keys, id, frame, blendWindow) : 1;
		if (w <= 0) continue;
		if (chain) {
			if (sampled.chainP) chain.bones.forEach((bone, i) => { if (sampled.chainP[i]) bone.position.lerp(sampled.chainP[i], w * (sampled.chainPWeight ?? 1)); });
			// DELTA blend for chain rotations, the mirror of basePos for the hips
			// and for exactly the same reason. Easing a bone toward the key's
			// ABSOLUTE rotation makes the smear proportional to how different the
			// keyed pose is from this frame's clip pose — which, six frames from a
			// walk's fix, is the whole stride. Measured: unkeyed blend-window
			// frames moved up to 197.9 mm for a sub-2 cm correction, a swing-phase
			// foot lift was flattened by 95.9 mm, and 14 unkeyed frames ended with
			// feet under the floor purely from the ramp. Re-applying the SOLVER'S
			// OWN rotation instead — applied = clipCurrent ∘ slerp(identity,
			// baseQ⁻¹ ∘ q, w) — makes the smear proportional to the correction,
			// which is the only thing the key ever claimed.
			const deltas = blendWindow > 0 ? sampled.deltaQ : null;
			if (deltas) {
				// Ease the translations with the rotations: switching to bind only
				// at w = 1 tears the otherwise continuous correction at island edges.
				if (!sampled.keepTranslations) restoreChainPositions(chain, w);
				for (let index = 0; index < chain.bones.length && index < deltas.length; index += 1) {
					if (!deltas[index]) continue;
					easedDelta.copy(deltas[index]);
					if (w < 1) easedDelta.slerp(identityQuat, 1 - w);
					chain.bones[index].quaternion.multiply(easedDelta);
				}
			} else {
				if (!sampled.keepTranslations) restoreChainPositions(chain, w);
				if (w >= 1) {
					chain.bones[0].quaternion.copy(sampled.q[0]);
					chain.bones[1].quaternion.copy(sampled.q[1]);
					// The effector's authored rotation rides along when the key has it
					// (pre-rotation keys hold only b0/b1 — apply whatever is stored).
					if (sampled.q[2]) chain.bones[2].quaternion.copy(sampled.q[2]);
				} else {
					// current quats are the base layer's (motion) — ease toward the key
					chain.bones[0].quaternion.slerp(sampled.q[0], w);
					chain.bones[1].quaternion.slerp(sampled.q[1], w);
					if (sampled.q[2]) chain.bones[2].quaternion.slerp(sampled.q[2], w);
				}
			}
			chain.bones[0].updateMatrixWorld(true);
		} else if (joint) {
			if (!sampled.p && joint.bindPos) joint.bone.position.lerp(joint.bindPos, w);
			// A translation-only key (see ikBakeKeyframe) stores no rotation at
			// all, and must leave the clip's own orientation strictly alone.
			if (sampled.q?.[0]) {
				if (blendWindow > 0 && sampled.deltaQ?.[0]) {
					easedDelta.copy(sampled.deltaQ[0]).slerp(identityQuat, 1 - w);
					joint.bone.quaternion.multiply(easedDelta);
				} else if (w >= 1) joint.bone.quaternion.copy(sampled.q[0]);
				else joint.bone.quaternion.slerp(sampled.q[0], w);
			}
			if (sampled.p && joint.bindPos) {
				// DELTA blend, the correction-mode default whenever the key knows
				// the pose it was baked over: position = clipPosition + (p −
				// basePos)·w. Lerping toward the key's ABSOLUTE p instead splices
				// that key's height onto its neighbours — a planted toe rose 30 cm
				// because the frame next to a jump key inherited a share of the
				// jump's hips height. The delta form carries only what the
				// correction actually changed, so a frame the clip already had
				// right stays exactly where the clip put it. At w = 1 on the keyed
				// frame itself the clip position IS basePos, so this reproduces the
				// baked pose exactly (clipPos + (p − basePos)·1 = p) — the identity
				// that lets it replace the absolute path rather than approximate it.
				if (blendWindow > 0 && sampled.basePos) {
					joint.bone.position.addScaledVector(deltaPos.subVectors(sampled.p, sampled.basePos), w);
				} else if (w >= 1) joint.bone.position.copy(sampled.p);
				else joint.bone.position.lerp(sampled.p, w);
			}
			joint.bone.updateMatrixWorld(true);
		}
	}
}

/**
 * Legacy keys were solved at bind translations and must still replay there.
 * New correction keys keep clip translations; explicit poses carry chainP.
 * On a legacy key's ease ramp, interpolate the ENTIRE local transform:
 * p = clipP + (bindP - clipP) * weight,
 * alongside the eased rotation delta. This keeps both endpoints exact and is
 * continuous at full weight; withholding the translation until then made a
 * 1 cm correction jump 50.5 mm on a chain whose locals were 2 cm off bind.
 * Partial weights deliberately interpolate segment lengths too, just as the
 * absolute-key path does. They are transition poses, not fresh IK solves.
 */
function restoreChainPositions(chain, weight = 1) {
	if (!chain?.bindPositions) return;
	for (let index = 0; index < chain.bones.length; index += 1) {
		const bone = chain.bones[index];
		const bind = chain.bindPositions[index];
		if (weight >= 1) bone.position.copy(bind);
		else bone.position.lerp(bind, weight);
	}
	chain.bones[0].updateMatrixWorld(true);
}

/**
 * A track's key ISLANDS: runs of keys close enough together to be one
 * correction, as [firstFrame, lastFrame, firstBlend, lastBlend] in ascending
 * order. Two consecutive keys belong to the same island while the gap between
 * them is no wider than the larger of their two blend ranges; a wider gap
 * starts a new island.
 *
 * A key's blend range is its own `blend` (frames, stored by a Pose fix drag
 * made with a wider or narrower correction range) or, for every key without
 * one, `blendWindow`. The range is the right ruler because it is exactly how
 * far a correction is allowed to reach: keys closer together than that overlap
 * anyway, and keys further apart are, by the layer's own definition, separate
 * local fixes with clip in between. The larger of the pair decides because the
 * wider key already reaches its neighbour.
 */
function trackIslands(keys, trackId, blendWindow) {
	const frames = [];
	for (const [f, entry] of keys) {
		const key = entry.get(trackId);
		if (key) frames.push([f, key.blend ?? blendWindow, key.correctionRange ?? null]);
	}
	if (!frames.length) return [];
	frames.sort((a, b) => a[0] - b[0]);
	// Paired boundary keys keep the selected interval connected even when an
	// older key lies inside it. Use their current frame positions so retiming
	// the timeline keeps the interval attached to its keys.
	const rangeEnd = new Map();
	const rangeId = range => range ? `${range.start}:${range.end}` : null;
	for (const [f, , range] of frames) if (range) rangeEnd.set(rangeId(range), f);
	const islands = [];
	let [first, firstBlend, firstRange] = frames[0];
	let connectedUntil = rangeEnd.get(rangeId(firstRange)) ?? first;
	let [prev, prevBlend] = frames[0];
	for (let index = 1; index < frames.length; index += 1) {
		const [f, blend, range] = frames[index];
		if (f > connectedUntil && f - prev > Math.max(prevBlend, blend)) {
			islands.push([first, prev, firstBlend, prevBlend]);
			first = f;
			firstBlend = blend;
		}
		connectedUntil = Math.max(connectedUntil, rangeEnd.get(rangeId(range)) ?? f);
		prev = f;
		prevBlend = blend;
	}
	islands.push([first, prev, firstBlend, prevBlend]);
	return islands;
}

/**
 * Correction strength at `frame` for one track: 1 on a key and anywhere inside
 * a key ISLAND, easing 1 → 0 outward from each island edge across that edge
 * key's blend range (its `blend`, else `blendWindow`), 0 beyond every island.
 *
 * This used to be "1 everywhere between the track's first and last key", which
 * quietly made every sparse correction a whole-clip rewrite: two collision
 * fixes at frames 2 and 18 replaced the entire arm swing in between (wrist
 * 60 cm off the generated pose at frame 11), and on a real 432-frame walk two
 * keys at 129 and 322 pinned a 193-frame slerp over the clip. Between islands
 * the clip is authored motion nobody asked to change, so the layer eases out of
 * one island, hands the frames back to the clip, and eases into the next.
 *
 * Single keys are unaffected (an island of one, easing both ways, exactly as
 * before), and a contiguous run of keys — auto-physics' corrected span with its
 * boundary pins, a fully baked pose — is one island, so full-strength playback
 * of authored ranges is unchanged too.
 */
export function correctionWeight(keys, trackId, frame, blendWindow) {
	const islands = trackIslands(keys, trackId, blendWindow);
	let best = 0;
	for (const [first, last, firstBlend, lastBlend] of islands) {
		if (frame >= first && frame <= last) return 1;
		const weight = frame < first ? 1 - (first - frame) / firstBlend : 1 - (frame - last) / lastBlend;
		if (weight > best) best = weight;
	}
	return Math.max(0, best);
}

/**
 * The rotation the correction actually applied, per bone: `baseQ⁻¹ ∘ q`, so
 * that `baseQ ∘ delta === q`. Null unless the key carries a base for every
 * rotation it stores — a half-based key would mix a delta with an absolute.
 */
function keyDeltas(entry) {
	if (!entry?.q || !entry.baseQ) return null;
	const out = [];
	for (let index = 0; index < entry.q.length; index += 1) {
		const target = entry.q[index];
		const base = entry.baseQ[index];
		if (!target || !base) return null;
		out.push(base.clone().invert().multiply(target));
	}
	return out;
}

/** A key as ikEvaluate consumes it, with its rotation deltas resolved. */
function withDeltas(entry) {
	return entry?.baseQ ? { ...entry, deltaQ: keyDeltas(entry) } : entry;
}

function sampleChain(keys, trackId, frame, chain) {
	let prevFrame = null;
	let nextFrame = null;
	for (const f of keys.keys()) {
		if (!keys.get(f).has(trackId)) continue;
		if (f <= frame && (prevFrame == null || f > prevFrame)) prevFrame = f;
		if (f >= frame && (nextFrame == null || f < nextFrame)) nextFrame = f;
	}
	if (prevFrame == null && nextFrame == null) return null;
	if (prevFrame == null) return withDeltas(keys.get(nextFrame).get(trackId));
	if (nextFrame == null || prevFrame === nextFrame) return withDeltas(keys.get(prevFrame).get(trackId));
	const a = keys.get(prevFrame).get(trackId);
	const b = keys.get(nextFrame).get(trackId);
	const t = (frame - prevFrame) / (nextFrame - prevFrame);
	const deltasA = keyDeltas(a);
	const deltasB = keyDeltas(b);
	// Missing chainP means raw clip for a new key, bind for a legacy key.
	// A mixed pair must ease between those policies, not switch at an endpoint.
	const positionsA = a.chainP ?? (a.keepTranslations ? null : chain?.bindPositions);
	const positionsB = b.chainP ?? (b.keepTranslations ? null : chain?.bindPositions);
	return {
		keepTranslations: Boolean(chain) || (a.keepTranslations === true && b.keepTranslations === true),
		chainP: positionsA && positionsB ? positionsA.map((p, i) => p.clone().lerp(positionsB[i], t)) : (positionsA ?? positionsB),
		chainPWeight: positionsA && positionsB ? 1 : (positionsA ? 1 - t : t),
		// Between two based keys the DELTAS interpolate, not the absolute
		// rotations and their bases separately: each key's delta is a statement
		// about its own frame's clip pose, and interpolating those statements is
		// what "half of one fix easing into the next" means. A mixed pair has no
		// common base to interpolate against and falls back to the absolute path.
		deltaQ: deltasA && deltasB && deltasA.length === deltasB.length
			? deltasA.map((d, i) => d.slerp(deltasB[i], t))
			: null,
		// Translation-only keys carry no q. Two of them interpolate to no
		// rotation at all; a mixed pair falls back to whichever key does author
		// one, which is the same constant-hold a lone key has always given.
		q: a.q && b.q
			? a.q.map((q, i) => q.clone().slerp(b.q[i], t))
			: (a.q ?? b.q ?? null),
		p: a.p && b.p ? a.p.clone().lerp(b.p, t) : (a.p || b.p || null),
		// Mixed keys (one baked with a base pose, one without) fall back to the
		// absolute blend rather than interpolating a delta against a base only
		// half the pair agrees on.
		basePos: a.basePos && b.basePos ? a.basePos.clone().lerp(b.basePos, t) : null,
	};
}
