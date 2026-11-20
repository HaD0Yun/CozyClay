import { memo, useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { defaultCharacterTint } from "./app-stage.jsx";
import {
	PROXY_BODY_HEIGHT as BODY_HEIGHT, PROXY_BODY_RADIUS as BODY_RADIUS, PROXY_HEAD_LIFT,
	PROXY_HEAD_RADIUS as HEAD_RADIUS, PROXY_SIT_LEG_REACH, PROXY_SIT_TORSO_HEIGHT,
} from "./proxy-figure-shape.js";

function addPart(group, geometry, material, position) {
	const mesh = new THREE.Mesh(geometry, material);
	mesh.position.set(...position);
	mesh.castShadow = true;
	mesh.receiveShadow = true;
	mesh.frustumCulled = false;
	group.add(mesh);
	return mesh;
}

export function proxyYaw(rot, posture = "stand") {
	return (rot * Math.PI) / 180 + (posture === "lie" ? Math.PI : 0);
}

export const ProxyFigure = memo(function ProxyFigure({
	position,
	rot,
	tint,
	scale = 1,
	posture = "stand",
	pickId,
	selected,
	onFrame,
}) {
	const seated = posture === "sit";
	const bodyHeight = seated ? PROXY_SIT_TORSO_HEIGHT : BODY_HEIGHT;
	const model = useMemo(() => {
		const bodyMaterial = new THREE.MeshStandardMaterial({
			color: tint ?? defaultCharacterTint({ model: "proxy-figure" }, 0),
			roughness: 0.66,
			metalness: 0,
			envMapIntensity: 0.35,
		});
		const group = new THREE.Group();
		addPart(group, new THREE.CapsuleGeometry(BODY_RADIUS, bodyHeight - BODY_RADIUS * 2, 12, 20), bodyMaterial, [0, bodyHeight / 2, 0]);
		addPart(group, new THREE.SphereGeometry(HEAD_RADIUS, 16, 12), bodyMaterial, [0, bodyHeight + PROXY_HEAD_LIFT, 0]);
		if (seated) {
			// Legs on the floor from behind the hip to PROXY_SIT_LEG_REACH ahead of
			// it, along local +z: the way the figure (and a rig at the same rot) faces.
			const legs = addPart(group, new THREE.CapsuleGeometry(BODY_RADIUS, PROXY_SIT_LEG_REACH - BODY_RADIUS, 12, 20), bodyMaterial,
				[0, BODY_RADIUS, (PROXY_SIT_LEG_REACH - BODY_RADIUS) / 2]);
			legs.rotation.x = Math.PI / 2;
		}
		return group;
	}, [bodyHeight, seated, tint]);
	useEffect(() => () => {
		const materials = new Set();
		model.traverse(node => {
			if (!node.isMesh) return;
			node.geometry.dispose();
			materials.add(node.material);
		});
		for (const material of materials) material.dispose();
	}, [model]);

	// The placed group is the figure's root frame: props attached to it ride it (stage-attach-frames.js).
	const rootRef = useRef(null);
	useEffect(() => {
		onFrame?.(rootRef.current);
		return () => onFrame?.(null);
	}, [onFrame]);

	return (
		<group
			ref={rootRef}
			position={position}
			rotation={[0, proxyYaw(rot, posture), 0]}
			scale={scale}
			userData={pickId ? { characterPick: pickId, selected: !!selected } : undefined}
		>
			<group position={posture === "lie" ? [0, BODY_RADIUS, 0] : [0, 0, 0]} rotation={posture === "lie" ? [-Math.PI / 2, 0, 0] : [0, 0, 0]}>
				<primitive object={model} />
			</group>
		</group>
	);
});

