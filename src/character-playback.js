// Play a take v3 on a character's own bones. A take compiled for a built-in body (X Bot, Y Bot) goes straight onto the
// Mixamo bones (motion3/playback.js applyTakeFrame). A take compiled for an imported rig (character-rig.js) drives the
// rig's canonical bones, which the file does not have: each frame is posed on the canonical skeleton (fk), turned into
// the file's own bone rotations by the adapter's bind offsets (motion3/rigs/retarget.js), and written onto the bones
// named in rigImport.sources. Unmapped bones (twists, metacarpals, a root) go back to their bind.
// The rig object an imported character reports (imported-character.jsx) holds the file's top joint's parent space at
// canonicalFrame(model): canonical metres = axes x k x raw + shift, in the character's placement frame, as the X Bot's
// centimetre rig root does. Every caller that played takes with applyTakeFrame plays them with this.
import { applyTakeFrame, isTakeV3 } from "./motion3/playback.js";
import { skeletonFor } from "./motion3/rigs/index.js";
import { fk } from "./motion3/compiler/skeleton.js";
import { retargetPose } from "./motion3/rigs/retarget.js";
import { importedRigData, isImportedModel } from "./character-rig.js";

const orders = new WeakMap(), bonesByRig = new WeakMap();

/** The registered data of an imported model with its retarget plan (registerCastRigs builds it), else null. */
function planFor(model) {
	const data = importedRigData(model);
	return data && data.sk === skeletonFor(model) ? data : null;
}

/** The file's top joint's parent space in the placement frame: { axes (3x3 rows), k (metres per raw unit), shift (m) }. */
export function canonicalFrame(model) {
	const hit = planFor(model);
	return hit && { axes: hit.plan.B, k: hit.plan.k, shift: hit.plan.shift };
}

/** The live bones of `rig` for each raw bone (first object of that name), cached per rig and model. */
function bonesOf(rig, model, sources) {
	const hit = bonesByRig.get(rig);
	if (hit?.model === model) return hit.bones;
	const first = new Map();
	rig.traverse(o => { if (!first.has(o.name)) first.set(o.name, o); });
	const bones = sources.map(name => first.get(name) ?? null);
	bonesByRig.set(rig, { model, bones });
	return bones;
}

/** Puts every bone `rig` has of an imported model back at its bind (the file's own local rotation and offset). */
export function restoreImportedBind(rig, model) {
	const data = importedRigData(model);
	if (!rig || !data) return false;
	bonesOf(rig, model, data.sources).forEach((bone, i) => {
		if (!bone) return;
		bone.quaternion.fromArray(data.raw.bones[i].localQuat);
		bone.position.fromArray(data.raw.bones[i].localPos);
	});
	rig.updateMatrixWorld(true);
	return true;
}

/**
 * applyTakeFrame for any character: frame `frame` of `take` onto `rig` (see the head of this file). A take of an
 * imported rig that is not registered (its entry was refused) leaves the bones as they are and answers null.
 */
export function playTakeFrame(rig, take, frame) {
	const hit = rig && isTakeV3(take) ? planFor(take.rig) : null;
	if (!hit) return isImportedModel(take?.rig) ? null : applyTakeFrame(rig, take, frame);
	const { sk, plan } = hit, B = take.bones.length, f = Math.max(0, Math.min(take.frameCount - 1, Math.round(frame) || 0));
	let order = orders.get(hit);
	if (order?.bones !== take.bones) orders.set(hit, order = { bones: take.bones, at: sk.names.map(name => take.bones.indexOf(name)) });
	const r = take.rot, h = take.hips, quats = order.at.map(b => { const i = (f * B + b) * 4; return b < 0 ? [0, 0, 0, 1] : [r[i], r[i + 1], r[i + 2], r[i + 3]]; });
	const pose = retargetPose(plan, fk(sk, quats, [h[f * 3], h[f * 3 + 1], h[f * 3 + 2]]));
	bonesOf(rig, take.rig, hit.sources).forEach((bone, i) => {
		if (!bone) return;
		bone.quaternion.fromArray(pose.quats[i] ?? hit.raw.bones[i].localQuat);
		bone.position.fromArray(i === pose.hips.bone ? pose.hips.position : hit.raw.bones[i].localPos);
	});
	rig.updateMatrixWorld(true);
}
