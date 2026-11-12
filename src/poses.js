/**
 * Pose data + pure logic for the pose studio. No React, no three.js imports:
 * object3D trees are consumed structurally (`isBone`, `traverse`, `rotation`),
 * so this module runs anywhere.
 */

/**
 * Ordered list of editable joints. `bone` is the canonical Mixamo name; the
 * matcher also accepts the `mixamorig:`-prefixed FBX spelling and rigs that
 * drop the prefix entirely.
 */
export const POSE_BONES = [
	{ id: "hips", bone: "mixamorigHips", label: "Hips" },
	{ id: "spine", bone: "mixamorigSpine", label: "Spine" },
	{ id: "chest", bone: "mixamorigSpine1", label: "Chest" },
	{ id: "upperChest", bone: "mixamorigSpine2", label: "Upper Chest" },
	{ id: "neck", bone: "mixamorigNeck", label: "Neck" },
	{ id: "head", bone: "mixamorigHead", label: "Head" },
	{ id: "lShoulder", bone: "mixamorigLeftShoulder", label: "L Shoulder" },
	{ id: "rShoulder", bone: "mixamorigRightShoulder", label: "R Shoulder" },
	{ id: "lArm", bone: "mixamorigLeftArm", label: "L Upper Arm" },
	{ id: "rArm", bone: "mixamorigRightArm", label: "R Upper Arm" },
	{ id: "lForeArm", bone: "mixamorigLeftForeArm", label: "L Forearm" },
	{ id: "rForeArm", bone: "mixamorigRightForeArm", label: "R Forearm" },
	{ id: "lHand", bone: "mixamorigLeftHand", label: "L Hand" },
	{ id: "rHand", bone: "mixamorigRightHand", label: "R Hand" },
	{ id: "lUpLeg", bone: "mixamorigLeftUpLeg", label: "L Thigh" },
	{ id: "rUpLeg", bone: "mixamorigRightUpLeg", label: "R Thigh" },
	{ id: "lLeg", bone: "mixamorigLeftLeg", label: "L Shin" },
	{ id: "rLeg", bone: "mixamorigRightLeg", label: "R Shin" },
	{ id: "lFoot", bone: "mixamorigLeftFoot", label: "L Foot" },
	{ id: "rFoot", bone: "mixamorigRightFoot", label: "R Foot" },
];

/** Strip every non-alphanumeric character and lowercase, so `mixamorig:LeftArm`,
 * `mixamorigLeftArm` and `LeftArm` all compare equal. */
export function normalizeBoneName(name) {
	return String(name ?? "").replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

/** A bone matches a joint when the normalised names are equal or one is a
 * suffix of the other (`mixamorigleftarm` vs bare `leftarm`). */
function boneMatches(boneName, entry) {
	const norm = normalizeBoneName(boneName);
	const target = normalizeBoneName(entry.bone);
	return norm === target || norm.endsWith(target) || target.endsWith(norm);
}

/**
 * The character's default standing pose.
 *
 * The pose library itself is the user's own: photographs they read in and
 * poses they save. This is not a library entry — it is the shape a character
 * spawns in and the one "Reset pose" returns to, so the rig never sits in a
 * bare T-pose just because the library is empty. `bones` maps a POSE_BONES id
 * to an [x, y, z] Euler triple in radians, a rotation delta composed onto the
 * character's rest (bind) pose, which keeps it rig-independent.
 */
export const DEFAULT_POSE = {
	id: "default",
	label: "Default",
	prompt: "standing relaxed with arms hanging naturally at their sides",
	bones: {
		lArm: [1.5632, 0.1164, -0.2889],
		rArm: [1.5632, -0.1164, 0.2889],
		lForeArm: [-0.0076, 0.0003, -0.0874],
		rForeArm: [-0.0076, -0.0003, 0.0874],
	},
};

const STORAGE_KEY = "cozyclay_poses";

/* --- quaternion helpers (plain math, no three.js import) ------------------
 * Pose values are Euler triples in radians, in the bone's local frame, applied
 * as a rotation delta on top of the character's rest (bind) pose. That keeps
 * presets rig-independent: "T-pose/rest" is all zeros on any rig, and a pose
 * captured on one character poses the other identically.
 * The Euler <-> quaternion conversions replicate three.js exactly (order XYZ),
 * so values written by three (e.g. a drag handler) round-trip bit-exactly.
 */

/** Fallback per-root cache of every bone's rest-pose quaternion, used when the
 * caller never mounted PoseHandles (which snapshots into `userData.poseBind`
 * at pose-mode entry, before any drag can move a bone). */
const bindByRoot = new WeakMap();

function qFromEuler(x, y, z) {
	const c1 = Math.cos(x / 2);
	const c2 = Math.cos(y / 2);
	const c3 = Math.cos(z / 2);
	const s1 = Math.sin(x / 2);
	const s2 = Math.sin(y / 2);
	const s3 = Math.sin(z / 2);
	return {
		x: s1 * c2 * c3 + c1 * s2 * s3,
		y: c1 * s2 * c3 - s1 * c2 * s3,
		z: c1 * c2 * s3 + s1 * s2 * c3,
		w: c1 * c2 * c3 - s1 * s2 * s3,
	};
}

function qMultiply(a, b) {
	return {
		x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
		y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
		z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
		w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
	};
}

function qInverse(q) {
	return { x: -q.x, y: -q.y, z: -q.z, w: q.w };
}

function qToEuler(q) {
	const m11 = 1 - 2 * (q.y * q.y + q.z * q.z);
	const m12 = 2 * (q.x * q.y - q.w * q.z);
	const m13 = 2 * (q.x * q.z + q.w * q.y);
	const m22 = 1 - 2 * (q.x * q.x + q.z * q.z);
	const m23 = 2 * (q.y * q.z - q.w * q.x);
	const m32 = 2 * (q.y * q.z + q.w * q.x);
	const m33 = 1 - 2 * (q.x * q.x + q.y * q.y);
	const y = Math.asin(Math.max(-1, Math.min(1, m13)));
	if (Math.abs(m13) < 0.9999999) {
		return [Math.atan2(-m23, m33), y, Math.atan2(-m12, m11)];
	}
	return [Math.atan2(m32, m22), y, 0];
}

/**
 * Snapshot the true bind pose, before anything has been applied to the rig.
 *
 * This MUST run while the rig is still untouched. PoseHandles used to be the
 * only writer, and it mounts long after Character's own effect has already
 * applied the default pose -- so the snapshot baked the default's deltas
 * (~90 degrees on the arms) and called them "rest". Everything downstream that
 * expresses a pose as a delta -- capturePose and savePose --
 * then measured against a pose instead of against the bind, and a default
 * character exported arms as identity.
 */
export function primeBindPose(root) {
	if (!root || root.userData?.poseBind) return;
	const map = new Map();
	root.traverse((object) => {
		if (object.isBone) {
			const q = object.quaternion;
			const p = object.position;
			map.set(object, {
				x: q.x,
				y: q.y,
				z: q.z,
				w: q.w,
				position: { x: p.x, y: p.y, z: p.z },
			});
		}
	});
	root.userData.poseBind = map;
}

function bindOf(root) {
	// primeBindPose stamps the untouched rig at clone time; prefer that over any
	// later capture, which would already carry whatever pose is on the rig.
	const primed = root.userData && root.userData.poseBind;
	if (primed) return primed;
	let map = bindByRoot.get(root);
	if (!map) {
		map = new Map();
		root.traverse((object) => {
			if (object.isBone) {
				const q = object.quaternion;
				const p = object.position;
				map.set(object, {
					x: q.x,
					y: q.y,
					z: q.z,
					w: q.w,
					position: { x: p.x, y: p.y, z: p.z },
				});
			}
		});
		bindByRoot.set(root, map);
	}
	return map;
}

/** True when `bone` hangs underneath one of the already-rotated instances.
 * Mixamo FBX exports nest an identity "skinned" copy of every bone under the
 * control bone; writing the control bone moves the whole subtree, so the copy
 * must not be rotated again. */
function isDescendantOf(bone, rotated) {
	for (let p = bone.parent; p; p = p.parent) {
		if (rotated.includes(p)) return true;
	}
	return false;
}

/** Apply a pose to a character root: every bone whose normalised name matches a
 * POSE_BONES entry gets the pose's Euler triple composed onto its rest rotation;
 * unmatched bones stay untouched. Returns how many of the POSE_BONES joints
 * were actually found and written. */
export function applyPose(root, pose) {
	const total = POSE_BONES.length;
	let applied = 0;
	if (root && pose) {
		const binds = bindOf(root);
		const matchesByJoint = new Map();
		root.traverse((object) => {
			if (!object.isBone) return;
			for (const entry of POSE_BONES) {
				if (boneMatches(object.name, entry)) {
					let list = matchesByJoint.get(entry.id);
					if (!list) matchesByJoint.set(entry.id, (list = []));
					list.push(object);
				}
			}
		});
		for (const entry of POSE_BONES) {
			const value = pose[entry.id];
			const list = matchesByJoint.get(entry.id);
			if (!list || !Array.isArray(value) || value.length < 3) continue;
			const delta = qFromEuler(value[0], value[1], value[2]);
			const rotated = [];
			for (const bone of list) {
				if (rotated.length && isDescendantOf(bone, rotated)) continue;
				rotated.push(bone);
				const q = qMultiply(delta, binds.get(bone) ?? binds.get(list[0]) ?? { x: 0, y: 0, z: 0, w: 1 });
				bone.quaternion.set(q.x, q.y, q.z, q.w);
			}
			applied++;
		}
		root.updateMatrixWorld(true);
	}
	return { applied, total };
}

/** Read the current rotation of every POSE_BONES joint back into the same
 * `{ id: [x, y, z] }` delta shape `applyPose` consumes. */
export function capturePose(root) {
	const pose = {};
	if (root) {
		const binds = bindOf(root);
		const captured = new Map();
		root.traverse((object) => {
			if (!object.isBone) return;
			for (const entry of POSE_BONES) {
				if (!captured.has(entry.id) && boneMatches(object.name, entry)) {
					captured.set(entry.id, object);
					break;
				}
			}
		});
		for (const entry of POSE_BONES) {
			const bone = captured.get(entry.id);
			if (bone) {
				const q = bone.quaternion;
				const bind = binds.get(bone);
				const delta = bind ? qMultiply({ x: q.x, y: q.y, z: q.z, w: q.w }, qInverse(bind)) : { x: q.x, y: q.y, z: q.z, w: q.w };
				pose[entry.id] = qToEuler(delta);
			}
		}
	}
	return pose;
}

function hipsBoneOf(root) {
	const entry = POSE_BONES.find((item) => item.id === "hips");
	let found = null;
	root.traverse((object) => {
		if (!found && object.isBone && boneMatches(object.name, entry)) found = object;
	});
	return found;
}

/**
 * The vertical distance the hips have moved off their bind height, in the
 * rig's own units. Rotations alone cannot say "crouched": with the hips left
 * at standing height, bent legs lift the feet off the floor. A measured take
 * (SAM, motion playback) writes the true hips position onto the bone, and
 * this reads it back so a pose can carry it as `rootY`.
 */
export function captureHipsOffset(root) {
	if (!root) return 0;
	const bone = hipsBoneOf(root);
	if (!bone) return 0;
	const bind = bindOf(root).get(bone);
	if (!bind?.position) return 0;
	return bone.position.y - bind.position.y;
}

/** Return every bone's LOCAL TRANSLATION to its bind value. A positionally
 * skinned motion frame writes per-bone positions the FK pose math never
 * produced; capturing or keying a pose over those locals bakes the mismatch
 * in — rotations from the pose, translations from the clip — and the body
 * visibly comes apart. Rotations are left alone: callers pose them next. */
export function restoreBindPositions(root) {
	if (!root) return;
	const binds = bindOf(root);
	root.traverse((object) => {
		if (!object.isBone) return;
		const saved = binds.get(object)?.position;
		if (saved) object.position.set(saved.x, saved.y, saved.z);
	});
	root.updateMatrixWorld(true);
}

/** Seat the hips `rootY` below (negative) or above their bind height. Always
 * write, even for 0: the previous pose may have been a crouch, and a stale
 * offset would leave the next standing pose buried in the floor. */
export function applyHipsOffset(root, rootY = 0) {
	if (!root) return;
	const bone = hipsBoneOf(root);
	if (!bone) return;
	const bind = bindOf(root).get(bone);
	if (!bind?.position) return;
	bone.position.y = bind.position.y + (Number.isFinite(rootY) ? rootY : 0);
	bone.updateMatrixWorld(true);
}

export function loadCustomPoses() {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return [];
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(
			(p) => p && typeof p === "object" && typeof p.id === "string" && p.bones && typeof p.bones === "object"
		);
	} catch {
		// Private mode / quota errors degrade to an empty list.
		return [];
	}
}

export function saveCustomPoses(list) {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
		return true;
	} catch {
		return false;
	}
}

export function deleteCustomPose(id, list) {
	const next = list.filter((p) => p.id !== id);
	saveCustomPoses(next);
	return next;
}
