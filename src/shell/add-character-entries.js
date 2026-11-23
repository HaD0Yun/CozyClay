// Add > Character offers both bodies in every project (ViewportToolbar). The
// project's cast style only decides which one comes first: never hide either.
import { ko } from "../locale.js";
import { NEW_CHARACTER_MODEL, PROXY_FIGURE_MODEL } from "../scenes.js";
import { CHARACTER_MODEL_LABELS } from "../character-name.js";

const ENTRIES = Object.freeze([
	Object.freeze({ add: "character", model: NEW_CHARACTER_MODEL, label: () => CHARACTER_MODEL_LABELS[NEW_CHARACTER_MODEL] }),
	Object.freeze({ add: "capsule", model: PROXY_FIGURE_MODEL, label: () => ko("Capsule figure", "캡슐 인물") }),
]);

export function addCharacterEntries(castStyle) {
	return castStyle === "capsule" ? [ENTRIES[1], ENTRIES[0]] : ENTRIES;
}
