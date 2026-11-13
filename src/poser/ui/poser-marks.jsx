// What Auto Pose handles look like, in the IK handles' vocabulary (pose-gizmo.js colours, camera-facing halo rings,
// drawn over the body on the poser camera's layer). States read apart without colour alone:
// held = solid dot + thick ring + outer hold ring; following = solid dot + thin ring; off = hollow faint ring;
// turn-only handles are diamonds; selected = white outer ring; hover grows the mark.
import * as THREE from "three";
import { POSER_LAYER } from "../../dualview.jsx";
import { backFaceFade, handleColor, ROTATION_AXES } from "../../pose-gizmo.js";
import { canMove } from "./handle-state.js";

const BIG = new Set(["hips", "leftHand", "rightHand", "leftFoot", "rightFoot"]);
/** Grab radius (metres) of a handle; the drawn dot is about half of it. */
export const markRadius = (id) => (BIG.has(id) ? 0.055 : 0.042);
/** Radius of the turn rings around the selected handle (metres). */
const RING_RADIUS = 0.16;
const RING_TUBE = 0.0045;
const markColor = (id) => handleColor(id === "lookAt" || id === "neck" ? "head" : id);
const onPoserLayer = (m) => m?.layers.set(POSER_LAYER);
const overlay = { toneMapped: false, depthTest: false, depthWrite: false, transparent: true };

/** One handle: a group the frame loop moves and paints (see paintMark). */
export function HandleMark({ id, groupRef }) {
	const r = markRadius(id), color = markColor(id), diamond = !canMove(id);
	return (
		<group ref={groupRef} renderOrder={999}>
			<mesh name="core" renderOrder={999} ref={onPoserLayer} raycast={() => {}}>
				{diamond ? <octahedronGeometry args={[r * 0.6]} /> : <sphereGeometry args={[r * 0.52, 20, 14]} />}
				<meshBasicMaterial color={color} {...overlay} />
			</mesh>
			<mesh name="ring" renderOrder={998} ref={onPoserLayer} raycast={() => {}}>
				<ringGeometry args={[r * 0.8, r * 0.92, 48]} />
				<meshBasicMaterial color={color} {...overlay} side={THREE.DoubleSide} />
			</mesh>
			<mesh name="thick" renderOrder={998} ref={onPoserLayer} raycast={() => {}}>
				<ringGeometry args={[r * 0.74, r * 1.0, 48]} />
				<meshBasicMaterial color={color} {...overlay} side={THREE.DoubleSide} />
			</mesh>
			<mesh name="hold" renderOrder={998} ref={onPoserLayer} raycast={() => {}}>
				<ringGeometry args={[r * 1.12, r * 1.2, 48]} />
				<meshBasicMaterial color={color} {...overlay} side={THREE.DoubleSide} />
			</mesh>
			<mesh name="select" renderOrder={1000} ref={onPoserLayer} raycast={() => {}}>
				<ringGeometry args={[r * 1.3, r * 1.42, 48]} />
				<meshBasicMaterial color="#ffffff" {...overlay} side={THREE.DoubleSide} />
			</mesh>
		</group>
	);
}

/** Paint a mark for its state: `{ enabled, held, selected, hover, active }`. */
export function paintMark(group, { enabled, held, selected, hover, active }) {
	const [core, ring, thick, holdRing, select] = group.children;
	core.visible = enabled;
	core.material.opacity = active ? 1 : held ? 1 : 0.85;
	ring.visible = !(enabled && held);
	ring.material.opacity = enabled ? 0.7 : 0.4;
	thick.visible = enabled && held;
	thick.material.opacity = 1;
	holdRing.visible = enabled && held;
	holdRing.material.opacity = 0.9;
	select.visible = selected || active;
	select.material.opacity = active ? 1 : 0.8;
	group.scale.setScalar(hover || active ? 1.18 : enabled ? 1 : 0.8);
}

/** World-axis turn rings for the selected handle; `hot` is the hovered or dragged axis. */
export function TurnRings({ groupRef }) {
	return (
		<group ref={groupRef} renderOrder={999} visible={false}>
			{ROTATION_AXES.map(({ axis, dir, color }) => (
				<group key={axis} name={axis} quaternion={new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir)}>
					<mesh ref={onPoserLayer} raycast={() => {}}>
						<torusGeometry args={[RING_RADIUS, RING_TUBE, 6, 96]} />
						<meshBasicMaterial ref={(m) => m && backFaceFade(m)} color={color} {...overlay} opacity={0.7} />
					</mesh>
				</group>
			))}
		</group>
	);
}

/** Highlight the hot ring axis (or none); while one drags, the others fade. */
export function paintRings(group, hot, dragging) {
	for (const child of group.children) {
		const mesh = child.children[0], on = child.name === hot;
		mesh.material.opacity = dragging ? (on ? 1 : 0.15) : on ? 1 : 0.55;
	}
}

/** Outline points of each ring (world), for screen-space picking: `{ axis, dir, points: THREE.Vector3[] }`. */
export function ringOutlines(centre, samples = 64) {
	return ROTATION_AXES.map(({ axis, dir }) => {
		const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir), points = [];
		for (let i = 0; i < samples; i += 1) {
			const a = (i / samples) * Math.PI * 2;
			points.push(new THREE.Vector3(Math.cos(a) * RING_RADIUS, Math.sin(a) * RING_RADIUS, 0).applyQuaternion(q).add(centre));
		}
		return { axis, dir, points };
	});
}

/** A thin line from the head to the look-at point. */
export function LookLine({ lineRef }) {
	return (
		<line ref={(l) => { if (l) { l.layers.set(POSER_LAYER); lineRef.current = l; } }} renderOrder={997} raycast={() => {}}>
			<bufferGeometry><bufferAttribute attach="attributes-position" args={[new Float32Array(6), 3]} /></bufferGeometry>
			<lineBasicMaterial color={markColor("lookAt")} {...overlay} opacity={0.6} />
		</line>
	);
}

/** Thin lines from each joint to its handle when the handle sits away from it (a held place the body did not reach). */
export function Tethers({ lineRef, count }) {
	return (
		<lineSegments ref={(l) => { if (l) { l.layers.set(POSER_LAYER); lineRef.current = l; } }} renderOrder={997} raycast={() => {}} frustumCulled={false}>
			<bufferGeometry><bufferAttribute attach="attributes-position" args={[new Float32Array(count * 6), 3]} /></bufferGeometry>
			<lineBasicMaterial color="#ffffff" {...overlay} opacity={0.75} />
		</lineSegments>
	);
}
