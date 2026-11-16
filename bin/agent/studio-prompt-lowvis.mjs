// The Studio agent's prompt under the lowvis engine: the animation-mode prompt (studio-prompt.mjs) without its guidance
// for the old motion engine, plus one paragraph on the motion tool (motion-door.mjs). The old prompt stays as it is,
// so the old engine comes back byte for byte (studio-motion-reference.mjs studioSystemPrompt).
// Each cut is named by its first and last words in the old text; a cut whose words are not found throws, so a change
// to the old text that moves them is caught at the first lowvis turn instead of leaving old guidance in.

// [from, through]: removed together with the space after them
const CUTS = [
	["Motion is computed, not generated:", "Report qa.blocking, not qa.total, the goals and output.fixed."],
	["A route's marks can carry", "never duplicate it."],
	["For a held prop use object.createKit", "never key its wrist."],
];
// [from, through, replacement]: lines of the cast-style gate
const LINES = [
	["- rig: cast only X Bot or Y Bot", "keep the rig.", "- rig: cast only the block figure (model x-bot-tpose)."],
	["- hybrid: the cast gate decides", "Ask once per shot.", "- hybrid: rig characters move through the motion tool; capsule figures are placed and moved as before."],
	["\nProposal: \"This shot needs", "(yes = capsules, no = keep the rig)\"", ""],
];
export const MOTION_TOOL_PARAGRAPH = "Body motion of rig characters is made by the motion tool, not by you. Call motion { request } once the set and the characters the motion needs exist. The user's message of this turn reaches the tool by itself, as typed; request is your own note: which body, which objects, what to keep. The tool reads the scene, writes the motion, installs the characters' takes and moves the objects it handles; outside a task it may add a character or a plain box when the scene lacks one. Set images: true when the user attached pictures of the pose, action or place. One call covers every character that acts in the same stretch of time. Its answer is a report with a Missing line: tell the user what was made and repeat what is Missing without softening it. A change to a motion is another call whose note says what to change and keep. Do not pose, key or path a rig character's body yourself.";
export const NO_MOTION_PARAGRAPH = "Body motion of rig characters is not available in this session: say so when it is asked for.";

function cut(text, from, through, replacement, trailingSpace) {
	const start = text.indexOf(from), end = start < 0 ? -1 : text.indexOf(through, start);
	if (start < 0 || end < 0) throw new Error(`studio-prompt-lowvis: the old prompt no longer has "${start < 0 ? from : through}"`);
	let stop = end + through.length;
	if (trailingSpace && text[stop] === " ") stop += 1;
	return text.slice(0, start) + replacement + text.slice(stop);
}

/** The lowvis engine's Studio prompt from the old one: the cuts, the gate lines, then the motion paragraph. */
export function lowvisStudioPrompt(oldText, { motion }) {
	let text = oldText;
	for (const [from, through] of CUTS) text = cut(text, from, through, "", true);
	for (const [from, through, replacement] of LINES) text = cut(text, from, through, replacement, false);
	return `${text}\n\n${motion ? MOTION_TOOL_PARAGRAPH : NO_MOTION_PARAGRAPH}`;
}
