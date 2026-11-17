// A lowvis look drawn over a Studio rig character (prototype): the block figure follows the rig's own bones, so the
// character stays a Studio cast member (takes, selection, placement, save) and only its body is drawn differently.
// The figure takes the pose of the rig's bones at each render (skin-pose.js). The rig's own meshes hide while the skin is on.
// It is as large as the character's scale and, when the character has a tint of its own, of that colour.
import { useEffect, useLayoutEffect, useMemo } from "react";
import { useThree } from "@react-three/fiber";
import { LOOKS } from "../looks/index.js";
import { followBones, jointBones } from "./skin-pose.js";

export function LowvisSkin({ rig, tint, colour = null, scale = 1, pickId = null, look = "block" }) {
	const body = useMemo(() => (LOOKS[look] ?? LOOKS.block)({ tint, colour }), [look, tint, colour]);
	const bones = useMemo(() => (rig ? jointBones(rig) : null), [rig]);
	const invalidate = useThree(state => state.invalidate);
	// in the commit itself, so the frame that drops the skin already shows the rig's own body (the stage draws on demand)
	useLayoutEffect(() => {
		if (!rig) return undefined;
		const hidden = [];
		// underLook: a ghost of this rig (ghost-set.js) still draws the mesh
		rig.traverse(node => { if (node.isMesh && node.visible) { node.visible = false; node.userData.underLook = true; hidden.push(node); } });
		invalidate();
		return () => { for (const node of hidden) { node.visible = true; delete node.userData.underLook; } invalidate(); };
	}, [rig, invalidate]);
	useEffect(() => () => {
		const materials = new Set();
		body.object3D.traverse(node => {
			if (!node.isMesh && !node.isLine) return;
			node.geometry?.dispose();
			for (const material of [node.material].flat()) if (material) materials.add(material);
		});
		for (const material of materials) material.dispose();
	}, [body]);
	useLayoutEffect(() => (bones ? followBones(body, bones, scale) : undefined), [body, bones, scale]);
	// the stage picker walks up from a hit mesh to a characterPick tag (object-gizmo.jsx): the figure is the click target the rig's meshes were
	return rig && bones?.every(Boolean) ? <primitive object={body.object3D} userData={pickId ? { characterPick: pickId } : {}} /> : null;
}
