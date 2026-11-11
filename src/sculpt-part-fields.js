/**
 * Optional sculpt part fields that any shape takes (its look, its surface
 * detail). Each entry is { key, read(raw, part, where) }: `read` runs only
 * when raw[key] is present, refuses a bad value with RecipeError
 * (sculpt-recipe-read.js) and writes the normalized value onto the part.
 * An edit that sets a field to null clears it. Pure: no three.js.
 */
import { SCULPT_OP_FIELD } from "./sculpt-cutters.js";
import { SURFACE_FIELDS } from "./sculpt-surface-fields.js";
import { RecipeError } from "./sculpt-recipe-read.js";
import { SCULPT_REPEAT_FIELD } from "./sculpt-repeat.js";
import { MATERIAL_FINISHES, MATERIAL_PRESETS } from "./material-presets.js";

/** A name from `names`; null clears the field (back to the default look),
 * which is how an edit `{ set: id, material: null }` undoes a preset. */
const readName = (key, names) => (raw, part, where) => {
	if (raw[key] === null) return;
	if (!names.includes(raw[key])) throw new RecipeError(`${where}.${key}`, `must be one of ${names.join(", ")}; got ${JSON.stringify(raw[key])}`);
	part[key] = raw[key];
};

export const SCULPT_PART_FIELDS = Object.freeze([
	// Surface presets (material-presets.js); color stays the tint.
	{ key: "material", read: readName("material", MATERIAL_PRESETS) },
	{ key: "finish", read: readName("finish", MATERIAL_FINISHES) },
	...SURFACE_FIELDS,
	SCULPT_REPEAT_FIELD,
	SCULPT_OP_FIELD,
]);
