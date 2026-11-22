/**
 * Practical lights in the set: a point or spot light a record carries, and its
 * editor-only marker.
 *
 * The light itself lives on the default layer, so the viewport, the shot
 * preview, capture_frame, contact sheets and the video export all light the
 * set with it. The marker (a bulb, plus the cone for a spot) is editor
 * furniture on GIZMO_LAYER, exactly like an Empty's axes: drawn in the working
 * views, dropped by every recorded camera, and picked through the same
 * `emptyPick` volume so the user can select and move the light.
 *
 * Everything that changes with time (take level, flicker, a spot's aim while
 * the record travels) is written by `placeObjectLook` (scene-light-place.js),
 * which SceneObject calls from its imperative place pass. The recorder runs
 * that pass for every frame it renders, so a scrub or an export never sees a
 * stale light.
 */

import { useEffect, useMemo } from "react";
import { useThree } from "@react-three/fiber";
import * as THREE from "three";
import { GIZMO_LAYER } from "./dualview.jsx";
import { EMPTY_MARKER_SIZE } from "./scene-objects.js";
import { SHADOW_FAR } from "./scene-light-place.js";

const DEG = Math.PI / 180;
const BULB_RADIUS = 0.07;
/** Drawn length of a spot's cone outline, metres (the light reaches further). */
const CONE_LENGTH = 0.7;

function makeLight(type, shadow) {
	const light = type === "spot" ? new THREE.SpotLight() : type === "directional" ? new THREE.DirectionalLight() : new THREE.PointLight();
	// three.js hangs a spot 1 m up (DEFAULT_UP) by default; a practical sits on its record's pivot.
	light.position.set(0, 0, 0);
	if (!light.isDirectionalLight) light.decay = 2;
	light.castShadow = shadow;
	light.userData.sceneLight = true;
	if (shadow) {
		const size = type === "directional" ? 2048 : type === "spot" ? 1024 : 512;
		light.shadow.mapSize.set(size, size);
		light.shadow.bias = -0.0004;
		light.shadow.normalBias = 0.02;
		// A lighter a hand-width from a face must still shadow the hand.
		light.shadow.camera.near = 0.03;
		light.shadow.camera.far = SHADOW_FAR;
		light.shadow.camera.updateProjectionMatrix();
	}
	return light;
}

/** Line pairs of a circle of `radius` in the plane spanned by axes a and b. */
function circle(out, radius, a, b, y = 0, segments = 24) {
	for (let i = 0; i < segments; i += 1) {
		for (const k of [i, i + 1]) {
			const t = (k / segments) * Math.PI * 2;
			const p = [0, y, 0];
			p[a] += Math.cos(t) * radius;
			p[b] += Math.sin(t) * radius;
			out.push(...p);
		}
	}
	return out;
}

function lineGeometry(positions) {
	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
	return geometry;
}

/** The bulb: three rings and a few short rays, so it reads as a light, not a ball. */
function bulbGeometry() {
	const out = [];
	circle(out, BULB_RADIUS, 0, 2);
	circle(out, BULB_RADIUS, 0, 1);
	circle(out, BULB_RADIUS, 1, 2);
	for (let i = 0; i < 8; i += 1) {
		const t = (i / 8) * Math.PI * 2;
		out.push(Math.cos(t) * BULB_RADIUS * 1.3, 0, Math.sin(t) * BULB_RADIUS * 1.3, Math.cos(t) * BULB_RADIUS * 2, 0, Math.sin(t) * BULB_RADIUS * 2);
	}
	return lineGeometry(out);
}

/** A directional light's rays along local -Y: five parallel lines of CONE_LENGTH with an arrow head on the middle one. */
function raysGeometry() {
	const out = [0, 0, 0, 0, -CONE_LENGTH, 0, 0, -CONE_LENGTH, 0, 0.05, -CONE_LENGTH + 0.1, 0, 0, -CONE_LENGTH, 0, -0.05, -CONE_LENGTH + 0.1, 0];
	for (const [x, z] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) out.push(x * BULB_RADIUS * 1.5, 0, z * BULB_RADIUS * 1.5, x * BULB_RADIUS * 1.5, -CONE_LENGTH * 0.8, z * BULB_RADIUS * 1.5);
	return lineGeometry(out);
}

/** A spot's cone along local -Y: four edges and the rim at CONE_LENGTH. */
function coneGeometry(angleDeg) {
	const radius = CONE_LENGTH * Math.tan(angleDeg * DEG);
	const out = circle([], radius, 0, 2, -CONE_LENGTH, 32);
	for (let i = 0; i < 4; i += 1) {
		const t = (i / 4) * Math.PI * 2;
		out.push(0, 0, 0, Math.cos(t) * radius, -CONE_LENGTH, Math.sin(t) * radius);
	}
	return lineGeometry(out);
}

const onGizmoLayer = (node) => {
	if (node) node.layers.set(GIZMO_LAYER);
};

function LightMarker({ type, angle, color }) {
	const bulb = useMemo(() => bulbGeometry(), []);
	const cone = useMemo(() => (type === "spot" ? coneGeometry(angle) : type === "directional" ? raysGeometry() : null), [type, angle]);
	useEffect(() => () => bulb.dispose(), [bulb]);
	useEffect(() => () => cone?.dispose(), [cone]);
	return (
		<group userData={{ lightMarker: true }}>
			<lineSegments ref={onGizmoLayer} geometry={bulb} renderOrder={997} frustumCulled={false}>
				<lineBasicMaterial color={color} depthTest={false} depthWrite={false} transparent opacity={0.95} />
			</lineSegments>
			{cone && (
				<group userData={{ lightCone: true }}>
					<lineSegments ref={onGizmoLayer} geometry={cone} renderOrder={997} frustumCulled={false}>
						<lineBasicMaterial color={color} depthTest={false} depthWrite={false} transparent opacity={0.55} />
					</lineSegments>
				</group>
			)}
			{/* Never drawn, still raycast: the object picker's gizmo-layer pass
			    finds it by `emptyPick` and selects the light's record. */}
			<mesh ref={onGizmoLayer} visible={false} userData={{ emptyPick: true }}>
				<sphereGeometry args={[EMPTY_MARKER_SIZE * 0.45, 12, 8]} />
				<meshBasicMaterial />
			</mesh>
		</group>
	);
}

/** A light record's content: the three.js light and its marker. Rebuilt only
 * when the type or the shadow switch changes (both change the shader). A light
 * past the drawn-light cap (object-look.js) keeps only its marker. */
export function SceneLight({ object }) {
	const { type, shadow, angle, color } = object.light;
	const light = useMemo(() => makeLight(type, shadow), [type, shadow]);
	useEffect(() => () => light.dispose(), [light]);
	return (
		<>
			{!object.lightCapped && <primitive object={light} />}
			<LightMarker type={type} angle={angle} color={color} />
		</>
	);
}

/** Ask for a frame when the record's light or glow changes. Both are written by
 * the place pass, which a demand frame loop runs only when something asks: an
 * edit that changes no three.js prop would otherwise wait for the next orbit. */
export function useLookRefresh(object) {
	const invalidate = useThree((state) => state.invalidate);
	useEffect(() => {
		invalidate();
	}, [invalidate, object.light, object.glow]);
}
