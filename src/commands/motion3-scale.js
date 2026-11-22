// Motion compile computes for the body at scale 1. An action that compiles (motion.compile, and motion.qa, motion.report,
// motion.keyObject, which compile the installed take's spec again) is refused on a scaled character, saying what that
// action does; reading the drawn bones (motion.sample) is not compiling and reads at the character's own scale.
import { fail } from "./shared.js";
import { characterName } from "../character-name.js";

/** Throws TARGET_NOT_READY when the character's scale is not 1; action names an action that compiles the installed take again. */
export function unitScale(character, action = null) {
	const s = character.scale ?? 1;
	if (Math.abs(s - 1) <= 1e-6) return;
	fail("TARGET_NOT_READY", action ? `${action} compiles the installed take's spec again, which motion compile does only for a body at scale 1; ${characterName(character)}'s scale is ${s}. motion.sample reads its bones as drawn, at that scale.`
		: "Set the character's scale back to 1 before compiling motion.");
}
