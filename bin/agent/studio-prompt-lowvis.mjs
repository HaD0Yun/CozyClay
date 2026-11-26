// The Studio agent's prompt under the lowvis engine: the animation-mode prompt (studio-prompt.mjs) without its guidance
// for the old motion engine, plus one paragraph on the motion tool (motion-door.mjs). The old prompt stays as it is,
// so the old engine comes back byte for byte (studio-motion-reference.mjs studioSystemPrompt).
// Each cut is named by its first and last words in the old text; a cut whose words are not found throws, so a change
// to the old text that moves them is caught at the first lowvis turn instead of leaving old guidance in.

// [from, through]: removed together with the space after them
const CUTS = [
	["A route's marks can carry", "never duplicate it."],
	["For a held prop use object.createKit", "never key its wrist."],
];
// [from, through, replacement]: the capsule figure and the cast-style gate give way to one line on people
const PEOPLE_LINE = "People are rig figures: rig characters of model x-bot-tpose. Their body motion comes from the motion tool.";
const LINES = [
	// the old engine's guidance goes; its one general sentence on calls stays
	["Motion is computed, not generated:", "Report qa.blocking, not qa.total, the goals and output.fixed. ", "Make independent calls in the same turn. "],
	["In the context, an entity with characterKind \"proxy\"", "(yes = capsules, no = keep the rig)\"", PEOPLE_LINE],
	[" In a hybrid project run the cast gate", "before step 2 places anyone.", ""],
	// the motion tool places what the body uses (MOTION_TOOL_PARAGRAPH), and its report is the check of the motion
	["2. Staging first: place and face the cast", "before any camera.", "2. Staging first, before any camera: the motion tool places the rig characters that move and the objects their bodies use; place the rest of the cast and the set around them."],
	["verify_result checks placement, framing and motion", "and motion", "verify_result checks placement and framing"],
];
export const MOTION_TOOL_PARAGRAPH = "Body motion of rig characters is made by the motion tool, not by you. When the user asks for body motion, call motion { request } first, before you build or change the set. The user's message of this turn reaches the tool by itself, as typed; request is your own note: which body, which objects, what to keep. The tool reads the scene and uses the characters and objects in it. It adds the characters and the objects the body touches, stands on, sits on, holds or moves that the scene lacks, each a plain stand-in at the place, size and turn the motion was written against: a box is a sculpt of one box, a ball or a box under 0.05 m tall is a sphere or a cube. A stand-in is only ever such a plain solid, never an effect, a light or an object of another kind, so never report one as such. An effect, a light or any other object that should move with a body or a prop must be in the scene when you call: make it first and name it in request; the tool moves that object itself, keeping its kind, and the result's carried names it. An object one bone of a body carries through the whole motion is attached to that bone instead of following a track, so it stays on the body under a timing edit or a new scale; the result's attached names each with its bone, and object.detach takes one off. One that other objects are grouped under keeps its track, which they go with. It installs the characters' takes and moves the objects it handles; its result names in used the objects the motion uses and the floor the bodies cross. Set images: true when the user attached pictures of the pose, action or place. One call covers every character that acts in the same stretch of time. When it answers started, the motion is written while you go on: until it is installed, a change to a character or object it is written against is refused. Once the motion writer has built its first clip, its stand-ins are in the scene and motion_result answers a draft; the motion is still being rewritten and is not installed, and the next motion_result answers the installed result. Give a stand-in its look in place with object.sculpt { id, recipe } (same id; the recipe's floor is y = 0 and its footprint is centred on the object), keeping where the body meets it: a drawn part at each of its contacts (against a carrying body part's drawn box, not in it), the box's flat top at its height, no footprint over the floor the feet use; a draft's stand-in takes its look before the install too. At the install a stand-in keeps the look you gave it and is set to the final motion's place and turn, unless you tilted it or attached it to a body; the result's propsSet says per object what the install changed since the draft, its motionFit names each object changed or added meanwhile that differs where the body goes, in metres, and its gaps each contact the drawn look misses. Place what stands at the objects the motion uses, and the camera, from where the result puts the bodies and those objects. Do not move, resize, turn or remove an object the motion uses. An edit of such an object answers motionFit: the differences between the object and the box the motion used where the body meets it, and its gaps; fit the look there. The report and its Missing line are the check of the motion: tell the user what was made and repeat what is Missing without softening it; do not check the body motion again with verify_result. A change to a motion is another call whose note says what to change and keep; it starts from the dressed scene. Do not pose, key or path a rig character's body yourself.";
// shown when no sign-in can run the motion writer (motion-writer.mjs writerRoute): the session's tools are fixed then
export const NO_MOTION_PARAGRAPH = "Body motion of rig characters is not available in this session: no model sign-in of the Studio can run the motion writer. When it is asked for, say so, and tell the user to sign in to a model provider in the model picker and then start a new conversation.";

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
