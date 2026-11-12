// The stage look: the key light the user grabs plus stage.lighting (sky, fog,
// ambient, fill, exposure, shadow softness, environment light, ambient
// occlusion) and the recipes that set them in one action. Pure data and arithmetic — no three.js or React — so the scene
// document, the command layer, the tests and the agent sidecar can all load it.
// The renderer reads it through stageLook() (room.jsx, stage-sky.jsx).
import { elementByPath } from "./studio-elements.js";
import { GRID_FOG, stageBackground } from "./grid-view.js";
import { environmentSpec } from "./stage-environment.js";
import { HDR_FIELDS, normalizeHdrFields } from "./stage-hdr.js";

export const LIGHTING_PRESETS = Object.freeze(["studio", "day", "overcast", "golden", "dusk", "night", "interior", "stage"]);

const HEX = /^#[0-9a-fA-F]{6}$/;
const plain = (value) => !!value && typeof value === "object" && !Array.isArray(value);
const color = (value, fallback) => (typeof value === "string" && HEX.test(value) ? value : fallback);
const limits = (path) => elementByPath(path);
const finite = (value, fallback, { min, max }) => (typeof value === "number" && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback);

// The key a new project opens with, and what Reset light and the studio look
// return to: a bright neutral sun (brightness 4, warmth 0). Saved stages keep
// their own key; only a record with no key at all picks this up. The 1.12
// still used as a ratio elsewhere (dim, practical lights) is the old key's
// brightness, kept as the scale those were tuned against.
const DEFAULT_KEY_LIGHT = Object.freeze({ x: 6, y: 9, z: 4, intensity: 4, warmth: 0, color: null });
// envLight and ao are 0 in the studio look: no environment map, no occlusion pass.
// No look names an HDR environment (stage-hdr.js); the user or the agent picks one.
const DEFAULT_LIGHTING = Object.freeze({ preset: "studio", sky: null, skyTop: null, ambient: 1, hemiSky: "#ffffff", hemiGround: "#5a5d64", fill: 1, fog: 0, exposure: 1, shadowSoftness: 0, envLight: 0, ao: 0, ...normalizeHdrFields() });
const LIGHTING_NUMBERS = ["fill", "fog", "exposure", "shadowSoftness", "envLight", "ao"];

/** Clamp a stored key light back into the stage's usable envelope. `color`
 * (a #rrggbb or null) overrides the warmth slider when set. */
export function createKeyLight(value) {
	const source = plain(value) ? value : {};
	const key = Object.fromEntries(["x", "y", "z", "intensity", "warmth"].map((axis) => [axis, finite(source[axis], DEFAULT_KEY_LIGHT[axis], limits(`stage.keyLight.${axis}`))]));
	return { ...key, color: color(source.color, null) };
}

/** stage.lighting with every field present and in range; anything missing or
 * malformed falls back to the studio look. */
export function normalizeLighting(value) {
	const source = plain(value) ? value : {};
	const number = (key) => finite(source[key], DEFAULT_LIGHTING[key], limits(`stage.lighting.${key}`));
	return {
		preset: LIGHTING_PRESETS.includes(source.preset) ? source.preset : DEFAULT_LIGHTING.preset,
		sky: color(source.sky, null),
		skyTop: color(source.skyTop, null),
		ambient: number("ambient"),
		hemiSky: color(source.hemiSky, DEFAULT_LIGHTING.hemiSky),
		hemiGround: color(source.hemiGround, DEFAULT_LIGHTING.hemiGround),
		...Object.fromEntries(LIGHTING_NUMBERS.map((key) => [key, number(key)])),
		...normalizeHdrFields(source),
	};
}

// Each recipe is a complete look: every lighting field plus the key's colour,
// brightness and place (the sun, the moon, the lamp). Key positions are metres
// around the stage centre; a low y is a low sun. Tuned by eye on the clay
// figure through the shot camera, so treat them as starting points to tweak.
const recipe = (lighting, keyLight) => Object.freeze({ lighting: Object.freeze({ ...DEFAULT_LIGHTING, ...lighting }), keyLight: Object.freeze(keyLight) });
export const LIGHTING_RECIPES = Object.freeze({
	studio: recipe({}, { ...DEFAULT_KEY_LIGHT }),
	day: recipe({ sky: "#bcd2e8", skyTop: "#4f86c6", ambient: 1.15, hemiSky: "#c4dcff", hemiGround: "#6b6253", fill: 0.7, fog: 0.12, shadowSoftness: 0.15, envLight: 1, ao: 0.8 },
		{ x: 5, y: 14, z: 7, intensity: 2.1, color: "#fff3df" }),
	overcast: recipe({ sky: "#c2c7ce", skyTop: "#8f97a3", ambient: 1.9, hemiSky: "#e3e8ef", hemiGround: "#5c5f64", fill: 1.2, fog: 0.3, exposure: 1.05, shadowSoftness: 1, envLight: 1, ao: 1 },
		{ x: 2, y: 14, z: 3, intensity: 0.55, color: "#e8ecf2" }),
	golden: recipe({ sky: "#f0a868", skyTop: "#6a8cc0", ambient: 0.75, hemiSky: "#9fb3d6", hemiGround: "#6e5136", fill: 0.45, fog: 0.3, shadowSoftness: 0.35, envLight: 1, ao: 0.8 },
		{ x: 9, y: 3.2, z: 4, intensity: 1.9, color: "#ffad5c" }),
	dusk: recipe({ sky: "#8a6f8c", skyTop: "#18223f", ambient: 0.8, hemiSky: "#5b6c9c", hemiGround: "#29242e", fill: 0.35, fog: 0.4, shadowSoftness: 0.6, envLight: 1, ao: 0.8 },
		{ x: -9, y: 1.8, z: -4, intensity: 0.7, color: "#ff9466" }),
	night: recipe({ sky: "#0b1426", skyTop: "#020408", ambient: 0.6, hemiSky: "#34507f", hemiGround: "#0a0c12", fill: 0.25, fog: 0.45, shadowSoftness: 0.75, envLight: 1, ao: 0.8 },
		{ x: -6, y: 6.5, z: 0.5, intensity: 0.6, color: "#9db6e6" }),
	interior: recipe({ sky: "#2b2621", ambient: 0.7, hemiSky: "#ffe2bf", hemiGround: "#3d3128", fill: 0.55, fog: 0.35, shadowSoftness: 0.55, envLight: 1, ao: 0.9 },
		{ x: 2, y: 4.5, z: 2.5, intensity: 1.35, color: "#ffd29c" }),
	stage: recipe({ sky: "#000000", ambient: 0, hemiSky: "#000000", hemiGround: "#000000", fill: 0, fog: 0.7, shadowSoftness: 0.2, ao: 0.6 },
		{ x: 1.5, y: 9, z: 3, intensity: 2.6, color: "#fff0d8" }),
});

/** What stage.applyLighting { keep } may hold back from the recipe. "lighting.hdr"
 * keeps the HDR environment with its rotation, intensity and backdrop switch. */
export const LIGHTING_KEEP_PATHS = Object.freeze(["keyLight.position", "keyLight.intensity", "keyLight.color",
	...["sky", "skyTop", "ambient", "hemiSky", "hemiGround", "fill", "fog", "exposure", "shadowSoftness", "envLight", "ao", "hdr"].map((key) => `lighting.${key}`)]);

/** The stage's { lighting, keyLight } after one recipe: every field written
 * from it except the `keep` paths, which stay as they are. Studio also resets
 * warmth, so it renders the tuned rig exactly; other recipes set a key colour,
 * which overrides warmth. */
export function applyLightingRecipe(stage, preset, keep = []) {
	const chosen = LIGHTING_RECIPES[preset];
	if (!chosen) throw new Error(`Unknown lighting preset: ${preset}`);
	const before = { lighting: normalizeLighting(stage?.lighting), keyLight: createKeyLight(stage?.keyLight) };
	const lighting = { ...chosen.lighting, preset };
	for (const path of keep) if (path.startsWith("lighting.")) lighting[path.slice(9)] = before.lighting[path.slice(9)];
	if (keep.includes("lighting.hdr")) for (const key of HDR_FIELDS) lighting[key] = before.lighting[key];
	const keyLight = { ...before.keyLight, ...chosen.keyLight };
	if (keep.includes("keyLight.position")) Object.assign(keyLight, { x: before.keyLight.x, y: before.keyLight.y, z: before.keyLight.z });
	if (keep.includes("keyLight.intensity")) keyLight.intensity = before.keyLight.intensity;
	if (keep.includes("keyLight.color")) Object.assign(keyLight, { color: before.keyLight.color, warmth: before.keyLight.warmth });
	return { lighting: normalizeLighting(lighting), keyLight: createKeyLight(keyLight) };
}

// Linear fog, in metres from the camera. With fog 0 the viewport keeps its
// tuned 18..54 m horizon fade and exports their 55..95 m one (stage-capture.jsx);
// haze pulls both in together, reaching 2..14 m at fog 1 (a black-void pool of
// light under the stage recipe). The squared falloff makes small values a
// distant haze rather than a jump.
export function hazeRange(fog) {
	const far = (1 - fog) ** 2;
	return { near: 2 + 53 * far, far: 14 + 81 * far };
}

/**
 * Everything the renderer needs for one look, as plain colours and numbers.
 * A null sky keeps the UI theme's studio stage — its grey, its deck and its
 * ground bounce — so the default renders exactly as before under both themes;
 * the grid view's neutral rig applies only then. An explicit sky makes the look
 * theme-independent: what the shot camera exports is the same for every user,
 * and so does an HDR backdrop (stage.lighting.hdr with hdrBackground).
 */
export function stageLook({ lighting, keyLight, theme = "dark", grid = false }) {
	const normalized = normalizeLighting(lighting), key = createKeyLight(keyLight);
	// An HDR backdrop is no UI theme's stage either: a null sky under it is the dark stage's grey.
	const l = normalized.sky === null && normalized.hdr && normalized.hdrBackground ? { ...normalized, sky: stageBackground("dark") } : normalized;
	const themed = l.sky === null, lightTheme = themed && theme === "light";
	const neutral = grid && themed && !lightTheme;
	const sky = themed ? stageBackground(theme) : l.sky;
	const haze = hazeRange(l.fog), base = neutral ? GRID_FOG : { near: 18, far: 54 };
	const dim = key.intensity / 1.12, lift = Math.min(1, 0.35 + 0.65 * dim);
	// The environment map takes over the hemisphere's share as envLight rises (stage-environment.js).
	const skyLight = 0.9 * lift * l.ambient, hemiShare = Math.max(0, 1 - l.envLight);
	return {
		sky, skyTop: l.skyTop,
		fog: { color: sky, near: Math.min(base.near, haze.near), far: Math.min(base.far, haze.far) },
		// Exports keep their own far horizon until haze asks for a nearer one.
		captureFog: l.fog > 0 ? haze : null,
		hemi: { sky: neutral ? "#ffffff" : l.hemiSky, ground: neutral ? "#3a3d42" : lightTheme ? "#d6d8de" : l.hemiGround, intensity: skyLight * hemiShare },
		// three's IBL irradiance is pi x the map, a hemisphere's is its colour x intensity: the 1/pi matches them.
		env: environmentSpec(l, key, sky), envIntensity: (skyLight * l.envLight) / Math.PI,
		// An HDR environment replaces that map once it has loaded (stage-sky.jsx): its light is
		// the file's radiance x hdrIntensity x envLight, its backdrop the file x hdrIntensity.
		hdr: l.hdr ? { id: l.hdr, rotation: l.hdrRotation, intensity: l.hdrIntensity, background: l.hdrBackground, envIntensity: l.envLight * l.hdrIntensity } : null,
		ao: l.ao,
		ambient: (neutral ? 0.34 : lightTheme ? 0.32 : 0.18) * lift * l.ambient,
		fill: 0.36 * dim * l.fill, rim: 0.22 * dim * l.fill,
		exposure: l.exposure,
		// shadow.radius in shadow-map texels (2048 over 28 m: ~1.4 cm each); 1 is the tuned hard
		// edge. A wider kernel reaches the surface's own depth on curved clay and
		// cross-hatches it, so the normal offset grows with it (metres).
		shadowRadius: 1 + l.shadowSoftness * 7,
		shadowNormalBias: 0.02 + l.shadowSoftness * 0.08,
		lightDeck: lightTheme,
	};
}
