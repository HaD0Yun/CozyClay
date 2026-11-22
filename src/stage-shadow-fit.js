// The key's shadow box follows the set. Each draw (a viewport pane, the preview card, an export frame) fits the key's
// orthographic shadow camera to the part of the set that can cast into what that draw's camera sees: the shadow
// casters' extent across the light, cut to the camera's view out to SHADOW_REACH metres. A set anywhere on the 500 m
// deck casts, and a small set gets fine texels. A fixed box around the origin left everything past 14 m unshadowed.
//
// The fit is the same for the same camera and the same set, so a viewport pane and an export through the same camera
// draw the same shadows, and two exports of one frame are identical. The box is snapped to whole texels and its size to
// SIZE_STEP, so a moving camera or figure does not make the shadow edges crawl.
import * as THREE from "three";

const SHADOW_MAP_SIZE = 2048;
// The box the stage used to have: 28 m over 2048 texels. stage.lighting.shadowSoftness gives the penumbra in texels at
// this density (stage-lighting.js shadowRadius); a box of another size scales the radius so the penumbra keeps its width
// in metres.
const REFERENCE_TEXEL = 28 / SHADOW_MAP_SIZE;
// Depth bias in metres (the old -0.0006 of the old 0.5..60 m depth range).
const BIAS_METRES = 0.0006 * 59.5;
const SHADOW_REACH = 80;
const MIN_HALF = 3;
const MAX_HALF = 60;
const SIZE_STEP = 1;
const PAD = 0.5;
// A posed figure reaches past its bones by about a limb's thickness.
const BONE_PAD = 0.35;

const corner = new THREE.Vector3(), centre = new THREE.Vector3(), sphere = new THREE.Sphere(), inverse = new THREE.Matrix4();
const NDC = [-1, 1].flatMap((x) => [-1, 1].map((y) => [x, y]));

/** Light-space extent (shadow camera view space) of the visible shadow casters the draw shows, each kept only where it
 *  lies across the light from `seen` (what the camera sees; null keeps all): { x0, x1, y0, y1, z0, z1 } or null. */
function castersExtent(root, view, layers, seen) {
	let box = null;
	const add = (point, pad) => {
		corner.copy(point).applyMatrix4(view);
		if (seen && (corner.x + pad < seen.x0 || corner.x - pad > seen.x1 || corner.y + pad < seen.y0 || corner.y - pad > seen.y1)) return;
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
		const geometry = node.geometry;
		if (!geometry) return;
		if (!geometry.boundingSphere) geometry.computeBoundingSphere();
		sphere.copy(geometry.boundingSphere).applyMatrix4(node.matrixWorld);
		if (Number.isFinite(sphere.radius)) add(sphere.center, sphere.radius);
	});
	return box;
}

/** Light-space x/y extent of what a perspective camera sees out to SHADOW_REACH metres, or null for other cameras. */
function viewExtent(camera, view) {
	if (!camera?.isPerspectiveCamera) return null;
	inverse.copy(camera.projectionMatrixInverse);
	const eye = centre.setFromMatrixPosition(camera.matrixWorld).clone();
	const reach = Math.min(1, SHADOW_REACH / camera.far);
	const box = { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity };
	for (const [x, y] of NDC) for (const z of [-1, 1]) {
		corner.set(x, y, z).applyMatrix4(inverse).applyMatrix4(camera.matrixWorld);
		if (z === 1) corner.sub(eye).multiplyScalar(reach).add(eye);
		corner.applyMatrix4(view);
		box.x0 = Math.min(box.x0, corner.x); box.x1 = Math.max(box.x1, corner.x);
		box.y0 = Math.min(box.y0, corner.y); box.y1 = Math.max(box.y1, corner.y);
	}
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
	const seen = viewExtent(camera, view);
	// no caster across the light from what the camera sees: nothing to shadow, the box stays as it was
	const casters = castersExtent(root, view, camera?.layers, seen);
	if (!casters) return;
	const x0 = Math.max(casters.x0, seen?.x0 ?? -Infinity), x1 = Math.min(casters.x1, seen?.x1 ?? Infinity);
	const y0 = Math.max(casters.y0, seen?.y0 ?? -Infinity), y1 = Math.min(casters.y1, seen?.y1 ?? Infinity);
	const half = Math.min(MAX_HALF, Math.max(MIN_HALF, Math.ceil((Math.max(x1 - x0, y1 - y0) / 2 + PAD) / SIZE_STEP) * SIZE_STEP));
	const texel = (2 * half) / SHADOW_MAP_SIZE;
	const left = snap((x0 + x1) / 2 - half, texel), bottom = snap((y0 + y1) / 2 - half, texel);
	cam.left = left; cam.right = left + 2 * half;
	cam.bottom = bottom; cam.top = bottom + 2 * half;
	// view space looks down -z: near is the caster nearest the light; far reaches SHADOW_REACH past the farthest caster,
	// so a long low-sun shadow still lands on the deck behind it
	cam.near = -(casters.z1 + PAD);
	cam.far = SHADOW_REACH - casters.z0;
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
