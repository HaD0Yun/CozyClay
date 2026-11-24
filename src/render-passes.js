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

// How the greys are shared out over the distance. "linear": equal metres, equal greys. "inverse": by nearness (1 / d).
// "log": by ratio, so 1 m to 2 m takes as many greys as 4 m to 8 m; a previs frame holds a body two metres away and a
// horizon forty metres away, and only the ratio gives both their steps. The first two write linear light into the sRGB
// target (the stored byte is the encoded grey); "log" writes so that the stored byte is the grey itself.
const CURVES = Object.freeze({ linear: 0, inverse: 1, log: 2 });
/** The distance a pre-pass byte stands for, drawn with `curve` over near..far. */
function greyDistance(grey, near, far, curve) {
	const encoded = Math.max(0, Math.min(255, grey)) / 255;
	if (curve === "log") return near * (far / near) ** (1 - encoded);
	// CaptureRig reads an sRGB target, not the shader's linear grey.
	const linear = new THREE.Color().setRGB(encoded, encoded, encoded, THREE.SRGBColorSpace).r;
	if (curve === "inverse") return 1 / (linear * (1 / near - 1 / far) + 1 / far);
	return near + (far - near) * (1 - linear);
}

/** Count one pre-pass frame's greys into `counts` (256 bins), every 16th pixel. */
export function countDepthGreys(depth, counts = new Uint32Array(256)) {
	for (let index = 0; index < depth.length; index += 64) counts[depth[index]] += 1;
	return counts;
}

/** The near and far distance that hold the counted surface but for `clip` of it at each end, so a sliver beside the
 * lens or a speck at the horizon does not take the greys of everything else; then a twentieth of the span (as a ratio) is
 * given back at each end, so what was left out still steps and the farthest wall is not the sky. Bin 0 is sky, or past the far end. */
export function depthRangeFromCounts(counts, near = 0.1, far = DEPTH_RANGE_M, curve = "linear", clip = 0.01) {
	let total = 0;
	for (let grey = 1; grey < 256; grey += 1) total += counts[grey];
	if (!total) return { near, far };
	let low = 1, high = 255;
	for (let seen = counts[low]; seen < total * clip && low < 255;) seen += counts[low += 1];
	for (let seen = counts[high]; seen < total * clip && high > 1;) seen += counts[high -= 1];
	const nearest = Math.max(near, greyDistance(high + 0.5, near, far, curve)), farthest = Math.max(greyDistance(low - 0.5, near, far, curve), nearest * 1.01);
	const give = (farthest / nearest) ** 0.05;
	return { near: Math.max(near, nearest / give), far: farthest * give };
}

/** Decode the sampled extrema of one depth pre-pass drawn with `curve` over near..far. */
export function depthRangeFromPixels(depth, near = 0.1, far = DEPTH_RANGE_M, curve = "linear") {
	let minGrey = 255;
	let maxGrey = 0;
	for (let index = 0; index < depth.length; index += 256) {
		minGrey = Math.min(minGrey, depth[index]);
		maxGrey = Math.max(maxGrey, depth[index]);
	}
	// Include the half-byte rounding interval so quantisation cannot clip a surface.
	const distance = grey => greyDistance(grey, near, far, curve);
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
 if (curve === "log") return 1 - Math.max(0, Math.min(1, Math.log(Math.max(d, near) / near) / Math.log(far / near)));
 if (curve === "inverse") return Math.max(0, Math.min(1, (1 / Math.max(d, near) - 1 / far) / (1 / near - 1 / far)));
 return 1 - Math.max(0, Math.min(1, (d - near) / Math.max(far - near, 0.0001)));
}

// How soft the edges of a depth video are: the sigma of a gaussian in pixels of a 1080-high frame. A depth plate
// with hard steps tells whatever reads it that every edge of a blocking figure is exact; this lets them give a little.
export const DEPTH_SOFTEN_PX = 0.6;

/** A per-frame decorator for offscreen-export: `(frame, rgba) => rgba`, the grey under a gaussian of `sigma` pixels. */
export function createDepthSoftener(width, height, sigma) {
	const radius = Math.max(1, Math.ceil(sigma * 3)), count = width * height;
	const kernel = Float32Array.from({ length: radius * 2 + 1 }, (_, i) => Math.exp(-((i - radius) ** 2) / (2 * sigma * sigma)));
	const sum = kernel.reduce((total, weight) => total + weight, 0);
	const a = new Float32Array(count), b = new Float32Array(count), out = new Uint8ClampedArray(count * 4);
	const pass = (from, to, n, step, lines, lineStep) => {
		for (let line = 0; line < lines; line += 1) {
			const base = line * lineStep;
			for (let i = 0; i < n; i += 1) {
				let acc = 0;
				for (let k = -radius; k <= radius; k += 1) acc += kernel[k + radius] * from[base + Math.min(n - 1, Math.max(0, i + k)) * step];
				to[base + i * step] = acc / sum;
			}
		}
	};
	return (frame, rgba) => {
		for (let i = 0; i < count; i += 1) a[i] = rgba[i * 4];
		pass(a, b, width, 1, height, width);
		pass(b, a, height, width, width, 1);
		for (let i = 0; i < count; i += 1) { out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = a[i]; out[i * 4 + 3] = 255; }
		return out;
	};
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

/** GLSL: the value the depth pass writes for view distance d on a ramp near..far (curve as in CURVES). */
export const DEPTH_RAMP = /* glsl */ `
float depthRamp(float d, float near, float far, float curve) {
	if (curve > 1.5) {
		float grey = 1.0 - clamp(log(max(d, near) / near) / log(far / near), 0.0, 1.0);
		return grey <= 0.04045 ? grey / 12.92 : pow((grey + 0.055) / 1.055, 2.4);
	}
	if (curve > 0.5) return clamp((1.0 / max(d, near) - 1.0 / far) / (1.0 / near - 1.0 / far), 0.0, 1.0);
	return 1.0 - clamp((d - near) / max(far - near, 0.0001), 0.0, 1.0);
}
`;

const DEPTH_FRAGMENT = /* glsl */ `
varying float vViewDepth;
uniform float uNear;
uniform float uRange;
uniform float uCurve;
${DEPTH_RAMP}
void main() {
	gl_FragColor = vec4(vec3(depthRamp(vViewDepth, uNear, uRange, uCurve)), 1.0);
}
`;

const BACKGROUND_FAR = new THREE.Color(0x000000);

function passMaterial(kind, camera, depthRange = null, depthCurve = "linear") {
	if (kind === "depth") {
		return new THREE.ShaderMaterial({
			vertexShader: DEPTH_VERTEX,
			fragmentShader: DEPTH_FRAGMENT,
			uniforms: {
				uCurve: { value: CURVES[depthCurve] ?? 0 },
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
	// Particles and trails have no surface either, but they are in the way of
	// what is behind them: in the depth plate each draws its own distance over
	// the surfaces (userData.ownDepth, effects/effect-meshes.js), mixed by its
	// opacity. In the normal plate they stay out.
	const hidden = [], own = [];
	const ramp = kind === "depth" ? { near: material.uniforms.uNear.value, far: material.uniforms.uRange.value, curve: material.uniforms.uCurve.value } : null;
	scene.traverse?.((node) => {
		if (node.userData?.beautyOnly && node.visible) {
			hidden.push(node);
			node.visible = false;
		}
		if (ramp && typeof node.userData?.ownDepth === "function") own.push(node);
	});
	try {
		for (const node of own) node.userData.ownDepth(ramp);
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
		for (const node of own) node.userData.ownDepth(null);
		material.dispose();
	}
	if (!buffer) return null;
	return toDataUrl ? toDataUrl(buffer) : buffer;
}
