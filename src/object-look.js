/**
 * Practical lights and glow: the record fields, their defaults and clamps, and
 * the per-frame numbers the renderer reads (flicker, take level, shadow cap).
 *
 * Pure on purpose: no three.js and no React, so the agent sidecar, the record
 * normalizer and Node tests all read the same rules.
 *
 * A light is a record with renderer "light". It is created from one of three
 * catalogue kinds, `point-light`, `spot-light` and `directional-light`, which
 * differ only in the `light.type` they start with. Like an Empty it has no
 * size: no collision, no surface, no footprint on the plan.
 *
 * `glow` can sit on any record. It makes the record's materials emissive and
 * adds a camera-facing additive halo, so an ember or a bulb reads as a light
 * source in the shot render without any post-processing pass.
 */

import { normalizeObjectColor } from "./object-colors.js";
import { objectMaterialFields, objectMaterialPatch } from "./material-presets.js";

export const LIGHT_KIND = "light";

/** three.js intensity per authored unit of a point or spot light. Authored values are candela-like
 * (decay 2: lighter flame 0.3-0.6, candle 0.3, desk lamp 5, street lamp 40).
 * A directional light has no falloff: its authored intensity is three.js's own,
 * the unit of stage.keyLight.intensity (0.9 is the default key), 0..DIRECTIONAL_MAX.
 * The scale is tuned against the default stage key (directional, 1.12) so a
 * street lamp's pool at 4 m reads about as bright as half the key, and a
 * lighter 25 cm from a face lifts it to roughly the key. */
export const LIGHT_INTENSITY_SCALE = 0.35;

const DIRECTIONAL_MAX = 4;

/** At most this many shown practical lights are drawn, in record order; the rest
 * keep their marker but light nothing and are reported. Measured 2026-11-22 (GPU
 * time of one 1920x1080 frame of the stage with two figures): no light 0.69 ms,
 * 16 spots 0.84 ms, 32 spots 4.2 ms, 32 points 1.14 ms. */
export const PRACTICAL_LIGHT_CAP = 16;
/** Of the drawn lights, at most this many render shadows (each is one depth map
 * and one texture unit in every lit material; a point light's map is six depth
 * passes). The rest still light the scene and are reported. Measured the same
 * way: 4 spot shadows 0.89 ms, 8 spot 1.33 ms, 4 point 1.51 ms, 8 point 2.22 ms;
 * 16 spot shadows fail to compile (16 texture units on that GPU). */
export const PRACTICAL_SHADOW_CAP = 4;

const LIGHT_TYPES = ["point", "spot", "directional"];
const LIGHT_DEFAULTS = Object.freeze({
	point: Object.freeze({ type: "point", color: "#ffc787", intensity: 5, range: 0, angle: 30, softness: 0.3, shadow: false, flicker: 0, aim: null }),
	spot: Object.freeze({ type: "spot", color: "#ffe0b2", intensity: 40, range: 0, angle: 30, softness: 0.3, shadow: true, flicker: 0, aim: null }),
	directional: Object.freeze({ type: "directional", color: "#fff4e0", intensity: 1, range: 0, angle: 30, softness: 0.3, shadow: true, flicker: 0, aim: null }),
});
const GLOW_DEFAULTS = Object.freeze({ color: "#ff9a3c", intensity: 4, halo: 1.5 });

const LIGHT_SIZE = { footprint: { width: 0, depth: 0 }, height: 0 };
/** The record entry every light normalizes through. */
const LIGHT_ENTRY = Object.freeze({ kind: LIGHT_KIND, label: "Light", group: "Lights", ...LIGHT_SIZE, color: "#ffd38a" });
/** The three creatable kinds: the add menu and the agent catalogue list these.
 * `placeY` is where a fresh one hangs, so it lights something on arrival. */
export const LIGHT_MENU_ENTRIES = Object.freeze([
	Object.freeze({ kind: "point-light", renderer: LIGHT_KIND, label: "Point light", group: "Lights", ...LIGHT_SIZE, color: "#ffc787", placeY: 1.5, light: LIGHT_DEFAULTS.point }),
	Object.freeze({ kind: "spot-light", renderer: LIGHT_KIND, label: "Spot light", group: "Lights", ...LIGHT_SIZE, color: "#ffe0b2", placeY: 3, light: LIGHT_DEFAULTS.spot }),
	Object.freeze({ kind: "directional-light", renderer: LIGHT_KIND, label: "Directional light", group: "Lights", ...LIGHT_SIZE, color: "#fff4e0", placeY: 6, light: LIGHT_DEFAULTS.directional }),
]);

/** The library entry for a light kind or the light renderer, or null. */
export function lightLibraryEntry(kind) {
	if (kind === LIGHT_KIND) return LIGHT_ENTRY;
	return LIGHT_MENU_ENTRIES.find((entry) => entry.kind === kind) ?? null;
}

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const finite = (value, fallback, min, max) => {
	const n = typeof value === "number" || typeof value === "string" ? Number(value) : NaN;
	return Number.isFinite(n) ? clamp(n, min, max) : fallback;
};
const hex = (value, fallback) => normalizeObjectColor(value) ?? fallback;
const point = (value) => {
	if (!value || typeof value !== "object") return null;
	const out = { x: Number(value.x), y: Number(value.y), z: Number(value.z) };
	return Object.values(out).every(Number.isFinite) ? out : null;
};
/** An aim: a world point, or { id } of a character or scene object the light turns to every frame. */
const aimOf = (value) => (typeof value?.id === "string" && value.id.length > 0 && value.id.length <= 80 ? { id: value.id } : point(value));

/** A stored or requested light repaired into the full record. `type` falls back
 * to `typeHint` (the kind it was created as), then to "point". */
export function normalizeObjectLight(value, typeHint = "point") {
	const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
	const type = LIGHT_TYPES.includes(source.type) ? source.type : LIGHT_TYPES.includes(typeHint) ? typeHint : "point";
	const base = LIGHT_DEFAULTS[type];
	return {
		type,
		color: hex(source.color, base.color),
		intensity: finite(source.intensity, base.intensity, 0, type === "directional" ? DIRECTIONAL_MAX : 1000),
		range: finite(source.range, base.range, 0, 100),
		angle: finite(source.angle, base.angle, 1, 89),
		softness: finite(source.softness, base.softness, 0, 1),
		shadow: typeof source.shadow === "boolean" ? source.shadow : base.shadow,
		flicker: finite(source.flicker, base.flicker, 0, 1),
		aim: aimOf(source.aim),
	};
}

/** A glow repaired into `{ color, intensity, halo }`, or null for none. */
export function normalizeObjectGlow(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	return {
		color: hex(value.color, GLOW_DEFAULTS.color),
		intensity: finite(value.intensity, GLOW_DEFAULTS.intensity, 0, 20),
		halo: finite(value.halo, GLOW_DEFAULTS.halo, 0, 4),
	};
}

/** The light/glow fields a normalized record carries. A light renderer always
 * has a light; any record keeps a glow (and a primitive its surface preset)
 * only when it has one, so records written before come back unchanged. */
export function objectLookFields(record, entry) {
	const out = {};
	if ((entry.renderer ?? entry.kind) === LIGHT_KIND) out.light = normalizeObjectLight(record.light, record.light?.type ?? entry.light?.type);
	const glow = normalizeObjectGlow(record.glow);
	if (glow) out.glow = glow;
	// A kit part a take switches on (a muzzle flash and its light) stays hidden without one (object-travel.js trackShown).
	if (record.showOnlyInTake === true) out.showOnlyInTake = true;
	// A primitive's surface preset (material-presets.js).
	return Object.assign(out, objectMaterialFields(record, entry.renderer ?? entry.kind));
}

/** The light/glow part of an object.update patch: each field merges over the
 * record's own and is repaired; `glow: null` removes the glow. Only changes are
 * returned. A light on a record that is not a light is ignored. A primitive's
 * material and finish ride along (material-presets.js). */
export function objectLookPatch(object, patch) {
	const update = {};
	if (patch?.light && typeof patch.light === "object" && object.renderer === LIGHT_KIND) {
		const next = normalizeObjectLight({ ...object.light, ...patch.light }, object.light?.type);
		if (JSON.stringify(next) !== JSON.stringify(object.light)) update.light = next;
	}
	if (patch?.glow !== undefined) {
		const next = patch.glow === null ? null : normalizeObjectGlow({ ...(object.glow ?? {}), ...patch.glow });
		if (JSON.stringify(next) !== JSON.stringify(object.glow ?? null)) update.glow = next;
	}
	return Object.assign(update, objectMaterialPatch(object, patch));
}

/** 32-bit FNV-1a of the record id: the flicker's seed. */
function seedOf(id) {
	let hash = 0x811c9dc5;
	for (const char of String(id)) {
		hash ^= char.codePointAt(0);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash;
}

/** Lattice value in [-1, 1] for an integer cell of a seeded stream. */
function lattice(seed, cell) {
	let h = Math.imul(seed ^ Math.imul(cell, 0x27d4eb2d), 0x165667b1) >>> 0;
	h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0;
	h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
	return ((h ^ (h >>> 16)) >>> 0) / 0x7fffffff - 1;
}

/** Smooth value noise in [-1, 1] at time `t` (cells of 1). */
function noise(seed, t) {
	const cell = Math.floor(t);
	const f = t - cell;
	const s = f * f * (3 - 2 * f);
	return lattice(seed, cell) * (1 - s) + lattice(seed, cell + 1) * s;
}

/**
 * The flicker multiplier of a light at `frame`: a pure function of the id, the
 * frame and the amount, so scrubbing, playback and export see the same value.
 * 0 is steady (exactly 1); 0.3 wavers like a candle; 0.6 jumps like a lighter.
 */
export function flickerAt(id, frame, amount, fps = 24) {
	const depth = finite(amount, 0, 0, 1);
	if (!(depth > 0)) return 1;
	const seed = seedOf(id);
	const t = (Number(frame) || 0) / (fps > 0 ? fps : 24);
	const n = 0.55 * noise(seed, t * 7) + 0.3 * noise(seed ^ 0x9e3779b9, t * 15) + 0.15 * noise(seed ^ 0x7f4a7c15, t * 31);
	return Math.max(0, 1 + depth * 0.65 * n);
}

/**
 * Which shown lights are drawn and which of those get a shadow: the first
 * PRACTICAL_LIGHT_CAP lights in record order are drawn (`unlit` lists the
 * rest), and of the drawn ones that ask for a shadow the first
 * PRACTICAL_SHADOW_CAP cast one (`capped` lists the rest), all by id.
 * `isHidden(record)` drops records the stage does not draw.
 */
export function practicalShadows(objects, isHidden = (object) => object?.hidden === true) {
	const shown = (objects ?? []).filter((object) => object?.renderer === LIGHT_KIND && !isHidden(object));
	const asking = shown.slice(0, PRACTICAL_LIGHT_CAP).filter((object) => object.light?.shadow === true);
	return { casting: asking.slice(0, PRACTICAL_SHADOW_CAP).map((object) => object.id), capped: asking.slice(PRACTICAL_SHADOW_CAP).map((object) => object.id),
		unlit: shown.slice(PRACTICAL_LIGHT_CAP).map((object) => object.id) };
}

/** The records as the stage draws them: lights past the shadow cap render with
 * `shadow: false` and `shadowCapped: true`, lights past the light cap with
 * `lightCapped: true` (their marker only). The same array when none is capped. */
export function capPracticalLights(objects) {
	const { capped, unlit } = practicalShadows(objects);
	if (!capped.length && !unlit.length) return objects;
	const dark = new Set(unlit), shadowless = new Set(capped);
	return objects.map((object) => (dark.has(object.id) ? { ...object, light: { ...object.light, shadow: false }, lightCapped: true }
		: shadowless.has(object.id) ? { ...object, light: { ...object.light, shadow: false }, shadowCapped: true } : object));
}

/** Receipt warnings, one per light past either cap, limited to `ids` when
 * given (the records an edit touched). */
function shadowCapWarnings(objects, ids = null, isHidden = undefined) {
	const { casting, capped, unlit } = practicalShadows(objects, isHidden);
	const touched = (id) => !ids || ids.includes(id);
	return [
		...unlit.filter(touched).map((id) => ({ code: "LIGHT_CAP", id, message: `Lights nothing: only the first ${PRACTICAL_LIGHT_CAP} shown lights are drawn.` })),
		...capped.filter(touched).map((id) => ({ code: "SHADOW_CAP", id,
			message: `Renders without a shadow: only ${PRACTICAL_SHADOW_CAP} lights cast shadows (${casting.join(", ")}).`.slice(0, 120) })),
	].slice(0, 4);
}

/** A command result with the shadow-cap warnings for the records it touched
 * appended, so a receipt says when a requested shadow is not drawn. */
export function withShadowCapWarnings(result, objects) {
	const warnings = shadowCapWarnings(objects, result?.affectedIds ?? []);
	return warnings.length ? { ...result, warnings: [...(result.warnings ?? []), ...warnings] } : result;
}
// A record's grasp sockets ride the same normalize and patch paths (object-grasp.js).
export { objectGraspFields, objectGraspPatch } from "./object-grasp.js";
export { objectMaterialKeys } from "./material-presets.js";
