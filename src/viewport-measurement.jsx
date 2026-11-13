import { useEffect, useState } from "react";
import { useThree } from "@react-three/fiber";
import { Html, Line } from "@react-three/drei";
import * as THREE from "three";
import { GIZMO_LAYER } from "./dualview.jsx";
import { setViewportTool, useViewportTools } from "./viewport-tools.js";
import { ko } from "./locale.js";

export default function ViewportMeasurement({ camRef }) {
	const { gl, scene } = useThree();
	const { measure } = useViewportTools();
	const [points, setPoints] = useState([]);
	useEffect(() => {
		if (!measure) return undefined;
		setPoints([]);
		const raycaster = new THREE.Raycaster();
		const onPick = event => {
			if (event.button !== 0 || event.target !== gl.domElement) return;
			const rect = gl.domElement.getBoundingClientRect();
			const ndc = new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
			const camera = camRef.current;
			if (!camera) return;
			raycaster.setFromCamera(ndc, camera);
			raycaster.layers.set(0);
			const hit = raycaster.intersectObjects(scene.children, true).find(entry => entry.object.isMesh && entry.object.visible && !entry.object.userData?.noMeasure);
			const point = hit?.point.clone() ?? raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), new THREE.Vector3());
			if (!point) return;
			event.preventDefault(); event.stopImmediatePropagation();
			setPoints(current => current.length === 1 ? [current[0], point] : [point]);
		};
		const onKey = event => {
			if (event.key !== "Escape") return;
			setPoints([]); setViewportTool("measure", false);
		};
		window.addEventListener("pointerdown", onPick, true);
		window.addEventListener("keydown", onKey);
		return () => {
			window.removeEventListener("pointerdown", onPick, true);
			window.removeEventListener("keydown", onKey);
		};
	}, [measure, gl, scene, camRef]);
	if (!measure) return null;
	const middle = points.length === 2 ? points[0].clone().add(points[1]).multiplyScalar(0.5) : points[0];
	const distance = points.length === 2 ? points[0].distanceTo(points[1]) : null;
	return <>
	<Html center zIndexRange={[30, 0]} style={{ pointerEvents: "none" }}>
		<span className="viewport-measure-status" data-testid="measure-status" data-points={points.length} role="status">
			{points.length === 0 ? "Ruler: pick the first surface point" : points.length === 1 ? "Ruler: pick the second point" : `${distance.toFixed(3)} m`}
		</span>
	</Html>
	{points.length > 0 && <group layers={GIZMO_LAYER} userData={{ noMeasure: true, noXray: true }}>
		{points.map((point, index) => <mesh key={index} position={point} userData={{ noMeasure: true, noXray: true }}>
			<sphereGeometry args={[0.045, 12, 8]} /><meshBasicMaterial color="#ffbf47" depthTest={false} />
		</mesh>)}
		{points.length === 2 && <Line points={points} color="#ffbf47" lineWidth={2} depthTest={false} />}
		<Html position={middle} center zIndexRange={[30, 0]} style={{ pointerEvents: "none" }}>
			<span className="viewport-measure-readout">{distance === null ? ko("Pick second point", "두 번째 점 선택", "选择第二个点") : `${distance.toFixed(3)} m`}</span>
		</Html>
	</group>}
	</>;
}
