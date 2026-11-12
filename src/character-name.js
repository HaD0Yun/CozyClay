// A character's display name (#1212). `subject` is the user's description of
// who the character is; when they never wrote one, the character is named from
// its body (CHARACTER_MODEL_LABELS) plus a suffix from its own id, so the name
// is unique within the cast and does not shift when others come and go. The
// agent's scene context and its name resolver both read this one function.
import { ko } from "./locale.js";

// The body labels live here, not in stage-startup-defaults.js (which imports three), so Node-side
// callers such as the MCP handlers can name a character without loading the stage.
export const CHARACTER_MODEL_LABELS = { "y-bot-tpose": "Y Bot", "x-bot-tpose": "X Bot" };
CHARACTER_MODEL_LABELS["proxy-figure"] = ko("Capsule figure", "캡슐 인물");

/** The display name of one cast row: its subject, else "<model label> <id suffix>". */
export function characterName(character) {
	const subject = typeof character?.subject === "string" ? character.subject.trim() : "";
	if (subject) return subject;
	const id = typeof character?.id === "string" ? character.id : "";
	const label = CHARACTER_MODEL_LABELS[character?.model] ?? character?.rigImport?.name ?? "Character";
	// char-3 -> "3", char-a -> "a", character-mf2k-4 -> "mf2k-4"; any other id (actor-a) is kept whole.
	return `${label} ${id.replace(/^(char|character)-/, "")}`.trim();
}

/** Prompt text for a character's description: its subject, else a neutral phrase.
 * The phrase exists only in prompts; it is never stored or used as a name. */
export const promptDescription = (subject) => (typeof subject === "string" && subject.trim() ? subject : "a person");
