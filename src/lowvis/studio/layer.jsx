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

export function LowvisLayer({ clip, look = "block" }) {
	const body = useMemo(() => createClipGroup(clip, look), [clip, look]);
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
