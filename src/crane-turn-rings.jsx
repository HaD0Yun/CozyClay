import { useEffect, useRef, useState } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { GIZMO_LAYER } from "./dualview.jsx";
import { railPoint } from "./camera-follow.js";
import { GizmoLabel } from "./stage-editor-gizmos.jsx";

/**
 * The rotate tool (E) on a selected camera-rail mark: a pan ring (about up) and a tilt ring (about the
 * camera's right where it passes the mark) that turn the head at that place of the rail — the mark's
 * yawDeg / pitchDeg (camera-rail-head.js railTurnAt), eased between marks like the crane height. They
 * stand at the dot the user selected, with a line the way the shot camera looks there, so what a ring turns
 * is in front of the hand even when the camera body is elsewhere on the rail. Move (W) keeps the arrows
 * (CraneHandles); the camera's own rings (the object gizmo) still turn the whole shot.
 */
const RING_R = 0.42;
const GIZMO_SCALE = 0.16; // metres of gizmo per metre of editor-camera distance, as the crane arrows
const PITCH_LIMIT = 85;
const RINGS = [
	{ key: "yawDeg", label: "pan", color: "#54e05c", axis: new THREE.Vector3(0, 1, 0), rotation: [Math.PI / 2, 0, 0] },
	{ key: "pitchDeg", label: "tilt", color: "#ff5340", axis: new THREE.Vector3(1, 0, 0), rotation: [0, Math.PI / 2, 0] },
];
const wrapDeg = (deg) => ((((deg + 180) % 360) + 360) % 360) - 180;

export function CraneTurnRings({ rail, crane, selectedIndex, enabled, view, paneRef, camRef, onChangePoints }) {
	const { gl } = useThree();
	const invalidate = useThree((state) => state.invalidate);
	const groupRef = useRef(null);
	const dragRef = useRef(null);
	const stateRef = useRef(null);
	const [lit, setLit] = useState(null);
	const point = enabled && rail && selectedIndex != null ? crane?.points?.[selectedIndex] : null;
	const base = point ? railPoint(rail, point.t * rail.length) : null;
	// the tilt ring and the view line stand in the camera's heading there; the rail's own direction without a view
	const heading = view?.yaw ?? (() => {
		if (!base) return 0;
		const ahead = railPoint(rail, Math.min(rail.length, point.t * rail.length + 0.05)), behind = railPoint(rail, Math.max(0, point.t * rail.length - 0.05));
		return Math.atan2(-(ahead.x - behind.x), -(ahead.z - behind.z));
	})();
	stateRef.current = { crane, selectedIndex, point, base, heading, onChangePoints };
	useFrame(() => {
		const group = groupRef.current, camera = camRef.current;
		if (!group || !camera) return;
		group.scale.setScalar(Math.max(0.35, camera.getWorldPosition(new THREE.Vector3()).distanceTo(group.getWorldPosition(new THREE.Vector3())) * GIZMO_SCALE));
	});
	useEffect(() => {
		groupRef.current?.traverse((node) => node.layers?.set(GIZMO_LAYER));
		invalidate();
	});
	useEffect(() => {
		if (!enabled) return undefined;
		const raycaster = new THREE.Raycaster();
		raycaster.layers.set(GIZMO_LAYER);
		const rayFrom = (event) => {
			const pane = paneRef.current, camera = camRef.current;
			if (!pane || !camera) return null;
			const bounds = pane.getBoundingClientRect();
			if (bounds.width < 2 || bounds.height < 2) return null;
			const ndc = new THREE.Vector2(((event.clientX - bounds.left) / bounds.width) * 2 - 1, -((event.clientY - bounds.top) / bounds.height) * 2 + 1);
			if (Math.abs(ndc.x) > 1 || Math.abs(ndc.y) > 1) return null;
			camera.updateMatrixWorld();
			raycaster.setFromCamera(ndc, camera);
			return raycaster;
		};
		const ringUnder = (event) => {
			if (!groupRef.current || !rayFrom(event)) return null;
			return raycaster.intersectObjects(groupRef.current.children, true).find((entry) => entry.object.userData?.craneRing)?.object.userData.craneRing ?? null;
		};
		// The pointer's angle around the ring, read in the ring's own plane (the object gizmo's way).
		const angleOn = (drag) => {
			const hit = new THREE.Vector3();
			if (!raycaster.ray.intersectPlane(drag.plane, hit)) return null;
			const offset = hit.sub(drag.origin);
			return offset.lengthSq() < 1e-8 ? null : Math.atan2(offset.dot(drag.binormal), offset.dot(drag.tangent));
		};
		const onDown = (event) => {
			const s = stateRef.current;
			if (event.button !== 0 || !s.point) return;
			const key = ringUnder(event);
			if (!key) return;
			const ring = RINGS.find((entry) => entry.key === key);
			const normal = ring.axis.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), s.heading);
			const origin = new THREE.Vector3(s.base.x, s.point.height, s.base.z);
			const tangent = new THREE.Vector3(normal.y, normal.z, normal.x).cross(normal).normalize();
			const drag = { key, origin, plane: new THREE.Plane().setFromNormalAndCoplanarPoint(normal, origin), tangent, binormal: normal.clone().cross(tangent).normalize(), turned: 0, start: s.point[key] ?? 0, index: s.selectedIndex };
			drag.last = angleOn(drag);
			if (drag.last == null) return;
			event.stopImmediatePropagation();
			event.preventDefault();
			dragRef.current = drag;
			gl.domElement.style.cursor = "grabbing";
			setLit(key);
		};
		const onMove = (event) => {
			const drag = dragRef.current, s = stateRef.current;
			if (!drag || !s.crane || !rayFrom(event)) return;
			const angle = angleOn(drag);
			if (angle == null) return;
			// wrapped increments: crossing the ring's seam never jumps a turn
			drag.turned += wrapDeg(((angle - drag.last) * 180) / Math.PI);
			drag.last = angle;
			const step = event.ctrlKey || event.metaKey ? 5 : 0.5;
			const raw = Math.round((drag.start + drag.turned) / step) * step;
			const value = drag.key === "pitchDeg" ? Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, raw)) : wrapDeg(raw);
			// one gesture, one undo step: the shots domain opens it on the first dragging write and closes it on release
			s.onChangePoints(s.crane.points.map((entry, i) => (i === drag.index ? { ...entry, [drag.key]: value } : entry)), { dragging: true });
			invalidate();
		};
		const onUp = () => {
			if (!dragRef.current) return;
			dragRef.current = null;
			gl.domElement.style.cursor = "";
			setLit(null);
		};
		const onHover = (event) => {
			if (dragRef.current || event.buttons !== 0 || event.target !== gl.domElement) return;
			const key = ringUnder(event);
			setLit((current) => (current === key ? current : key));
			if (key) gl.domElement.style.cursor = "grab";
		};
		// QA hook (harmless in use): which ring a press at these client pixels would take
		window.__craneRingAt = (x, y) => ringUnder({ clientX: x, clientY: y });
		const el = gl.domElement;
		el.addEventListener("pointerdown", onDown, true);
		window.addEventListener("pointermove", onMove, true);
		window.addEventListener("pointerup", onUp, true);
		window.addEventListener("pointermove", onHover);
		return () => {
			el.removeEventListener("pointerdown", onDown, true);
			window.removeEventListener("pointermove", onMove, true);
			window.removeEventListener("pointerup", onUp, true);
			window.removeEventListener("pointermove", onHover);
			delete window.__craneRingAt;
		};
		// paneRef/camRef are stable refs; handlers read live state through stateRef
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [enabled, gl, invalidate]);
	if (!point) return null;
	const pitch = view?.pitch ?? 0;
	const look = [-Math.sin(heading) * Math.cos(pitch), Math.sin(pitch), -Math.cos(heading) * Math.cos(pitch)];
	const turned = (key) => (point[key] ?? 0).toFixed(1);
	return (
		<group>
			<group ref={groupRef} position={[base.x, point.height, base.z]}>
				<group rotation={[0, heading, 0]}>
					{RINGS.map(({ key, color, rotation }) => (
						<group key={key} rotation={rotation}>
							<mesh renderOrder={999}>
								<torusGeometry args={[RING_R, lit === key ? 0.03 : 0.022, 8, 48]} />
								<meshBasicMaterial color={lit === key ? "#ffd23d" : color} depthTest={false} depthWrite={false} transparent opacity={0.95} toneMapped={false} />
							</mesh>
							{/* the grab band: a 2 cm ring is nothing to aim at */}
							<mesh userData={{ craneRing: key }}>
								<torusGeometry args={[RING_R, 0.07, 6, 32]} />
								<meshBasicMaterial visible={false} />
							</mesh>
						</group>
					))}
				</group>
				{/* the way the shot camera looks where it passes this mark */}
				<mesh position={look.map((v) => v * 0.33)} quaternion={new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(...look))} renderOrder={999}>
					<cylinderGeometry args={[0.012, 0.012, 0.66, 6]} />
					<meshBasicMaterial color="#ffffff" depthTest={false} depthWrite={false} transparent opacity={0.9} />
				</mesh>
				<mesh position={look.map((v) => v * 0.72)} quaternion={new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(...look))} renderOrder={999}>
					<coneGeometry args={[0.045, 0.12, 12]} />
					<meshBasicMaterial color="#ffffff" depthTest={false} depthWrite={false} transparent opacity={0.9} />
				</mesh>
			</group>
			{lit && (
				<GizmoLabel position={[base.x, point.height + 0.5, base.z]} camRef={camRef}
					text={`${RINGS.find((entry) => entry.key === lit).label} ${turned(lit)}°`} />
			)}
		</group>
	);
}
