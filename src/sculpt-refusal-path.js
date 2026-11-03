// The object.sculpt refusal path studio:refused carries (command-bus-telemetry.js, #1042).
import { PART_KEYS } from "./sculpt-recipe.js";

const RECIPE_PATH_WORDS = new Set(["recipe", "parts", "edits", "set", "add", "remove", "version", ...PART_KEYS]);
/**
 * A refused recipe's path (normalizeSculptRecipe / patchSculptRecipe `path`) as an object.sculpt argument path for
 * telemetry (#1042): part ids and indices fold to [], and the path stops before the first word a recipe does not
 * declare (an unknown key the caller made up). "parts[eye].size[1]" -> "$.args.recipe.parts[].size[]".
 */
export function sculptRefusalPath(path) {
	const steps = String(path ?? "").replace(/\[[^\]]*\]/g, "[]").split(".");
	const kept = [];
	for (const step of steps) {
		const word = step.replace(/(\[\])+$/, "");
		if (!RECIPE_PATH_WORDS.has(word)) break;
		kept.push(step);
	}
	if (!kept.length) return "$.args";
	const head = kept[0].replace(/(\[\])+$/, "");
	return `$.args.${head === "parts" ? "recipe." : ""}${kept.join(".")}`;
}
