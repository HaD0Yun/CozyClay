// Motion compile computes for the body at scale 1. An action that compiles (motion.compile, and motion.qa, motion.report,
// motion.keyObject, which compile the installed take's spec again) is refused on a scaled character, saying what that
// action does; reading the take's bones (motion.sample) is not compiling and reads at the character's own place and scale.
// A raw track (motion.v4.install) has no spec to compile: the reads that measure by compiling say so at any scale.
import { fail } from "./shared.js";
import { characterName } from "../character-name.js";

const SAMPLE = "motion.sample reads the take's bones at the character's place and scale.";
const scaled = character => Math.abs((character.scale ?? 1) - 1) > 1e-6;

/** Throws TARGET_NOT_READY when the character's scale is not 1; action names an action that compiles the installed take again and installs the result. */
export function unitScale(character, action = null) {
	if (!scaled(character)) return;
	fail("TARGET_NOT_READY", action ? `${action} compiles the installed take's spec again, which motion compile does only for a body at scale 1; ${characterName(character)}'s scale is ${character.scale}.`
		: "Set the character's scale back to 1 before compiling motion.");
}

/** Throws TARGET_NOT_READY when `action` (a read that measures by compiling the installed take's spec again) cannot measure this body's take. */
export function measurable(character, take, action) {
	if (take.spec?.raw) fail("TARGET_NOT_READY", `${action} measures a take by compiling its motion spec again; ${characterName(character)}'s take was installed as a raw track and has no spec to compile, at any scale. ${SAMPLE}`);
	if (scaled(character)) fail("TARGET_NOT_READY", `${action} measures a take by compiling its motion spec again, for the body at scale 1; ${characterName(character)} is at scale ${character.scale}, so that would not measure the body as it is. ${SAMPLE}`);
}
