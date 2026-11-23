// The key's shadow box follows the set. Each draw (a viewport pane, the preview card, an export frame) fits the key's
// orthographic shadow camera to the part of the set that can cast into what that draw's camera sees: the shadow
// casters that stand across the light from the camera's view (out to SHADOW_REACH metres), cut to that view. A set
// anywhere on the 500 m deck casts. A fixed box around the origin left everything past 14 m unshadowed.
//
// The fit is the same for the same camera and the same set, so a viewport pane and an export through the same camera
// draw the same shadows, and two exports of one frame are identical. The box is snapped to whole texels, its depth to
// whole metres and its size to a short ladder, so a moving camera or figure does not make the shadow edges crawl: they
// move only on a frame where the box takes another size of the ladder.
import * as THREE from "three";

const SHADOW_MAP_SIZE = 2048;
// The box the stage used to have: 28 m over 2048 texels, 1.37 cm a texel. It is the smallest box, so a set that fits
// it is shadowed exactly as finely as before; stage.lighting.shadowSoftness gives the penumbra in texels at this
// density (stage-lighting.js shadowRadius). A wider box is coarser; it scales the radius so the penumbra keeps its
// width in metres.
const REFERENCE_TEXEL = 28 / SHADOW_MAP_SIZE;
// Depth bias in metres (the old -0.0006 of the old 0.5..60 m depth range).
const BIAS_METRES = 0.0006 * 59.5;
const SHADOW_REACH = 80;
// Half sizes of the box, metres: about a fifth apart, so a walk across the set changes the size once or not at all.
const HALF_SIZES = [14, 16, 20, 24, 28, 32, 40, 48, 60];
const PAD = 0.5;
// A posed figure reaches past its bones by about a limb's thickness.
const BONE_PAD = 0.35;

const corner = new THREE.Vector3(), centre = new THREE.Vector3(), forward = new THREE.Vector3(), sphere = new THREE.Sphere();
const inverse = new THREE.Matrix4(), clip = new THREE.Matrix4(), frustum = new THREE.Frustum(), reach = new THREE.Plane();
const NDC = [-1, 1].flatMap((x) => [-1, 1].map((y) => [x, y]));

/** What a perspective camera sees out to SHADOW_REACH metres, in light space (the shadow camera's view space): its
 *  x/y extent and its bounding planes (the four sides and the reach), or null for other cameras. */
function viewVolume(camera, view) {
	if (!camera?.isPerspectiveCamera) return null;
	inverse.copy(camera.projectionMatrixInverse);
	const eye = centre.setFromMatrixPosition(camera.matrixWorld).clone();
	const scale = Math.min(1, SHADOW_REACH / camera.far);
	const box = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity, planes: [] };
	for (const [x, y] of NDC) for (const z of [-1, 1]) {
		corner.set(x, y, z).applyMatrix4(inverse).applyMatrix4(camera.matrixWorld);
		if (z === 1) corner.sub(eye).multiplyScalar(scale).add(eye);
		corner.applyMatrix4(view);
		box.x0 = Math.min(box.x0, corner.x); box.x1 = Math.max(box.x1, corner.x);
		box.y0 = Math.min(box.y0, corner.y); box.y1 = Math.max(box.y1, corner.y);
	}
	frustum.setFromProjectionMatrix(clip.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse), camera.coordinateSystem, camera.reversedDepth);
	camera.getWorldDirection(forward);
	reach.setFromNormalAndCoplanarPoint(forward.negate(), corner.copy(forward).multiplyScalar(-Math.min(SHADOW_REACH, camera.far)).add(eye));
	// planes 0..3 of a three frustum are its sides
	for (const plane of [frustum.planes[0], frustum.planes[1], frustum.planes[2], frustum.planes[3], reach]) box.planes.push(plane.clone().applyMatrix4(view));
	return box;
}

/** Whether a sphere at `at` (light space) can cast into the view: the line through it along the light (z), widened by
 *  the sphere, meets the view volume, and the sphere is not past all of it. */
function castsInto(seen, at, radius) {
	let far = -Infinity, near = Infinity;
	for (const { normal, constant } of seen.planes) {
		const rest = normal.x * at.x + normal.y * at.y + constant + radius * Math.hypot(normal.x, normal.y);
		if (Math.abs(normal.z) < 1e-6) { if (rest < 0) return false; } else if (normal.z > 0) far = Math.max(far, -rest / normal.z);
		else near = Math.min(near, -rest / normal.z);
	}
	// light space looks down -z: the view volume on this line runs from z = near (toward the light) down to z = far
	return far <= near && at.z + radius >= far;
}

/** Light-space extent of the visible shadow casters the draw shows that can cast into `seen` (null keeps all):
 *  { x0, x1, y0, y1, z0, z1 } or null. */
function castersExtent(root, view, layers, seen) {
	let box = null;
	const add = (point, pad) => {
		corner.copy(point).applyMatrix4(view);
		if (seen && !castsInto(seen, corner, pad)) return;
		box ??= { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity, z0: Infinity, z1: -Infinity };
		box.x0 = Math.min(box.x0, corner.x - pad); box.x1 = Math.max(box.x1, corner.x + pad);
		box.y0 = Math.min(box.y0, corner.y - pad); box.y1 = Math.max(box.y1, corner.y + pad);
		box.z0 = Math.min(box.z0, corner.z - pad); box.z1 = Math.max(box.z1, corner.z + pad);
	};
	root.traverseVisible((node) => {
		if (!node.isMesh || !node.castShadow || (layers && !node.layers.test(layers))) return;
		// a skinned figure is where its bones are this frame, not where its bind pose was
		if (node.isSkinnedMesh && node.skeleton) {
			for (const bone of node.skeleton.bones) add(centre.setFromMatrixPosition(bone.matrixWorld), BONE_PAD);
			return;
		}
		// an instanced mesh keeps the sphere of all its instances itself
		const owner = node.isInstancedMesh ? node : node.geometry;
		if (!owner) return;
		if (!owner.boundingSphere) owner.computeBoundingSphere();
		sphere.copy(owner.boundingSphere).applyMatrix4(node.matrixWorld);
		if (Number.isFinite(sphere.radius)) add(sphere.center, sphere.radius);
	});
	return box;
}

const snap = (value, step) => Math.floor(value / step) * step;

/** Fit `light`'s shadow camera for a draw through `camera`. The penumbra and normal offset are read from
 *  light.userData.shadowRadius / shadowNormalBias (at the reference density). */
function fitKeyShadow(light, camera, stock) {
	const shadow = light.shadow, cam = shadow.camera;
	// orient the shadow camera as three does (from the light toward its target), so its view space is light space
	stock(light, camera);
	let root = light;
	while (root.parent) root = root.parent;
	const view = cam.matrixWorldInverse;
	const seen = viewVolume(camera, view);
	// no caster across the light from what the camera sees: nothing to shadow, the box stays as it was
	const casters = castersExtent(root, view, camera?.layers, seen);
	if (!casters) return;
	const x0 = Math.max(casters.x0, seen?.x0 ?? -Infinity), x1 = Math.min(casters.x1, seen?.x1 ?? Infinity);
	const y0 = Math.max(casters.y0, seen?.y0 ?? -Infinity), y1 = Math.min(casters.y1, seen?.y1 ?? Infinity);
	const need = Math.max(x1 - x0, y1 - y0) / 2 + PAD;
	const half = HALF_SIZES.find((size) => size >= need) ?? HALF_SIZES.at(-1);
	const texel = (2 * half) / SHADOW_MAP_SIZE;
	const left = snap((x0 + x1) / 2 - half, texel), bottom = snap((y0 + y1) / 2 - half, texel);
	cam.left = left; cam.right = left + 2 * half;
	cam.bottom = bottom; cam.top = bottom + 2 * half;
	// view space looks down -z: near is the caster nearest the light; far reaches SHADOW_REACH past the farthest caster,
	// so a long low-sun shadow still lands on the deck behind it
	cam.near = Math.floor(-(casters.z1 + PAD));
	cam.far = Math.ceil(SHADOW_REACH - casters.z0);
	cam.updateProjectionMatrix();
	const scale = texel / REFERENCE_TEXEL;
	shadow.radius = (light.userData.shadowRadius ?? 1) / scale;
	shadow.normalBias = (light.userData.shadowNormalBias ?? 0.02) * Math.max(1, scale);
	shadow.bias = -(BIAS_METRES * Math.max(1, scale)) / (cam.far - cam.near);
	stock(light, camera);
}

/** Make `light`'s shadow follow the set (see the head of this file); answers the undo. */
export function followSet(light) {
	light.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
	const stock = light.shadow.updateMatrices.bind(light.shadow);
	light.shadow.updateMatrices = (target, camera) => fitKeyShadow(target, camera, stock);
	return () => { delete light.shadow.updateMatrices; };
}
