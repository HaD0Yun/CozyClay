/**
 * A recipe, or a list of part edits, applied as far as it is valid.
 *
 * normalizeSculptRecipe and patchSculptRecipe refuse the whole call at the
 * first bad value, so one wrong size in a 30-part recipe cost the whole
 * recipe. Here each refused part (or edit) is left out with its reason and the
 * rest is kept; the caller reports every left-out item, so nothing differs
 * from what was asked without the caller being told. Nothing is clamped.
 *
 * Kept atomic: a refusal that no single part causes (the recipe's own keys,
 * the part, item and copy totals) refuses the call as a whole, and so does a
 * call where every part or edit is refused. Pure: no three.js.
 */
import { normalizeSculptRecipe, patchSculptRecipe } from "./sculpt-recipe.js";

/**
 * The index of the refused raw part. A refusal inside one part carries its position (partIndex); only a
 * check across parts (duplicate ids, parents, cutters, repeats) names a part by id alone, `parts[<id>]`.
 * A digit id ("2") is never read as a position.
 */
function refusedPartIndex(result, parts) {
	if (Number.isInteger(result.partIndex)) return result.partIndex < parts.length ? result.partIndex : -1;
	const match = /^parts\[([^\]]*)\]/.exec(result.path ?? "");
	if (!match) return -1;
	const ids = parts.map((part) => (part && typeof part === "object" ? part.id : undefined));
	// A second part with the same id is the one refused; the first stays.
	return / is used twice$/.test(result.error) ? ids.lastIndexOf(match[1]) : ids.indexOf(match[1]);
}

/**
 * Returns `{ ok: true, recipe, skipped }` with `skipped` = [{ id, error, path, example? }] for every part left out,
 * or the usual `{ ok: false, error, path, example?, skipped }` when nothing (or no single part) can be kept;
 * `allRefused: true` marks the case where every part was refused (not a recipe-wide limit).
 */
export function normalizeSculptRecipeKeeping(input) {
	const whole = normalizeSculptRecipe(input);
	if (whole.ok || !Array.isArray(input?.parts)) return { ...whole, skipped: [] };
	let parts = [...input.parts], origin = parts.map((_, index) => index);
	const skipped = [], leftOut = new Set();
	let result = whole;
	for (; !result.ok; result = normalizeSculptRecipe({ ...input, parts })) {
		const at = refusedPartIndex(result, parts);
		if (at < 0) return { ...result, skipped };
		const part = parts[at], id = typeof part?.id === "string" ? part.id : undefined;
		const orphan = typeof part?.parent === "string" && leftOut.has(part.parent) && !parts.some((other) => other?.id === part.parent);
		// A path by position names the part as the caller listed it, not as the shortened list does.
		const own = (text) => String(text).replace(`parts[${at}]`, `parts[${origin[at]}]`);
		const path = result.byPosition ? own(result.path) : result.path, error = result.byPosition ? own(result.error) : result.error;
		skipped.push({ id, path, error: orphan ? `parts[${id}]: left out with its parent ${part.parent}` : error, ...(result.example && !orphan ? { example: result.example } : {}) });
		if (id !== undefined) leftOut.add(id);
		parts = parts.filter((_, index) => index !== at);
		origin = origin.filter((_, index) => index !== at);
		if (!parts.length) return { ...whole, skipped, allRefused: true };
	}
	return { ...result, skipped };
}

const editTarget = (edit) => {
	const key = edit && typeof edit === "object" ? ["set", "remove"].find((name) => typeof edit[name] === "string") : undefined;
	return key ? edit[key] : typeof edit?.add?.id === "string" ? edit.add.id : undefined;
};

/**
 * Edits applied one by one, each against the recipe the earlier ones left; an edit that only works after a
 * later one (a child added before its parent) is tried again after the others, until no more land.
 * Returns `{ ok: true, recipe, changed, skipped }` with `skipped` = [{ index, id, error, path, example? }],
 * or `{ ok: false, ... , skipped }` when no edit lands.
 */
export function patchSculptRecipeKeeping(recipe, edits) {
	const whole = patchSculptRecipe(recipe, edits);
	if (whole.ok || !Array.isArray(edits) || edits.length < 2 || !normalizeSculptRecipe(recipe).ok) return { ...whole, skipped: [] };
	let current = recipe, waiting = edits.map((edit, index) => ({ edit, index }));
	const changed = new Set(), refusals = new Map();
	for (let landed = true; landed && waiting.length; ) {
		landed = false;
		waiting = waiting.filter(({ edit, index }) => {
			const result = patchSculptRecipe(current, [edit]);
			if (!result.ok) {
				refusals.set(index, result);
				return true;
			}
			current = result.recipe;
			result.changed.forEach((id) => changed.add(id));
			landed = true;
			return false;
		});
	}
	const skipped = waiting.map(({ edit, index }) => {
		const result = refusals.get(index), path = String(result.path ?? "").replace(/^edits\[0\]/, `edits[${index}]`);
		return { index, id: editTarget(edit), path, error: String(result.error).replace(/^edits\[0\]/, `edits[${index}]`), ...(result.example ? { example: result.example } : {}) };
	});
	if (skipped.length === edits.length) return { ...whole, skipped, allRefused: true };
	return { ok: true, recipe: current, changed: [...changed], skipped };
}
