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
import { GLASS_PANE_OPACITY } from "./material-presets.js";
import { authoredOpacity } from "./pose-fade.js";

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
// target (the stored byte is the encoded grey); "log" writes so that the stored byte is the grey itself. "ratio" is the
// same share-out written as it is, for a read-back that keeps its precision (options.precise; depth-plate.js).
const CURVES = Object.freeze({ linear: 0, inverse: 1, log: 2, ratio: 3 });
/** The distance a pre-pass byte stands for, drawn with `curve` over near..far. */
export function greyDistance(grey, near, far, curve) {
	const encoded = Math.max(0, Math.min(255, grey)) / 255;
	if (curve === "log") return near * (far / near) ** (1 - encoded);
	// CaptureRig reads an sRGB target, not the shader's linear grey.
	const linear = new THREE.Color().setRGB(encoded, encoded, encoded, THREE.SRGBColorSpace).r;
	if (curve === "inverse") return 1 / (linear * (1 / near - 1 / far) + 1 / far);
	return near + (far - near) * (1 - linear);
}

/** The grey (0 far .. 1 near) the pass draws for distance `d` over near..far: the shader's ramp (DEPTH_RAMP) in JS.
 * greyDistance reads the distance back from the byte the target stores for it. */
export function depthGrey(d, near, far, curve = "linear") {
 if (curve === "log") return 1 - Math.max(0, Math.min(1, Math.log(Math.max(d, near) / near) / Math.log(far / near)));
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

/** GLSL: the value the depth pass writes for view distance d on a ramp near..far (curve as in CURVES). */
export const DEPTH_RAMP = /* glsl */ `
float depthRamp(float d, float near, float far, float curve) {
	if (curve > 1.5) {
		float grey = 1.0 - clamp(log(max(d, near) / near) / log(far / near), 0.0, 1.0);
		return curve > 2.5 || grey <= 0.04045 ? (curve > 2.5 ? grey : grey / 12.92) : pow((grey + 0.055) / 1.055, 2.4);
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
uniform float uCover;
${DEPTH_RAMP}
void main() {
	gl_FragColor = vec4(vec3(depthRamp(vViewDepth, uNear, uRange, uCurve)), uCover);
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
				uCover: { value: 1 },
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

/** How much of what is behind it a mesh covers in the picture: 1 for a solid, the opacity of a see-through material,
 * the plain pane's share for clear glass (three's transmission). A mesh of several materials is as solid as its most solid one.
 * The opacity is the authored one: a prop Pose mode fades to work on the figure is as solid in the plate as it is in the set. */
function surfaceCover(mesh) {
	const cover = (m) => (m?.transparent && authoredOpacity(m) < 1 ? authoredOpacity(m) : m?.transmission > 0 ? 1 - m.transmission * (1 - GLASS_PANE_OPACITY) : 1);
	// a mesh with an empty list of materials draws nothing: it stays with the override, which draws nothing either
	const materials = [mesh.material].flat();
	return materials.length ? Math.max(...materials.map(cover)) : 1;
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
	// opacity. In the normal plate they stay out. A see-through surface (glass, a pane at part opacity) is a surface,
	// and what is behind it is in the picture too: in the depth plate it draws its distance over what is behind it,
	// mixed by the share of it the picture covers (a veil: the pass's material at that share, drawn after the solids).
	const hidden = [], own = [], veiled = [], veils = new Map();
	const veil = (cover) => veils.get(cover) ?? veils.set(cover, Object.assign(material.clone(), { transparent: true, depthWrite: false, allowOverride: false,
		uniforms: { ...material.uniforms, uCover: { value: cover } } })).get(cover);
	const ramp = kind === "depth" ? { near: material.uniforms.uNear.value, far: material.uniforms.uRange.value, curve: material.uniforms.uCurve.value } : null;
	scene.traverse?.((node) => {
		if (node.userData?.beautyOnly && node.visible) {
			hidden.push(node);
			node.visible = false;
		}
		if (ramp && typeof node.userData?.ownDepth === "function") own.push(node);
		else if (ramp && node.isMesh && node.material && surfaceCover(node) < 1) veiled.push([node, node.material]);
	});
	try {
		for (const node of own) node.userData.ownDepth(ramp);
		for (const [node] of veiled) node.material = veil(Math.round(surfaceCover(node) * 100) / 100);
		scene.overrideMaterial = material;
		// Empty sky is infinitely far away, so on a depth plate it is black. The
		// studio's pale stage colour would otherwise read as "nearest thing in
		// the frame" to anything consuming the pass.
		if (kind === "depth") scene.background = BACKGROUND_FAR;
		buffer = capture.render(options.precise ? { precise: true } : undefined);
	} finally {
		// The viewport draws from this same scene object, so the override must
		// come off before anything else can paint with it — even if the render
		// threw.
		scene.overrideMaterial = previousMaterial;
		scene.background = previousBackground;
		for (const node of hidden) node.visible = true;
		for (const node of own) node.userData.ownDepth(null);
		for (const [node, drawn] of veiled) node.material = drawn;
		for (const made of veils.values()) made.dispose();
		material.dispose();
	}
	if (!buffer) return null;
	return toDataUrl ? toDataUrl(buffer) : buffer;
}
