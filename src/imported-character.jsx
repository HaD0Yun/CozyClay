// A cast member from an imported character file (character-import.js): the stored file's own mesh and bones, played
// on its own skeleton (character-playback.js). The rig object it reports holds the file's top joint's parent space at
// the canonical frame of its adapted rig (canonicalFrame: canonical metres = axes x k x raw + shift), so a take's
// joints land where they were compiled, in the placement frame the X Bot's centimetre rig root uses. With no take
// playing the bones stand at their bind. The file's materials give way to the clay tint, as the X Bot's do.
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useThree } from "@react-three/fiber";
import * as THREE from "three";
import { cloneMeshGraph } from "./mesh-graph-clone.js";
import { subscribeToMeshScene } from "./scene-mesh-cache.js";
import { canonicalFrame, restoreImportedBind } from "./character-playback.js";
import { primeBindPose } from "./poses.js";
import { registerCastRigs } from "./character-rig.js";

/** The rig root: a group whose transform maps the file's top joint's parent space into the placement frame. */
function buildRig(source, character) {
	const { model, rigImport } = registerCastRigs([character])[0], frame = canonicalFrame(model);
	if (!frame) return null;
	const clone = cloneMeshGraph(source), top = rigImport.raw.bones.findIndex(b => b.parent < 0);
	let joint = null;
	clone.traverse(o => { if (!joint && o.name === rigImport.sources[top]) joint = o; });
	if (!joint) return null;
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

export const ImportedCharacter = memo(function ImportedCharacter({ character, position, rot, tint, pose, onRig, pickId }) {
	const { model, rigImport } = character;
	const [source, setSource] = useState(null);
	useEffect(() => {
		setSource(null);
		return subscribeToMeshScene(rigImport.assetId, setSource);
	}, [rigImport.assetId]);
	// the model id names the file and the template, so a moved or retinted entry keeps its rig (a new clone re-binds it)
	const characterRef = useRef(character);
	characterRef.current = character;
	const rig = useMemo(() => (source ? buildRig(source, { ...characterRef.current, model }) : null), [source, model]);

	const invalidate = useThree(state => state.invalidate);
	useLayoutEffect(() => {
		if (!rig) return;
		const body = new THREE.Color(tint).multiplyScalar(0.9);
		rig.traverse(child => { if (child.isMesh) child.material.color.copy(body); });
		invalidate();
	}, [rig, tint, invalidate]);

	// A pose (no take playing) stands the bones at their bind: the pose library's joints are the X Bot's.
	useEffect(() => { if (rig && pose) restoreImportedBind(rig, model); }, [rig, pose, model]);

	const onRigRef = useRef(onRig);
	onRigRef.current = onRig;
	useEffect(() => { if (rig) onRigRef.current?.(rig); }, [rig]);
	useEffect(() => () => rig?.traverse(child => { if (child.isMesh) child.material?.dispose?.(); }), [rig]);

	return (
		<group position={position} rotation={[0, (rot * Math.PI) / 180, 0]} userData={pickId ? { characterPick: pickId } : undefined}>
			{rig && <primitive object={rig} />}
		</group>
	);
});
