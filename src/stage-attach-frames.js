import * as THREE from "three";
import { SCENE_ATTACH_BONES } from "./scene-objects.js";

import { normalizeBoneName } from "./poses.js";

/** The rig rows that ARE an attach frame: `rig.<track id>`, the same camel
 * spellings SCENE_ATTACH_BONES uses. The group rows above them (rig.torso,
 * rig.leftArm …) name a limb, not a frame, so they are deliberately absent. */
export const ATTACH_BONE_ROWS = new Map(SCENE_ATTACH_BONES.map((bone) => [`rig.${bone}`, bone]));

/** Attach track id -> the Mixamo bone carrying that frame on the shipped rigs. */
const MIXAMO_ATTACH_BONES = {
	hips: "Hips", spine: "Spine", chest: "Spine1", neck: "Neck", head: "Head",
	leftShoulder: "LeftArm", leftElbow: "LeftForeArm", leftHand: "LeftHand",
	rightShoulder: "RightArm", rightElbow: "RightForeArm", rightHand: "RightHand",
	leftKnee: "LeftLeg", leftFoot: "LeftFoot", rightKnee: "RightLeg", rightFoot: "RightFoot",
};
const ATTACH_BONE_NAMES = Object.fromEntries(SCENE_ATTACH_BONES.map((bone) => [bone, MIXAMO_ATTACH_BONES[bone]]));

// One scratch set for the whole module: resolving a frame runs per attached
// prop per frame and must never allocate.
const attachPos = new THREE.Vector3();
const attachQuat = new THREE.Quaternion();
const attachScale = new THREE.Vector3();
const attachRootPos = new THREE.Vector3();
const attachRootQuat = new THREE.Quaternion();
const ATTACH_UNIT_SCALE = new THREE.Vector3(1, 1, 1);
export const attachWorldMatrix = new THREE.Matrix4();
const attachLocalMatrix = new THREE.Matrix4();
const attachToMatrix = new THREE.Matrix4();
const attachInverseMatrix = new THREE.Matrix4();
const placePos = new THREE.Vector3();
const placeQuat = new THREE.Quaternion();
const placeScale = new THREE.Vector3();
const placeEuler = new THREE.Euler();

/** The bone a rig offers under `mixamoName`, by the project's matching rule
 * (normalised names equal, or one a suffix of the other; first depth-first
 * match wins — poses.js and motion3/playback.js agree). Cached per rig: this is
 * asked once per attached prop per rendered frame. */
const attachBoneCache = new WeakMap();
function attachBoneOf(rig, mixamoName) {
	let byName = attachBoneCache.get(rig);
	if (!byName) attachBoneCache.set(rig, (byName = new Map()));
	if (byName.has(mixamoName)) return byName.get(mixamoName);
	const target = normalizeBoneName(mixamoName);
	let found = null;
	rig.traverse((node) => {
		if (found || !node.isBone) return;
		const norm = normalizeBoneName(node.name);
		if (norm === target || norm.endsWith(target)) found = node;
	});
	byName.set(mixamoName, found);
	return found;
}

/**
 * The LIVE world frame an attachment rides, or null when the rig (or that bone)
 * is not there — a dangling attachment then renders where its numbers say,
 * which is exactly what a detached prop does.
 *
 * The frame is deliberately UNSCALED. The shipped rigs are Mixamo centimetres
 * scaled by 0.01 on the model, so a raw bone matrix would push a hundredfold
 * into every carried prop's local numbers and leave the Inspector unreadable.
 * A carried prop takes the bone's place and facing; its size stays its own.
 *
 * `bone === null` is the character's animated ROOT: the hips' travel (during
 * playback the hips travel lives in the bones — see motion3/playback.js)
 * carried at the character's own yaw, so a prop dropped on
 * the character walks with the body instead of rolling with the hips.
 */
export function attachFrameMatrix(rig, bone, out = new THREE.Matrix4()) {
	if (!rig) return null;
	const name = ATTACH_BONE_NAMES[bone ?? "hips"];
	if (!name) return null;
	const node = attachBoneOf(rig, name);
	if (!node) return null;
	// Ancestors included: the bones are written imperatively by playback and by
	// the export, either of which can land before the renderer's own pass.
	node.updateWorldMatrix(true, false);
	node.matrixWorld.decompose(attachPos, attachQuat, attachScale);
	if (bone != null) return out.compose(attachPos, attachQuat, ATTACH_UNIT_SCALE);
	// The Character group carries the scene placement and the clip-to-scene yaw;
	// the rig model hangs off it, so its parent IS that group.
	const group = rig.parent ?? rig;
	group.updateWorldMatrix(true, false);
	group.matrixWorld.decompose(attachRootPos, attachRootQuat, attachScale);
	return out.compose(attachPos, attachRootQuat, ATTACH_UNIT_SCALE);
}

/** A prop's placement as a matrix — the same compose props.jsx renders from
 * (position, XYZ euler in degrees, per-axis scale). */
export function sceneObjectMatrix(object, out = new THREE.Matrix4()) {
	return out.compose(
		placePos.set(object.x ?? 0, object.y ?? 0, object.z ?? 0),
		placeQuat.setFromEuler(placeEuler.set(
			(object.rotX ?? 0) * THREE.MathUtils.DEG2RAD,
			(object.rot ?? 0) * THREE.MathUtils.DEG2RAD,
			(object.rotZ ?? 0) * THREE.MathUtils.DEG2RAD,
		)),
		placeScale.set(object.scaleX ?? 1, object.scaleY ?? 1, object.scaleZ ?? 1),
	);
}

/** …and back out into the nine authored channels, or null if the matrix could
 * not be read as a placement at all (a singular frame inverts to zeros, and a
 * zero matrix decomposes to NaN). Rounded, because a matrix round trip
 * otherwise turns a typed 1.5 into 1.4999999999999998 in the Inspector the
 * moment a prop is picked up and put down again. */
function sceneObjectPlacement(matrix) {
	matrix.decompose(placePos, placeQuat, placeScale);
	placeEuler.setFromQuaternion(placeQuat);
	const round = (value) => Math.round(value * 1e6) / 1e6;
	const placement = {
		x: round(placePos.x), y: round(placePos.y), z: round(placePos.z),
		rotX: round(placeEuler.x * THREE.MathUtils.RAD2DEG),
		rot: round(placeEuler.y * THREE.MathUtils.RAD2DEG),
		rotZ: round(placeEuler.z * THREE.MathUtils.RAD2DEG),
		scaleX: round(placeScale.x), scaleY: round(placeScale.y), scaleZ: round(placeScale.z),
	};
	return Object.values(placement).every((value) => Number.isFinite(value)) ? placement : null;
}

/**
 * The nine channels rewritten so a prop does not MOVE when it changes frames.
 *
 * `world` is where the prop actually IS — read off the live group in the scene
 * graph, NOT recomputed from its numbers. That distinction is the whole point:
 * an attach->attach drop would otherwise have to reconstruct the world
 * transform through the frame the prop is leaving, and any disagreement
 * between that reconstruction and what the renderer last drew (a rig posed a
 * beat later than the last drawn frame, a frame that no longer resolves) lands
 * on screen as a jump. Reading the group makes every drop the same one-frame
 * conversion the world->attach and attach->world cases already were.
 *
 * Returns null when the frame it needs is missing — converting against a rig
 * that is not on stage would be precisely the jump this exists to prevent —
 * and the caller then refuses the whole drop rather than re-labelling numbers
 * it could not convert.
 */
export function attachPlacementPatch(world, attach, frameOf) {
	if (!world) return null;
	if (!attach) return sceneObjectPlacement(attachLocalMatrix.copy(world));
	const frame = frameOf(attach.characterId, attach.bone ?? null, attachToMatrix);
	if (!frame) return null;
	return sceneObjectPlacement(attachLocalMatrix.copy(world).premultiply(attachInverseMatrix.copy(frame).invert()));
}

/**
 * Write a computed placement straight onto the record, around
 * updateSceneObject. Deliberate, and the only call site allowed to: those
 * limits are WORLD limits (y floors at the deck, x/z stay inside the room),
 * and while a prop is attached its numbers are a LOCAL transform in a bone
 * frame — a hand rides 1.3 m above the deck, so a carried prop's local y is
 * routinely negative and clamping it to the floor IS the visual jump the
 * conversion exists to prevent. Every value here comes out of a decomposed
 * matrix, so the record shape is sound by construction.
 */
export function placeSceneObject(objects, id, placement) {
	if (!placement) return objects;
	let changed = false;
	const next = objects.map((object) => {
		if (object.id !== id) return object;
		if (Object.entries(placement).every(([key, value]) => object[key] === value)) return object;
		changed = true;
		return { ...object, ...placement };
	});
	return changed ? next : objects;
}
