import { useEffect, useMemo, useRef, useState } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import { Line, Text } from "@react-three/drei";
import * as THREE from "three";
import { GIZMO_LAYER } from "./dualview.jsx";
import { craneHeightAt, prepareRailBend, railPoint } from "./camera-follow.js";
import { floorDragStart } from "./rail-dot-drag.js";
import { insertPathMark, MARK_GAP, MAX_PATH_LEAN, MAX_PATH_MARKS, MAX_PATH_POINTS, nearestPathFraction, pathCurve, pathMarkFractions, pathMarks, pathPointAtFraction } from "./object-path.js";

/**
 * The key light drawn as a grabbable sun in the editor view: a warm core with
 * rays, on GIZMO_LAYER so preview, capture and PlayView never see it. A line
 * drops to the floor so its height reads against the stage, like the crane's.
 * The sun's own body is the drag surface — a grab moves it freely on the
 * camera-facing plane (the cursor and the sun stay glued), and the gizmo's
 * arrows (via ObjectGizmo) stay available for single-axis precision. Its
 * colour follows the dial, and while selected a ray points at the stage so
 * the light's direction reads at a glance.
 */
export function KeyLightPuck({ keyLight, selected, visible, paneRef, camRef, onSelect, onChange, onDragEnd }) {
	const { gl } = useThree();
	const groupRef = useRef(null);
	const dragRef = useRef(null);
	const stateRef = useRef(null);
	const [dragKind, setDragKind] = useState(null);
	const invalidate = useThree((state) => state.invalidate);
	stateRef.current = { keyLight, visible, onSelect, onChange, onDragEnd };
	useEffect(() => {
		groupRef.current?.traverse((node) => node.layers?.set(GIZMO_LAYER));
		invalidate();
	}, [visible, selected, keyLight, dragKind, invalidate]);
	useEffect(() => {
		if (!visible) return undefined;
		const raycaster = new THREE.Raycaster();
		raycaster.layers.set(GIZMO_LAYER);
		const rayFrom = (event) => {
			const pane = paneRef.current;
			const camera = camRef.current;
			if (!pane || !camera) return null;
			const bounds = pane.getBoundingClientRect();
			if (bounds.width < 2 || bounds.height < 2) return null;
			const ndc = new THREE.Vector2(
				((event.clientX - bounds.left) / bounds.width) * 2 - 1,
				-((event.clientY - bounds.top) / bounds.height) * 2 + 1,
			);
			if (Math.abs(ndc.x) > 1 || Math.abs(ndc.y) > 1) return null;
			camera.updateMatrixWorld();
			raycaster.setFromCamera(ndc, camera);
			return raycaster;
		};
		const onDown = (event) => {
			const s = stateRef.current;
			if (event.button !== 0 || event.altKey) return;
			if (!groupRef.current || !rayFrom(event)) return;
			const hit = raycaster.intersectObjects(groupRef.current.children, true)
				.find((entry) => {
					for (let node = entry.object; node; node = node.parent) if (node.userData?.keyLightPick) return true;
					return false;
				});
			if (!hit) return;
			event.stopImmediatePropagation();
			event.preventDefault();
			s.onSelect?.();
			const start = { ...s.keyLight };
			const origin = new THREE.Vector3(start.x, start.y, start.z);
			// free move on the camera-facing plane through the sun: the cursor
			// and the sun stay glued from any viewing angle — no degenerate
			// floor-plane geometry when the sun is viewed from below
			const facing = new THREE.Vector3();
			camRef.current.getWorldDirection(facing);
			const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(facing, origin);
			const hitStart = new THREE.Vector3();
			if (!raycaster.ray.intersectPlane(plane, hitStart)) return;
			dragRef.current = { start, plane, hitStart, moved: false };
			setDragKind("move");
			invalidate();
		};
		const onMove = (event) => {
			const drag = dragRef.current;
			if (!drag || !rayFrom(event)) return;
			const world = new THREE.Vector3();
			if (!raycaster.ray.intersectPlane(drag.plane, world)) return;
			drag.moved = true;
			stateRef.current.onChange?.({
				x: drag.start.x + (world.x - drag.hitStart.x),
				y: drag.start.y + (world.y - drag.hitStart.y),
				z: drag.start.z + (world.z - drag.hitStart.z),
			}, { dragging: true });
			invalidate();
		};
		const onUp = () => {
			const drag = dragRef.current;
			if (!drag) return;
			dragRef.current = null;
			setDragKind(null);
			if (drag.moved) stateRef.current.onDragEnd?.();
			invalidate();
		};
		const el = gl.domElement;
		el.addEventListener("pointerdown", onDown);
		window.addEventListener("pointermove", onMove, true);
		window.addEventListener("pointerup", onUp, true);
		return () => {
			el.removeEventListener("pointerdown", onDown);
			window.removeEventListener("pointermove", onMove, true);
			window.removeEventListener("pointerup", onUp, true);
		};
		// paneRef/camRef are stable refs; handlers read live state through stateRef
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [visible, gl, invalidate]);
	const drop = useMemo(() => new Float32Array([0, 0, 0, 0, -keyLight.y, 0]), [keyLight.y]);
	// the sun dims with its own dial, so the stage's mood reads off the puck
	const glow = Math.max(0.18, Math.min(1, keyLight.intensity / 1.12));
	const sunColor = useMemo(
		() => new THREE.Color("#5c5040").lerp(new THREE.Color(selected ? "#ffcf5e" : "#f2b544"), glow).getStyle(),
		[selected, glow],
	);
	if (!visible) return null;
	return (
		<group ref={groupRef} position={[keyLight.x, keyLight.y, keyLight.z]}>
			<mesh userData={{ keyLightPick: true }}>
				<sphereGeometry args={[0.16, 20, 16]} />
				<meshBasicMaterial color={sunColor} toneMapped={false} />
			</mesh>
			{/* rays: eight short spokes so it reads as a sun, not a ball */}
			{Array.from({ length: 8 }, (_, i) => {
				const angle = (i / 8) * Math.PI * 2;
				return (
					<mesh key={i} userData={{ keyLightPick: true }} position={[Math.cos(angle) * 0.27, Math.sin(angle) * 0.27, 0]} rotation={[0, 0, angle + Math.PI / 2]}>
						<cylinderGeometry args={[0.014, 0.014, 0.1, 6]} />
						<meshBasicMaterial color={sunColor} toneMapped={false} />
					</mesh>
				);
			})}
			{/* the real grab surface: generous, invisible, around the whole sun */}
			<mesh userData={{ keyLightPick: true }}>
				<sphereGeometry args={[0.42, 12, 10]} />
				<meshBasicMaterial visible={false} />
			</mesh>
			<lineSegments>
				<bufferGeometry>
					<bufferAttribute attach="attributes-position" array={drop} count={2} itemSize={3} />
				</bufferGeometry>
				<lineBasicMaterial color="#f2b544" transparent opacity={selected ? 0.6 : 0.25} />
			</lineSegments>
			{/* where the light points: a dashed ray toward the stage centre */}
			{selected && (
				<Line
					points={[[0, 0, 0], [-keyLight.x * 0.86, -keyLight.y * 0.86, -keyLight.z * 0.86]]}
					color="#ffb454"
					lineWidth={1.6}
					dashed
					dashSize={0.32}
					gapSize={0.22}
					transparent
					opacity={0.45}
				/>
			)}
			{/* live readout while the sun is being dragged */}
			{dragKind && (
				<GizmoLabel
					position={[0, 0.5, 0]}
					text={`x ${keyLight.x.toFixed(1)}  y ${keyLight.y.toFixed(1)}  z ${keyLight.z.toFixed(1)}`}
					camRef={camRef}
				/>
			)}
		</group>
	);
}

/**
 * The shot camera drawn as an object in the editor view: a body and a short
 * frustum wireframe on GIZMO_LAYER, synced from the live camera every frame.
 * Preview, capture and PlayView draws all drop GIZMO_LAYER, so the ghost can
 * never reach a recorded frame.
 */
export function ShotCameraGhost({ camRef, fovDeg, aspect, visible, selected }) {
	const groupRef = useRef(null);
	const invalidate = useThree((state) => state.invalidate);
	const frustum = useMemo(() => {
		const depth = 0.62;
		const h = Math.tan(THREE.MathUtils.degToRad(fovDeg) / 2) * depth;
		const w = h * aspect;
		const corners = [[-w, h], [w, h], [w, -h], [-w, -h]];
		const points = [];
		for (const [x, y] of corners) points.push(0, 0, 0, x, y, -depth);
		for (let i = 0; i < 4; i++) {
			const [ax, ay] = corners[i];
			const [bx, by] = corners[(i + 1) % 4];
			points.push(ax, ay, -depth, bx, by, -depth);
		}
		return new Float32Array(points);
	}, [fovDeg, aspect]);
	useEffect(() => {
		groupRef.current?.traverse((node) => node.layers?.set(GIZMO_LAYER));
		invalidate();
	}, [visible, frustum, selected, invalidate]);
	useFrame(() => {
		const cam = camRef.current;
		const group = groupRef.current;
		if (!cam || !group) return;
		group.position.copy(cam.position);
		group.quaternion.copy(cam.quaternion);
	});
	if (!visible) return null;
	return (
		<group ref={groupRef}>
			<mesh userData={{ shotCameraPick: true }} position={[0, 0, 0.06]}>
				<boxGeometry args={[0.15, 0.11, 0.2]} />
				<meshBasicMaterial color={selected ? "#ffb454" : "#3b6ea5"} />
			</mesh>
			{/* the lens: a short cone opening toward the view direction */}
			<mesh userData={{ shotCameraPick: true }} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, -0.075]}>
				<coneGeometry args={[0.052, 0.09, 20, 1, true]} />
				<meshBasicMaterial color={selected ? "#e09a3e" : "#2f5a8a"} side={THREE.DoubleSide} />
			</mesh>
			<lineSegments key={`${fovDeg}:${aspect}`}>
				<bufferGeometry>
					<bufferAttribute attach="attributes-position" array={frustum} count={frustum.length / 3} itemSize={3} />
				</bufferGeometry>
				<lineBasicMaterial color={selected ? "#ffb454" : "#6f9cc9"} transparent opacity={0.85} />
			</lineSegments>
		</group>
	);
}

/**
 * The drawn camera rail in the 3D Scene view: editor furniture on the gizmo
 * layer, so PlayView, the ink prepass and exports never see it.
 */
export function CameraRailScenePreview({ points, cumLen, length, crane }) {
	const rootRef = useRef(null);
	const lines = useMemo(() => {
		if (!points || points.length < 2) return null;
		const floor = points.map((point) => [point.x, 0.03, point.z]);
		// A craned rail shows WHERE THE LENS RIDES: the same path lifted along
		// the crane's start→end heights by arc progress, with the floor line
		// kept as the track's ground projection.
		const lifted = crane && cumLen && length > 1e-9
			? points.map((point, i) => [point.x, craneHeightAt(crane, cumLen[i] / length), point.z])
			: null;
		return { floor, lifted };
	}, [points, cumLen, length, crane]);
	useEffect(() => {
		rootRef.current?.traverse((node) => node.layers.set(GIZMO_LAYER));
	});
	if (!lines) return null;
	// drei's Line renders screen-space fat lines: a WebGL <line> is always
	// 1px, which reads as a hairline on dense displays.
	return (
		<group ref={rootRef}>
			<Line points={lines.floor} color="#a78bfa" lineWidth={2} transparent opacity={lines.lifted ? 0.35 : 0.8} depthWrite={false} />
			{lines.lifted && (
				<Line points={lines.lifted} color="#a78bfa" lineWidth={2.5} transparent opacity={0.9} depthWrite={false} />
			)}
		</group>
	);
}


/**
 * The crane's height marks as grabbable dots on the lifted curve. Click a
 * dot to select it; the selected dot grows a 3-axis gizmo — Y sets the
 * mark's height, X/Z bend the camera path itself by moving the drawn rail
 * control point nearest the mark. A free drag moves the dot over the floor, bending the rail (rail-dot-drag.js);
 * Shift-drag slides along the arc at a fixed height, double-click the curve
 * adds a mark and Delete removes a non-endpoint. Dots live on GIZMO_LAYER, so the
 * recording never sees them.
 */
export const CRANE_AXES = [
	{ axis: "x", dir: new THREE.Vector3(1, 0, 0), color: "#ff5340" },
	{ axis: "y", dir: new THREE.Vector3(0, 1, 0), color: "#54e05c" },
	{ axis: "z", dir: new THREE.Vector3(0, 0, 1), color: "#3d8bff" },
];
export const CRANE_ARROW_LEN = 0.5;
export const CRANE_GIZMO_SCALE = 0.16; // metres of gizmo per metre of camera distance

// The rail-bend preparation is shared with the Top-View board and lives with the
// rest of the rail math.
export { prepareRailBend };

/**
 * A floating readout beside a drag — billboarded, sized to the screen, on
 * GIZMO_LAYER so it is editor furniture the recording never sees.
 */
export function GizmoLabel({ position, text, camRef }) {
	const ref = useRef(null);
	useFrame(() => {
		const cam = camRef?.current;
		const node = ref.current;
		if (!cam || !node) return;
		node.quaternion.copy(cam.getWorldQuaternion(new THREE.Quaternion()));
		const world = node.getWorldPosition(new THREE.Vector3());
		node.scale.setScalar(Math.max(0.4, cam.getWorldPosition(new THREE.Vector3()).distanceTo(world) * 0.11));
		node.traverse((child) => child.layers?.set(GIZMO_LAYER));
	});
	return (
		<Text
			ref={ref}
			position={position}
			fontSize={0.19}
			color="#ffd27a"
			outlineWidth={0.014}
			outlineColor="#241a05"
			anchorX="center"
			anchorY="bottom"
			renderOrder={1000}
			material-depthTest={false}
			material-transparent
		>
			{text}
		</Text>
	);
}

// How near (screen pixels) a press must be to the drawn route to count as
// aimed at it — the line is thin, so the target is a generous band around it.
const PATH_LINE_PICK_PX = 14;
// A mark never sits closer than this to its neighbours (fraction of the route),
// a little over the schema's own gap so a slide never lands on the edge of it.
const PATH_MARK_CLEARANCE = MARK_GAP + 0.01;
// The selected dot's lean rings, in the travel frame (Y up, Z forward): bank
// spins about forward — a torus lies in XY, so its axis is already Z — and
// pitch about the lateral axis, the same torus turned onto YZ. The rotate tool
// (E) shows them in place of the move arrows, exactly as the object gizmo does.
const PATH_RING_R = 0.42;
const PATH_RINGS = [
	{ key: "bank", color: "#ffb454", rotation: [0, 0, 0] },
	{ key: "pitch", color: "#7cc7ff", rotation: [0, Math.PI / 2, 0] },
];
const wrapDeg = (deg) => ((((deg + 180) % 360) + 360) % 360) - 180;

/** A world point in the pane's client pixels, or null behind the camera. */
function paneProject(world, pane, camera) {
	if (!pane || !camera) return null;
	const bounds = pane.getBoundingClientRect();
	const projected = new THREE.Vector3(world.x, world.y ?? 0, world.z).project(camera);
	return projected.z > 1 ? null : {
		x: bounds.left + ((projected.x + 1) / 2) * bounds.width,
		y: bounds.top + ((1 - projected.y) / 2) * bounds.height,
	};
}

/**
 * A scene object's travel path in the 3D view, edited the way the camera rail
 * is (CraneHandles): the route is a dense curve, and a few MARKS ride on it —
 * the two ends, plus any added by double-clicking the line. Pressing a mark
 * selects it and drags it freely (the curve bends around it, fading out by the
 * neighbouring marks, so the marks beside it stay put); Shift slides it along
 * the route; the 3-axis gizmo on the selected mark bends x / z and lifts y;
 * Delete removes an interior mark. The marks are where a hand takes hold; the
 * route's own points are its shape and are moved by the bend, never one by one.
 */
export function ObjectPathHandles({ path, selectedIndex, enabled, mode = "move", paneRef, camRef, onSelect, onChangePath, onDragStart, onDragEnd }) {
	const { gl } = useThree();
	const invalidate = useThree((state) => state.invalidate);
	const groupRef = useRef(null);
	const gizmoRef = useRef(null);
	const dragRef = useRef(null);
	const stateRef = useRef(null);
	// What the pointer is doing: a bend drag lights up the span it deforms.
	const [dragInfo, setDragInfo] = useState(null);
	// Mark index under the pointer, for the hover highlight.
	const [hover, setHover] = useState(null);
	// The pointer is on the line where a dot could still be dropped.
	const [lineHover, setLineHover] = useState(false);
	// Which lean ring the pointer is over, for the hover highlight.
	const [ringHover, setRingHover] = useState(null);
	stateRef.current = { path, selectedIndex, enabled, mode, onSelect, onChangePath, onDragStart, onDragEnd };
	// The line is not a mesh the raycaster can hit, but the object gizmo's
	// selection handler decides "does this press belong to a path handle?" by
	// raycasting GIZMO_LAYER (gizmo-claim.js). This invisible node answers that
	// ray in SCREEN space — near the drawn curve counts — so a press on the
	// route is claimed instead of deselecting the object, which unmounted these
	// handles before the double-click that adds a mark could arrive.
	const lineProxy = useMemo(() => {
		const node = new THREE.Group();
		node.userData.pathLine = true;
		node.raycast = function raycastRoute(raycaster, intersects) {
			const s = stateRef.current;
			const camera = raycaster.camera ?? camRef.current;
			if (!s.enabled || !s.path || !camera || !paneRef.current) return;
			// Any point down the ray lands on the pointer's pixel: that is the pointer.
			const ahead = raycaster.ray.at(Math.max(1, (camera.near ?? 0.1) * 2), new THREE.Vector3());
			const pointer = paneProject(ahead, paneRef.current, camera);
			if (!pointer) return;
			const spot = nearestPathFraction(s.path, (world) => paneProject(world, paneRef.current, camera), pointer.x, pointer.y);
			if (spot && spot.d <= PATH_LINE_PICK_PX) intersects.push({ distance: 1e-3, point: ahead, object: node });
		};
		return node;
		// refs are stable
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);
	useFrame(() => {
		const gizmo = gizmoRef.current;
		const camera = camRef.current;
		if (!gizmo || !camera) return;
		const world = gizmo.getWorldPosition(new THREE.Vector3());
		gizmo.scale.setScalar(Math.max(0.35, camera.getWorldPosition(new THREE.Vector3()).distanceTo(world) * CRANE_GIZMO_SCALE));
	});
	// Everything here is editor furniture on GIZMO_LAYER — and the pick
	// raycasts look only there, so a handle that mounts later (the rings the
	// rotate tool brings) must be stamped too: `mode` is a dependency.
	useEffect(() => {
		groupRef.current?.traverse((node) => node.layers?.set(GIZMO_LAYER));
		invalidate();
	}, [path, selectedIndex, enabled, mode, dragInfo, invalidate]);
	useEffect(() => {
		if (!enabled) return undefined;
		const raycaster = new THREE.Raycaster();
		raycaster.layers.set(GIZMO_LAYER);
		const rayFrom = (event) => {
			const pane = paneRef.current;
			const camera = camRef.current;
			if (!pane || !camera) return null;
			const bounds = pane.getBoundingClientRect();
			if (bounds.width < 2 || bounds.height < 2) return null;
			const ndc = new THREE.Vector2(
				((event.clientX - bounds.left) / bounds.width) * 2 - 1,
				-((event.clientY - bounds.top) / bounds.height) * 2 + 1,
			);
			if (Math.abs(ndc.x) > 1 || Math.abs(ndc.y) > 1) return null;
			camera.updateMatrixWorld();
			raycaster.setFromCamera(ndc, camera);
			return raycaster;
		};
		const paneScreen = (world) => paneProject(world, paneRef.current, camRef.current);
		// The bend a drag of mark `index` will apply: the route's points with a
		// per-point weight (the camera rail's own preparation, so a mark deforms
		// the route the same way here), seeded with a vertex under the mark when
		// the stroke left none close enough to pull.
		const prepareBend = (s, index) => {
			const fractions = pathMarkFractions(s.path);
			const base = pathPointAtFraction(s.path, fractions[index]);
			if (!base) return null;
			return { base, fractions, bend: prepareRailBend(s.path.points, base, fractions.map((t) => ({ t })), index, { maxControls: MAX_PATH_POINTS }) };
		};
		// The travel frame at mark `index`: the heading the body has there (the
		// route's own direction), as forward / right vectors on the floor.
		const frameAt = (s, index) => {
			const t = pathMarkFractions(s.path)[index];
			const before = pathPointAtFraction(s.path, Math.max(0, t - 0.01));
			const after = pathPointAtFraction(s.path, Math.min(1, t + 0.01));
			const yaw = before && after ? Math.atan2(after.x - before.x, after.z - before.z) : 0;
			return { yaw, forward: new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw)), right: new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw)) };
		};
		const onDown = (event) => {
			const s = stateRef.current;
			if (!s.enabled || !s.path || event.button !== 0) return;
			if (!groupRef.current || !rayFrom(event)) return;
			const hits = raycaster.intersectObjects(groupRef.current.children, true);
			// A ring on the selected dot turns its lean: bank about the travel
			// direction, pitch about the lateral axis. The pointer's angle around
			// the ring is read in the ring's own plane, the object gizmo's way.
			const ringHit = hits.find((entry) => entry.object.userData?.pathRing);
			if (ringHit && s.mode === "rotate" && s.selectedIndex != null) {
				const key = ringHit.object.userData.pathRing;
				const fractions = pathMarkFractions(s.path);
				if (s.selectedIndex <= 0 || s.selectedIndex >= fractions.length - 1) return;
				const base = pathPointAtFraction(s.path, fractions[s.selectedIndex]);
				if (!base) return;
				const frame = frameAt(s, s.selectedIndex);
				const spin = key === "bank" ? frame.forward : frame.right;
				const origin = new THREE.Vector3(base.x, base.y, base.z);
				const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(spin, origin);
				const hit = new THREE.Vector3();
				if (!raycaster.ray.intersectPlane(plane, hit)) return;
				const tangent = new THREE.Vector3(spin.y, spin.z, spin.x).cross(spin).normalize();
				const binormal = spin.clone().cross(tangent).normalize();
				const offset = hit.clone().sub(origin);
				if (offset.lengthSq() < 1e-8) return;
				event.stopImmediatePropagation();
				event.preventDefault();
				const marks = pathMarks(s.path);
				dragRef.current = {
					ring: key, index: s.selectedIndex, origin, plane, tangent, binormal,
					lastAngle: Math.atan2(offset.dot(binormal), offset.dot(tangent)), turned: 0,
					startValue: marks[s.selectedIndex - 1]?.[key] ?? 0, marks, recorded: false,
				};
				gl.domElement.style.cursor = "grabbing";
				setDragInfo({ ring: key });
				invalidate();
				return;
			}
			// The axis gizmo outranks the dots: its arrows sit on the selected
			// mark, and a press on an arrow is a directed move, not a reselect.
			const axisHit = hits.find((entry) => entry.object.userData?.pathAxis);
			if (axisHit && s.selectedIndex != null) {
				const prepared = prepareBend(s, s.selectedIndex);
				if (!prepared?.bend) return;
				const axis = axisHit.object.userData.pathAxis;
				const origin = new THREE.Vector3(prepared.base.x, prepared.base.y, prepared.base.z);
				const dir = CRANE_AXES.find((entry) => entry.axis === axis).dir;
				const eye = new THREE.Vector3();
				camRef.current.getWorldDirection(eye);
				// slide plane: contains the axis and faces the camera as squarely as it can
				const normal = dir.clone().cross(eye).cross(dir);
				if (normal.lengthSq() < 1e-6) return;
				normal.normalize();
				const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, origin);
				const hitStart = new THREE.Vector3();
				if (!raycaster.ray.intersectPlane(plane, hitStart)) return;
				event.stopImmediatePropagation();
				event.preventDefault();
				dragRef.current = { axis, index: s.selectedIndex, dir: dir.clone(), plane, hitStart, bend: prepared.bend, recorded: false };
				setDragInfo({ t0: prepared.bend.t0, radius: prepared.bend.radius });
				invalidate();
				return;
			}
			const hit = hits.find((entry) => entry.object.userData?.pathIndex !== undefined);
			if (!hit) {
				// A press on the route itself belongs to it too: take it so the
				// fly camera does not, and the object stays selected for the
				// double-click that follows.
				if (hits.some((entry) => entry.object.userData?.pathLine)) {
					event.stopImmediatePropagation();
					event.preventDefault();
				}
				return;
			}
			const index = hit.object.userData.pathIndex;
			const prepared = prepareBend(s, index);
			if (!prepared?.bend) return;
			// A press on the mark moves it freely on the camera plane — the sun
			// puck's grammar, so the route can be nudged without aiming at an arrow.
			const facing = new THREE.Vector3();
			camRef.current.getWorldDirection(facing);
			const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(facing, new THREE.Vector3(prepared.base.x, prepared.base.y, prepared.base.z));
			const hitStart = new THREE.Vector3();
			if (!raycaster.ray.intersectPlane(plane, hitStart)) return;
			event.stopImmediatePropagation();
			event.preventDefault();
			s.onSelect(index);
			const slide = event.shiftKey && index > 0 && index < prepared.fractions.length - 1;
			dragRef.current = { axis: null, index, slide, plane, hitStart, base: prepared.base, fractions: prepared.fractions, marks: pathMarks(s.path), bend: prepared.bend, recorded: false };
			gl.domElement.style.cursor = "grabbing";
			setDragInfo(slide ? { slide: true } : { t0: prepared.bend.t0, radius: prepared.bend.radius });
			invalidate();
		};
		const onMove = (event) => {
			const s = stateRef.current;
			const drag = dragRef.current;
			if (!drag || !s.enabled || !s.path) return;
			if (!rayFrom(event)) return;
			if (drag.ring) {
				const hit = new THREE.Vector3();
				if (!raycaster.ray.intersectPlane(drag.plane, hit)) return;
				const offset = hit.sub(drag.origin);
				const angle = Math.atan2(offset.dot(drag.binormal), offset.dot(drag.tangent));
				// Wrapped increments: crossing the ring's seam never jumps a turn.
				drag.turned += wrapDeg(((angle - drag.lastAngle) * 180) / Math.PI);
				drag.lastAngle = angle;
				// The lean's own handedness (travelPose): bank is a right-handed
				// turn about forward; pitch reads nose-up, the other way about right.
				const raw = drag.startValue + (drag.ring === "bank" ? drag.turned : -drag.turned);
				const step = event.ctrlKey || event.metaKey ? 5 : 0.5;
				const value = Math.max(-MAX_PATH_LEAN, Math.min(MAX_PATH_LEAN, Math.round(raw / step) * step));
				if (!drag.recorded) {
					s.onDragStart?.();
					drag.recorded = true;
				}
				s.onChangePath({ marks: drag.marks.map((entry, i) => (i + 1 === drag.index ? { ...entry, [drag.ring]: value } : entry)) }, { dragging: true });
				invalidate();
				return;
			}
			if (drag.slide) {
				// slide along the arc: the ray onto the horizontal plane at the mark
				const floor = new THREE.Plane(new THREE.Vector3(0, 1, 0), -drag.base.y);
				const world = new THREE.Vector3();
				if (!raycaster.ray.intersectPlane(floor, world)) return;
				const spot = nearestPathFraction(s.path, (point) => ({ x: point.x, y: point.z }), world.x, world.z);
				if (!spot) return;
				const t = Math.max(
					drag.fractions[drag.index - 1] + PATH_MARK_CLEARANCE,
					Math.min(drag.fractions[drag.index + 1] - PATH_MARK_CLEARANCE, spot.t),
				);
				if (!drag.recorded) {
					s.onDragStart?.();
					drag.recorded = true;
				}
					// the dot keeps its lean as it slides: matched by place in the row, not by value
					s.onChangePath({ marks: drag.marks.map((entry, i) => (i + 1 === drag.index ? { ...entry, t } : entry)) }, { dragging: true });
				invalidate();
				return;
			}
			const world = new THREE.Vector3();
			if (!raycaster.ray.intersectPlane(drag.plane, world)) return;
			let delta;
			if (drag.axis) {
				const travel = world.clone().sub(drag.hitStart).dot(drag.dir);
				delta = drag.dir.clone().multiplyScalar(travel);
			} else {
				delta = world.clone().sub(drag.hitStart);
			}
			if (!drag.recorded) {
				s.onDragStart?.();
				drag.recorded = true;
			}
			// A weighted bump: the points around the mark follow, fading out by the
			// neighbouring marks; the ends of an interior mark's bend stay pinned.
			const moved = drag.bend.startControls.map((entry, i) => {
				const weight = drag.bend.weights[i];
				if (!(weight > 0)) return entry;
				return {
					...entry,
					x: entry.x + delta.x * weight,
					y: Math.max(0, (entry.y ?? 0) + delta.y * weight),
					z: entry.z + delta.z * weight,
				};
			});
			s.onChangePath({ points: moved }, { dragging: true });
			invalidate();
		};
		const onUp = () => {
			const drag = dragRef.current;
			dragRef.current = null;
			setDragInfo(null);
			if (drag) gl.domElement.style.cursor = "";
			if (drag?.recorded) stateRef.current.onDragEnd?.();
			invalidate();
		};
		// Hover: the only cue that the dots are handles. Window-bubble, so it
		// runs after the object gizmo's own cursor reset on the canvas.
		const onHover = (event) => {
			const s = stateRef.current;
			if (dragRef.current || !s.enabled || !s.path || event.buttons !== 0 || event.target !== gl.domElement) {
				setHover((current) => (current === null ? current : null));
				setLineHover((current) => (current ? false : current));
				setRingHover((current) => (current === null ? current : null));
				return;
			}
			let index = null;
			let ring = null;
			if (rayFrom(event) && groupRef.current) {
				const hits = raycaster.intersectObjects(groupRef.current.children, true);
				const axisHit = s.selectedIndex != null && hits.find((entry) => entry.object.userData?.pathAxis);
				const ringHit = s.mode === "rotate" && s.selectedIndex != null && hits.find((entry) => entry.object.userData?.pathRing);
				const dot = hits.find((entry) => entry.object.userData?.pathIndex !== undefined);
				if (ringHit) ring = ringHit.object.userData.pathRing;
				else if (!axisHit && dot) index = dot.object.userData.pathIndex;
			}
			setHover((current) => (current === index ? current : index));
			setRingHover((current) => (current === ring ? current : ring));
			if (index !== null || ring !== null) gl.domElement.style.cursor = "grab";
			// The line itself answers too: it brightens and the cursor says "copy"
			// while a double-click here would still drop a dot.
			let addable = false;
			if (index === null && camRef.current) {
				const fractions = pathMarkFractions(s.path);
				if (fractions.length < MAX_PATH_MARKS) {
					camRef.current.updateMatrixWorld();
					const best = nearestPathFraction(s.path, paneScreen, event.clientX, event.clientY);
					addable = !!best && best.d <= PATH_LINE_PICK_PX && !fractions.some((entry) => Math.abs(entry - best.t) < PATH_MARK_CLEARANCE);
				}
			}
			setLineHover((current) => (current === addable ? current : addable));
			if (addable) gl.domElement.style.cursor = "copy";
		};
		// Double-click the route to drop a mark on it — the crane curve's
		// gesture, so one habit covers both. A mark only gives the next drag
		// something to grab in the middle: it never changes where the object goes.
		const onDouble = (event) => {
			const s = stateRef.current;
			if (!s.enabled || !s.path || !camRef.current) return;
			const fractions = pathMarkFractions(s.path);
			if (fractions.length >= MAX_PATH_MARKS) return;
			camRef.current.updateMatrixWorld();
			const best = nearestPathFraction(s.path, paneScreen, event.clientX, event.clientY);
			if (!best || best.d > PATH_LINE_PICK_PX) return;
			// Not on top of a mark that is already there.
			if (fractions.some((entry) => Math.abs(entry - best.t) < PATH_MARK_CLEARANCE)) return;
			event.stopImmediatePropagation();
			event.preventDefault();
			// The new dot is born with the lean the route already has there, and its
			// neighbours keep theirs.
			const added = insertPathMark(s.path, best.t);
			if (!added) return;
			s.onDragStart?.();
			s.onChangePath({ marks: added.marks });
			s.onDragEnd?.();
			s.onSelect(added.index);
			invalidate();
		};
		// Delete removes the selected interior mark, never the object: while a
		// mark is selected this handler owns the key, and the scene-object delete
		// handler stands down (it checks the same selection). The ends stay — a
		// route is whatever lies between them; "Delete path" clears it.
		const onKey = (event) => {
			const s = stateRef.current;
			if (!s.enabled || !s.path || s.selectedIndex == null) return;
			if (event.key !== "Delete" && event.key !== "Backspace") return;
			if (document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
			event.preventDefault();
			event.stopImmediatePropagation();
			const fractions = pathMarkFractions(s.path);
			if (s.selectedIndex <= 0 || s.selectedIndex >= fractions.length - 1) return;
			s.onDragStart?.();
			s.onChangePath({ marks: pathMarks(s.path).filter((_, i) => i + 1 !== s.selectedIndex) });
			s.onDragEnd?.();
			s.onSelect(null);
			invalidate();
		};
		const el = gl.domElement;
		el.addEventListener("pointerdown", onDown);
		window.addEventListener("pointermove", onMove, true);
		window.addEventListener("pointerup", onUp, true);
		window.addEventListener("pointermove", onHover);
		el.addEventListener("dblclick", onDouble, true);
		window.addEventListener("keydown", onKey, true);
		return () => {
			el.removeEventListener("pointerdown", onDown);
			window.removeEventListener("pointermove", onMove, true);
			window.removeEventListener("pointerup", onUp, true);
			window.removeEventListener("pointermove", onHover);
			el.removeEventListener("dblclick", onDouble, true);
			window.removeEventListener("keydown", onKey, true);
		};
		// paneRef/camRef are stable; handlers read live state through stateRef
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [enabled, gl, invalidate]);
	const curve = useMemo(() => (path?.points?.length > 1 ? pathCurve(path) : null), [path]);
	const linePoints = useMemo(
		// The curve the object travels, not the chords between its points.
		() => (curve ? curve.points : []).map((point) => [point.x, point.y + 0.02, point.z]),
		[curve],
	);
	const marks = useMemo(
		() => (path ? pathMarkFractions(path).map((t) => pathPointAtFraction(path, t)) : []),
		[path],
	);
	// The dots that carry a lean, in the travel frame they will pose the body in:
	// a yaw from the route's direction there, then the lean itself.
	const leans = useMemo(() => {
		if (!path) return [];
		return pathMarks(path).map((mark, i) => {
			if (!mark.bank && !mark.pitch) return null;
			const before = pathPointAtFraction(path, Math.max(0, mark.t - 0.01));
			const after = pathPointAtFraction(path, Math.min(1, mark.t + 0.01));
			const yaw = before && after ? Math.atan2(after.x - before.x, after.z - before.z) : 0;
			const quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(-mark.pitch * (Math.PI / 180), yaw, mark.bank * (Math.PI / 180), "YXZ"));
			return { index: i + 1, quaternion };
		}).filter(Boolean);
	}, [path]);
	// The travel frame the selected dot's rings stand in: a yaw from the route's
	// direction there. Only an interior dot has one — the ends are always level.
	const leanFrame = useMemo(() => {
		if (!path || selectedIndex == null) return null;
		const fractions = pathMarkFractions(path);
		if (selectedIndex <= 0 || selectedIndex >= fractions.length - 1) return null;
		const t = fractions[selectedIndex];
		const before = pathPointAtFraction(path, Math.max(0, t - 0.01));
		const after = pathPointAtFraction(path, Math.min(1, t + 0.01));
		const yaw = before && after ? Math.atan2(after.x - before.x, after.z - before.z) : 0;
		return { quaternion: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw) };
	}, [path, selectedIndex]);
	if (!enabled || !path || linePoints.length < 2) return null;
	const selected = selectedIndex != null ? marks[selectedIndex] : null;
	return (
		<group ref={groupRef}>
			<primitive object={lineProxy} />
			<Line points={linePoints} color={lineHover ? "#d4f7e2" : "#6fcf97"} lineWidth={lineHover ? 4 : 2.5} transparent opacity={lineHover ? 1 : 0.9} />
			{selected && (
				<group ref={gizmoRef} position={[selected.x, selected.y, selected.z]} renderOrder={999}>
					{mode === "rotate" && leanFrame && (
						<group quaternion={leanFrame.quaternion}>
							{PATH_RINGS.map(({ key, color, rotation }) => {
								const lit = dragInfo?.ring === key || (!dragInfo && ringHover === key);
								return (
									<group key={key} rotation={rotation}>
										<mesh renderOrder={999}>
											<torusGeometry args={[PATH_RING_R, 0.022, 8, 48]} />
											<meshStandardMaterial color="#000000" emissive={lit ? "#ffd23d" : color} emissiveIntensity={lit ? 3 : 2.2} toneMapped={false} depthTest={false} depthWrite={false} transparent opacity={0.95} />
										</mesh>
										{/* the grab band: a 2 cm ring is nothing to aim at */}
										<mesh userData={{ pathRing: key }}>
											<torusGeometry args={[PATH_RING_R, 0.07, 6, 32]} />
											<meshBasicMaterial visible={false} />
										</mesh>
									</group>
								);
							})}
						</group>
					)}
					{mode !== "rotate" && CRANE_AXES.map(({ axis, dir, color }) => {
						const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
						return (
							<group key={axis} quaternion={quat}>
								<mesh position={[0, CRANE_ARROW_LEN / 2 + 0.08, 0]} renderOrder={999}>
									<cylinderGeometry args={[0.016, 0.016, CRANE_ARROW_LEN, 8]} />
									<meshStandardMaterial color="#000000" emissive={color} emissiveIntensity={2.2} toneMapped={false} depthTest={false} depthWrite={false} transparent opacity={0.95} />
								</mesh>
								<mesh position={[0, CRANE_ARROW_LEN + 0.08 + 0.07, 0]} renderOrder={999}>
									<coneGeometry args={[0.05, 0.14, 14]} />
									<meshStandardMaterial color="#000000" emissive={color} emissiveIntensity={2.2} toneMapped={false} depthTest={false} depthWrite={false} transparent opacity={0.95} />
								</mesh>
								<mesh position={[0, (CRANE_ARROW_LEN + 0.14) / 2 + 0.08, 0]} userData={{ pathAxis: axis }}>
									<cylinderGeometry args={[0.09, 0.09, CRANE_ARROW_LEN + 0.14, 8]} />
									<meshBasicMaterial visible={false} />
								</mesh>
							</group>
						);
					})}
				</group>
			)}
			{marks.map((point, index) => point && (
				<group key={`${index}:${marks.length}`} position={[point.x, point.y, point.z]}>
					<mesh userData={{ pathIndex: index }} renderOrder={998} scale={hover === index ? 1.3 : 1}>
						<sphereGeometry args={[0.085, 16, 12]} />
						{/* the selected mark keeps its own colour; hover only brightens */}
						<meshBasicMaterial color={index === selectedIndex ? (hover === index ? "#ffd08a" : "#ffb454") : hover === index ? "#d4f7e2" : "#6fcf97"} depthTest={false} transparent opacity={0.95} />
					</mesh>
					{/* the real click target: a dot is a dozen pixels from a few
					    metres back, so an invisible halo carries the press */}
					{/* a dot that leans the body: a bar through it tilted the way the
					    body will sit (across = bank, along = pitch), in the travel frame */}
					{leans.filter((lean) => lean.index === index).map((lean) => (
						<group key="lean" quaternion={lean.quaternion} userData={{ pathLean: true }}>
							<mesh renderOrder={998}>
								<boxGeometry args={[0.7, 0.03, 0.03]} />
								<meshBasicMaterial color="#ffb454" depthTest={false} transparent opacity={0.95} />
							</mesh>
							<mesh renderOrder={998}>
								<boxGeometry args={[0.03, 0.03, 0.46]} />
								<meshBasicMaterial color="#ffd08a" depthTest={false} transparent opacity={0.95} />
							</mesh>
						</group>
					))}
					<mesh userData={{ pathIndex: index }}>
						<sphereGeometry args={[0.24, 10, 8]} />
						<meshBasicMaterial visible={false} />
					</mesh>
				</group>
			))}
			{/* live readout while a drag moves the mark */}
			{dragInfo && selected && (
				<GizmoLabel
					position={[selected.x, selected.y + 0.42, selected.z]}
					text={dragInfo.ring
						? `${dragInfo.ring} ${(pathMarks(path)[selectedIndex - 1]?.[dragInfo.ring] ?? 0).toFixed(1)}°`
						: dragInfo.slide ? `${Math.round(pathMarkFractions(path)[selectedIndex] * 100)}%` : `x ${selected.x.toFixed(1)}  y ${selected.y.toFixed(1)}  z ${selected.z.toFixed(1)}`}
					camRef={camRef}
				/>
			)}
			{/* the span a bend will actually deform, lit on the route */}
			{dragInfo?.radius != null && curve && (() => {
				const span = [];
				for (let i = 0; i < curve.points.length; i += 1) {
					const t = curve.cumulative[i] / curve.length;
					if (t >= dragInfo.t0 - dragInfo.radius && t <= dragInfo.t0 + dragInfo.radius) {
						span.push([curve.points[i].x, curve.points[i].y + 0.03, curve.points[i].z]);
					}
				}
				if (span.length < 2) return null;
				return <Line points={span} color="#ffb454" lineWidth={4} transparent opacity={0.9} />;
			})()}
		</group>
	);
}

export function CraneHandles({ rail, crane, controlPoints, selectedIndex, enabled, paneRef, camRef, onSelect, onChangePoints, onChangeRail, onDragStart, onDragEnd }) {
	const { gl } = useThree();
	const invalidate = useThree((state) => state.invalidate);
	const groupRef = useRef(null);
	const gizmoRef = useRef(null);
	const dragRef = useRef(null);
	const stateRef = useRef(null);
	// What the pointer is doing right now, for the in-scene feedback layer:
	// height-ish drags float a metre readout, a bend drag lights up the arc
	// span the bump will actually deform.
	const [dragInfo, setDragInfo] = useState(null);
	stateRef.current = { rail, crane, controlPoints, selectedIndex, enabled, onSelect, onChangePoints, onChangeRail, onDragStart, onDragEnd };
	// Constant on-screen size for the axis gizmo: it is UI, not set dressing.
	useFrame(() => {
		const gizmo = gizmoRef.current;
		const camera = camRef.current;
		if (!gizmo || !camera) return;
		const world = gizmo.getWorldPosition(new THREE.Vector3());
		gizmo.scale.setScalar(Math.max(0.35, camera.getWorldPosition(new THREE.Vector3()).distanceTo(world) * CRANE_GIZMO_SCALE));
	});
	useEffect(() => {
		groupRef.current?.traverse((node) => node.layers?.set(GIZMO_LAYER));
	});
	useEffect(() => {
		if (!enabled) return undefined;
		const raycaster = new THREE.Raycaster();
		raycaster.layers.set(GIZMO_LAYER);
		const rayFrom = (event) => {
			const pane = paneRef.current;
			const camera = camRef.current;
			if (!pane || !camera) return null;
			const bounds = pane.getBoundingClientRect();
			if (bounds.width < 2 || bounds.height < 2) return null;
			const ndc = new THREE.Vector2(
				((event.clientX - bounds.left) / bounds.width) * 2 - 1,
				-((event.clientY - bounds.top) / bounds.height) * 2 + 1,
			);
			if (Math.abs(ndc.x) > 1 || Math.abs(ndc.y) > 1) return null;
			camera.updateMatrixWorld();
			raycaster.setFromCamera(ndc, camera);
			return raycaster;
		};
		const paneScreen = (world) => {
			const pane = paneRef.current.getBoundingClientRect();
			const projected = world.project(camRef.current);
			return projected.z > 1 ? null : {
				x: pane.left + ((projected.x + 1) / 2) * pane.width,
				y: pane.top + ((1 - projected.y) / 2) * pane.height,
			};
		};
		const onDown = (event) => {
			const s = stateRef.current;
			if (!s.enabled || !s.crane || event.button !== 0) return;
			if (!groupRef.current || !rayFrom(event)) return;
			const hits = raycaster.intersectObjects(groupRef.current.children, true);
			// The axis gizmo outranks the dots: its arrows sit on the selected
			// dot, and a press on an arrow is a directed move, not a reselect.
			const axisHit = hits.find((entry) => entry.object.userData?.craneAxis);
			if (axisHit && s.selectedIndex != null && s.crane.points[s.selectedIndex]) {
				const axis = axisHit.object.userData.craneAxis;
				const point = s.crane.points[s.selectedIndex];
				const base = railPoint(s.rail, point.t * s.rail.length);
				const origin = new THREE.Vector3(base.x, point.height, base.z);
				const dir = CRANE_AXES.find((entry) => entry.axis === axis).dir;
				const eye = new THREE.Vector3();
				camRef.current.getWorldDirection(eye);
				// slide plane: contains the axis and faces the camera as squarely
				// as it can — the same construction the object gizmo uses
				const normal = dir.clone().cross(eye).cross(dir);
				if (normal.lengthSq() < 1e-6) return;
				normal.normalize();
				const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, origin);
				const hitStart = new THREE.Vector3();
				if (!raycaster.ray.intersectPlane(plane, hitStart)) return;
				// x/z bend the rail: a weighted bump around the mark's base, so
				// the path deforms locally and the marks beside it stay put.
				const bend = axis === "y" ? null : prepareRailBend(s.controlPoints, base, s.crane.points, s.selectedIndex);
				if (axis !== "y" && !bend) return;
				event.stopImmediatePropagation();
				event.preventDefault();
				dragRef.current = {
					axis,
					index: s.selectedIndex,
					dir: dir.clone(),
					plane,
					hitStart,
					startHeight: point.height,
					startControls: bend?.startControls ?? null,
					bendWeights: bend?.weights ?? null,
					recorded: false,
				};
				setDragInfo(axis === "y" ? { kind: "height" } : { kind: "bend", t0: bend.t0, radius: bend.radius });
				invalidate();
				return;
			}
			const hit = hits.find((entry) => entry.object.userData?.craneIndex !== undefined);
			if (!hit) return;
			event.stopImmediatePropagation();
			event.preventDefault();
			const index = hit.object.userData.craneIndex;
			s.onSelect(index);
			dragRef.current = floorDragStart(s, index, raycaster.ray, event.shiftKey) ?? { index, slide: event.shiftKey, recorded: false };
			setDragInfo(dragRef.current.axis ? { kind: "bend", t0: dragRef.current.t0, radius: dragRef.current.radius } : { kind: event.shiftKey ? "slide" : "free" });
			invalidate();
		};
		const onMove = (event) => {
			const s = stateRef.current;
			const drag = dragRef.current;
			if (!drag || !s.enabled || !s.crane || !s.rail) return;
			if (!rayFrom(event)) return;
			const points = s.crane.points;
			const point = points[drag.index];
			if (!point) return;
			if (!drag.recorded) {
				s.onDragStart?.();
				drag.recorded = true;
			}
			if (drag.axis) {
				const world = new THREE.Vector3();
				if (!raycaster.ray.intersectPlane(drag.plane, world)) return;
				const travel = world.sub(drag.hitStart).dot(drag.dir);
				if (drag.axis === "y") {
					const height = Math.max(0.1, Math.min(12, drag.startHeight + travel));
					s.onChangePoints(points.map((entry, i) => (i === drag.index ? { ...entry, height } : entry)), { dragging: true });
				} else if (drag.startControls && drag.bendWeights && s.onChangeRail) {
					const dx = drag.axis === "x" ? travel : drag.axis === "floor" ? world.x : 0;
					const dz = drag.axis === "z" ? travel : drag.axis === "floor" ? world.z : 0;
					const moved = drag.startControls.map((entry, i) => (drag.bendWeights[i] > 0
						? { ...entry, x: entry.x + dx * drag.bendWeights[i], z: entry.z + dz * drag.bendWeights[i] }
						: entry));
					s.onChangeRail(moved, { dragging: true });
				}
				invalidate();
				return;
			}
			if (drag.slide && drag.index > 0 && drag.index < points.length - 1) {
				// slide along the arc: ray onto the horizontal plane at the mark
				const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -point.height);
				const world = new THREE.Vector3();
				if (!raycaster.ray.intersectPlane(plane, world)) return;
				let bestI = 0;
				let bestD = Infinity;
				for (let i = 0; i < s.rail.points.length; i += 1) {
					const d = Math.hypot(s.rail.points[i].x - world.x, s.rail.points[i].z - world.z);
					if (d < bestD) {
						bestD = d;
						bestI = i;
					}
				}
				const t = Math.max(
					points[drag.index - 1].t + 0.02,
					Math.min(points[drag.index + 1].t - 0.02, s.rail.cumLen[bestI] / s.rail.length),
				);
				s.onChangePoints(points.map((entry, i) => (i === drag.index ? { ...entry, t } : entry)), { dragging: true });
			} else {
				// free move: ray onto the camera-facing vertical plane at the base.
				// Its y sets the height; its x/z re-projects an interior mark onto
				// the nearest rail arc position, so one drag steers both axes — the
				// rail is the only x/z a crane mark can occupy.
				const base = railPoint(s.rail, point.t * s.rail.length);
				const camera = camRef.current;
				const facing = new THREE.Vector3();
				camera.getWorldDirection(facing);
				facing.y = 0;
				if (facing.lengthSq() < 1e-6) return; // looking straight down: height is unreadable
				facing.normalize();
				const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(facing, new THREE.Vector3(base.x, 0, base.z));
				const world = new THREE.Vector3();
				if (!raycaster.ray.intersectPlane(plane, world)) return;
				const height = Math.max(0.1, Math.min(12, world.y));
				let t = point.t;
				if (drag.index > 0 && drag.index < points.length - 1) {
					let bestI = 0;
					let bestD = Infinity;
					for (let i = 0; i < s.rail.points.length; i += 1) {
						const d = Math.hypot(s.rail.points[i].x - world.x, s.rail.points[i].z - world.z);
						if (d < bestD) {
							bestD = d;
							bestI = i;
						}
					}
					t = Math.max(
						points[drag.index - 1].t + 0.02,
						Math.min(points[drag.index + 1].t - 0.02, s.rail.cumLen[bestI] / s.rail.length),
					);
				}
				s.onChangePoints(points.map((entry, i) => (i === drag.index ? { ...entry, t, height } : entry)), { dragging: true });
			}
			invalidate();
		};
		const onUp = () => {
			if (dragRef.current?.recorded) stateRef.current.onDragEnd?.();
			dragRef.current = null;
			setDragInfo(null);
		};
		const onDouble = (event) => {
			const s = stateRef.current;
			if (!s.enabled || !s.crane || !s.rail || !camRef.current) return;
			camRef.current.updateMatrixWorld();
			let best = null;
			for (let i = 0; i < s.rail.points.length; i += 1) {
				const t = s.rail.cumLen[i] / s.rail.length;
				const screen = paneScreen(new THREE.Vector3(s.rail.points[i].x, craneHeightAt(s.crane, t), s.rail.points[i].z));
				if (!screen) continue;
				const d = Math.hypot(screen.x - event.clientX, screen.y - event.clientY);
				if (!best || d < best.d) best = { d, t };
			}
			if (!best || best.d > 14) return;
			if (s.crane.points.length >= 8) return;
			if (s.crane.points.some((entry) => Math.abs(entry.t - best.t) < 0.03)) return;
			event.stopImmediatePropagation();
			event.preventDefault();
			const added = [...s.crane.points, { t: best.t, height: craneHeightAt(s.crane, best.t) }].sort((a, b) => a.t - b.t);
			s.onChangePoints(added);
			s.onSelect(added.findIndex((entry) => entry.t === best.t));
			invalidate();
		};
		const onKey = (event) => {
			const s = stateRef.current;
			if (!s.enabled || !s.crane) return;
			if (event.key !== "Delete" && event.key !== "Backspace") return;
			if (document.activeElement && /INPUT|TEXTAREA/.test(document.activeElement.tagName)) return;
			const index = s.selectedIndex;
			if (index == null || index <= 0 || index >= s.crane.points.length - 1) return;
			event.preventDefault();
			s.onChangePoints(s.crane.points.filter((_, i) => i !== index));
			s.onSelect(null);
			invalidate();
		};
		const el = gl.domElement;
		el.addEventListener("pointerdown", onDown, true);
		window.addEventListener("pointermove", onMove, true);
		window.addEventListener("pointerup", onUp, true);
		el.addEventListener("dblclick", onDouble, true);
		window.addEventListener("keydown", onKey);
		return () => {
			el.removeEventListener("pointerdown", onDown, true);
			window.removeEventListener("pointermove", onMove, true);
			window.removeEventListener("pointerup", onUp, true);
			el.removeEventListener("dblclick", onDouble, true);
			window.removeEventListener("keydown", onKey);
		};
		// paneRef/camRef are stable refs; handlers read live state through stateRef
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [enabled, gl, invalidate]);
	if (!enabled || !crane || !rail) return null;
	const selectedPoint = selectedIndex != null ? crane.points[selectedIndex] : null;
	const selectedBase = selectedPoint ? railPoint(rail, selectedPoint.t * rail.length) : null;
	return (
		<group ref={groupRef}>
			{selectedPoint && (
				<group ref={gizmoRef} position={[selectedBase.x, selectedPoint.height, selectedBase.z]} renderOrder={999}>
					{CRANE_AXES.map(({ axis, dir, color }) => {
						const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
						return (
							<group key={axis} quaternion={quat}>
								<mesh position={[0, CRANE_ARROW_LEN / 2 + 0.08, 0]} renderOrder={999}>
									<cylinderGeometry args={[0.016, 0.016, CRANE_ARROW_LEN, 8]} />
									<meshStandardMaterial color="#000000" emissive={color} emissiveIntensity={2.2} toneMapped={false} depthTest={false} depthWrite={false} transparent opacity={0.95} />
								</mesh>
								<mesh position={[0, CRANE_ARROW_LEN + 0.08 + 0.07, 0]} renderOrder={999}>
									<coneGeometry args={[0.05, 0.14, 14]} />
									<meshStandardMaterial color="#000000" emissive={color} emissiveIntensity={2.2} toneMapped={false} depthTest={false} depthWrite={false} transparent opacity={0.95} />
								</mesh>
								<mesh position={[0, (CRANE_ARROW_LEN + 0.14) / 2 + 0.08, 0]} userData={{ craneAxis: axis }}>
									<cylinderGeometry args={[0.09, 0.09, CRANE_ARROW_LEN + 0.14, 8]} />
									<meshBasicMaterial visible={false} />
								</mesh>
							</group>
						);
					})}
				</group>
			)}
			{crane.points.map((point, index) => {
				const base = railPoint(rail, point.t * rail.length);
				return (
					<group key={`${index}:${crane.points.length}`} position={[base.x, point.height, base.z]}>
						<mesh userData={{ craneIndex: index }} renderOrder={998}>
							<sphereGeometry args={[0.085, 16, 12]} />
							<meshBasicMaterial color={index === selectedIndex ? "#ffb454" : "#a78bfa"} depthTest={false} transparent opacity={0.95} />
						</mesh>
						{/* the real click target: a dot is a dozen pixels from a few
						    metres back, so an invisible halo carries the press */}
						<mesh userData={{ craneIndex: index }}>
							<sphereGeometry args={[0.24, 10, 8]} />
							<meshBasicMaterial visible={false} />
						</mesh>
					</group>
				);
			})}
			{/* live readout while a drag changes the mark's height */}
			{dragInfo && dragInfo.kind !== "bend" && selectedPoint && (
				<GizmoLabel
					position={[selectedBase.x, selectedPoint.height + 0.28, selectedBase.z]}
					text={dragInfo.kind === "slide" ? `${Math.round(selectedPoint.t * 100)}%` : `${selectedPoint.height.toFixed(1)} m`}
					camRef={camRef}
				/>
			)}
			{/* the span a bend drag will actually deform, lit on the floor path */}
			{dragInfo?.kind === "bend" && (() => {
				const span = [];
				for (let i = 0; i < rail.points.length; i += 1) {
					const t = rail.cumLen[i] / rail.length;
					if (t >= dragInfo.t0 - dragInfo.radius && t <= dragInfo.t0 + dragInfo.radius) {
						span.push([rail.points[i].x, 0.035, rail.points[i].z]);
					}
				}
				if (span.length < 2) return null;
				return <Line points={span} color="#ffb454" lineWidth={4} transparent opacity={0.9} />;
			})()}
		</group>
	);
}

export function ShotPathPreview({ waypoints, start, activeWaypointId }) {
	const rootRef = useRef(null);
	const line = useMemo(() => {
		if (!waypoints.length) return null;
		const points = [{ x: start.x, z: start.z }, ...waypoints];
		const positions = new Float32Array(points.length * 3);
		points.forEach((point, i) => {
			positions[i * 3] = point.x;
			positions[i * 3 + 1] = 0.03;
			positions[i * 3 + 2] = point.z;
		});
		const geometry = new THREE.BufferGeometry();
		geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
		return geometry;
	}, [start.x, start.z, waypoints]);
	useEffect(() => {
		// Every render: drei's Text meshes appear asynchronously, and each new
		// node must land on the gizmo layer before the next capture.
		rootRef.current?.traverse((node) => node.layers.set(GIZMO_LAYER));
	});
	if (!waypoints.length) return null;
	return (
		<group ref={rootRef}>
			{line && (
				<line geometry={line}>
					<lineBasicMaterial color="#4e9fb3" transparent opacity={0.8} depthWrite={false} />
				</line>
			)}
			{waypoints.map((waypoint, i) => {
				const active = waypoint.id === activeWaypointId;
				const color = active ? "#ffd76c" : "#4e9fb3";
				return (
					<group key={waypoint.id} position={[waypoint.x, 0.03, waypoint.z]}>
						<mesh rotation={[-Math.PI / 2, 0, 0]}>
							<ringGeometry args={[0.21, 0.25, 32]} />
							<meshBasicMaterial color={color} depthWrite={false} />
						</mesh>
						<Text
							position={[0, 0.02, 0.36]}
							rotation={[-Math.PI / 2, 0, 0]}
							fontSize={0.12}
							color={color}
							anchorX="center"
							anchorY="middle"
							outlineWidth={0.01}
							outlineColor="#1c1a17"
							outlineOpacity={0.85}
						>
							{String(i + 1)}
						</Text>
					</group>
				);
			})}
		</group>
	);
}
