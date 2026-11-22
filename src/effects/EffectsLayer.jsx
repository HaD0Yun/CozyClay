/**
 * Effects in the set: the particles and trails of every effect record, plus
 * the editor-only marker that lets an emitter be picked and moved.
 *
 * Particles live in WORLD space under SetProps, not under the emitter's own
 * group: a puff already in the air keeps drifting when its emitter moves on
 * or is hidden (an exhale ends, a cigarette goes back in the pocket). They
 * are placed imperatively from the frame ref, like a prop, and registered in
 * the props registry, so the recorder's "place every prop now" pass redraws
 * them for the frame it is about to capture.
 */
import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { GIZMO_LAYER } from "../dualview.jsx";
import { createEffectMeshes } from "./effect-meshes.js";
import { effectSceneOf, publishEffectScene } from "./state.js";
import { sceneObjectMatrix } from "../stage-attach-frames.js";

/** The props-registry key the effects pass is filed under (never an object id). */
const EFFECTS_ENTRY = Symbol("effects");
const MARKER_COLOR = "#7fd4f0";
const onGizmoLayer = (node) => {
	if (node) node.layers.set(GIZMO_LAYER);
};

/**
 * An emitter's viewport presence, editor furniture like an Empty's cross:
 * a small diamond with an arrow up its local +Y (where particles are thrown)
 * or, for a trail, a bar along local Y as wide as the ribbon. On GIZMO_LAYER,
 * so no shot, capture or export ever draws it, with an invisible pick volume.
 */
export function EffectMarker({ object }) {
	const trail = object.effect?.preset === "trail";
	const half = trail ? Math.max(0.05, (object.effect?.width ?? 0.5) / 2) : 0.06;
	const lines = useMemo(() => {
		const d = 0.05;
		const diamond = [[d, 0, 0], [0, d, 0], [0, d, 0], [-d, 0, 0], [-d, 0, 0], [0, -d, 0], [0, -d, 0], [d, 0, 0],
			[0, 0, d], [0, d, 0], [0, d, 0], [0, 0, -d], [0, 0, -d], [0, -d, 0], [0, -d, 0], [0, 0, d]];
		const marks = trail
			? [[0, -half, 0], [0, half, 0], [-0.03, -half, 0], [0.03, -half, 0], [-0.03, half, 0], [0.03, half, 0]]
			: [[0, d, 0], [0, 0.16, 0], [0, 0.16, 0], [0.025, 0.12, 0], [0, 0.16, 0], [-0.025, 0.12, 0]];
		const geometry = new THREE.BufferGeometry();
		geometry.setAttribute("position", new THREE.Float32BufferAttribute([...diamond, ...marks].flat(), 3));
		return geometry;
	}, [trail, half]);
	useEffect(() => () => lines.dispose(), [lines]);
	return (
		<group userData={{ effectMarker: true }}>
			<lineSegments ref={onGizmoLayer} geometry={lines} renderOrder={997} frustumCulled={false}>
				<lineBasicMaterial color={MARKER_COLOR} depthTest={false} depthWrite={false} transparent opacity={0.95} />
			</lineSegments>
			<mesh ref={onGizmoLayer} visible={false} userData={{ emptyPick: true }}>
				<sphereGeometry args={[0.08, 12, 8]} />
				<meshBasicMaterial />
			</mesh>
		</group>
	);
}

/** A record pinned to a bone emits, at the current frame, from where the bone
 * is now: its prop is placed first, then its world matrix read back from the
 * props registry. At another frame (a particle's birth, a trail's past) from
 * where the character's take has the bone then (`attachFrameAtRef.current(
 * characterId, bone, frame, now, out)`, attach-history.js) times the record's
 * own numbers; the live frame when that cannot be read. */
const bonePlace = new THREE.Matrix4(), ownPlace = new THREE.Matrix4();
const liveWorld = (registryRef, frameRef, attachFrameAtRef, lookupOf) => (id, out, frame = null) => {
	const now = frameRef?.current ?? 0, record = lookupOf().get(id);
	if (frame !== null && Math.round(frame) !== Math.round(now) && record?.attach) {
		const at = attachFrameAtRef?.current?.(record.attach.characterId, record.attach.bone ?? null, frame, now, bonePlace);
		if (at) return out.multiplyMatrices(at, sceneObjectMatrix(record, ownPlace));
	}
	const entry = registryRef?.current?.get(id);
	if (!entry) return null;
	entry.place();
	return entry.world(out);
};

/**
 * Every effect record's particles at the frame in `frameRef`. `objects` are
 * the AUTHORED records (a take can hide an emitter at the current frame while
 * its smoke is still in the air); `registryRef` is SetProps' placement
 * registry, which the recorder's sync pass walks.
 */
export function EffectsLayer({ objects, frameRef = null, take = null, registryRef = null, attachFrameAtRef = null, fadeOpacity = null }) {
	const base = useMemo(() => effectSceneOf(objects), [objects]);
	const any = base.records.length > 0;
	const meshes = useMemo(() => (any ? createEffectMeshes() : null), [any]);
	useEffect(() => () => meshes?.dispose(), [meshes]);
	const lookupRef = useRef(base.lookup);
	lookupRef.current = base.lookup;
	const live = useMemo(() => liveWorld(registryRef, frameRef, attachFrameAtRef, () => lookupRef.current), [registryRef, frameRef, attachFrameAtRef]);
	const scene = useMemo(() => ({ ...base, take: take ?? {}, live }), [base, take, live]);
	const drawnRef = useRef(null);
	const place = () => {
		if (!meshes) return;
		const frame = frameRef?.current ?? 0, opacity = fadeOpacity ?? 1;
		const key = [frame, scene, opacity];
		const attached = scene.records.some((record) => record.attach);
		if (!attached && drawnRef.current?.every((value, i) => value === key[i])) return;
		drawnRef.current = key;
		meshes.update(scene, frame, opacity);
	};
	useFrame(place);
	useEffect(() => {
		publishEffectScene(() => scene);
		return () => publishEffectScene(null);
	}, [scene]);
	// Re-filed every render, so the recorder's pass runs this render's
	// placement and runs it after every prop (an attached emitter reads one).
	useEffect(() => {
		const registry = registryRef?.current;
		if (!registry || !meshes) return undefined;
		registry.set(EFFECTS_ENTRY, { place, world: () => null });
		return () => { registry.delete(EFFECTS_ENTRY); };
	});
	if (!meshes) return null;
	return (
		<>
			<primitive object={meshes.particles} />
			<primitive object={meshes.ribbons} />
		</>
	);
}
