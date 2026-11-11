/**
 * `repeat` on a sculpt part: `count` copies of the part laid out by rule, so
 * eight spokes, a row of pickets or a spiral stair cost ONE part. Copy k is
 * the part moved by k × step, then turned k × turn about `pivot` (all in the
 * part's parent frame), then nudged by its seeded `jitter`. The copies are
 * merged into the part's one geometry (sculpt-geometry.js), so a repeated
 * part counts once toward maxParts, the way a scatter does; the whole
 * recipe's copies are capped by SCULPT_LIMITS.maxRepeatCopies instead.
 *
 * Refused, never clamped: a repeat on a scatter (already instanced) or on a
 * cutter (op), and a repeated part that carries parts, since a child would
 * have to pick one copy to ride. Pure: no three.js.
 */
import { RecipeError, readInteger, readSeed, readUnit, readVector } from "./sculpt-recipe-read.js";
import { IDENTITY, composeMatrix, invertRigid, multiply, reflectX } from "./sculpt-matrix.js";
import { isMirrorCopy, partSeed, seededRandom } from "./sculpt-noise.js";

const KEYS = ["count", "step", "turn", "pivot", "jitter"];
const JITTER_KEYS = ["position", "rotation", "scale", "seed"];
const MAX_STEP = 5;
const MAX_PIVOT = 20;
const JITTER_RANGES = { position: [0, 0.5], rotation: [0, 180], scale: [0, 0.5] };

/** A refusal under `repeat`; it brings the repeat example with it (sculpt-shape-examples.js). */
function refuse(path, message) {
	throw Object.assign(new RecipeError(path, message), { example: "repeat" });
}

function readObject(value, path, keys) {
	if (!value || typeof value !== "object" || Array.isArray(value)) refuse(path, `must be an object { ${keys.join(", ")} }, got ${JSON.stringify(value)}`);
	for (const key of Object.keys(value)) if (!keys.includes(key)) refuse(`${path}.${key}`, `unknown key (allowed: ${keys.join(", ")})`);
}

/** Retags a plain reader's refusal so it carries the repeat example too. */
function tagged(read) {
	try {
		return read();
	} catch (error) {
		if (error instanceof RecipeError) error.example = "repeat";
		throw error;
	}
}

const readRange = (max, unit) => (value, path) => {
	if (Math.abs(value) > max) refuse(path, `must be within ±${max}${unit}, got ${value}`);
};

export const SCULPT_REPEAT_FIELD = Object.freeze({
	key: "repeat",
	read(raw, part, where) {
		const at = `${where}.repeat`;
		const value = raw.repeat;
		if (value === null) return;
		readObject(value, at, KEYS);
		if (part.shape === "scatter") refuse(at, "does not apply to a scatter: raise its count instead");
		const repeat = tagged(() => ({ count: readInteger(value.count, `${at}.count`, undefined, 2, 64) }));
		for (const [key, max, unit] of [["step", MAX_STEP, " m"], ["turn", 360, " degrees"], ["pivot", MAX_PIVOT, " m"]]) {
			if (value[key] !== undefined) repeat[key] = tagged(() => readVector(value[key], `${at}.${key}`, null, readRange(max, unit)));
		}
		if (value.jitter !== undefined) {
			readObject(value.jitter, `${at}.jitter`, JITTER_KEYS);
			const jitter = {};
			for (const [key, [lo, hi]] of Object.entries(JITTER_RANGES)) {
				if (value.jitter[key] !== undefined) jitter[key] = tagged(() => readUnit(value.jitter[key], `${at}.jitter.${key}`, 0, lo, hi));
			}
			if (value.jitter.seed !== undefined) jitter.seed = tagged(() => readSeed(value.jitter.seed, `${at}.jitter.seed`));
			repeat.jitter = jitter;
		}
		const moves = [repeat.step, repeat.turn].some((vector) => vector?.some((component) => component !== 0)) || repeat.jitter?.position > 0;
		if (!moves) refuse(at, "needs a non-zero step [x,y,z] m or turn [x,y,z] degrees (or jitter.position), or every copy sits on the first");
		part.repeat = repeat;
	},
});

/** Refuses repeat on a cutter and on a part that carries parts. Run it once parents resolve. */
export function checkSculptRepeats(parts) {
	const repeated = new Set(parts.filter((part) => part.repeat).map((part) => part.id));
	for (const part of parts) {
		if (part.repeat && part.op) refuse(`parts[${part.id}].repeat`, "a cutter (op) cannot repeat; give each opening its own cutter");
		if (repeated.has(part.parent)) refuse(`parts[${part.parent}].repeat`, `a repeated part cannot carry parts ("${part.id}" names it as parent); make the child a sibling with its own repeat`);
	}
}

/** A copy count, 1 for a part without repeat. */
export const repeatCount = (part) => part.repeat?.count ?? 1;

/**
 * The part's copies as matrices in its OWN frame (the frame its mesh is drawn
 * in), first copy first: [IDENTITY] without repeat. `part` is a drawn part
 * from expandSculptParts; a mirrored copy's copies are its source's copies
 * seen in the mirror (the same jitter, reflected), because the seed ignores
 * the `.mirror` suffix and the layout is reflected across x = 0.
 */
export function repeatCopies(part) {
	const repeat = part.repeat;
	if (!repeat) return [IDENTITY];
	const local = composeMatrix(part.position, part.rotation);
	const toLocal = invertRigid(local);
	const step = repeat.step ?? [0, 0, 0], turn = composeMatrix([0, 0, 0], repeat.turn ?? [0, 0, 0]), pivot = repeat.pivot ?? [0, 0, 0];
	const jitter = repeat.jitter ?? {};
	const random = seededRandom(partSeed(part, (jitter.seed ?? 0) + 7));
	const spread = (amount) => (random() * 2 - 1) * (amount ?? 0);
	const around = (matrix) => multiply(composeMatrix(pivot, [0, 0, 0]), multiply(matrix, composeMatrix(pivot.map((v) => -v), [0, 0, 0])));
	const copies = [];
	let spin = IDENTITY;
	for (let k = 0; k < repeat.count; k += 1) {
		const shift = step.map((value) => k * value + spread(jitter.position));
		let placed = multiply(around(spin), composeMatrix(shift, [0, 0, 0]));
		let own = composeMatrix([0, 0, 0], [spread(jitter.rotation), spread(jitter.rotation), spread(jitter.rotation)], 1 + spread(jitter.scale));
		if (isMirrorCopy(part)) {
			placed = reflectX(placed);
			own = reflectX(own);
		}
		copies.push(multiply(toLocal, multiply(placed, multiply(local, own))));
		spin = multiply(spin, turn);
	}
	return copies;
}
