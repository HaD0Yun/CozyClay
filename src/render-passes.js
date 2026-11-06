// Depth and normal passes for the blocking frame.
//
// A generator handed one RGB plate has to guess the geometry behind it. A
// depth pass says how far away every pixel is, and a normal pass says which
// way its surface faces — the two conditioning images ControlNet-style tools
// ask for. Both are the SAME render the RGB plate came from, taken through
// the same offscreen capture rig, with one material override swapped in for
// the draw and taken back out immediately after.
//
// Nothing here owns the renderer: the capture rig is passed in, so the studio
// and a headless test drive the identical path.

import * as THREE from "three";

export const PASS_KINDS = Object.freeze(["depth", "normal"]);

// How far the grey ramp reaches, in metres. The shot camera's far plane sits
// at 100 m and its near plane at 0.1 m; normalising across that whole range
// would push every blocking distance a previs shot actually uses into the
// darkest few percent of the ramp. 40 m is the working depth of the stage (the
// viewport's own fog dissolves the deck by ~54 m), so the subject and the deck
// under it spread across the full range instead of collapsing to black.
export const DEPTH_RANGE_M = 40;

/** Decode the sampled extrema of one depth pre-pass. */
export function depthRangeFromPixels(depth, near = 0.1, far = DEPTH_RANGE_M) {
	let minGrey = 255;
	let maxGrey = 0;
	for (let index = 0; index < depth.length; index += 256) {
		minGrey = Math.min(minGrey, depth[index]);
		maxGrey = Math.max(maxGrey, depth[index]);
	}
	// CaptureRig reads an sRGB target, not the shader's linear grey. Include
	// the half-byte rounding interval so quantisation cannot clip a surface.
	const distance = grey => {
		const encoded = Math.max(0, Math.min(255, grey)) / 255;
		const linear = new THREE.Color().setRGB(encoded, encoded, encoded, THREE.SRGBColorSpace).r;
		return near + (far - near) * (1 - linear);
	};
	// An all-black sample hit no surface (only sky, or geometry between the samples): it bounds no near distance, so a
	// shot of such frames keeps depthRangeFromFrames' fallback range instead of a near plane at the far end.
	if (maxGrey === 0) return { min: NaN, max: far };
	return { min: distance(maxGrey + 0.5), max: distance(minGrey - 0.5) };
}

/** Return the shot-wide near/far range from per-frame extrema. */
export function depthRangeFromFrames(frames, fallbackNear = 0.1, fallbackFar = DEPTH_RANGE_M) {
	let near = Infinity;
	let far = -Infinity;
	for (const frame of frames ?? []) {
		if (Number.isFinite(frame?.min) && frame.min > 0) near = Math.min(near, frame.min);
		if (Number.isFinite(frame?.max) && frame.max > 0) far = Math.max(far, frame.max);
	}
	if (!Number.isFinite(near) || !Number.isFinite(far)) return { near: fallbackNear, far: fallbackFar };
	return { near, far: Math.max(far, near + 0.0001) };
}

export function depthGrey(d, near, far, curve = "linear") {
 if (curve === "inverse") return Math.max(0, Math.min(1, (1 / Math.max(d, near) - 1 / far) / (1 / near - 1 / far)));
 return 1 - Math.max(0, Math.min(1, (d - near) / Math.max(far - near, 0.0001)));
}

/** File name for a downloaded pass: `blocking-frame-depth.png`. */
export function passFileName(kind) {
	if (!PASS_KINDS.includes(kind)) throw new Error(`Unknown render pass: ${kind}`);
	return `blocking-frame-${kind}.png`;
}

// Linear view-space depth, near = white. THREE.MeshDepthMaterial writes the
// non-linear window-space z instead: with a 0.1 m near plane that curve spends
// most of its range in the first metre, so a blocking frame comes out as a
// near-black plate with no readable falloff (RGBADepthPacking is worse again —
// it spreads the value over four channels and reads as colour noise). This
// shader is the plain depth-to-grey the deliverable wants, and the range it
// normalises over is the stage's, not the projection's.
// An InstancedMesh (a sculpt's scatter) draws every instance through its
// instanceMatrix; without it all of them would land on the mesh's origin.
const DEPTH_VERTEX = /* glsl */ `
#include <common>
#include <skinning_pars_vertex>
varying float vViewDepth;
void main() {
	#include <skinbase_vertex>
	#include <begin_vertex>
	#include <skinning_vertex>
	vec4 local = vec4(transformed, 1.0);
#ifdef USE_INSTANCING
	local = instanceMatrix * local;
#endif
	vec4 viewPosition = modelViewMatrix * local;
	vViewDepth = -viewPosition.z;
	gl_Position = projectionMatrix * viewPosition;
}
`;

const DEPTH_FRAGMENT = /* glsl */ `
varying float vViewDepth;
uniform float uNear;
uniform float uRange;
uniform bool uInverse;
void main() {
	float normalized = clamp((vViewDepth - uNear) / max(uRange - uNear, 0.0001), 0.0, 1.0);
	float grey = uInverse ? clamp((1.0 / max(vViewDepth, uNear) - 1.0 / uRange) / (1.0 / uNear - 1.0 / uRange), 0.0, 1.0) : 1.0 - normalized;
	gl_FragColor = vec4(vec3(grey), 1.0);
}
`;

const BACKGROUND_FAR = new THREE.Color(0x000000);

function passMaterial(kind, camera, depthRange = null, depthCurve = "linear") {
	if (kind === "depth") {
		return new THREE.ShaderMaterial({
			vertexShader: DEPTH_VERTEX,
			fragmentShader: DEPTH_FRAGMENT,
			uniforms: {
				uInverse: { value: depthCurve === "inverse" },
				uNear: { value: Number.isFinite(depthRange?.near) ? depthRange.near : (Number.isFinite(camera?.near) ? camera.near : 0.1) },
				uRange: { value: Number.isFinite(depthRange?.far) ? depthRange.far : DEPTH_RANGE_M },
			},
			// The stage's fog is a viewport look, not geometry: a depth plate that
			// faded into the fog colour would report the horizon as near.
			fog: false,
		});
	}
	if (kind === "normal") return new THREE.MeshNormalMaterial();
	throw new Error(`Unknown render pass: ${kind}`);
}

/**
 * Render one pass through the capture rig.
 *
 * @param {{ render: () => (Uint8Array|null) }} capture the offscreen capture rig
 * @param {{ overrideMaterial: unknown }} scene the scene the rig draws
 * @param {{ near?: number }} camera the shot camera the rig renders through
 *   (the rig clones it itself; the depth ramp reads its near plane)
 * @param {"depth"|"normal"} kind
 * @param {(buffer: Uint8Array) => string} [toDataUrl] converts the rig's RGBA
 *   read-back into a PNG data URL; omitted, the raw buffer comes back
 * @returns {string|Uint8Array|null} the PNG data URL (or the raw buffer)
 */
export function renderPass(capture, scene, camera, kind, toDataUrl = null, options = {}) {
	if (!capture || !scene || !camera) return null;
	const material = passMaterial(kind, camera, options.depthRange, options.depthCurve);
	const previousMaterial = scene.overrideMaterial;
	const previousBackground = scene.background;
	let buffer = null;
	// A glow halo (userData.beautyOnly) is light, not a surface: drawn with the
	// pass material it would be a solid quad in the depth or normal plate.
	const hidden = [];
	scene.traverse?.((node) => {
		if (node.userData?.beautyOnly && node.visible) {
			hidden.push(node);
			node.visible = false;
		}
	});
	try {
		scene.overrideMaterial = material;
		// Empty sky is infinitely far away, so on a depth plate it is black. The
		// studio's pale stage colour would otherwise read as "nearest thing in
		// the frame" to anything consuming the pass.
		if (kind === "depth") scene.background = BACKGROUND_FAR;
		buffer = capture.render();
	} finally {
		// The viewport draws from this same scene object, so the override must
		// come off before anything else can paint with it — even if the render
		// threw.
		scene.overrideMaterial = previousMaterial;
		scene.background = previousBackground;
		for (const node of hidden) node.visible = true;
		material.dispose();
	}
	if (!buffer) return null;
	return toDataUrl ? toDataUrl(buffer) : buffer;
}
