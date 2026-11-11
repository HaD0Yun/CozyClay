/**
 * Set props: low-poly clay maquettes to block against.
 *
 * The set is a bare room and a figure; a shot that needs "something in the
 * world" (a wall to lean on, to walk past, to frame behind) has nothing
 * to work with. These props are built from primitives in the same clay style
 * as the Room and the character tint, so the whole frame stays one
 * consistent maquette. Practical lights and glow live in scene-lights.jsx
 * and object-glow.js.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import { objectTransformAt } from "./object-path.js";
import { sceneObjectCarryMatrixAt, sceneObjectTravelMatrixAt, trackShown, travelPose } from "./object-travel.js";
import * as THREE from "three";
import { GIZMO_LAYER } from "./dualview.jsx";
import { CUTOUT_KIND, MESH_KIND, EMPTY_KIND, EMPTY_MARKER_SIZE, SCULPT_KIND } from "./scene-objects.js";
import { TEXT_KIND } from "./text/text-record.js";
import { TextObject } from "./text/text-object.jsx";
import { useSharedSculpt } from "./shared-sculpt.js";
import { depthRankProps, usePrimitiveLook } from "./primitive-look.js";
import { subscribeToAssetTexture } from "./scene-asset-cache.js";
import { ImportedMesh } from "./imported-mesh.jsx";
import { EffectMarker, EffectsLayer } from "./effects/EffectsLayer.jsx";
import { EFFECT_KIND } from "./effects/effect-record.js";
import { applyPoseFade } from "./pose-fade.js";
import { coplanarDepthRanks } from "./coplanar-depth.js";
import { autoFlat } from "./auto-flat.js";
import { LIGHT_KIND, capPracticalShadows } from "./object-look.js";
import { SceneLight, useLookRefresh } from "./scene-lights.jsx";
import { placeObjectLook } from "./scene-light-place.js";

/**
 * The creatable primitives, Unity's 3D Object menu in clay. Each one is built
 * with its base on the local floor (y = 0), so an object's `y` reads as height
 * above the deck rather than "half of me is underground". A surface preset
 * (primitive-look.js) replaces the clay; glass casts no shadow.
 */
function Primitive({ kind, object, color, autoColor, depthRank = 0 }) {
	const side = kind === "plane" ? THREE.DoubleSide : THREE.FrontSide;
	const look = usePrimitiveLook(object, kind, side, depthRank), cast = !(look?.transmission > 0);
	const material = look ? <primitive object={look} attach="material" /> : autoColor ? (
		<meshStandardMaterial {...autoFlat(autoColor)} side={side} {...depthRankProps(depthRank)} />
	) : (
		<meshStandardMaterial color={color} roughness={0.82} side={side} {...depthRankProps(depthRank)} />
	);
	if (kind === "sphere") {
		return (
			<mesh position={[0, 0.5, 0]} castShadow={cast} receiveShadow>
				<sphereGeometry args={[0.5, 28, 18]} />
				{material}
			</mesh>
		);
	}
	if (kind === "capsule") {
		return (
			<mesh position={[0, 0.7, 0]} castShadow={cast} receiveShadow>
				<capsuleGeometry args={[0.35, 0.7, 6, 18]} />
				{material}
			</mesh>
		);
	}
	if (kind === "cylinder") {
		return (
			<mesh position={[0, 0.5, 0]} castShadow={cast} receiveShadow>
				<cylinderGeometry args={[0.5, 0.5, 1, 26]} />
				{material}
			</mesh>
		);
	}
	if (kind === "cone") {
		return (
			<mesh position={[0, 0.5, 0]} castShadow={cast} receiveShadow>
				<coneGeometry args={[0.5, 1, 26]} />
				{material}
			</mesh>
		);
	}
	if (kind === "plane") {
		return (
			<mesh position={[0, 0.004, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
				<planeGeometry args={[2, 2]} />
				{material}
			</mesh>
		);
	}
	return (
		<mesh position={[0, 0.5, 0]} castShadow={cast} receiveShadow>
			<boxGeometry args={[1, 1, 1]} />
			{material}
		</mesh>
	);
}

/** The texture behind an `assetId`, or null while it loads (or forever, if the
 * picture is gone). Subscribing rather than loading here means the same
 * picture on two cards is one decode. */
function useAssetTexture(assetId) {
	const [texture, setTexture] = useState(null);
	useEffect(() => {
		setTexture(null);
		if (!assetId) return undefined;
		return subscribeToAssetTexture(assetId, setTexture);
	}, [assetId]);
	return texture;
}

/** The placeholder tint for a card whose picture has not arrived (or has gone
 * missing): blockout grey, because that is exactly what it is again. */
const MISSING_CUTOUT = "#c2c6c8";

/**
 * A cutout: an imported picture standing on a card, the standee a blockout
 * gets instead of a modelled prop.
 *
 * The card is built base-on-the-floor like every primitive, and sized in
 * metres by the record — `footprint.width` is already derived from the
 * measured height and the picture's aspect, so the geometry never has to do
 * that arithmetic again.
 *
 * Alpha-CUT, not blended: `alphaTest` keeps the card writing depth, which is
 * what lets the ink pass, the shadows and the grey boxes all agree about what
 * is in front of what. A blended card would sort by object and swim through
 * the set.
 *
 * But a bare alpha test is a decision per pixel, so the silhouette comes out
 * as a staircase — and the matte's own soft edge is thrown away at the
 * threshold. `alphaToCoverage` spends the MSAA samples the canvas already has
 * on that edge instead: partial alpha becomes partial coverage, so the outline
 * is resolved by the same antialiasing that smooths every other edge in the
 * frame, and depth is still written. The test then only has to reject what is
 * genuinely nothing (0.15), rather than choosing a side for every half-lit
 * pixel — which is also what keeps a thin structure alive as the card recedes
 * and its alpha is averaged down by the mip chain.
 */
function Cutout({ object }) {
	const texture = useAssetTexture(object.assetId);
	const width = object.footprint?.width ?? 1;
	const height = object.height ?? 1;
	return (
		<mesh position={[0, height / 2, 0]} castShadow receiveShadow userData={{ cutoutTexture: texture ?? null }}>
			<planeGeometry args={[width, height]} />
			<meshStandardMaterial
				map={texture ?? null}
				color={texture ? object.color : MISSING_CUTOUT}
				// A card seen edge-on is a card, not a hole: both faces draw.
				side={THREE.DoubleSide}
				alphaTest={texture ? 0.15 : 0}
				alphaToCoverage={!!texture}
				roughness={0.92}
				metalness={0}
			/>
		</mesh>
	);
}

/**
 * A sculpt: the clay parts its recipe describes, built once per recipe and
 * shared by its copies. The shaded look is buildSculptGroup's own clay (part
 * colours, gradients, scatter tints); auto-colour paints the whole sculpt flat
 * like any other prop, because it is one object. Depth rank rides on either.
 */
function Sculpt({ object, depthRank = 0 }) {
	// Copies of one recipe share its built geometry (shared-sculpt.js); the record's colour tints the copy.
	return <primitive object={useSharedSculpt(object, depthRank)} />;
}

const PRIMITIVE_KINDS = new Set(["cube", "sphere", "capsule", "cylinder", "cone", "plane"]);

// X red, Y green, Z blue: the DCC convention, so a turned Empty reads its own
// orientation off the marker.
const EMPTY_AXES = [
	{ to: [1, 0, 0], color: "#e5594f" },
	{ to: [0, 1, 0], color: "#5fb95f" },
	{ to: [0, 0, 1], color: "#4f86e5" },
];

/**
 * An Empty's viewport presence: a three-axis cross and a pick volume, and
 * nothing else. It is editor furniture, so every node sits on GIZMO_LAYER —
 * the layer the shot camera, the preview card, PlayView, the ink prepass and
 * the recorder all drop — and it casts no shadow because it has no mesh to
 * cast one. The pick volume is invisible (never drawn) but still raycasts; the
 * object picker finds it by `userData.emptyPick` on the gizmo-layer pass.
 */
function EmptyMarker() {
	const half = EMPTY_MARKER_SIZE / 2;
	const axes = useMemo(() => {
		const positions = [], colors = [];
		const color = new THREE.Color();
		for (const axis of EMPTY_AXES) {
			positions.push(-axis.to[0] * half, -axis.to[1] * half, -axis.to[2] * half, axis.to[0] * half, axis.to[1] * half, axis.to[2] * half);
			color.set(axis.color);
			colors.push(color.r, color.g, color.b, color.r, color.g, color.b);
		}
		const geometry = new THREE.BufferGeometry();
		geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
		geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
		return geometry;
	}, [half]);
	useEffect(() => () => axes.dispose(), [axes]);
	const onLayer = (node) => node?.layers.set(GIZMO_LAYER);
	return (
		<group userData={{ emptyMarker: true }}>
			<lineSegments ref={onLayer} geometry={axes} renderOrder={997} frustumCulled={false}>
				<lineBasicMaterial vertexColors depthTest={false} depthWrite={false} transparent opacity={0.95} />
			</lineSegments>
			<mesh ref={onLayer} visible={false} userData={{ emptyPick: true }}>
				<sphereGeometry args={[half * 1.25, 12, 8]} />
				<meshBasicMaterial />
			</mesh>
		</group>
	);
}

function SceneObjectContent({ object, depthRank = 0 }) {
	// `autoColor` is the viewport-only display color the auto-color mode stamps
	// onto the DISPLAYED object (App's displaySceneObjects); the authored
	// `color` is untouched underneath. Cutouts stay out: tinting a photo
	// standee destroys the one thing it is for. Imported meshes take the same
	// override as a cube — file materials are cloned and tinted per instance.
	const { renderer, color, autoColor } = object;
	if (renderer === EMPTY_KIND) return <EmptyMarker />;
	if (renderer === LIGHT_KIND) return <SceneLight object={object} />;
	if (renderer === EFFECT_KIND) return <EffectMarker object={object} />;
	if (renderer === CUTOUT_KIND) return <Cutout object={object} />;
	if (renderer === MESH_KIND) return <ImportedMesh object={object} />;
	if (renderer === SCULPT_KIND) return <Sculpt object={object} depthRank={depthRank} />;
	if (renderer === TEXT_KIND) return <TextObject object={object} />;
	if (PRIMITIVE_KINDS.has(renderer)) return <Primitive kind={renderer} object={object} color={color} autoColor={autoColor} depthRank={depthRank} />;
	return null;
}

/**
 * Selection cage: the object's bounding box drawn as EDGES only. A wireframe
 * box draws every triangle diagonal too, which reads as a scribble over the
 * object instead of a selection.
 */
function SelectionBox({ object }) {
	// An Empty has no extent, so its cage is the marker's own cube, centred on
	// the origin (a prop's cage stands on it).
	const empty = object.renderer === EMPTY_KIND || object.renderer === LIGHT_KIND || object.renderer === EFFECT_KIND;
	const height = empty ? EMPTY_MARKER_SIZE : Math.max(object.height ?? 1, 0.08);
	const width = empty ? EMPTY_MARKER_SIZE : object.footprint?.width ?? 1;
	const depth = empty ? EMPTY_MARKER_SIZE : object.footprint?.depth ?? 1;
	const edges = useMemo(
		() => new THREE.EdgesGeometry(new THREE.BoxGeometry(width * 1.04, height * 1.04, depth * 1.04)),
		[width, height, depth],
	);
	useEffect(() => () => edges.dispose(), [edges]);
	return (
		<lineSegments
			// The cage is editor furniture, exactly like the transform gizmo, so
			// it lives on GIZMO_LAYER — the layer PlayView, the ink prepass and
			// CaptureRig already strip. Set on the mesh itself (via the ref):
			// three.js layer membership is per object, and the camera mask
			// checks the object that actually renders.
			ref={(mesh) => {
				if (mesh) mesh.layers.set(GIZMO_LAYER);
			}}
			geometry={edges}
			position={[0, empty ? 0 : height / 2, 0]}
			renderOrder={998}
		>
			<lineBasicMaterial color="#e7b557" transparent opacity={0.95} depthTest={false} depthWrite={false} />
		</lineSegments>
	);
}

const DEG = Math.PI / 180;

// One scratch set for the whole module: placement runs per prop per frame.
const placePos = new THREE.Vector3();
const placeQuat = new THREE.Quaternion();
const placeScale = new THREE.Vector3();
const placeEuler = new THREE.Euler();
const placeLocal = new THREE.Matrix4();
const placeWorld = new THREE.Matrix4();
const placeFrame = new THREE.Matrix4();

function SceneObject({ object, selected, frameRef = null, take = null, attachFrameRef = null, registryRef = null, travelLookupRef = null, fadeOpacity = null, depthRank = 0 }) {
	const groupRef = useRef(null);
	const attach = object.attach ?? null;
	// An object on a travel path — or one CARRIED by a character — is placed
	// imperatively from the frame ref, not from React state: the offscreen
	// export advances frames without a re-render, and a prop that only moved on
	// re-render would freeze in the recording while the preview animated. A
	// carried prop is the same problem one level up: the bone it rides is
	// written straight into the scene graph by the playback code, never through
	// React, so nothing re-renders when the character moves.
	const place = () => {
		const group = groupRef.current;
		if (!group) return;
		const frame = frameRef?.current ?? 0;
		// A record under a routed parent travels with it (object-travel.js), and
		// so does a routed record itself: one answer from the authored records.
		const travelled = frameRef && !attach && travelLookupRef?.current
			? sceneObjectTravelMatrixAt(travelLookupRef.current, object.id, frame, take ?? {}, placeWorld)
			: null;
		if ((group.visible = trackShown(object.id, frame, take, travelLookupRef?.current)) && travelled) {
			travelled.decompose(group.position, group.quaternion, group.scale);
		} else if (attach || object.path) {
			// The authored numbers first. While attached they are the prop's LOCAL
			// transform in the attach frame; otherwise they are already world.
			placePos.set(object.x, object.y ?? 0, object.z);
			placeEuler.set((object.rotX ?? 0) * DEG, object.rot * DEG, (object.rotZ ?? 0) * DEG, "XYZ");
			placeScale.set(object.scaleX ?? 1, object.scaleY ?? 1, object.scaleZ ?? 1);
			if (frameRef && object.path) {
				const at = objectTransformAt(object, frame, take ?? {});
				if (at) {
					placePos.set(at.x, at.y, at.z);
					// The same pose object-travel gives a routed record: yaw, then
					// the body's own pitch, then its roll (+ the route's lean).
					const pose = travelPose(object, at);
					placeEuler.set(pose.rotX * DEG, pose.rot * DEG, pose.rotZ * DEG, "YXZ");
				}
			}
			// A missing rig (the character left the cast, or its model has not
			// mounted yet) leaves a dangling attachment: place the numbers as plain
			// world, exactly like a detached prop, rather than freeze the prop at
			// whatever pose it last held.
			const rigFrame = attach ? attachFrameRef?.current?.(attach.characterId, attach.bone ?? null, placeFrame) ?? null : null;
			if (rigFrame) {
				placeLocal.compose(placePos, placeQuat.setFromEuler(placeEuler), placeScale);
				placeWorld.multiplyMatrices(rigFrame, placeLocal).decompose(placePos, placeQuat, placeScale);
				group.position.copy(placePos);
				group.quaternion.copy(placeQuat);
				group.scale.copy(placeScale);
			} else {
				group.position.copy(placePos);
				group.rotation.copy(placeEuler);
				group.scale.copy(placeScale);
			}
		}
		// QA hook: headless checks read the ANIMATED, WORLD position here, because
		// the store only knows the authored one — and while attached the authored
		// one is not even in world space. Harmless in normal use.
		if (typeof window !== "undefined") {
			(window.__cclayPropWorld ??= {})[object.id] = { x: group.position.x, y: group.position.y, z: group.position.z, quat: { x: group.quaternion.x, y: group.quaternion.y, z: group.quaternion.z, w: group.quaternion.w }, frame };
		}
		applyPoseFade(group, fadeOpacity, object.opacity ?? 1);
		// A light's level, flicker and aim, and a glow, for this frame (scene-light-place.js).
		placeObjectLook(group, object, frame, take);
	};
	useFrame(place);
	useLookRefresh(object);
	// Two things the App needs to reach imperatively, registered per prop: a
	// placement pass for the recorder (which renders through gl.render() and so
	// never runs the frame loop — see SetProps' syncRef), and the prop's live
	// world matrix, which is what a hierarchy drop converts FROM. The ref
	// indirection keeps the registered callbacks reading the CURRENT object.
	const placeRef = useRef(place);
	placeRef.current = place;
	const entryRef = useRef(null);
	if (!entryRef.current) {
		entryRef.current = {
			place: () => placeRef.current(),
			// Rebuilt from the transform place() last wrote, so it is exactly what
			// is on screen — including while paused, when no frame has run since.
			world: (out) => {
				const group = groupRef.current;
				if (!group) return null;
				group.updateWorldMatrix(true, false);
				return out ? out.copy(group.matrixWorld) : group.matrixWorld;
			},
		};
	}
	useEffect(() => {
		if (!registryRef) return undefined;
		const registry = registryRef.current;
		registry.set(object.id, entryRef.current);
		return () => { registry.delete(object.id); };
	}, [registryRef, object.id]);
	return (
		<group
			ref={groupRef}
			position={[object.x, object.y ?? 0, object.z]}
			rotation={[(object.rotX ?? 0) * DEG, object.rot * DEG, (object.rotZ ?? 0) * DEG]}
			scale={[object.scaleX ?? 1, object.scaleY ?? 1, object.scaleZ ?? 1]}
			// the viewport picker walks up from a hit mesh to find this id
			userData={{ sceneObjectId: object.id }}
		>
			<SceneObjectContent object={object} depthRank={depthRank} />
			{selected && <SelectionBox object={object} />}
		</group>
	);
}

/** User-added scene objects, all driven by the shared object registry.
 *
 * `attachFrameRef.current(characterId, bone, out)` resolves the live world
 * frame a carried prop rides, or null. `syncRef` is filled with a "place every
 * prop now" callback for the offscreen export, which renders outside the frame
 * loop and would otherwise record props one frame stale; `worldRef` with a
 * "where is this prop" lookup, so a reparent converts from the transform on
 * screen instead of from a second computation of it. */
export function SetProps({ objects = [], authoredObjects = null, selectedId = null, frameRef = null, take = null, attachFrameRef = null, syncRef = null, worldRef = null, fadeOpacity = null }) {
	const registryRef = useRef(null);
	// The authored records by id: a child's travel is its routed parent's
	// route against the parent's AUTHORED pose, which the display copies in
	// `objects` no longer carry once they have been animated.
	const travelLookupRef = useRef(null);
	travelLookupRef.current = useMemo(() => (authoredObjects ? new Map(authoredObjects.map((object) => [object.id, object])) : null), [authoredObjects]);
	// Coplanar-face ranks come from the AUTHORED records: a routed group moves
	// rigidly, so what shares a plane at rest shares it on every frame.
	const depthRanks = useMemo(() => coplanarDepthRanks(authoredObjects ?? objects), [authoredObjects, objects]);
	if (!registryRef.current) registryRef.current = new Map();
	if (syncRef) syncRef.current = () => { for (const entry of registryRef.current.values()) entry.place(); };
	if (worldRef) worldRef.current = (id, out) => registryRef.current.get(id)?.world(out) ?? null;
	return (
		<group>
			{/* Lights past the practical shadow cap draw without one (object-look.js). */}
			{capPracticalShadows(objects).map((object) => (
				<SceneObject
					key={object.id}
					object={object}
					selected={object.id === selectedId}
					frameRef={frameRef}
					take={take}
					attachFrameRef={attachFrameRef}
					registryRef={registryRef}
					travelLookupRef={travelLookupRef}
					fadeOpacity={fadeOpacity}
					depthRank={depthRanks.get(object.id) ?? 0}
				/>
			))}
			<EffectsLayer objects={authoredObjects ?? objects} frameRef={frameRef} take={take} registryRef={registryRef} fadeOpacity={fadeOpacity} />
		</group>
	);
}

const carryMatrix = new THREE.Matrix4();

/**
 * A group that rides a scene object's travel: whatever is inside it (a
 * character grouped under a car) is moved and turned with the object's route,
 * on top of its own transform and animation. Placed imperatively from the
 * frame ref for the same reason a routed prop is — the offscreen export
 * advances frames without a re-render — and registered in `registryRef` so the
 * recorder can place every carrier before it renders a frame.
 *
 * `objectsRef.current` holds the AUTHORED records by id; with no object, or an
 * object that does not travel, the group stays at identity.
 */
export function ObjectCarrier({ objectId = null, objectsRef, frameRef = null, take = null, registryRef = null, children }) {
	const groupRef = useRef(null);
	const place = () => {
		const group = groupRef.current;
		if (!group) return;
		const carried = objectId && objectsRef?.current
			? sceneObjectCarryMatrixAt(objectsRef.current, objectId, frameRef?.current ?? 0, take ?? {}, carryMatrix)
			: null;
		if (carried) carried.decompose(group.position, group.quaternion, group.scale);
		else {
			group.position.set(0, 0, 0);
			group.quaternion.identity();
			group.scale.set(1, 1, 1);
		}
	};
	// Ahead of every priority-0 placement: a prop held by a rider reads its
	// bone's world matrix through this group, so the carry must land first or
	// the prop trails the hand by one frame. Mount order alone does not hold
	// (SetProps mounts before the cast; a rig remount moves to the back).
	useFrame(place, -1);
	const placeRef = useRef(place);
	placeRef.current = place;
	useEffect(() => {
		if (!registryRef) return undefined;
		const registry = registryRef.current;
		const entry = () => placeRef.current();
		registry.add(entry);
		return () => { registry.delete(entry); };
	}, [registryRef]);
	return <group ref={groupRef}>{children}</group>;
}
