// The studio's generation prompt describes every visible character (#1213).
// This maps the cast to composePrompt's `subjects` list. It imports nothing
// that loads three, so Node tests can call it directly.
import { promptDescription } from "./character-name.js";
import { DEFAULT_POSE } from "./poses.js";

const promptSubject = (character) => ({
	description: promptDescription(character?.subject),
	posePhrase: (character?.pose ?? DEFAULT_POSE).prompt ?? "",
});

/** One { description, posePhrase } per visible character, in cast order. With no
 * visible character the list is `fallback` alone (the first cast member, or its
 * placeholder), which is what the prompt described before the cast was a list. */
export function promptSubjects(characters, fallback) {
	const visible = characters.filter((character) => character.hidden !== true);
	return (visible.length ? visible : [fallback]).map(promptSubject);
}
