/**
 * The per-frame half of practical lights and glow, kept free of React so the
 * place pass can be exercised in Node: SceneObject calls `placeObjectLook`
 * from its imperative place pass (and the recorder through it, for every
 * frame it renders), and it writes the light's numbers and the glow for that
 * frame only.
 */

import * as THREE from "three";
import { LIGHT_INTENSITY_SCALE, flickerAt } from "./object-look.js";
import { trackLevel } from "./object-travel.js";
import { hasGlow, placeObjectGlow } from "./object-glow.js";

const DEG = Math.PI / 180;
/** A shadow camera's far plane when the light has no range of its own. */
export const SHADOW_FAR = 40;

const DOWN = new THREE.Vector3(0, -1, 0);
const scratchDir = new THREE.Vector3();
const scratchTarget = new THREE.Vector3();
const scratchPos = new THREE.Vector3();
const scratchQuat = new THREE.Quaternion();
const scratchScale = new THREE.Vector3();

function childWith(group, key) {
	for (const child of group.children) if (child.userData?.[key]) return child;
	return null;
}

/** Half the side of a directional light's shadow box (m), centred on its aim line. */
const DIRECTIONAL_SHADOW_HALF = 10;
/** How far past its aim point a directional light's shadow box reaches (m). */
const DIRECTIONAL_SHADOW_BEYOND = 20;
/** A directional light with no aim point lays its shadow box this far down its -Y (m). */
const DIRECTIONAL_REACH = 10;

const aimFrame = new THREE.Matrix4();
/** The aimAt a SceneObject's place pass hands placeObjectLook: a record's middle (its pivot raised half its authored
 * height, as placed now; `registryRef` holds each record's { world(out) }, `recordsRef` the records by id) or a rig
 * character's hips (`attachFrameRef`, stage-attach-frames.js); null when neither is on stage. `cast` is the characters
 * on stage when the set is given them: one that left the cast is not aimed at, though its rig may still be held. */
export const aimAtFor = (registryRef, recordsRef, attachFrameRef, cast = null) => (id, out) => {
	const placed = registryRef?.current?.get(id)?.world(aimFrame);
	if (placed) return out.set(0, (recordsRef?.current?.get(id)?.height ?? 0) / 2, 0).applyMatrix4(placed);
	const frame = cast && !cast.some((character) => character.id === id) ? null : attachFrameRef?.current?.(id, null, aimFrame);
	return frame ? out.setFromMatrixPosition(frame) : null;
};

/** Where the light points this frame, as a world point in `out`, or null for the record's own -Y:
 * an aim point, or the point `aimAt(id, out)` resolves for an aimed-at character or record. */
function aimPoint(aim, aimAt, out) {
	if (!aim) return null;
	if (aim.id === undefined) return out.set(aim.x, aim.y, aim.z);
	return aimAt?.(aim.id, out) ?? null;
}

/** Write the light's numbers for this frame. `gain` is level × flicker. */
function placeSceneLight(group, object, gain, aimAt) {
	const light = childWith(group, "sceneLight");
	if (!light) return;
	const { color, intensity, range, angle, softness, aim } = object.light;
	// The lighting check reads which record a drawn light belongs to, and whether its aim was found (studio-lighting-check.js).
	light.userData.sceneObjectId = object.id;
	light.color.set(color);
	light.intensity = intensity * (light.isDirectionalLight ? 1 : LIGHT_INTENSITY_SCALE) * gain;
	if (!light.isDirectionalLight) light.distance = range;
	if (light.castShadow && light.isPointLight) {
		const far = range > 0 ? range : SHADOW_FAR;
		if (light.shadow.camera.far !== far) {
			light.shadow.camera.far = far;
			light.shadow.camera.updateProjectionMatrix();
		}
	}
	if (light.isPointLight) return;
	if (light.isSpotLight) {
		light.angle = angle * DEG;
		light.penumbra = softness;
	}
	// The target is kept outside the scene graph, in world space: an aim point
	// is a place in the set, and the record's own -Y is where it hangs pointing.
	group.updateWorldMatrix(true, false);
	group.matrixWorld.decompose(scratchPos, scratchQuat, scratchScale);
	const aimed = aimPoint(aim, aimAt, scratchTarget);
	light.userData.aimFound = aim?.id === undefined || aimed !== null;
	if (aimed) scratchDir.subVectors(aimed, scratchPos);
	else scratchDir.copy(DOWN).applyQuaternion(scratchQuat);
	if (scratchDir.lengthSq() < 1e-10) scratchDir.copy(DOWN).applyQuaternion(scratchQuat);
	const reach = light.isDirectionalLight && aimed ? scratchDir.length() : DIRECTIONAL_REACH;
	scratchDir.normalize();
	light.target.position.copy(scratchPos).addScaledVector(scratchDir, light.isDirectionalLight ? reach : 1);
	light.target.updateMatrixWorld();
	if (light.isDirectionalLight && light.castShadow) placeDirectionalShadow(light, reach + DIRECTIONAL_SHADOW_BEYOND, softness);
	const cone = childWith(group, "lightMarker")?.children.find((child) => child.userData?.lightCone);
	if (cone) cone.quaternion.setFromUnitVectors(DOWN, scratchDir.applyQuaternion(scratchQuat.invert()));
}

/** A directional light's shadow box: DIRECTIONAL_SHADOW_HALF either side of its aim line, from the
 * light to `far` along it; softness widens the edge the way the key's shadowSoftness does. */
function placeDirectionalShadow(light, far, softness) {
	const camera = light.shadow.camera;
	light.shadow.radius = 1 + softness * 7;
	light.shadow.normalBias = 0.02 + softness * 0.08;
	if (camera.far === far && camera.right === DIRECTIONAL_SHADOW_HALF) return;
	Object.assign(camera, { left: -DIRECTIONAL_SHADOW_HALF, right: DIRECTIONAL_SHADOW_HALF, top: DIRECTIONAL_SHADOW_HALF, bottom: -DIRECTIONAL_SHADOW_HALF, near: 0.1, far });
	camera.updateProjectionMatrix();
}

/**
 * The per-frame look of one record: its light (if it is one) and its glow (if
 * it has one), from the take's level at `frame` and the light's flicker. Pure
 * in the frame number, so any frame can be drawn in any order. `aimAt(id, out)`
 * writes where a character or record a light aims at stands now into the
 * Vector3 `out` and returns it, or returns null when it is not on stage.
 */
export function placeObjectLook(group, object, frame, take, aimAt = null) {
	if (!object.light && !object.glow && !hasGlow(group)) return;
	const level = trackLevel(object.id, frame, take);
	const gain = level * (object.light ? flickerAt(object.id, frame, object.light.flicker, take?.fps) : 1);
	if (object.light) placeSceneLight(group, object, gain, aimAt);
	placeObjectGlow(group, object, gain);
}
