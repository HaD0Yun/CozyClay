/**
 * Where a character's bone is at ANOTHER frame than the one the rig is posed at, for the effects of an emitter
 * attached to that bone (object.attach). A particle is born where its emitter was at its birth frame, and a trail is
 * the emitter's path over the last second; the live rig only knows the current frame, so without this an attached
 * emitter's whole plume would ride the bone rigidly. The pose is the character's own take (the one playback writes into
 * the rig, motion3/playback.js applyTakeFrame) through forward kinematics, in the frame the rig draws its skeleton in, and
 * calibrated against the live bone on the current frame, so on that frame it is the live attach frame exactly.
 */
import * as THREE from "three";
import { attachFrameMatrix } from "../stage-attach-frames.js";
import { skeletonFor } from "../motion3/rigs/index.js";
import { fk } from "../motion3/compiler/skeleton.js";
import { quatFromMat } from "../motion3/compiler/math.js";

/** Attach bone -> the rig bone that carries it (the same pairs as src/stage-attach-frames.js MIXAMO_ATTACH_BONES). */
const BONE_NAME = {
	hips: "Hips", spine: "Spine", chest: "Spine1", neck: "Neck", head: "Head",
	leftShoulder: "LeftArm", leftElbow: "LeftForeArm", leftHand: "LeftHand",
	rightShoulder: "RightArm", rightElbow: "RightForeArm", rightHand: "RightHand",
	leftKnee: "LeftLeg", leftFoot: "LeftFoot", rightKnee: "RightLeg", rightFoot: "RightFoot",
};
const order = new WeakMap(); // take -> its bone index for every skeleton bone
const pos = new THREE.Vector3(), quat = new THREE.Quaternion(), scale = new THREE.Vector3(), unit = new THREE.Vector3(1, 1, 1);
const CM = new THREE.Matrix4().makeScale(100, 100, 100);
const live = new THREE.Matrix4(), nowM = new THREE.Matrix4(), thenM = new THREE.Matrix4(), group = new THREE.Matrix4();

/** The matrix with its scale taken out, in place. */
const unscaled = (m) => { m.decompose(pos, quat, scale); return m.compose(pos, quat, unit); };

/** The bone's place and turn at take frame f in the character group's frame, into out; null when the take lacks it. */
function boneInTake(sk, take, j, f, out) {
	let index = order.get(take);
	if (!index) order.set(take, (index = sk.names.map((name) => take.bones.indexOf(name))));
	const F = take.frameCount, k = Math.max(0, Math.min(F - 1, Math.round(f) || 0)), B = take.bones.length;
	const quats = index.map((b) => (b < 0 ? [0, 0, 0, 1] : Array.from(take.rot.subarray((k * B + b) * 4, (k * B + b) * 4 + 4))));
	const body = fk(sk, quats, Array.from(take.hips.subarray(k * 3, k * 3 + 3)));
	if (!body.P[j]) return null;
	const q = quatFromMat(body.R[j]);
	return out.compose(pos.set(body.P[j][0], body.P[j][1], body.P[j][2]), quat.set(q[0], q[1], q[2], q[3]), unit);
}

/**
 * attachFrameAt({ rig, take, model, bone, frame, now, out }) -> the attach frame (world place and turn, unscaled, as
 * attachFrameMatrix gives it) of `bone` at timeline frame `frame`, while the rig stands posed at frame `now`; null for
 * the root frame (bone null), a body motion3 has no skeleton for, a character without a take of that shape, or a rig
 * not on stage: the caller then uses the live frame.
 */
export function attachFrameAt({ rig, take, model, bone, frame, now, out = new THREE.Matrix4() }) {
	const sk = skeletonFor(model), name = BONE_NAME[bone];
	if (!rig?.parent || !sk || !name || !take?.rot || !take?.hips || !Array.isArray(take.bones)) return null;
	const j = sk.index[name];
	if (j === undefined || !attachFrameMatrix(rig, bone, live)) return null;
	// the frame the skeleton's metres are drawn in: the Hips bone's parent (the character group, its scale, the
	// model's centimetre armature) times 100, as playback writes the take's hips in centimetres
	let hips = null;
	rig.traverse((node) => { if (!hips && node.isBone && /Hips$/.test(node.name)) hips = node; });
	if (!hips?.parent) return null;
	hips.parent.updateWorldMatrix(true, false);
	group.copy(hips.parent.matrixWorld).multiply(CM);
	if (!boneInTake(sk, take, j, now, nowM) || !boneInTake(sk, take, j, frame, thenM)) return null;
	// in the world through that frame (the place, turn and scale of the body), each as an unscaled frame; then
	// world(frame) = live(now) x world(now)^-1 x world(frame), exact on the current frame
	unscaled(nowM.premultiply(group)).invert();
	unscaled(thenM.premultiply(group));
	return unscaled(out.multiplyMatrices(live, nowM).multiply(thenM));
}
