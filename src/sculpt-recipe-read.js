/**
 * Readers shared by the sculpt recipe modules (sculpt-recipe.js, sculpt-shapes.js,
 * sculpt-part-fields.js). Each one refuses a bad value with the field's path
 * instead of clamping it. Pure: no three.js.
 */

export const tidy = (value) => {
	const rounded = Math.round(value * 1e4) / 1e4;
	return rounded === 0 ? 0 : rounded;
};
export const isFiniteNumber = (value) => typeof value === "number" && Number.isFinite(value);

export class RecipeError extends Error {
	constructor(path, message) {
		super(`${path}: ${message}`);
		this.path = path;
	}
}

export function readVector(value, path, fallback, check) {
	if (value === undefined && fallback) return [...fallback];
	if (!Array.isArray(value) || value.length !== 3 || !value.every(isFiniteNumber)) {
		throw new RecipeError(path, `must be three numbers [x, y, z], got ${JSON.stringify(value)}`);
	}
	value.forEach((component, axis) => check(component, `${path}[${axis}]`));
	return value.map(tidy);
}

export function readUnit(value, path, fallback, min, max) {
	if (value === undefined) return fallback;
	if (!isFiniteNumber(value) || value < min || value > max) {
		throw new RecipeError(path, `must be a number from ${min} to ${max}, got ${JSON.stringify(value)}`);
	}
	return tidy(value);
}

export function readInteger(value, path, fallback, min, max) {
	if (value === undefined && fallback !== undefined) return fallback;
	if (!Number.isInteger(value) || value < min || value > max) {
		throw new RecipeError(path, `must be a whole number from ${min} to ${max}, got ${JSON.stringify(value)}`);
	}
	return value;
}

/** A pattern seed (detail bumps, scatter layout): 0 unless the recipe picks another. */
export const readSeed = (value, path) => readInteger(value, path, 0, 0, 999999);

export function readChoice(value, path, fallback, choices) {
	if (value === undefined && fallback !== undefined) return fallback;
	if (!choices.includes(value)) throw new RecipeError(path, `must be one of ${choices.join(", ")}; got ${JSON.stringify(value)}`);
	return value;
}

const HEX_SHORT = /^#?([0-9a-f]{3})$/i;
const HEX_LONG = /^#?([0-9a-f]{6})$/i;

/** `#rgb` or `#rrggbb` (the `#` optional), as lower-case `#rrggbb`. */
export function readHexColor(value, path) {
	const text = typeof value === "string" ? value.trim() : "";
	const short = HEX_SHORT.exec(text);
	if (short) return `#${short[1].toLowerCase().replace(/./g, (digit) => digit + digit)}`;
	const long = HEX_LONG.exec(text);
	if (long) return `#${long[1].toLowerCase()}`;
	throw new RecipeError(path, `colour must be #rgb or #rrggbb, got ${JSON.stringify(value)}`);
}

// Slips with one obvious reading are read that way, not refused: a refusal costs the model the whole recipe again
// (measured: 24 refusals in 14 runs, of which camelCase ids 9, detail.scale 4, sphere or cone 3).
const SHAPE_ALIASES = { sphere: ["blob", { roundness: 0 }], ball: ["blob", { roundness: 0 }], ellipsoid: ["blob", { roundness: 0 }], cone: ["cylinder", { taper: 1 }], cube: ["box", {}], cuboid: ["box", {}] };
export function forgiveSculptPart(raw) {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
	const alias = Object.hasOwn(SHAPE_ALIASES, raw.shape) ? SHAPE_ALIASES[raw.shape] : null;
	const part = alias ? { ...alias[1], ...raw, shape: alias[0] } : raw, scale = part.detail?.scale;
	return isFiniteNumber(scale) && (scale < 1 || scale > 12) ? { ...part, detail: { ...part.detail, scale: Math.min(12, Math.max(1, scale)) } } : part;
}
