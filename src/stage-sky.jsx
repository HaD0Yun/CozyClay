import { useEffect, useLayoutEffect, useRef } from "react";
import { useThree } from "@react-three/fiber";
import * as THREE from "three";
import { stageLook } from "./stage-lighting.js";
import { ENV_HEIGHT, ENV_WIDTH, environmentPixels } from "./stage-environment.js";
import { installOcclusion } from "./stage-occlusion.js";
import { useHdrMap } from "./stage-hdr-map.js";
import { refreshHdrLibrary } from "./stage-hdr-library.js";

// Rows of the equirectangular gradient: v runs from straight down (0) through
// the horizon (0.5) to straight up (1).
const SKY_ROWS = 128;
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

/** A sky that grades from `bottom` at the horizon (and below it) to `top`
 * overhead, eased so most of the change happens in the lower 60 degrees a shot
 * camera actually sees. Built once per look as an sRGB equirectangular texture;
 * three draws it as the background in the same pass as the scene. */
function gradientSky(bottom, top) {
	const [from, to] = [rgb(bottom), rgb(top)];
	const data = new Uint8Array(SKY_ROWS * 4);
	for (let row = 0; row < SKY_ROWS; row++) {
		const elevation = ((row + 0.5) / SKY_ROWS - 0.5) * 180;
		const t = elevation <= 0 ? 0 : 1 - (1 - Math.min(1, elevation / 60)) ** 2;
		for (let channel = 0; channel < 3; channel++) data[row * 4 + channel] = Math.round(from[channel] + (to[channel] - from[channel]) * t);
		data[row * 4 + 3] = 255;
	}
	const texture = new THREE.DataTexture(data, 1, SKY_ROWS);
	texture.colorSpace = THREE.SRGBColorSpace;
	texture.mapping = THREE.EquirectangularReflectionMapping;
	texture.magFilter = THREE.LinearFilter;
	texture.minFilter = THREE.LinearFilter;
	texture.needsUpdate = true;
	return texture;
}

/** The look's environment map (stage-environment.js), prefiltered for image-based
 * lighting. Half floats keep the glow around the key above 1 and filter
 * everywhere WebGL2 runs. */
function environmentMap(gl, spec) {
	const pixels = environmentPixels(spec), half = new Uint16Array(pixels.length);
	for (let i = 0; i < pixels.length; i++) half[i] = THREE.DataUtils.toHalfFloat(pixels[i]);
	const texture = new THREE.DataTexture(half, ENV_WIDTH, ENV_HEIGHT, THREE.RGBAFormat, THREE.HalfFloatType);
	texture.mapping = THREE.EquirectangularReflectionMapping;
	texture.magFilter = THREE.LinearFilter;
	texture.minFilter = THREE.LinearFilter;
	texture.needsUpdate = true;
	try { return prefiltered(gl, texture); } finally { texture.dispose(); }
}

/** An equirectangular map prefiltered for image-based lighting (PMREM). */
function prefiltered(gl, texture) {
	const generator = new THREE.PMREMGenerator(gl);
	try { return generator.fromEquirectangular(texture); } finally { generator.dispose(); }
}

/**
 * The stage's sky, fog and exposure (stage.lighting through stageLook), set on
 * the one scene and renderer every path draws with: the viewport panes, the
 * shot preview card, capture_frame, contact sheets and video export
 * (stage-capture.jsx). Nothing here is a post-process; it is all the same pass.
 *
 * The open stage runs 500 m; without a falloff the whole deck reads at once and
 * the horizon sits a kilometre away. The fog fades the floor INTO the sky colour,
 * so past its far distance the deck simply ceases to exist with no horizon line,
 * no clip edge and no tone break. Haze (stage.lighting.fog) pulls that fade in.
 *
 * Perspective cameras see the gradient sky when skyTop is set; orthographic ones
 * (the plan) keep the flat horizon colour, since a box-mapped sky has no meaning
 * looking straight down. A caller that swaps the background for a pass of its
 * own (render-passes.js) is left alone.
 *
 * The environment light (scene.environment) and the ambient occlusion pass
 * (stage-occlusion.js) are set here too, for the same paths. Both are off in the
 * studio look, which therefore draws exactly what it drew before them. The map
 * is rebuilt only when its colours or the key's direction change.
 *
 * An HDR environment (stage.lighting.hdr, stage-hdr-map.js) replaces that map
 * once it has loaded: its prefiltered texture is the light (prefiltered again
 * only when the map changes; rotation and intensity are uniforms), and with
 * hdrBackground the map itself is the perspective backdrop, the deck fading
 * into the map's horizon colour. Until a file loads, the look's own sky lights.
 */
export function StageAtmosphere({ lighting = null, keyLight, theme = "dark", grid = false }) {
	// The scene and renderer are read inside the effects: they are three objects
	// this component configures, not React state.
	const get = useThree((state) => state.get), invalidate = useThree((state) => state.invalidate);
	const look = stageLook({ lighting, keyLight, theme, grid });
	const { sky, skyTop, exposure } = look, { near, far } = look.fog;
	const hazeNear = look.captureFog?.near ?? null, hazeFar = look.captureFog?.far ?? null;
	const envKey = look.env ? JSON.stringify(look.env) : null, { envIntensity, ao } = look;
	const hdrMap = useHdrMap(look.hdr?.id ?? null), hdr = hdrMap ? look.hdr : null;
	const backdrop = hdr?.background ? hdrMap : null, backdropIntensity = backdrop ? hdr.intensity : 1;
	const hdrLight = hdr ? hdr.envIntensity : null, hdrTurn = hdr ? (hdr.rotation * Math.PI) / 180 : 0;
	useEffect(() => { void refreshHdrLibrary(); }, []);
	useLayoutEffect(() => {
		const { scene } = get();
		const flat = backdrop ? new THREE.Color().setRGB(...backdrop.horizon.map((value) => value * backdropIntensity), THREE.LinearSRGBColorSpace) : new THREE.Color(sky);
		const gradient = skyTop ? gradientSky(sky, skyTop) : null, map = backdrop?.texture ?? null;
		scene.background = flat;
		scene.backgroundIntensity = backdropIntensity;
		scene.fog = new THREE.Fog(flat, near, far);
		scene.onBeforeRender = (_renderer, _scene, camera) => {
			if (scene.background === flat || scene.background === gradient || (map && scene.background === map)) scene.background = camera.isPerspectiveCamera ? map ?? gradient ?? flat : flat;
		};
		invalidate();
		return () => {
			scene.onBeforeRender = () => {};
			gradient?.dispose();
		};
	}, [get, invalidate, sky, skyTop, near, far, backdrop, backdropIntensity]);
	useLayoutEffect(() => {
		// Exposure is the tone curve's, for the canvas and for every export (CaptureRig draws through the same curve);
		// the haze's fog range is what an export uses instead of its own far horizon.
		const { scene, gl } = get();
		gl.toneMappingExposure = exposure;
		scene.userData.stageCapture = { fog: hazeNear === null ? null : { near: hazeNear, far: hazeFar } };
		invalidate();
	}, [get, invalidate, exposure, hazeNear, hazeFar]);
	const hdrTexture = hdrMap?.texture ?? null, envSource = hdrTexture ? null : envKey;
	useLayoutEffect(() => {
		if (!hdrTexture && !envSource) return undefined;
		const { scene, gl } = get();
		const target = hdrTexture ? prefiltered(gl, hdrTexture) : environmentMap(gl, JSON.parse(envSource));
		scene.environment = target.texture;
		invalidate();
		return () => {
			if (scene.environment === target.texture) scene.environment = null;
			target.dispose();
			invalidate();
		};
	}, [get, invalidate, hdrTexture, envSource]);
	useLayoutEffect(() => {
		const { scene } = get();
		scene.environmentIntensity = hdrLight ?? envIntensity;
		// The light and the backdrop turn together: +90 deg carries +x to -z.
		scene.environmentRotation.set(0, hdrTurn, 0);
		scene.backgroundRotation.set(0, hdrTurn, 0);
		invalidate();
	}, [get, invalidate, envIntensity, hdrLight, hdrTurn]);
	// The pass stays installed while ao > 0; the slider only changes its strength.
	const occlusion = useRef({ strength: ao }), occluded = ao > 0;
	useLayoutEffect(() => {
		if (!occluded) return undefined;
		const remove = installOcclusion(get().scene, occlusion.current);
		invalidate();
		return () => {
			remove();
			invalidate();
		};
	}, [get, invalidate, occluded]);
	useLayoutEffect(() => {
		occlusion.current.strength = ao;
		invalidate();
	}, [invalidate, ao]);
	return null;
}
