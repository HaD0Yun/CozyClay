// The motion reference every first spec needs, motion.describe essentials and goals, appended to the Studio
// animation prompt so it rides the cached prompt prefix instead of costing model round trips (in 66 audited
// agent sessions 66 read essentials and 52 read goals by tool before their first compile). describe() is
// deterministic, so the block is byte-identical in every request and session and the cache keeps it.
// Lazy: the describe graph loads three, which the package-isolated start of bin/cozyclay.mjs does not have.
export const MOTION_REFERENCE_TOPICS = ["essentials", "goals"];

let reference;

/** The <motion-reference> block: one describe answer per line, in MOTION_REFERENCE_TOPICS order. */
export async function motionReference() {
	if (reference === undefined) {
		const { describe } = await import("../../src/motion3/describe.js");
		reference = `<motion-reference>\n${MOTION_REFERENCE_TOPICS.map(topic => JSON.stringify(describe(topic))).join("\n")}\n</motion-reference>`;
	}
	return reference;
}

/**
 * The Studio animation-mode system prompt.
 * engine "old": the rules and procedure, then the motion reference. engine "lowvis" (studio-prompt-lowvis.mjs): the
 * same without the old motion guidance and without the reference, then the motion tool's paragraph when motion is true
 * (the session has the motion tool) or the sentence that body motion is not available.
 */
export async function studioSystemPrompt({ engine = "old", motion = false } = {}) {
	const { STUDIO_SYSTEM_PROMPT } = await import("./studio-prompt.mjs");
	if (engine === "lowvis") return (await import("./studio-prompt-lowvis.mjs")).lowvisStudioPrompt(STUDIO_SYSTEM_PROMPT, { motion });
	return `${STUDIO_SYSTEM_PROMPT}\n\n${await motionReference()}`;
}
