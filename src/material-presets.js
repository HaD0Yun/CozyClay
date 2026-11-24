/**
 * Material presets: named surface looks for sculpt parts (`material`, `finish`)
 * and plain primitives (`object.material`, `object.finish`). Pure data and the
 * record rules, no three.js, so the recipe reader, the scene record and Node
 * tests share one list; material-look.js turns an entry into a material.
 *
 * A record keeps only the names. `color` stays the base tint ("#c24a3b" with
 * wood is red-painted wood), and a colour left at the blockout grey takes the
 * preset's own (brick with no colour draws brick red). `finish` replaces the
 * preset's roughness: chrome is metal + gloss, frosted glass is glass + matte.
 * Clay with no finish is exactly the look every prop wore before presets.
 *
 * An entry (every field optional): roughness, metalness, color (its natural
 * tint), physical (MeshPhysicalMaterial fields), env (reflection strength on
 * a stage with no environment of its own), and a pattern with its tile in
 * metres, the axis its grain runs along (up: the part's own y; long: its
 * longest side; hang: its most upright side, skipping a slab's thickness),
 * albedo contrast, bump depth in metres, roughness variation and a mask
 * colour (brick mortar).
 */

import { GREY_BOX } from "./object-colors.js";

// How much of what is behind it a clear glass pane covers where the Studio draws it as a plain pane: the flat look's
// picture (stage-finish-surface.js) and the depth plate (render-passes.js) give it the same share.
export const GLASS_PANE_OPACITY = 0.22;

export const MATERIAL_LOOKS = Object.freeze({
	clay: { roughness: 0.82 },
	wood: { roughness: 0.68, color: "#9a6b3f", pattern: "wood", tile: 0.5, grain: "long", contrast: 0.32, bump: 0.0015, roughVar: 0.1 },
	straw: { roughness: 0.88, color: "#c8a85c", pattern: "straw", tile: 0.6, grain: "hang", contrast: 0.5, bump: 0.02, roughVar: 0.08 },
	stone: { roughness: 0.9, color: "#8d8a83", pattern: "stone", tile: 1, contrast: 0.32, bump: 0.008, roughVar: 0.1 },
	brick: { roughness: 0.88, color: "#a5503a", pattern: "brick", tile: 0.5, grain: "hang", contrast: 0.22, bump: 0.008, roughVar: 0.08, mask: "#b9b3a8" },
	concrete: { roughness: 0.92, color: "#a7a49d", pattern: "concrete", tile: 1.2, contrast: 0.2, bump: 0.0015, roughVar: 0.08 },
	metal: { roughness: 0.32, metalness: 1, color: "#c9ccd1", env: 1, pattern: "brushed", tile: 0.4, contrast: 0.06, bump: 0.0001, roughVar: 0.12 },
	glass: { roughness: 0.04, color: "#f2f7f7", env: 1, physical: { transmission: 1, ior: 1.5 } },
	ceramic: { roughness: 0.35, color: "#efece4", env: 0.45, physical: { clearcoat: 1, clearcoatRoughness: 0.06 } },
	plastic: { roughness: 0.3, env: 0.35 },
	rubber: { roughness: 0.92, color: "#2d2d2f", pattern: "stipple", tile: 0.15, contrast: 0.08, bump: 0.0003, roughVar: 0.06 },
	fabric: { roughness: 0.95, pattern: "weave", tile: 0.12, contrast: 0.22, bump: 0.0008, roughVar: 0.05, physical: { sheen: 1, sheenRoughness: 0.6 } },
	paper: { roughness: 0.88, color: "#ebe6da", pattern: "paper", tile: 0.25, contrast: 0.08, bump: 0.0002 },
	foliage: { roughness: 0.62, color: "#4f7d34", pattern: "leaves", tile: 0.6, contrast: 0.45, bump: 0.015, roughVar: 0.15, physical: { sheen: 0.8, sheenRoughness: 0.45 } },
});

export const MATERIAL_PRESETS = Object.freeze(Object.keys(MATERIAL_LOOKS));
/** What a finish sets the roughness to, whatever the preset's own. */
export const FINISH_ROUGHNESS = Object.freeze({ matte: 0.85, satin: 0.45, gloss: 0.12 });
export const MATERIAL_FINISHES = Object.freeze(Object.keys(FINISH_ROUGHNESS));

/** The colour a surface draws in: the authored one, or the preset's own while
 * the authored one is still the blockout grey. */
export function lookTint(color, preset) {
	const own = MATERIAL_LOOKS[preset]?.color;
	return own && (!color || color.toLowerCase() === GREY_BOX) ? own : color ?? GREY_BOX;
}

/** The record renderers that draw a preset (props.jsx Primitive). */
const LOOK_RENDERERS = new Set(["cube", "sphere", "capsule", "cylinder", "cone", "plane"]);
const LOOK_KEYS = [["material", MATERIAL_PRESETS], ["finish", MATERIAL_FINISHES]];

/** The patch keys object.update reads for the look, on the renderers that draw one. */
export const objectMaterialKeys = (renderer) => (LOOK_RENDERERS.has(renderer) ? LOOK_KEYS.map(([key]) => key) : []);

/** The material/finish a normalized record keeps: known names on a primitive,
 * nothing otherwise, so records written before presets come back unchanged. */
export function objectMaterialFields(record, renderer) {
	if (!LOOK_RENDERERS.has(renderer)) return {};
	return Object.fromEntries(LOOK_KEYS.filter(([key, names]) => names.includes(record?.[key])).map(([key]) => [key, record[key]]));
}

/** The material/finish part of an object.update patch: a known name sets it,
 * null removes it (back to the preset default), anything else is ignored. */
export function objectMaterialPatch(object, patch) {
	if (!LOOK_RENDERERS.has(object?.renderer)) return {};
	const update = {};
	for (const [key, names] of LOOK_KEYS) {
		const value = patch?.[key];
		if (value === undefined || (value !== null && !names.includes(value))) continue;
		if ((value ?? undefined) !== object[key]) update[key] = value;
	}
	return update;
}
