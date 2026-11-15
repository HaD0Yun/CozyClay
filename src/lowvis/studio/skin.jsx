// A lowvis look drawn over a Studio rig character (prototype): the block figure follows the rig's own bones, so the
// character stays a Studio cast member (takes, selection, placement, save) and only its body is drawn differently.
// The 17 lowvis joints are X Bot bones (tools/lowvis/make-rig17.mjs): each frame the skin reads those bones' world
// places and rotations and hands them to the look as one clip frame. The rig's own meshes hide while the skin is on.
import { useEffect, useLayoutEffect, useMemo } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { normalizeBoneName } from "../../poses.js";
import { LOOKS } from "../looks/index.js";
import { JOINTS, JOINT_COUNT, SOURCE_REST_QUAT } from "../rig17.js";

/** The rig's control bone of each lowvis joint (the first bone of that name, as motion3/playback.js picks them). */
function jointBones(rig) {
	const first = new Map();
	rig.traverse(node => {
		if (!node.isBone) return;
		const name = normalizeBoneName(node.name);
		if (!first.has(name)) first.set(name, node);
	});
	return JOINTS.map(joint => {
		const target = normalizeBoneName(joint);
		for (const [name, bone] of first) if (name === target || name.endsWith(target)) return bone;
		return null;
	});
}

export function LowvisSkin({ rig, tint, look = "block" }) {
	const body = useMemo(() => (LOOKS[look] ?? LOOKS.block)({ tint }), [look, tint]);
	const bones = useMemo(() => (rig ? jointBones(rig) : null), [rig]);
	const frame = useMemo(() => ({
		pos: new Float32Array(JOINT_COUNT * 3), quat: new Float32Array(JOINT_COUNT * 4), p: new THREE.Vector3(), q: new THREE.Quaternion(),
		fromRest: SOURCE_REST_QUAT.map(q => new THREE.Quaternion(q[0], q[1], q[2], q[3]).invert()),
	}), []);
	const invalidate = useThree(state => state.invalidate);
	// in the commit itself, so the frame that drops the skin already shows the rig's own body (the stage draws on demand)
	useLayoutEffect(() => {
		if (!rig) return undefined;
		const hidden = [];
		rig.traverse(node => { if (node.isMesh && node.visible) { node.visible = false; hidden.push(node); } });
		invalidate();
		return () => { for (const node of hidden) node.visible = true; invalidate(); };
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
	useFrame(() => {
		if (!bones) return;
		bones.forEach((bone, j) => {
			if (!bone) return;
			bone.getWorldPosition(frame.p).toArray(frame.pos, j * 3);
			// a clip joint's quaternion is its world rotation from rest
			bone.getWorldQuaternion(frame.q).multiply(frame.fromRest[j]).toArray(frame.quat, j * 4);
		});
		body.setPose(frame.pos, frame.quat, 0);
	});
	return rig && bones?.every(Boolean) ? <primitive object={body.object3D} /> : null;
}
