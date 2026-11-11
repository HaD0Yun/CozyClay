// The rig root of an imported character (character-import.js): a clone of the file's parsed scene under a group whose
// transform maps the file's top joint's parent space into the character's placement frame, at the canonical frame of
// its adapted rig (character-playback.js canonicalFrame: canonical metres = axes x k x raw + shift), as the X Bot's
// centimetre rig root does. Bones stand at their bind; the file's materials give way to clay (the tint is the caller's).
import * as THREE from "three";
import { cloneMeshGraph } from "./mesh-graph-clone.js";
import { canonicalFrame, restoreImportedBind } from "./character-playback.js";
import { primeBindPose } from "./poses.js";
import { importedRigData, registerCastRigs } from "./character-rig.js";

/**
 * The rig root for `character` ({ model, adaptedRig, rigImport }) from its parsed file `source`; null when its rig does
 * not register (registerCastRigs refuses an entry whose plan does not build) or the file lacks its top joint.
 */
export function buildImportedRig(source, character) {
	const model = registerCastRigs([character])[0]?.model, frame = canonicalFrame(model), data = importedRigData(model);
	if (!frame || !data) return null;
	const top = data.raw.bones.findIndex(b => b.parent < 0), clone = cloneMeshGraph(source);
	let joint = null;
	clone.traverse(o => { if (!joint && o.name === data.sources[top]) joint = o; });
	if (!joint?.parent) return null;
	clone.updateMatrixWorld(true);
	// file root -> top joint's parent space; canonical = [axes x k | shift] x that space
	const below = joint.parent.matrixWorld.clone(), { axes: A, k, shift } = frame;
	const canonical = new THREE.Matrix4().set(A[0][0] * k, A[0][1] * k, A[0][2] * k, shift[0], A[1][0] * k, A[1][1] * k, A[1][2] * k, shift[1], A[2][0] * k, A[2][1] * k, A[2][2] * k, shift[2], 0, 0, 0, 1);
	const rig = new THREE.Group();
	canonical.multiply(below.invert()).decompose(rig.position, rig.quaternion, rig.scale);
	rig.name = `imported:${model}`;
	rig.add(clone);
	clone.traverse(child => {
		if (child.isLight || child.isCamera) child.visible = false;
		if (!child.isMesh) return;
		child.material?.dispose?.();
		child.material = new THREE.MeshStandardMaterial({ roughness: 0.66, metalness: 0, envMapIntensity: 0.35 });
		child.frustumCulled = false;
		child.castShadow = true;
		child.receiveShadow = true;
	});
	restoreImportedBind(rig, model);
	primeBindPose(rig);
	return rig;
}
