// Binds a live three.js character rig (the Mixamo FBX root, scaled 0.01 per cm times the stage stature) to the poser
// core. The poser works on the body at its own size: its frame is the rig root's local space (armature cm) in metres,
// so stage placement, turn and stature live only in the root's world matrix and never reach the network.
// Reads the pose back and writes solved bone transforms.
import * as THREE from "three";
import xBot from "../../motion3/rigs/x-bot-tpose.json" with { type: "json" };
import yBot from "../../motion3/rigs/y-bot-tpose.json" with { type: "json" };
import { findBone } from "../../motion/find-bone.js";
import { mul, mulTB, mulTVec, mulVec } from "../mat3.js";
import { readPose } from "../retarget.js";
import { HELD_JOINTS } from "./pose-ops.js";
import { characterFromRigJson } from "../ybot.js";

const RIGS = { "y-bot-tpose": yBot, "x-bot-tpose": xBot };
/**
 * IK tracks an Auto Pose write touches so that a release keys it. The upper chest (Mixamo Spine2) and the toes have no
 * track, so their turns are dropped when keying.
 */
export const POSER_KEY_TRACKS = Object.freeze(["hips", "spine", "chest", "neck", "head", "leftShoulder", "rightShoulder", "leftHand", "rightHand", "leftFoot", "rightFoot"]);
// Joints whose bones the keys store (signature of "the pose Auto Pose wrote"): all written joints but Chest and toes.
const KEYED_JOINTS = [0, 1, 2, 4, 6, 10, 11, 12, 13, 16, 17, 18, 19, 22, 23, 24, 26, 27, 28];

/** Whether Auto Pose has a rig table for this character model (the shipped Mixamo bodies). */
export const poserSupports = (model) => model in RIGS;

/** Flat row-major 3x3 rotation of a three.js matrix's upper-left block (column-major storage). */
function rowsOf(e) {
	return [e[0], e[4], e[8], e[1], e[5], e[9], e[2], e[6], e[10]];
}

/** Null when the model has no table or the rig is missing a bone Auto Pose writes. `poser` is a createPoser() result. */
export function createRigBridge(rig, model, poser) {
	if (!rig || !RIGS[model]) return null;
	rig.updateMatrixWorld(true);
	const sv = new THREE.Vector3().setFromMatrixScale(rig.matrixWorld), stature = (sv.x + sv.y + sv.z) / 3 / 0.01;
	const character = characterFromRigJson(RIGS[model]);
	// metres per armature unit as the core measured the body, so the bridge and the core always agree
	const facts = poser.prepare(character), sk = poser.skeleton, s = facts.s;
	const needed = new Set([...facts.boneOf.filter((b, j) => b >= 0 && facts.written[j]), ...facts.between].map((b) => facts.bones[b].name));
	const bones = new Map();
	for (const name of needed) {
		const bone = findBone(rig, name);
		if (!bone) return null;
		bones.set(name, bone);
	}
	const jointBone = (j) => bones.get(facts.bones[facts.boneOf[j]]?.name);
	const inv = new THREE.Matrix4(), m = new THREE.Matrix4(), rot = new THREE.Matrix4(), v = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
	const refresh = () => { rig.updateMatrixWorld(true); inv.copy(rig.matrixWorld).invert(); };
	refresh();

	/** Armature-space `{ R, t }` of a bone as it stands (rig root space, armature units). */
	function armature(name) {
		m.multiplyMatrices(inv, bones.get(name).matrixWorld).decompose(v, q, sc);
		return { R: rowsOf(rot.makeRotationFromQuaternion(q).elements), t: [v.x, v.y, v.z] };
	}
	/** Stage world point (THREE.Vector3) -> poser frame [x, y, z] in metres. */
	function toPoser(world) {
		v.copy(world).applyMatrix4(inv);
		return mulVec([0, 0, 0], 0, facts.R, 0, [v.x, v.y, v.z], 0).map((x) => x * s);
	}
	/** Poser frame point -> stage world (written into `out`). */
	function toWorld(p, out = new THREE.Vector3()) {
		const a = mulTVec([0, 0, 0], 0, facts.R, 0, p, 0);
		return out.set(a[0] / s, a[1] / s, a[2] / s).applyMatrix4(rig.matrixWorld);
	}
	/** World position of a joint's bone head. */
	const jointWorld = (j, out = new THREE.Vector3()) => jointBone(j).getWorldPosition(out);
	/** A joint's global rotation relative to its rest, in the poser frame: `R (B E_jᵀ) Rᵀ`. */
	function turnAt(j) {
		const B = armature(facts.bones[facts.boneOf[j]].name).R, t1 = new Float64Array(9), t2 = new Float64Array(9);
		mulTB(t1, 0, B, 0, facts.E, 9 * j);
		mul(t2, 0, facts.R, 0, t1, 0);
		return Array.from(mulTB(new Float64Array(9), 0, t2, 0, facts.R, 0));
	}
	/** A stage-world axis (unit THREE.Vector3) in the poser frame, for turning handles about world axes. */
	function axisToPoser(axis) {
		const turn = rowsOf(rot.extractRotation(rig.matrixWorld).elements);
		return mulVec([0, 0, 0], 0, facts.R, 0, mulTVec([0, 0, 0], 0, turn, 0, [axis.x, axis.y, axis.z], 0), 0);
	}

	return {
		rig, model, character, facts, skeleton: sk, stature,
		refresh, toPoser, toWorld, jointWorld, turnAt, axisToPoser,
		jointPoser: (j) => toPoser(jointWorld(j, new THREE.Vector3())),
		/** The pose as it stands, skeleton frame. */
		readPose: () => { refresh(); return readPose(sk, facts, armature); },
		/** Write solved bones (`{ name, quaternion, position }`, three.js parent-relative locals). */
		write(list) {
			for (const { name, quaternion, position } of list) {
				const bone = bones.get(name);
				if (!bone) continue;
				bone.quaternion.set(quaternion[0], quaternion[1], quaternion[2], quaternion[3]);
				bone.position.set(position[0], position[1], position[2]);
			}
			refresh();
		},
		/** Local rotations (flat row-major) of the bones no key stores, per joint (pose-ops.js HELD_JOINTS). */
		heldLocals() {
			const keep = new Map();
			for (const [j] of HELD_JOINTS) { const b = jointBone(j); if (b) keep.set(j, rowsOf(rot.makeRotationFromQuaternion(b.quaternion).elements)); }
			return keep;
		},
		/** Local quaternions of the keyed bones and the hips position: tells whether the pose changed elsewhere. */
		signature() {
			const out = [];
			for (const j of KEYED_JOINTS) { const b = jointBone(j); if (b) out.push(b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w); }
			const hips = jointBone(0);
			out.push(hips.position.x, hips.position.y, hips.position.z);
			return out;
		},
	};
}

/** Whether two signatures describe the same pose (quaternion sign and float noise allowed). */
export function sameSignature(a, b, eps = 1e-5) {
	if (!a || !b || a.length !== b.length) return false;
	const quats = a.length - 3;
	for (let i = 0; i < quats; i += 4) {
		const d = a[i] * b[i] + a[i + 1] * b[i + 1] + a[i + 2] * b[i + 2] + a[i + 3] * b[i + 3];
		if (1 - Math.abs(d) > eps) return false;
	}
	for (let i = quats; i < a.length; i += 1) if (Math.abs(a[i] - b[i]) > eps * 100) return false;
	return true;
}
