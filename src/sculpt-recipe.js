/**
 * Sculpt recipes: a clay prop described as data.
 *
 * A `sculpt` object carries a recipe of soft parts instead of a mesh file, so an
 * agent can build a prop from a reference image without anything it writes
 * being executed. This module is the pure half: it owns the schema, refuses
 * what it cannot draw, expands mirrors and parent chains into object-frame
 * transforms, and measures the standing box. It is importable without three.js
 * so the scene record, the MCP server and the tests all read one truth.
 *
 * A recipe that breaks a rule is REFUSED with the reason, never clamped into a
 * different shape: an agent that asked for a 40 m head should hear why, not
 * see a 20 m one and believe it.
 *
 * Contract: docs/sculpt-from-image.md.
 */

import { RecipeError, forgiveSculptPart, readHexColor, readVector, tidy } from "./sculpt-recipe-read.js";
import { SCULPT_SHAPES, SCULPT_SHAPE_KEYS, SCULPT_SHAPE_SPECS } from "./sculpt-shapes.js";
import { SCULPT_PART_FIELDS } from "./sculpt-part-fields.js";
import { checkSculptCutters } from "./sculpt-cutters.js";
import { checkSculptRepeats, repeatCopies, repeatCount } from "./sculpt-repeat.js";
import { IDENTITY, applyMatrix, composeMatrix, multiply } from "./sculpt-matrix.js";

const SCULPT_RECIPE_VERSION = 1;
export const SCULPT_LIMITS = Object.freeze({
	/** after mirrors are expanded */
	maxParts: 48,
	minExtent: 0.005,
	maxExtent: 20,
	maxOffset: 20,
	maxDepth: 8,
	/** scatter items across the whole recipe, after mirrors */
	maxScatterItems: 12000,
	/** repeat copies across the whole recipe, after mirrors: each copy is real
	 * vertices in one merged mesh, and 256 dense blobs is about 0.8 M of them */
	maxRepeatCopies: 256,
});
const SCULPT_DEFAULT_COLOR = "#c2c6c8";
/** The suffix a mirrored copy's id gets. `.` is outside the id alphabet, so a
 * copy can never collide with an authored part. */
export const SCULPT_MIRROR_SUFFIX = ".mirror";
const MIN_HEIGHT = 0.05;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
export const PART_KEYS = new Set(["id", "shape", "size", "position", "rotation", "color", "parent", "mirror", ...SCULPT_SHAPE_KEYS, ...SCULPT_PART_FIELDS.map((field) => field.key)]);
const wrapDegrees = (deg) => {
	const wrapped = ((((deg + 180) % 360) + 360) % 360) - 180;
	return wrapped === -180 ? 180 : wrapped;
};

const readColor = (value, path) => (value === undefined ? SCULPT_DEFAULT_COLOR : readHexColor(value, path));

function normalizePart(input, index) {
	const raw = forgiveSculptPart(input), at = `parts[${index}]`;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new RecipeError(at, "must be an object");
	for (const key of Object.keys(raw)) {
		if (!PART_KEYS.has(key)) throw new RecipeError(`${at}.${key}`, `unknown key (allowed: ${[...PART_KEYS].join(", ")})`);
	}
	if (typeof raw.id !== "string" || !ID_PATTERN.test(raw.id)) {
		throw new RecipeError(`${at}.id`, `must be 1-40 letters, digits, - and _, starting with a letter or digit; got ${JSON.stringify(raw.id)}`);
	}
	const where = `parts[${raw.id}]`;
	if (!SCULPT_SHAPES.includes(raw.shape)) {
		throw new RecipeError(`${where}.shape`, `must be one of ${SCULPT_SHAPES.join(", ")}; got ${JSON.stringify(raw.shape)}`);
	}
	const spec = SCULPT_SHAPE_SPECS[raw.shape];
	for (const key of SCULPT_SHAPE_KEYS) {
		if (raw[key] !== undefined && !spec.keys.includes(key)) {
			throw new RecipeError(`${where}.${key}`, `does not apply to a ${raw.shape}`);
		}
	}
	const size = readVector(raw.size, `${where}.size`, null, (value, path) => {
		if (value < SCULPT_LIMITS.minExtent || value > SCULPT_LIMITS.maxExtent) {
			throw new RecipeError(path, `extent must be ${SCULPT_LIMITS.minExtent}-${SCULPT_LIMITS.maxExtent} m, got ${value}`);
		}
	});
	const position = readVector(raw.position, `${where}.position`, [0, 0, 0], (value, path) => {
		if (Math.abs(value) > SCULPT_LIMITS.maxOffset) throw new RecipeError(path, `must be within ±${SCULPT_LIMITS.maxOffset} m, got ${value}`);
	});
	const rotation = readVector(raw.rotation, `${where}.rotation`, [0, 0, 0], () => {}).map((deg) => tidy(wrapDegrees(deg)));
	if (raw.parent !== undefined && (typeof raw.parent !== "string" || !raw.parent)) {
		throw new RecipeError(`${where}.parent`, "must be another part's id");
	}
	if (raw.mirror !== undefined && typeof raw.mirror !== "boolean") throw new RecipeError(`${where}.mirror`, "must be true or false");
	const part = {
		id: raw.id,
		shape: raw.shape,
		size,
		position,
		rotation,
		color: readColor(raw.color, `${where}.color`),
	};
	if (raw.parent !== undefined) part.parent = raw.parent;
	if (raw.mirror === true) part.mirror = true;
	// A shape's own refusal brings a valid example of that shape (sculpt-shape-examples.js).
	try { spec.read(raw, part, where); } catch (error) { throw Object.assign(error, { example: error.example ?? raw.shape }); }
	for (const field of SCULPT_PART_FIELDS) if (raw[field.key] !== undefined) field.read(raw, part, where);
	return part;
}

/** Depth of every part in the parent forest, refusing unknown parents and cycles. */
function partDepths(parts) {
	const byId = new Map(parts.map((part) => [part.id, part]));
	const depths = new Map();
	const depthOf = (part, trail) => {
		if (depths.has(part.id)) return depths.get(part.id);
		if (!part.parent) {
			depths.set(part.id, 0);
			return 0;
		}
		const parent = byId.get(part.parent);
		if (!parent) throw new RecipeError(`parts[${part.id}].parent`, `no part named "${part.parent}"`);
		if (trail.has(parent.id)) throw new RecipeError(`parts[${part.id}].parent`, "parents form a cycle");
		const depth = depthOf(parent, new Set([...trail, part.id])) + 1;
		if (depth > SCULPT_LIMITS.maxDepth) throw new RecipeError(`parts[${part.id}].parent`, `parent chain is deeper than ${SCULPT_LIMITS.maxDepth}`);
		depths.set(part.id, depth);
		return depth;
	};
	for (const part of parts) depthOf(part, new Set([part.id]));
	// A mirror inside a mirrored subtree would mint the same `.mirror` id twice.
	for (const part of parts) {
		if (!part.mirror) continue;
		for (let up = byId.get(part.parent); up; up = byId.get(up.parent)) {
			if (up.mirror) throw new RecipeError(`parts[${part.id}].mirror`, `"${up.id}" above it is already mirrored, which copies this part too`);
		}
	}
	return depths;
}

/**
 * The recipe as the record stores it, or the reason it cannot be drawn.
 * Returns `{ ok: true, recipe }` or `{ ok: false, error, path }`; never throws.
 */
export function normalizeSculptRecipe(input) {
	try {
		if (!input || typeof input !== "object" || Array.isArray(input)) throw new RecipeError("recipe", "must be an object with a parts array");
		for (const key of Object.keys(input)) {
			if (key !== "version" && key !== "parts") throw new RecipeError(`recipe.${key}`, "unknown key (allowed: version, parts)");
		}
		if (input.version !== undefined && input.version !== SCULPT_RECIPE_VERSION) {
			throw new RecipeError("recipe.version", `only version ${SCULPT_RECIPE_VERSION} is understood, got ${JSON.stringify(input.version)}`);
		}
		if (!Array.isArray(input.parts) || input.parts.length === 0) throw new RecipeError("recipe.parts", "must be a non-empty array");
		const parts = input.parts.map(normalizePart);
		const seen = new Set();
		for (const part of parts) {
			if (seen.has(part.id)) throw new RecipeError(`parts[${part.id}].id`, "is used twice");
			seen.add(part.id);
		}
		partDepths(parts);
		checkSculptCutters(parts);
		checkSculptRepeats(parts);
		const recipe = { version: SCULPT_RECIPE_VERSION, parts };
		const drawn = expandSculptParts(recipe);
		if (drawn.length > SCULPT_LIMITS.maxParts) {
			throw new RecipeError("recipe.parts", `expands to ${drawn.length} parts with mirrors; the limit is ${SCULPT_LIMITS.maxParts}`);
		}
		// A scatter is one part but many drawn items; the frame rate pays per item.
		const items = drawn.reduce((sum, part) => sum + (part.shape === "scatter" ? part.count : 0), 0);
		if (items > SCULPT_LIMITS.maxScatterItems) {
			throw new RecipeError("recipe.parts", `scatter parts draw ${items} items with mirrors; the limit is ${SCULPT_LIMITS.maxScatterItems}`);
		}
		const copies = drawn.reduce((sum, part) => sum + (part.repeat ? repeatCount(part) : 0), 0);
		if (copies > SCULPT_LIMITS.maxRepeatCopies) {
			throw Object.assign(new RecipeError("recipe.parts", `repeat parts draw ${copies} copies with mirrors; the limit is ${SCULPT_LIMITS.maxRepeatCopies}`), { example: "repeat" });
		}
		return { ok: true, recipe };
	} catch (error) {
		if (error instanceof RecipeError) return { ok: false, error: error.message, path: error.path, ...(error.example ? { example: error.example } : {}) };
		throw error;
	}
}

/**
 * A recipe edited part by part instead of rewritten. `edits` are applied in
 * order: `{ set: id, ...fields }` merges fields into one part (`parent: null`,
 * `mirror: false` and null for an optional field such as `detail` clear),
 * `{ add: part }` appends, `{ remove: id }` drops a
 * part and every part below it. The result is normalized as a whole, so an edit
 * that leaves the recipe undrawable is refused with the usual path.
 * Returns `{ ok: true, recipe, changed: [ids] }` or `{ ok: false, error, path }`.
 */
export function patchSculptRecipe(recipe, edits) {
	const base = normalizeSculptRecipe(recipe);
	if (!base.ok) return base;
	if (!Array.isArray(edits) || edits.length === 0) return { ok: false, error: "edits: must be a non-empty array", path: "edits" };
	const parts = base.recipe.parts.map((part) => ({ ...part }));
	const changed = new Set();
	for (const [index, edit] of edits.entries()) {
		const at = `edits[${index}]`;
		const ops = edit && typeof edit === "object" ? ["set", "add", "remove"].filter((key) => key in edit) : [];
		if (ops.length !== 1) return { ok: false, error: `${at}: must have exactly one of set, add, remove`, path: at };
		if (ops[0] === "add") {
			parts.push(edit.add);
			changed.add(edit.add?.id);
			continue;
		}
		const id = edit[ops[0]];
		const found = parts.findIndex((part) => part.id === id);
		if (found < 0) return { ok: false, error: `${at}.${ops[0]}: no part named ${JSON.stringify(id)}`, path: `${at}.${ops[0]}` };
		if (ops[0] === "remove") {
			const gone = new Set([id]);
			for (let grew = true; grew; ) {
				grew = false;
				for (const part of parts) if (part.parent && gone.has(part.parent) && !gone.has(part.id)) { gone.add(part.id); grew = true; }
			}
			for (let i = parts.length - 1; i >= 0; i -= 1) if (gone.has(parts[i].id)) parts.splice(i, 1);
			gone.forEach((entry) => changed.add(entry));
			continue;
		}
		const { set: _set, ...fields } = edit;
		if ("id" in fields) return { ok: false, error: `${at}.id: rename by remove + add`, path: `${at}.id` };
		const next = { ...parts[found], ...fields };
		if (fields.parent === null) delete next.parent;
		if (fields.mirror === false) delete next.mirror;
		for (const field of SCULPT_PART_FIELDS) if (fields[field.key] === null) delete next[field.key];
		// Shape-specific defaults belong to the old shape, not the new one.
		if ("shape" in fields) for (const key of SCULPT_SHAPE_KEYS) if (!(key in fields)) delete next[key];
		parts[found] = next;
		changed.add(id);
	}
	const normalized = normalizeSculptRecipe({ version: SCULPT_RECIPE_VERSION, parts });
	return normalized.ok ? { ...normalized, changed: [...changed] } : normalized;
}

/** A reflection across x = 0 of the parent frame keeps the part's shape and
 * negates the lateral axis only: position.x flips, and the yaw and roll turn
 * the other way. Shapes symmetric about their own x need nothing more; the
 * others reflect their own data (SCULPT_SHAPE_SPECS[shape].mirror), so no
 * negative scale (and no winding flip) is needed. */
function mirroredPart(part, parentId) {
	const copy = {
		...part,
		id: `${part.id}${SCULPT_MIRROR_SUFFIX}`,
		position: [tidy(-part.position[0]), part.position[1], part.position[2]],
		rotation: [part.rotation[0], tidy(-part.rotation[1]), tidy(-part.rotation[2])],
	};
	delete copy.mirror;
	SCULPT_SHAPE_SPECS[copy.shape].mirror?.(copy);
	if (parentId !== undefined) copy.parent = parentId;
	return copy;
}

/**
 * Every part that will be drawn, in parent-before-child order, with its
 * object-frame `matrix`. A mirrored part brings its whole subtree with it:
 * a pupil on a mirrored eye shows up in both eyes.
 */
export function expandSculptParts(recipe) {
	const parts = recipe.parts;
	const children = new Map();
	for (const part of parts) {
		const key = part.parent ?? "";
		if (!children.has(key)) children.set(key, []);
		children.get(key).push(part);
	}
	const out = [];
	const visit = (part, parentMatrix, idPrefixParent, reflect) => {
		const placed = reflect ? mirroredPart(part, idPrefixParent) : idPrefixParent !== undefined ? { ...part, parent: idPrefixParent } : { ...part };
		const matrix = multiply(parentMatrix, composeMatrix(placed.position, placed.rotation));
		out.push({ ...placed, matrix });
		for (const child of children.get(part.id) ?? []) visit(child, matrix, placed.id, reflect);
		if (part.mirror && !reflect) {
			const mirror = mirroredPart(part, idPrefixParent);
			const mirrorMatrix = multiply(parentMatrix, composeMatrix(mirror.position, mirror.rotation));
			out.push({ ...mirror, matrix: mirrorMatrix });
			for (const child of children.get(part.id) ?? []) visit(child, mirrorMatrix, mirror.id, true);
		}
	};
	for (const root of children.get("") ?? []) visit(root, IDENTITY, undefined, false);
	return out;
}

/** The part's own box, in its local frame, as eight corners. A tapered blob
 * or cylinder never grows past its declared size, so the box stays honest. */
function localCorners(part) {
	const [sx, sy, sz] = part.size.map((value) => value / 2);
	const corners = [];
	for (const x of [-sx, sx]) for (const y of [-sy, sy]) for (const z of [-sz, sz]) corners.push([x, y, z]);
	return corners;
}

/** A drawn part's object-frame axis-aligned box, every repeat copy included. */
export function drawnPartBox(part) {
	const min = [Infinity, Infinity, Infinity];
	const max = [-Infinity, -Infinity, -Infinity];
	for (const copy of repeatCopies(part)) {
		const matrix = multiply(part.matrix, copy);
		for (const corner of localCorners(part)) {
			applyMatrix(matrix, corner).forEach((value, axis) => {
				min[axis] = Math.min(min[axis], value);
				max[axis] = Math.max(max[axis], value);
			});
		}
	}
	return { min, max };
}

/** A cutter (op) is not drawn and only takes from its parent, so it never widens the box. */
export function sculptBounds(recipe) {
	const boxes = expandSculptParts(recipe).filter((drawn) => !drawn.op).map(drawnPartBox);
	const min = [0, 1, 2].map((axis) => Math.min(...boxes.map((box) => box.min[axis])));
	const max = [0, 1, 2].map((axis) => Math.max(...boxes.map((box) => box.max[axis])));
	return { min: min.map(tidy), max: max.map(tidy) };
}

/**
 * The standing box the scene record stores: a footprint centred on the object
 * origin (the plan board and the blockers assume a centred rectangle, so an
 * off-centre recipe gets the conservative box that contains it) and the
 * height of the highest point above the floor.
 */
export function sculptStandingBox(recipe) {
	const { min, max } = sculptBounds(recipe);
	return {
		footprint: {
			width: tidy(Math.max(SCULPT_LIMITS.minExtent, 2 * Math.max(Math.abs(min[0]), Math.abs(max[0])))),
			depth: tidy(Math.max(SCULPT_LIMITS.minExtent, 2 * Math.max(Math.abs(min[2]), Math.abs(max[2])))),
		},
		height: tidy(Math.max(MIN_HEIGHT, max[1])),
	};
}
