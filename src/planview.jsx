import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import { Line, Text } from "@react-three/drei";
import * as THREE from "three";
import { aimAt } from "./controls.jsx";
import { PLAN_LAYER } from "./dualview.jsx"; import { createFloorRaycastTools, floorPointAt } from "./floor-raycast.js";
import { EMPTY_MARKER_SIZE, isEmptyObject, objectSize } from "./scene-objects.js";
import { displayObjectLabel } from "./object-catalog.jsx";
import { ko } from "./locale.js";
import { isProxyFigure } from "./scenes.js";
import { prepareRailBend } from "./camera-follow.js";
import { MARK_GAP, MAX_PATH_MARKS, MAX_PATH_POINTS, nearestPathFraction, pathCurve, pathMarkFractions, pathPointAtFraction } from "./object-path.js";

const ROOM_LIMIT = 240; // stay on the open stage (matches scene-objects' clamp)
const ACTOR_LIMIT = 4; // matches the Subject sliders' range
const PUCK_R = 0.34;
const GRAB_R = 1.0; // the pick radius, well beyond the drawn disc
const HANDLE_DIST = 1.25; // how far the facing handle sits from the centre
const HANDLE_R = 0.14;
const HANDLE_GRAB = 0.5;
const CAMERA_COLOR = "#007f9e";
const SUBJECT_ONE_COLOR = "#2457d6";
const SUBJECT_TWO_COLOR = "#d63b55";
// Props are the plan's backdrop: a pale wash, a hairline edge and a muted
// name, so the camera, the cast and the rail are what reads first.
const OBJECT_COLOR = "#f3f0ea";
const PROP_EDGE_COLOR = "#a19b91";
const PROP_LABEL_COLOR = "#8a847b";
const SELECTED_COLOR = "#b77900";
const CAST_RING_INNER = 0.62;
const CAST_RING_OUTER = 0.8;

/** yaw that makes the character's local +Z face the given direction */
const yawToward = (dx, dz) => Math.atan2(dx, dz);
const wrapDeg = (deg) => ((((deg + 180) % 360) + 360) % 360) - 180;
/** world position of a puck's facing handle */
const handleAt = (e) => {
	const distance = e.handleDist ?? HANDLE_DIST;
	return { x: e.x + distance * Math.sin(e.yaw), z: e.z + distance * Math.cos(e.yaw) };
};
const near = (ax, az, bx, bz, r) => (ax - bx) ** 2 + (az - bz) ** 2 < r * r;
const insideFootprint = (point, entity, padding = 0.2) => {
	const dx = point.x - entity.x;
	const dz = point.z - entity.z;
	const cos = Math.cos(entity.yaw);
	const sin = Math.sin(entity.yaw);
	const localX = dx * cos - dz * sin;
	const localZ = dx * sin + dz * cos;
	return (
		Math.abs(localX) <= entity.footprint.width / 2 + padding &&
		Math.abs(localZ) <= entity.footprint.depth / 2 + padding
	);
};

/** The lens cone, so you can see what the camera covers without leaving the plan. */
function FrustumWedge({ fovDeg, active }) {
	const geometry = useMemo(() => new THREE.BufferGeometry(), []);
	const half = (fovDeg * Math.PI) / 180 / 2;
	// a 16:9 frame is wider than the vertical fov it is specified by
	const spread = Math.atan(Math.tan(half) * (16 / 9));
	const reach = 6;
	useEffect(() => {
		const points = new Float32Array([
			0, 0, 0,
			-Math.sin(spread) * reach, 0, -Math.cos(spread) * reach,
			Math.sin(spread) * reach, 0, -Math.cos(spread) * reach,
		]);
		geometry.setAttribute("position", new THREE.BufferAttribute(points, 3));
		geometry.computeVertexNormals();
	}, [geometry, spread]);

	return (
		<mesh geometry={geometry} position={[0, 0.02, 0]} renderOrder={8}>
			<meshBasicMaterial
				color={CAMERA_COLOR}
				transparent
				opacity={active ? 0.46 : 0.28}
				side={THREE.DoubleSide}
				depthWrite={false}
				depthTest={false}
			/>
		</mesh>
	);
}

/**
 * A staging puck: drag the body to slide it, drag the outrigger handle to turn it.
 *
 * Rotation has to be available right here. Reaching for a numeric slider on the
 * far side of the screen to spin an actor is the single most awkward thing a
 * plan board can ask for, so the facing indicator doubles as the grab point.
 *
 * Purely visual — picking is done analytically against circles on the floor,
 * because these live in a viewport that is not the one driving R3F's events.
 */
function Puck({ color, dragging, turning, showBody = true, handleDist = HANDLE_DIST }) {
	return (
		<group>
			{showBody && (
				<>
					<mesh position={[0, 0.03, 0]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={10}>
						<circleGeometry args={[PUCK_R, 6, Math.PI / 6]} />
						<meshBasicMaterial color={color} transparent opacity={0.94} depthWrite={false} depthTest={false} />
					</mesh>
					<mesh position={[0, 0.04, 0]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={10}>
						<ringGeometry
							args={[
								PUCK_R * (dragging ? 1.24 : 1.14),
								PUCK_R * (dragging ? 1.45 : 1.32),
								6,
								1,
								Math.PI / 6,
							]}
						/>
						<meshBasicMaterial
							color={color}
							transparent
							opacity={dragging ? 0.9 : 0.46}
							depthWrite={false}
							depthTest={false}
						/>
					</mesh>
				</>
			)}

			{/* stem: makes the handle read as attached to the puck, not as debris */}
			<mesh position={[0, 0.035, handleDist / 2]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={9}>
				<planeGeometry args={[0.07, handleDist]} />
				<meshBasicMaterial
					color={color}
					transparent
					opacity={turning ? 1 : 0.68}
					depthWrite={false}
					depthTest={false}
				/>
			</mesh>
			<mesh position={[0, 0.045, handleDist]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={11}>
				<circleGeometry args={[turning ? HANDLE_R * 1.2 : HANDLE_R, 4, Math.PI / 4]} />
				<meshBasicMaterial color={color} depthWrite={false} depthTest={false} />
			</mesh>
			<mesh position={[0, 0.044, handleDist]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={11}>
				<ringGeometry args={[HANDLE_R * 1.42, HANDLE_R * 1.62, 4, 1, Math.PI / 4]} />
				<meshBasicMaterial
					color={color}
					transparent
					opacity={turning ? 1 : 0.72}
					depthWrite={false}
					depthTest={false}
				/>
			</mesh>
		</group>
	);
}

/**
 * Floor-plan annotation. Lies flat on the deck so it reads from straight above.
 *
 * Short by design: full names ran into each other the moment two actors stood
 * closer than the width of the word, which in a two-shot is always.
 */
function PlanLabel({ text, color, offset = -0.72, muted = false }) {
	return (
		<Text
			position={[0, 0.05, offset]}
			rotation={[-Math.PI / 2, 0, 0]}
			fontSize={muted ? 0.26 : 0.32}
			color={color}
			anchorX="center"
			anchorY="middle"
			outlineWidth={muted ? 0 : 0.045}
			outlineColor="#0e0d10"
			outlineOpacity={0.92}
			renderOrder={muted ? 8 : 12}
			depthOffset={-1}
		>
			{text}
		</Text>
	);
}

/** A ring around a character's real mesh in its role colour: the cast reads
 * first on a busy plan without the mesh itself being covered. */
function CastRing({ color }) {
	return (
		<mesh position={[0, 0.05, 0]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={11}>
			<ringGeometry args={[CAST_RING_INNER, CAST_RING_OUTER, 40]} />
			<meshBasicMaterial color={color} transparent opacity={0.9} depthWrite={false} depthTest={false} />
		</mesh>
	);
}

/** An Empty on the board: no footprint, just a small cross and a ring where
 * its origin stands, so a group node can be found, selected and dragged like
 * any other row of the plan. */
function EmptyPlanMarker({ object, selected, dragging, turning }) {
	const half = EMPTY_MARKER_SIZE / 2;
	const color = selected ? SELECTED_COLOR : PROP_LABEL_COLOR;
	const rotation = (object.rot * Math.PI) / 180;
	const cross = useMemo(() => [[[-half, 0.04, 0], [half, 0.04, 0]], [[0, 0.04, -half], [0, 0.04, half]]], [half]);
	return (
		<group position={[object.x, 0, object.z]} rotation={[0, rotation, 0]}>
			{cross.map((points, index) => (
				<Line key={index} points={points} color={color} lineWidth={selected ? 2 : 1.5} transparent opacity={selected ? 1 : 0.85} depthWrite={false} depthTest={false} renderOrder={12} />
			))}
			<mesh position={[0, 0.036, 0]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={11}>
				<ringGeometry args={[half * 0.8, half * 0.95, 24]} />
				<meshBasicMaterial color={color} transparent opacity={selected ? 0.9 : 0.6} depthWrite={false} depthTest={false} />
			</mesh>
			<group position={[0, 0, half + 0.35]} rotation={[0, -rotation, 0]}>
				<PlanLabel text={displayObjectLabel(object.name).slice(0, 8)} color={color} offset={0} muted={!selected} />
			</group>
			{selected && <Puck color={SELECTED_COLOR} showBody={false} handleDist={half + 0.65} dragging={dragging} turning={turning} />}
		</group>
	);
}

function SceneObjectFootprint({ object, selected, dragging, turning }) {
	if (isEmptyObject(object)) return <EmptyPlanMarker object={object} selected={selected} dragging={dragging} turning={turning} />;
	const { width, height, depth } = objectSize(object);
	const objectLabel = displayObjectLabel(object.name).slice(0, 8);
	const handleDist = depth / 2 + 0.65;
	const rotation = (object.rot * Math.PI) / 180;
	// An unselected prop is washed where it stands: a pale cap just above its
	// top, depth-tested, so its own colours fade while a character beside or on
	// it still shows through. Selection keeps the loud amber footprint.
	const capY = (object.y ?? 0) + height + 0.02;
	const edge = useMemo(() => {
		const x = width / 2;
		const z = depth / 2;
		return [[-x, capY, -z], [x, capY, -z], [x, capY, z], [-x, capY, z], [-x, capY, -z]];
	}, [width, depth, capY]);
	return (
		<group position={[object.x, 0, object.z]} rotation={[0, rotation, 0]}>
			{selected ? (
				<>
					<mesh position={[0, 0.032, 0]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={10}>
						<planeGeometry args={[width, depth]} />
						<meshBasicMaterial color={SELECTED_COLOR} transparent opacity={0.58} depthWrite={false} depthTest={false} />
					</mesh>
					<mesh position={[0, 0.04, 0]} renderOrder={11}>
						<boxGeometry args={[width, 0.02, depth]} />
						<meshBasicMaterial color={SELECTED_COLOR} wireframe depthTest={false} />
					</mesh>
				</>
			) : (
				<>
					{/* Auto-color mode stamps `autoColor` on displayed objects; the board
					    agrees with the viewport so "the teal box" means the same thing in
					    both panes. */}
					<mesh position={[0, capY, 0]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={6}>
						<planeGeometry args={[width, depth]} />
						<meshBasicMaterial color={object.autoColor ?? OBJECT_COLOR} transparent opacity={0.72} depthWrite={false} />
					</mesh>
					<Line points={edge} color={PROP_EDGE_COLOR} lineWidth={1} transparent opacity={0.7} depthWrite={false} renderOrder={7} />
				</>
			)}
			<group position={[0, 0, depth / 2 + 0.45]} rotation={[0, -rotation, 0]}>
				<PlanLabel text={objectLabel} color={selected ? SELECTED_COLOR : PROP_LABEL_COLOR} offset={0} muted={!selected} />
			</group>
			{selected && <Puck color={SELECTED_COLOR} showBody={false} handleDist={handleDist} dragging={dragging} turning={turning} />}
		</group>
	);
}

const WAYPOINT_COLOR = "#078267";
const RAIL_COLOR = "#7137c8"; // saturated violet, same identity as its timeline lane
const SUBJECT_PATH_COLOR = "#008f83";

function directionTriangle(from, to, distance = 0.26) {
	const dx = to.x - from.x;
	const dz = to.z - from.z;
	const length = Math.hypot(dx, dz);
	if (length < 0.03) return null;
	const ux = dx / length;
	const uz = dz / length;
	const px = -uz;
	const pz = ux;
	const tip = to;
	const base = { x: tip.x - ux * distance, z: tip.z - uz * distance };
	const width = distance * 0.55;
	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute("position", new THREE.Float32BufferAttribute([
		tip.x, 0.052, tip.z,
		base.x + px * width, 0.052, base.z + pz * width,
		base.x - px * width, 0.052, base.z - pz * width,
	], 3));
	return geometry;
}

/** ARDY movement endpoints shown while composing a camera rail. The direct
 * start-to-end vector gives the operator one unambiguous travel direction. */
function SubjectMovementGuide({ track }) {
	const guide = useMemo(() => {
		if (!track?.length) return null;
		const start = track[0];
		const end = track[track.length - 1];
		const moving = Math.hypot(end.x - start.x, end.z - start.z) > 0.05;
		return { start, end, moving, arrow: moving ? directionTriangle(start, end, 0.34) : null };
	}, [track]);
	useEffect(() => () => {
		guide?.arrow?.dispose();
	}, [guide]);
	if (!guide) return null;
	return (
		<group>
			<Line points={[[guide.start.x, 0.041, guide.start.z], [guide.end.x, 0.041, guide.end.z]]} color={SUBJECT_PATH_COLOR} lineWidth={3} transparent opacity={guide.moving ? 0.95 : 0.55} depthWrite={false} depthTest={false} renderOrder={9} />
			{guide.arrow && (
				<mesh geometry={guide.arrow} renderOrder={11}>
					<meshBasicMaterial color={SUBJECT_PATH_COLOR} depthWrite={false} depthTest={false} side={THREE.DoubleSide} />
				</mesh>
			)}
			{[
				{ point: guide.start, label: ko("PATH START", "경로 시작") },
				{ point: guide.end, label: ko("PATH END", "경로 끝") },
			].map(({ point, label }) => (
				<group key={label} position={[point.x, 0, point.z]}>
					<mesh position={[0, 0.055, 0]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={11}>
						<ringGeometry args={[0.12, 0.18, 18]} />
						<meshBasicMaterial color={SUBJECT_PATH_COLOR} depthWrite={false} depthTest={false} />
					</mesh>
					<Text position={[0, 0.06, 0.38]} rotation={[-Math.PI / 2, 0, 0]} fontSize={0.2} color={SUBJECT_PATH_COLOR} anchorX="center" anchorY="middle" outlineWidth={0.035} outlineColor="#0e0d10" outlineOpacity={0.82} renderOrder={12} depthOffset={-1}>
						{`${label} (${point.x.toFixed(1)}, ${point.z.toFixed(1)})`}
					</Text>
				</group>
			))}
			{!guide.moving && (
				<Text position={[guide.start.x, 0.06, guide.start.z - 0.42]} rotation={[-Math.PI / 2, 0, 0]} fontSize={0.24} color={SUBJECT_PATH_COLOR} anchorX="center" anchorY="middle" outlineWidth={0.035} outlineColor="#0e0d10" outlineOpacity={0.82} renderOrder={12} depthOffset={-1}>
					{ko("PLAYER STILL", "플레이어 정지")}
				</Text>
			)}
		</group>
	);
}

/**
 * A scene object's travel path on the plan board. The camera's rail owns
 * RAIL_COLOR; a prop's route gets its own green so the two never read as the
 * same instruction at a glance.
 */
const OBJECT_PATH_COLOR = "#6fcf97";
const OBJECT_PATH_SELECTED_COLOR = "#ffb454";
const OBJECT_PATH_LIT_COLOR = "#d4f7e2";
// How near the floor pointer must be to grab a route point, in metres.
const PATH_POINT_GRAB = 0.34;
function ObjectPathLine({ path, selectedIndex = null, hoverIndex = null, lit = false }) {
	const curve = useMemo(() => (path?.points?.length > 1 ? pathCurve(path) : null), [path]);
	const marks = useMemo(() => (path ? pathMarkFractions(path).map((t) => pathPointAtFraction(path, t)) : []), [path]);
	if (!curve || curve.points.length < 2) return null;
	return (
		<group>
			{/* The camera rail's own line: the curve the object travels, with the
			    same start disc, START label, heading arrow and end ring. Only the
			    colour is the prop's. */}
			<CameraRailLine points={curve.points} color={lit ? OBJECT_PATH_LIT_COLOR : OBJECT_PATH_COLOR} />
			{/* The marks, like the rail's crane dots: the ends plus any added by
			    double-clicking the line. These are what the board lets you grab. */}
			{marks.map((point, index) => point && (
				<mesh
					key={index}
					position={[point.x, 0.042, point.z]}
					rotation={[-Math.PI / 2, 0, 0]}
					renderOrder={12}
				>
					<circleGeometry args={[index === selectedIndex ? 0.13 : index === hoverIndex ? 0.12 : 0.1, 14]} />
					<meshBasicMaterial
						color={index === selectedIndex ? OBJECT_PATH_SELECTED_COLOR : index === hoverIndex ? "#d4f7e2" : "#2f8f5b"}
						depthWrite={false}
						depthTest={false}
					/>
				</mesh>
			))}
		</group>
	);
}

function CameraRailLine({ points, live = false, color = RAIL_COLOR }) {
	const directionGeometry = useMemo(() => {
		if (live || !points || points.length < 2) return null;
		const head = points[0];
		const next = points.find((p) => Math.hypot(p.x - head.x, p.z - head.z) > 0.01);
		if (!next) return null;
		const dx = next.x - head.x;
		const dz = next.z - head.z;
		const length = Math.hypot(dx, dz);
		const ux = dx / length;
		const uz = dz / length;
		const px = -uz;
		const pz = ux;
		const tipDistance = Math.min(0.9, length * 0.72);
		const arrowLength = Math.min(0.34, tipDistance * 0.6);
		const arrowWidth = Math.min(0.18, arrowLength * 0.55);
		const tip = { x: head.x + ux * tipDistance, z: head.z + uz * tipDistance };
		const base = { x: tip.x - ux * arrowLength, z: tip.z - uz * arrowLength };
		const arrow = new THREE.BufferGeometry();
		arrow.setAttribute("position", new THREE.Float32BufferAttribute([
			tip.x, 0.045, tip.z,
			base.x + px * arrowWidth, 0.045, base.z + pz * arrowWidth,
			base.x - px * arrowWidth, 0.045, base.z - pz * arrowWidth,
		], 3));
		return arrow;
	}, [live, points]);
	useEffect(() => () => directionGeometry?.dispose(), [directionGeometry]);
	if (!points || points.length < 2) return null;
	const first = points[0];
	const last = points[points.length - 1];
	return (
		<group>
			<Line points={points.map((point) => [point.x, 0.03, point.z])} color={color} lineWidth={live ? 2.5 : 3.5} transparent opacity={live ? 0.72 : 0.96} depthWrite={false} depthTest={false} renderOrder={9} />
			{!live && (
				<>
					<mesh position={[first.x, 0.04, first.z]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={11}>
						<circleGeometry args={[0.22, 20]} />
						<meshBasicMaterial color={color} depthWrite={false} depthTest={false} />
					</mesh>
					<mesh position={[first.x, 0.039, first.z]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={10}>
						<ringGeometry args={[0.27, 0.32, 20]} />
						<meshBasicMaterial color={color} transparent opacity={0.72} depthWrite={false} depthTest={false} />
					</mesh>
					<Text
						position={[first.x, 0.05, first.z + 0.48]}
						rotation={[-Math.PI / 2, 0, 0]}
						fontSize={0.24}
						color={color}
						anchorX="center"
						anchorY="middle"
						outlineWidth={0.035}
						outlineColor="#0e0d10"
						outlineOpacity={0.85}
						renderOrder={12}
						depthOffset={-1}
					>
						{ko("START", "시작")}
					</Text>
					{directionGeometry && (
						<mesh geometry={directionGeometry} renderOrder={11}>
							<meshBasicMaterial color={color} depthWrite={false} depthTest={false} side={THREE.DoubleSide} />
						</mesh>
					)}
					<mesh position={[last.x, 0.04, last.z]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={10}>
						<ringGeometry args={[0.1, 0.15, 16]} />
						<meshBasicMaterial color={color} depthWrite={false} depthTest={false} />
					</mesh>
				</>
			)}
		</group>
	);
}

/**
 * The root path: numbered dots at each waypoint's floor position, connected
 * in chronological frame order. Lies flat on the deck like the pucks, so it
 * reads from straight above and never enters shot-camera exports.
 */
function WaypointPath({ waypoints, start, activeWaypointId }) {
	const pathPoints = useMemo(() => [{ x: start.x, z: start.z }, ...waypoints], [start.x, start.z, waypoints]);

	return (
		<group>
			{pathPoints.length > 1 && (
				<Line points={pathPoints.map((point) => [point.x, 0.02, point.z])} color={WAYPOINT_COLOR} lineWidth={2.5} transparent opacity={0.9} depthWrite={false} depthTest={false} renderOrder={9} />
			)}
			{waypoints.map((w, i) => {
				const active = w.id === activeWaypointId;
				return (
				<group key={w.id} position={[w.x, 0, w.z]}>
					<mesh position={[0, 0.045, 0]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={11}>
						<circleGeometry args={[active ? 0.2 : 0.15, 20]} />
						<meshBasicMaterial color={active ? "#ffd76c" : WAYPOINT_COLOR} depthWrite={false} depthTest={false} />
					</mesh>
					<Text
						position={[0, 0.05, 0.3]}
						rotation={[-Math.PI / 2, 0, 0]}
						fontSize={0.26}
						color={active ? "#ffd76c" : WAYPOINT_COLOR}
						anchorX="center"
						anchorY="middle"
						outlineWidth={0.04}
						outlineColor="#0e0d10"
						outlineOpacity={0.85}
						renderOrder={12}
						depthOffset={-1}
					>
						{i + 1}
					</Text>
				</group>
				);
			})}
		</group>
	);
}

/**
 * Top-down staging board. Drag a puck to move it, drag its handle to turn it.
 *
 * Picking is analytic rather than raycast-against-meshes: the board lives in a
 * second viewport with its own camera, and R3F's event system only knows about
 * the default one. Everything here sits on the y=0 plane, so a ground-plane
 * intersection plus circle tests is both simpler and exact.
 *
 * Dragging is tracked on `window`, not on the host element: an element only
 * reports moves that still hit it, so a fast drag off the edge silently strands
 * the puck.
 */
export function PlanBoard({ hostRef, planCamRef, shotCamRef, look, fovDeg, characters = [], characterPlacements = [], onMoveCharacter, onCharacterGestureStart, onWaypointGestureStart, onCameraGestureStart, pathStart = null, waypoints, activeWaypointId, onSelectWaypoint, onMoveWaypoint, onSelectEntity, sceneObjects = [], selectedSceneObjectId, onMoveSceneObject, onObjectMoveStart, onObjectMoveEnd, cameraRailPoints = null, railDraw = false, onRailStroke, pathDraw = false, onPathStroke, objectPath = null, objectPathSelectedIndex = null, onObjectPathPointSelect, onObjectPathChange, onObjectPathMarkInsert, onObjectPathGestureStart, onObjectPathGestureEnd, subjectTrack = null, onCameraChange, keyLight = null, minimal = false }) {
	characters = characters.map(entry => {
		const placement = isProxyFigure(entry) && characterPlacements.find(view => view.id === entry.id);
		return placement ? { ...entry, x: placement.position[0], z: placement.position[2], rot: placement.rot } : entry;
	});
	const [drag, setDrag] = useState(null); // { id, mode }
	// live stroke while the rail is being drawn; world XZ, display only
	const [railStroke, setRailStroke] = useState(null);
	// the route mark under the pointer, for the hover highlight
	const [hoverMark, setHoverMark] = useState(null);
	// The pointer is on the route where a double-click would still drop a dot.
	const [hoverLine, setHoverLine] = useState(false);
	const rootRef = useRef();
	const camPos = useRef();
	const camRot = useRef();
	const dragRef = useRef(null);
	// Numbered waypoints are direct-manipulation handles. Empty floor presses
	// intentionally do nothing; root keyframes are authored in the timeline.
	const tools = useMemo(() => createFloorRaycastTools(), []);

	// The overlay belongs to the plan camera alone. Without this the pucks would
	// be drawn flat across the floor of the shot — and into exported frames.
	useLayoutEffect(() => {
		rootRef.current?.traverse((o) => o.layers.set(PLAN_LAYER));
	});

	// The drag listeners must never be re-registered mid-drag: their cleanup
	// clears dragRef, so a dep that changes while dragging (charA.x does, on the
	// very first move) would kill the drag after one frame. Read live values
	// through a ref and keep the effect's deps stable.
	const latest = useRef({ objectPath, objectPathSelectedIndex, onObjectPathPointSelect, onObjectPathChange, onObjectPathMarkInsert, onObjectPathGestureStart, onObjectPathGestureEnd, characters, waypoints, onSelectWaypoint, onMoveWaypoint, onMoveCharacter, onCharacterGestureStart, onWaypointGestureStart, onCameraGestureStart, onSelectEntity, sceneObjects, selectedSceneObjectId, onMoveSceneObject, onObjectMoveStart, onObjectMoveEnd, railDraw, onRailStroke, pathDraw, onPathStroke, onCameraChange });
	latest.current = { objectPath, objectPathSelectedIndex, onObjectPathPointSelect, onObjectPathChange, onObjectPathMarkInsert, onObjectPathGestureStart, onObjectPathGestureEnd, characters, waypoints, onSelectWaypoint, onMoveWaypoint, onMoveCharacter, onCharacterGestureStart, onWaypointGestureStart, onCameraGestureStart, onSelectEntity, sceneObjects, selectedSceneObjectId, onMoveSceneObject, onObjectMoveStart, onObjectMoveEnd, railDraw, onRailStroke, pathDraw, onPathStroke, onCameraChange };

	const targets = () => {
		const cast = latest.current.characters;
		const cam = shotCamRef.current;
		const out = [];
		if (cam) out.push({ id: "cam", x: cam.position.x, z: cam.position.z, yaw: look.current.yaw });
		cast.forEach((entry, listIndex) => {
			if (entry.hidden) return;
			out.push({
				id: listIndex === 0 ? "a" : listIndex === 1 ? "b" : `char:${entry.id}`,
				charId: entry.id,
				x: entry.x,
				z: entry.z,
				yaw: (entry.rot * Math.PI) / 180,
			});
		});
		for (const object of latest.current.sceneObjects) {
			// An Empty has no footprint; it is picked by its marker's size.
			const size = isEmptyObject(object) ? { width: EMPTY_MARKER_SIZE, depth: EMPTY_MARKER_SIZE } : objectSize(object);
			const { width, depth } = size;
			out.push({
				id: `object:${object.id}`,
				objectId: object.id,
				x: object.x,
				z: object.z,
				yaw: (object.rot * Math.PI) / 180,
				rot: object.rot,
				footprint: { width, depth },
				handleDist: depth / 2 + 0.65,
				selected: object.id === latest.current.selectedSceneObjectId,
			});
		}
		return out;
	};

	const aimTarget = () => {
		const cast = latest.current.characters.filter((entry) => !entry.hidden);
		const y = 1.35;
		if (!cast.length) return { x: 0, y, z: 0 };
		// The camera aims at the middle of the whole visible cast, not just
		// the legacy two-shot pair.
		const mid = cast.reduce((acc, entry) => ({ x: acc.x + entry.x / cast.length, z: acc.z + entry.z / cast.length }), { x: 0, z: 0 });
		return { x: mid.x, y, z: mid.z };
	};

	useFrame(() => {
		const cam = shotCamRef.current;
		if (!cam || !camPos.current || !camRot.current) return;
		camPos.current.position.set(cam.position.x, 0, cam.position.z);
		camRot.current.rotation.y = look.current.yaw;
	});

	useEffect(() => {
		const host = hostRef.current;
		if (!host) return undefined;
		const snap = (v, limit) => THREE.MathUtils.clamp(Math.round(v / 0.05) * 0.05, -limit, limit);

		/** pointer -> a point on the floor, seen through the plan camera */
		const toFloor = (event) => floorPointAt(event, host, planCamRef.current, tools);

		// A generous nearest-point hit target makes the numbered roots draggable
		// directly, without requiring a prior timeline selection/focus step.
		const pick = (p) => {
			let nearestWaypoint = null;
			let nearestDistance = Infinity;
			for (const waypoint of latest.current.waypoints) {
				const distance = (p.x - waypoint.x) ** 2 + (p.z - waypoint.z) ** 2;
				if (distance < nearestDistance) {
					nearestWaypoint = waypoint;
					nearestDistance = distance;
				}
			}
			if (nearestWaypoint && nearestDistance < 0.5 ** 2) {
				return { id: `waypoint:${nearestWaypoint.id}`, mode: "waypoint", origin: nearestWaypoint };
			}
			// Overlapping pucks (S1 sitting on the camera, like a close-up
			// setup): the FIRST list entry used to win, so grabbing S1 near the
			// cam moved the camera instead and the character never budged —
			// "the puck doesn't move". Pick the NEAREST target instead.
			// A route's own points outrank pucks: they are smaller, they sit on
			// top of the deck, and a press near one is always meant for it.
			const route = latest.current.objectPath;
			if (route && route.points?.length >= 2) {
				let nearest = null;
				pathMarkFractions(route).forEach((t, i) => {
					const at = pathPointAtFraction(route, t);
					if (!at) return;
					const d = (p.x - at.x) ** 2 + (p.z - at.z) ** 2;
					if (d < PATH_POINT_GRAB * PATH_POINT_GRAB && (!nearest || d < nearest.d)) nearest = { d, index: i };
				});
				if (nearest) return { id: `path:${nearest.index}`, mode: "pathPoint", origin: { pathIndex: nearest.index } };
			}
			const list = targets();
			let best = null;
			for (const e of list) {
				const h = handleAt(e);
				const dh = (p.x - h.x) ** 2 + (p.z - h.z) ** 2;
				if ((!e.objectId || e.selected) && dh < HANDLE_GRAB * HANDLE_GRAB && (!best || dh < best.d)) best = { id: e.id, mode: "turn", origin: e, d: dh };
				const db = (p.x - e.x) ** 2 + (p.z - e.z) ** 2;
				const bodyHit = e.objectId ? insideFootprint(p, e) : db < GRAB_R * GRAB_R;
				if (bodyHit && (!best || db < best.d)) best = { id: e.id, mode: "move", origin: e, d: db };
			}
			if (best) return { id: best.id, mode: best.mode, origin: best.origin };
			return null;
		};

		const onDown = (event) => {
			if (event.button !== 0) return;
			// Rail drawing and object-path drawing share one stroke gesture:
			// a stroke starts anywhere on the deck, so puck picking would
			// fight every stroke that crosses one.
			const strokeTool = latest.current.railDraw ? "rail" : latest.current.pathDraw ? "path" : null;
			if (strokeTool) {
				const start = toFloor(event);
				if (!start) return;
				event.preventDefault();
				event.stopPropagation();
				dragRef.current = { mode: strokeTool, stroke: [{ x: start.x, z: start.z }] };
				setDrag({ id: strokeTool, mode: strokeTool });
				setRailStroke([{ x: start.x, z: start.z }]);
				host.style.cursor = "crosshair";
				return;
			}
			const p = toFloor(event);
			const grip = p && pick(p);
			if (!grip) return;
			event.preventDefault();
			event.stopPropagation();
			dragRef.current = grip;
			setDrag({ id: grip.id, mode: grip.mode });
			if (grip.mode === "pathPoint") latest.current.onObjectPathPointSelect?.(grip.origin.pathIndex);
			else if (grip.mode === "waypoint") latest.current.onSelectWaypoint?.(grip.origin.id);
			else latest.current.onSelectEntity?.(grip.id);
			// Scene-object grips only: select FIRST (the call above), then
			// begin — App's select handler settles any open transaction, so
			// beginning before the select would leak the freshly-issued token
			// instantly (plan §6.4). Camera, character and waypoint grips
			// write separate state and must never open a scene transaction.
			if (grip.mode === "pathPoint") {
				// One undo entry per mark drag, like every other plan gesture.
				latest.current.onObjectPathGestureStart?.();
				// The bend this drag applies (the camera rail's own preparation):
				// the route's points around the mark follow, fading out by the
				// neighbouring marks.
				const route = latest.current.objectPath;
				const fractions = pathMarkFractions(route);
				const base = pathPointAtFraction(route, fractions[grip.origin.pathIndex]);
				const bend = base && prepareRailBend(route.points, base, fractions.map((t) => ({ t })), grip.origin.pathIndex, { maxControls: MAX_PATH_POINTS });
				dragRef.current.bend = bend;
				dragRef.current.pressed = { x: p.x, z: p.z };
			} else if (grip.origin.objectId) {
				dragRef.current.token = latest.current.onObjectMoveStart?.({
					owner: "plan",
					cancel: () => teardownDrag(grip),
				});
			} else if (grip.origin.charId) {
				// One undo entry per character gesture: App snapshots the cast
				// here, the drag's per-tick moves then apply on top.
				latest.current.onCharacterGestureStart?.();
			} else if (grip.mode === "waypoint") {
				// Same contract for the root path: one entry per waypoint drag,
				// snapshotted before the first onMoveWaypoint tick lands.
				latest.current.onWaypointGestureStart?.();
			} else if (grip.id === "cam") {
				// The camera puck writes shot framing (move AND turn), so its
				// gesture opens a shot-level entry before the first commit.
				latest.current.onCameraGestureStart?.();
			}
			host.style.cursor = grip.mode === "turn" ? "ew-resize" : "grabbing";
		};

		// hover is the only cue that these are handles at all
		const onHover = (event) => {
			if (dragRef.current) return;
			if (latest.current.railDraw || latest.current.pathDraw) {
				host.style.cursor = "crosshair";
				return;
			}
			const p = toFloor(event);
			const grip = p && pick(p);
			const markIndex = grip?.mode === "pathPoint" ? grip.origin.pathIndex : null;
			setHoverMark((current) => (current === markIndex ? current : markIndex));
			// The route answers too: it brightens and the cursor says "copy" while a
			// double-click here would still add a dot.
			let addable = false;
			const route = latest.current.objectPath;
			if (!grip && p && route && route.points?.length >= 2) {
				const fractions = pathMarkFractions(route);
				if (fractions.length < MAX_PATH_MARKS) {
					const best = nearestPathFraction(route, (point) => ({ x: point.x, y: point.z }), p.x, p.z);
					addable = !!best && best.d <= PATH_POINT_GRAB && !fractions.some((entry) => Math.abs(entry - best.t) < MARK_GAP + 0.01);
				}
			}
			setHoverLine((current) => (current === addable ? current : addable));
			host.style.cursor = addable
				? "copy"
				: !grip
					? "default"
					: grip.mode === "turn"
						? "ew-resize"
						: "grab";
		};

		const onMove = (event) => {
			const grip = dragRef.current;
			if (!grip) return;
			const p = toFloor(event);
			if (!p) return;

			if (grip.mode === "rail" || grip.mode === "path") {
				// sample sparsely; RDP simplifies the rest on commit
				const tail = grip.stroke[grip.stroke.length - 1];
				if (Math.hypot(p.x - tail.x, p.z - tail.z) > 0.06) {
					grip.stroke.push({ x: p.x, z: p.z });
					setRailStroke([...grip.stroke]);
				}
				return;
			}

			if (grip.mode === "pathPoint") {
				if (!grip.bend) return;
				// Floor only: a point's height is the scene's business, so y rides
				// through untouched. The pull is snapped like every board move.
				const dx = Math.round((p.x - grip.pressed.x) / 0.05) * 0.05;
				const dz = Math.round((p.z - grip.pressed.z) / 0.05) * 0.05;
				const moved = grip.bend.startControls.map((entry, i) => {
					const weight = grip.bend.weights[i];
					return weight > 0
						? { ...entry, x: THREE.MathUtils.clamp(entry.x + dx * weight, -ROOM_LIMIT, ROOM_LIMIT), z: THREE.MathUtils.clamp(entry.z + dz * weight, -ROOM_LIMIT, ROOM_LIMIT) }
						: entry;
				});
				latest.current.onObjectPathChange?.({ points: moved });
				return;
			}

			if (grip.mode === "waypoint") {
				latest.current.onMoveWaypoint?.(grip.origin.id, snap(p.x, ROOM_LIMIT), snap(p.z, ROOM_LIMIT));
				return;
			}

			if (grip.mode === "turn") {
				const dx = p.x - grip.origin.x;
				const dz = p.z - grip.origin.z;
				// Right on the pivot there is no direction to read, and atan2 of a
				// near-zero vector snaps wildly. Hold the last angle instead.
				if (dx * dx + dz * dz < 0.04) return;
				const yaw = yawToward(dx, dz);
				if (grip.id === "cam") {
					// a manual aim; the operator has decided to point off-subject
					look.current.yaw = yaw;
					latest.current.onCameraChange?.();
					return;
				}
				// 5° detents, because actors are blocked to clean angles
				const deg = wrapDeg(Math.round((yaw * 180) / Math.PI / 5) * 5);
				if (grip.origin.objectId) latest.current.onMoveSceneObject?.(grip.origin.objectId, { rot: deg }, grip.token);
				else latest.current.onMoveCharacter?.(grip.origin.charId, (prev) => ({ ...prev, rot: deg }));
				return;
			}

			if (grip.id === "cam") {
				const cam = shotCamRef.current;
				if (!cam) return;
				cam.position.set(snap(p.x, ROOM_LIMIT), cam.position.y, snap(p.z, ROOM_LIMIT));
				// Sliding the camera across the floor plan must keep it pointed at the
				// cast. Without this every drag leaves the lens staring at a wall.
				const angles = aimAt(cam.position, aimTarget());
				look.current.yaw = angles.yaw;
				look.current.pitch = angles.pitch;
				latest.current.onCameraChange?.();
				return;
			}
			const next = { x: snap(p.x, ACTOR_LIMIT), z: snap(p.z, ACTOR_LIMIT) };
			if (grip.origin.objectId) latest.current.onMoveSceneObject?.(grip.origin.objectId, {
				x: snap(p.x, ROOM_LIMIT),
				z: snap(p.z, ROOM_LIMIT),
			}, grip.token);
			else latest.current.onMoveCharacter?.(grip.origin.charId, (prev) => ({ ...prev, ...next }));
		};

		// Teardown-only close: null the drag ref and reset the drag visuals.
		// Never closes the transaction — used by the store's cancel (which is
		// forbidden from calling the end prop back, plan §6.2) as well as the
		// producer's own close paths.
		const teardownDrag = (grip) => {
			if (!grip || dragRef.current !== grip) return;
			dragRef.current = null;
			setDrag(null);
			host.style.cursor = "default";
		};

		// pointerup, pointercancel, window blur and unmount all COMMIT: the
		// travel already applied is real work the user can see, so it becomes
		// one undo entry rather than being silently reverted (plan §6.3).
		// Escape is the only gesture that rolls back.
		const closeDrag = (commit) => {
			const grip = dragRef.current;
			if (!grip) return;
			if (grip.mode === "rail" || grip.mode === "path") {
				// commit hands the raw stroke to the app (which simplifies and
				// splines it); Escape throws the stroke away
				const tool = grip.mode;
				teardownDrag(grip);
				setRailStroke(null);
				if (commit && grip.stroke.length >= 2) {
					if (tool === "rail") latest.current.onRailStroke?.(grip.stroke);
					else latest.current.onPathStroke?.(grip.stroke);
				}
				return;
			}
			if (grip.mode === "pathPoint") {
				teardownDrag(grip);
				latest.current.onObjectPathGestureEnd?.(commit);
				return;
			}
			const token = grip.token;
			teardownDrag(grip);
			if (commit && grip.id === "cam") latest.current.onCameraChange?.();
			if (token != null) latest.current.onObjectMoveEnd?.(token, { commit });
		};

		const onUp = () => {
			closeDrag(true);
		};

		const onCancel = () => closeDrag(true);

		const onBlur = () => closeDrag(true);

		// Double-click the route to drop a point mid-path — the same gesture the
		// 3D scene uses, offered here because this is the board the route was
		// drawn on, so this is where a hand goes looking for it.
		const onDouble = (event) => {
			const route = latest.current.objectPath;
			if (!route || route.points?.length < 2) return;
			if (latest.current.railDraw || latest.current.pathDraw) return;
			const p = toFloor(event);
			if (!p) return;
			const fractions = pathMarkFractions(route);
			if (fractions.length >= MAX_PATH_MARKS) return;
			const best = nearestPathFraction(route, (point) => ({ x: point.x, y: point.z }), p.x, p.z);
			// Near the line, and not on top of a mark that is already there.
			if (!best || best.d > PATH_POINT_GRAB) return;
			if (fractions.some((entry) => Math.abs(entry - best.t) < MARK_GAP + 0.01)) return;
			event.preventDefault();
			event.stopPropagation();
			latest.current.onObjectPathMarkInsert?.(best.t);
		};

		const onEscape = (event) => {
			if (event.key !== "Escape") return;
			if (!dragRef.current) return;
			// Capture-phase stopPropagation keeps the same press from also
			// reaching App's Escape-clears-selection handler (plan §7).
			event.stopPropagation();
			closeDrag(false);
		};

		host.addEventListener("pointerdown", onDown);
		host.addEventListener("dblclick", onDouble);
		host.addEventListener("pointermove", onHover);
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
		window.addEventListener("pointercancel", onCancel);
		window.addEventListener("blur", onBlur);
		window.addEventListener("keydown", onEscape, true);
		return () => {
			host.removeEventListener("pointerdown", onDown);
			host.removeEventListener("dblclick", onDouble);
			host.removeEventListener("pointermove", onHover);
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
			window.removeEventListener("pointercancel", onCancel);
			window.removeEventListener("blur", onBlur);
			window.removeEventListener("keydown", onEscape, true);
			closeDrag(true);
		};
	}, [hostRef, planCamRef, shotCamRef, tools, look]);

	const state = (id) => ({ dragging: drag?.id === id && drag.mode === "move", turning: drag?.id === id && drag.mode === "turn" });

	return (
		<group ref={rootRef}>
			<group ref={camPos}>
				<PlanLabel text={ko("CAM", "카메라")} color={CAMERA_COLOR} />
				<group ref={camRot}>
					<FrustumWedge fovDeg={fovDeg} active={drag?.id === "cam"} />
					<Puck color={CAMERA_COLOR} {...state("cam")} />
				</group>
			</group>

			{characters.map((entry, listIndex) => {
				if (entry.hidden) return null;
				const puckId = listIndex === 0 ? "a" : listIndex === 1 ? "b" : `char:${entry.id}`;
				const color = listIndex === 0 ? SUBJECT_ONE_COLOR : SUBJECT_TWO_COLOR;
				return (
					<group key={entry.id} position={[entry.x, 0, entry.z]} userData={{ characterPuck: entry.id }}>
						<PlanLabel text={ko(`S${listIndex + 1}`, `인물 ${listIndex + 1}`)} color={color} offset={-(CAST_RING_OUTER + 0.3)} />
						<CastRing color={color} />
						<group rotation={[0, (entry.rot * Math.PI) / 180, 0]}>
							{/* The real character mesh already renders in Top-View. Keep only
							    its facing stem/handle instead of covering it with a hex puck. */}
							<Puck color={color} showBody={false} {...state(puckId)} />
						</group>
					</group>
				);
			})}

			{/* Minimal board (landing playground): camera, cast and the rail only.
			    Footprints, labels, waypoints, guides and the light are the working
			    board's business and read as clutter to someone drawing a first dolly. */}
			{!minimal && sceneObjects.map((object) => (
				<SceneObjectFootprint
					key={object.id}
					object={object}
					selected={object.id === selectedSceneObjectId}
					{...state(`object:${object.id}`)}
				/>
			))}

			{!minimal && waypoints.length > 0 && <WaypointPath waypoints={waypoints} start={pathStart ?? characters[0] ?? { x: 0, z: 0 }} activeWaypointId={activeWaypointId} />}
			{!minimal && (railDraw || cameraRailPoints) && <SubjectMovementGuide track={subjectTrack} />}
			{cameraRailPoints && cameraRailPoints.length > 1 && <CameraRailLine points={cameraRailPoints} />}
			{railStroke && railStroke.length > 1 && <CameraRailLine points={railStroke} live />}
			{/* The selected object's travel path, drawn in its own colour so a
			    prop's route never reads as the camera's rail. */}
			{!minimal && objectPath && objectPath.points?.length > 1 && <ObjectPathLine path={objectPath} selectedIndex={objectPathSelectedIndex} hoverIndex={hoverMark} lit={hoverLine} />}
			{/* The sun on the floor plan: a gold disc + a stem toward the stage
			    centre, so blocking can read where the light comes from without
			    switching to the 3D scene. Not draggable here — the 3D puck owns
			    the gesture; this is a readout. */}
			{!minimal && keyLight && (
				<group position={[keyLight.x, 0, keyLight.z]}>
					<mesh position={[0, 0.05, 0]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={10}>
						<circleGeometry args={[PUCK_R * 0.7, 20]} />
						<meshBasicMaterial color="#f2b544" transparent opacity={0.85} depthWrite={false} depthTest={false} />
					</mesh>
					{(() => {
						// stem pointing at the stage centre, in the light's local frame
						const angle = Math.atan2(-keyLight.x, -keyLight.z);
						const dist = Math.hypot(keyLight.x, keyLight.z);
						return (
							<group rotation={[0, angle, 0]}>
								<mesh position={[0, 0.045, dist / 2]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={9}>
									<planeGeometry args={[0.05, dist]} />
									<meshBasicMaterial color="#f2b544" transparent opacity={0.35} depthWrite={false} depthTest={false} />
								</mesh>
							</group>
						);
					})()}
					<PlanLabel text={ko("LIGHT", "조명")} color="#f2b544" offset={-0.5} />
				</group>
			)}
		</group>
	);
}
