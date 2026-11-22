import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { stageLook } from "./stage-lighting.js";
import { followSet } from "./stage-shadow-fit.js";
// Patches three's PCF filter before any material compiles (16 taps past radius 1).
import "./soft-shadows.js";
export { StageAtmosphere } from "./stage-sky.jsx";

/**
 * The blocking set: an open stage floor.
 *
 * The set used to be a two-walled room corner, which kept AI blocking frames
 * enclosed but boxed the camera and capped how far a run or a chase could be
 * staged. The walls are gone: the stage is now a near-infinite open deck —
 * large enough that no ordinary blocking ever meets its edge — and enclosure,
 * when a shot needs it, comes from placed set pieces instead of the stage.
 *
 * Dimensions are metres. The floor is deliberately finite (a plane, not a
 * shader-infinite grid) so exports keep a clean horizon and the framing math
 * never meets an unbounded surface.
 */

// The deck is the grey workbench (the same neutral family as STAGE_BACKGROUND
// in grid-view.js), a step lighter than the sky so the horizon still reads,
// with the grid lines drawn ON it in a lighter grey.
//
// Lit, not unlit. An unlit deck renders one flat colour across its whole 500 m,
// which costs an exported blocking frame two depth cues at once: the falloff
// that says how far away the floor is, and the contact shading that says the
// subject is standing ON it rather than floating. The colour is lifted to
// compensate for the shading the lambert term now applies, so the deck keeps
// the same on-screen brightness it had while unlit.
const FLOOR = "#5b5d63";
// The light theme's deck: the cyclorama floor. Tone mapping caps a lit
// white deck near #d4, a dull grey under a white sky, so it also glows a
// little (FLOOR_LIGHT_GLOW): it renders about #dedede near the camera and
// fades into the sky (grid-view.js STAGE_BACKGROUND_LIGHT) with distance.
// The key's contact shadow still reads, since the glow is only a fifth.
const FLOOR_LIGHT = "#ffffff";
const FLOOR_LIGHT_GLOW = 0.2;

export const STAGE_SIZE = 500;

/** Metres between the heavy lines; minor lines every metre. */
const TILE_M = 10;

// Line ink per theme: how far a line darkens the lit deck. The light deck
// needs as much ink as the dark one to read: its lines are thin dark marks on
// a bright floor, and anything fainter vanished into it.
const GRID_INK = Object.freeze({
	dark: { minor: 0.22, major: 0.42 },
	light: { minor: 0.38, major: 0.5 },
});

/**
 * The measuring grid, drawn INTO the deck rather than floating above it.
 *
 * A GridHelper is a separate object a couple of millimetres over a 500 m
 * plane, and at that separation it loses to the floor across almost the whole
 * frame — it survives only where the surface is grazed near the horizon, which
 * is exactly where it is useless. Drawing the lines in the floor's own shader
 * ends the contest: the marks ARE the surface, so they cannot z-fight with it,
 * cannot be sorted behind it, and shade, shadow and fog exactly as the deck
 * does.
 *
 * Computed per pixel from the world position, not baked into a tiled texture:
 * a texture blurred its lines up close and mip-averaged them into a grey
 * moire toward the horizon. Here every line is ~1 px wide at any distance
 * (fwidth), and a line family fades out once its spacing drops under a few
 * pixels, so the far deck is clean floor instead of a band of noise.
 */
function makeDeckMaterial(light) {
	const ink = light ? GRID_INK.light : GRID_INK.dark;
	// A standard surface with no specular is the lambert deck it replaced, and it takes the finish's surface look like
	// every other surface on the set (stage-finish-surface.js): the same light steps, shadow edge and environment
	// light. Two things it sets for itself (userData below). Its fill gain is 1: the look lifts the fill to keep a
	// form's shade side readable, and the open deck has no shade side, only the shadows cast on it, which stay as
	// dark against the lit deck as in the look the owner approved (2026-11-16). And a lamp's light falls off on it
	// as the lamp's does: the look's flat lamp pool keeps a form's faces flat, and the deck is where a lamp's pool
	// is seen, as bright under the lamp as before the deck took the look.
	const material = new THREE.MeshPhysicalMaterial({
		roughness: 1,
		metalness: 0,
		specularIntensity: 0,
		color: light ? FLOOR_LIGHT : FLOOR,
		emissive: light ? FLOOR_LIGHT : "#000000",
		emissiveIntensity: light ? FLOOR_LIGHT_GLOW : 0,
		// Push the deck's depth back a hair so an object face lying in its plane
		// (a floor slab whose bottom is at y=0) wins the depth test instead of
		// flickering against it (#1075). Depth only: the grid lines and the
		// shadows the deck receives are untouched.
		polygonOffset: true,
		polygonOffsetFactor: 1,
		polygonOffsetUnits: 1,
	});
	material.onBeforeCompile = (shader) => {
		shader.uniforms.gridInk = { value: new THREE.Vector2(ink.minor, ink.major) };
		shader.vertexShader = shader.vertexShader
			.replace("#include <common>", "#include <common>\nvarying vec2 vGridXZ;")
			.replace("#include <begin_vertex>", "#include <begin_vertex>\nvGridXZ = (modelMatrix * vec4(transformed, 1.0)).xz;");
		shader.fragmentShader = shader.fragmentShader
			.replace("#include <common>", `#include <common>
varying vec2 vGridXZ;
uniform vec2 gridInk;
// 0..1 coverage of the lines every \`spacing\` metres, \`width\` px wide.
float gridLines(float spacing, float width) {
	vec2 cell = vGridXZ / spacing;
	vec2 perPx = fwidth(cell);
	vec2 dist = abs(fract(cell - 0.5) - 0.5) / max(perPx, vec2(1e-5));
	float line = 1.0 - clamp(min(dist.x, dist.y) - (width - 1.0) * 0.5, 0.0, 1.0);
	// Cells under ~5 px would alias: fade the family out before they do.
	float fade = 1.0 - smoothstep(0.08, 0.2, max(perPx.x, perPx.y));
	return line * fade;
}`)
			.replace("#include <opaque_fragment>", `outgoingLight *= 1.0 - max(gridLines(1.0, 1.0) * gridInk.x, gridLines(${TILE_M.toFixed(1)}, 1.6) * gridInk.y);
#include <opaque_fragment>`);
	};
	material.customProgramCacheKey = () => `deck-grid-${light ? "light" : "dark"}`;
	Object.assign(material.userData, { surfaceFill: 1, surfaceLampStock: true });
	return material;
}

export function Room({ light = false }) {
	const material = useMemo(() => makeDeckMaterial(light), [light]);
	useEffect(() => () => material.dispose(), [material]);
	return (
		<group>
			<mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} receiveShadow userData={{ noInk: true }} material={material}>
				<planeGeometry args={[STAGE_SIZE, STAGE_SIZE]} />
			</mesh>
		</group>
	);
}

/** Key/fill/rim rig tuned so a clay figure keeps readable form from any angle.
 * The key is the USER'S light: `keyLight` carries its grabbable position and
 * the rig's master brightness — fill and rim ride the same dimmer so turning
 * the key down darkens the whole stage instead of flattening it. */
// Cool/warm slider → light colour. 0.5 is neutral white (the grey set and the
// grey clay stay grey); 0 pulls toward cool daylight (the key a new project
// opens with, stage-lighting.js), 1 toward sunset amber.
export function keyLightColor(warmth = 0.5) {
	const w = Math.max(0, Math.min(1, warmth ?? 0.5));
	const base = new THREE.Color("#ffffff");
	if (w < 0.5) return base.clone().lerp(new THREE.Color("#e8f0ff"), (0.5 - w) * 2).getStyle();
	if (w > 0.5) return base.clone().lerp(new THREE.Color("#ffc27a"), (w - 0.5) * 2).getStyle();
	return "#ffffff";
}

/**
 * One neutral rig (Blender's workbench studio light idea): a white sky over
 * a grey ground bounce. `neutral` is the grid view, where the deck is gone
 * and the ambient is lifted so authored colours stay saturated without any
 * pretend floor. `lighting` (stage.lighting) scales and tints the rig into a
 * look — night, golden hour, a black stage — through stageLook(); its studio
 * default renders the tuned rig unchanged.
 */
export function StageLights({ keyLight = { x: 6, y: 9, z: 4, intensity: 1.12, warmth: 0.5 }, lighting = null, neutral = false, light = false }) {
	const look = stageLook({ lighting, keyLight, theme: light ? "light" : "dark", grid: neutral });
	const key = useRef(null);
	useLayoutEffect(() => followSet(key.current), []);
	return (
		<>
			<hemisphereLight args={[look.hemi.sky, look.hemi.ground, 0.9]} intensity={look.hemi.intensity} />
			{/* The light stage is a bright room: more ambient, so the clay's shaded
			    side stays soft grey instead of going charcoal against white. */}
			<ambientLight intensity={look.ambient} />
			{/* Only the key casts: one soft, unambiguous contact shadow reads as
			    ground contact, while three overlapping shadows read as noise. The
			    map covers the part of the set each draw can see, wherever it stands
			    on the deck (stage-shadow-fit.js), rather than the whole 500 m deck. */}
			<directionalLight
				ref={key}
				color={keyLight.color ?? keyLightColor(keyLight.warmth)}
				position={[keyLight.x, keyLight.y, keyLight.z]}
				intensity={keyLight.intensity}
				castShadow
				// PCF spreads its taps over shadow.radius texels, so a larger radius
				// is a wider penumbra in the same single pass (stage.lighting.shadowSoftness;
				// soft-shadows.js says why not VSM). The normal offset grows with the
				// radius. Both are given at the old 28 m box's density; the fit keeps
				// their width in metres.
				userData-shadowRadius={look.shadowRadius}
				userData-shadowNormalBias={look.shadowNormalBias}
			/>
			{/* Fill and rim are fill lights: under the toon look they light every face alike (stage-finish-surface.js applySurfaceLook). */}
			<directionalLight color="#eef2f4" position={[-6, 4, -4]} intensity={look.fill} userData-fillLight />
			<directionalLight color="#ffffff" position={[2, 3, 9]} intensity={look.rim} userData-fillLight />
		</>
	);
}
