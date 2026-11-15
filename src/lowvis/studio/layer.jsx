// The lowvis layer of the Studio stage (prototype): a lowvis clip's characters and props drawn in the Studio's own
// scene at the Studio playhead, so the Studio's cameras, shots, timeline and export see them. The figures are not
// Studio cast members: they cannot be selected, moved or posed there.
import { useEffect, useLayoutEffect, useMemo } from "react";
import { useThree } from "@react-three/fiber";
import * as THREE from "three";
import { playbackFrame, usePlaybackSnapshot } from "../../motion/playback-frame-store.js";
import { clipBounds, createClipGroup } from "../viewer/scene.js";

/** What a camera frames to see the whole clip over all its frames: { target: { x, y, z }, radius } in metres. */
export function clipFrame(clip) {
	const box = clipBounds(clip), centre = box.getCenter(new THREE.Vector3());
	return { target: { x: centre.x, y: centre.y, z: centre.z }, radius: Math.max(1, box.getSize(new THREE.Vector3()).length() / 2) };
}

/** The start of clip character `index` as a Studio placement: { x, z, rot (degrees about Y, 0 faces +Z) }. */
export function clipStart(clip, index) {
	const c = clip.characters[index], q = new THREE.Quaternion(c.quat[0], c.quat[1], c.quat[2], c.quat[3]); // the Hips joint at frame 0
	const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
	return { x: c.pos[0], z: c.pos[2], rot: Math.round(THREE.MathUtils.radToDeg(Math.atan2(forward.x, forward.z)) * 10) / 10 };
}

/** figures: false draws the clip's props alone: its characters are Studio cast members then (take.js). */
export function LowvisLayer({ clip, look = "block", figures = true }) {
	const body = useMemo(() => createClipGroup(clip, look, { figures }), [clip, look, figures]);
	const frame = usePlaybackSnapshot(playbackFrame), invalidate = useThree(state => state.invalidate);
	useLayoutEffect(() => {
		body.setFrame(Math.round(frame));
		invalidate();
	}, [body, frame, invalidate]);
	useEffect(() => () => {
		const materials = new Set();
		body.group.traverse(node => {
			if (!node.isMesh && !node.isLine) return;
			node.geometry?.dispose();
			for (const material of [node.material].flat()) if (material) materials.add(material);
		});
		for (const material of materials) material.dispose();
	}, [body]);
	return <primitive object={body.group} />;
}
