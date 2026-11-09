// A cast member from an imported character file (character-import.js): the stored file's own mesh and bones, played
// on its own skeleton (character-playback.js). The rig object it reports holds the file's top joint's parent space at
// the canonical frame of its adapted rig (canonicalFrame: canonical metres = axes x k x raw + shift), so a take's
// joints land where they were compiled, in the placement frame the X Bot's centimetre rig root uses. With no take
// playing the bones stand at their bind. The file's materials give way to the clay tint, as the X Bot's do.
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useThree } from "@react-three/fiber";
import * as THREE from "three";
import { subscribeToMeshScene } from "./scene-mesh-cache.js";
import { restoreImportedBind } from "./character-playback.js";
import { buildImportedRig } from "./imported-rig-root.js";

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
	const rig = useMemo(() => (source ? buildImportedRig(source, { ...characterRef.current, model }) : null), [source, model]);

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
