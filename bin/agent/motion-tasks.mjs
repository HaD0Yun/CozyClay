// Motion tasks (parallel Studio tasks with the v4 motion engine, #1138). In task mode the coordinator splits a request by
// kind: building (objects, characters, props, placement, camera, lights) stays an ordinary task on the Studio engine,
// and the body motion of a rig character is a motion task, which runs the v4 tools and prompt on the pi loop
// (v4/pi-turn.mjs) inside the same task transaction as any task. This file is what the split adds: the dispatch
// field, the coordinator's rules, the character a motion task animates and the header its run reads.
// The coordinator designs the motion before it dispatches it (motion-design.mjs, rule M10): a motion dispatch names
// the design, and the motion task reads it after its instructions.
// All of it is used only while the motion engine is available (v4/models.mjs motionTaskModel): without it the
// coordinator's prompt and tools are the ones of main-prompt.mjs and main-agent.mjs, unchanged.

/** The `motion` field of dispatch_task and of a dispatch_plan step. */
export const MOTION_FIELD = Object.freeze({ type: "object", additionalProperties: false, required: ["designId"],
	description: "Makes this a motion task (rules M1-M10): the motion engine animates ONE rig character's body and nothing else. designId: the design of this motion, from design_motion (call it first). characterId: the rig character to animate; leave it out when a step this one dependsOn creates the character.",
	properties: { designId: { type: "string", maxLength: 40, description: "the id design_motion answered for this motion" },
		characterId: { type: "string", maxLength: 120, description: "an existing rig character's id (read it with inspect_studio)" } } });

/** A motion task's scope may be empty: its character is added when it starts. */
export const MOTION_SCOPE_HELP = " A motion task's scope is its character and is added for you: send [] unless it needs more.";

const MOTION_RULES = `Motion tasks (the motion engine is on; where these differ from rules 2, 3 and 8, these win):
M1. The body motion of a rig character (context characterKind "rig": walking, jumping, climbing, swinging a tool, lifting, sitting down, falling, any take) is always a motion task: design it first (M10), then dispatch it with motion: { designId, characterId }. It runs on the motion engine, which animates that ONE character frame by frame, measures the result and looks at its own renders. Never put a rig character's body motion in an ordinary task.
M2. A motion task changes nothing but that character's take and, inside the take, the poses of scene objects the character handles (a box it lifts, an axe it swings). It cannot create, place, scale, attach or delete anything, and it does not touch the camera, the lights or the timeline. So everything the motion needs exists before it starts: split the request into building and moving.
M3. Building is ordinary task work: the character standing where the action starts and facing it (at scale 1), the props, the set. A prop the motion handles is a free scene object placed where the character holds or reaches it (an axe at her hands, a box on the table within reach). Tell the build task NOT to attach that prop to the character and to make no motion and no action pose: the motion task grips the prop and moves it.
M4. Send building and moving as ONE dispatch_plan in which the motion step dependsOn the build step. When the character exists already, name it: motion: { designId, characterId }. When the build step creates it, send motion: { designId } and the motion task takes the rig character that step made; when a plan creates several rig characters, dispatch their motion tasks after the build is done, naming each id from its done event. A motion task's scope is its character and is added for you: send scope [].
M5. One motion task animates one character. Characters that do not touch each other get one motion task each. Motion in which two characters touch or hit each other stays ONE ordinary task (rule 3): the engine does not see another character's motion.
M6. A capsule figure (context characterKind "proxy") has no skeleton: its poses are ordinary task work, never a motion task. When the user wants real body motion and the character is, or would be, a capsule figure, ask whether to use a rig character before you dispatch. The engine animates the standard rig bodies (Y Bot, X Bot): when a motion task fails saying its character is not one, make that motion in an ordinary task.
M7. Write a motion task's instructions as in rule 7: the user's words quoted, then the scene facts it needs (the character, which object is what and where it is, where the contact is, which hand or foot if the user said), then "Visible criteria:". Leave out frame counts, QA rules and stop rules: how the person moves is in the design (M10), and the engine turns it into poses and checks the motion itself. Rule 8 is about motion an ordinary task makes (M5, M6), never about a motion task.
M8. A motion task usually takes 5 to 25 minutes. Say so once when you dispatch it, and never cancel it for being slow.
M9. A camera or shot that frames the motion is an ordinary task that dependsOn the motion task. A change to a motion still being made ("the left hand higher") is steer_task. After the motion task ended, a change is a new motion task for that character with a design of its own, and it builds the take again: say in its instructions what to keep.
M10. Design before you dispatch. For every motion task, first call design_motion: picture a real person doing exactly this action in this scene, and write how they do it. Where they stand and face and how they hold things; the action as phases in time order with how long each takes; in every phase what the body does from the ground up (feet and legs, hips, spine, shoulders, arms and hands, head and eyes), where the weight is and what touches what; where the force comes from; the rhythm; what the viewer must read and what would look fake. Read the scene first (inspect_studio) and use its real ids, sizes and distances; when the build step has not made the things yet, design from what you tell that step to make. design_motion answers a designId: pass it as motion.designId, and the motion task receives the design. A motion dispatch without a design is refused. When you tell the user what you started, say the design in three to five short lines.`;

// Rule 8 of the plain prompt calls an ordinary task that makes motion "a motion task": with the engine on, that name is the engine's.
const RULE_8 = "8. A motion task is done at its first take", RULE_8_ORDINARY = "8. Motion that an ordinary task makes is done at its first take";

/** The coordinator's system prompt with the motion rules after it (and rule 8 named for the ordinary tasks it is about). */
export const motionMainPrompt = base => `${base.replace(RULE_8, RULE_8_ORDINARY)}\n\n${MOTION_RULES}`;

const idOf = key => String(key).replace(/^character:/, "").replace(/:(placement|take|ik|props)$/, "");
const complete = context => !context?.entityPage || (context.entities ?? []).length >= context.entityPage.total;
const rigRows = context => (context?.entities ?? []).filter(row => row?.kind === "character" && row.characterKind === "rig");

/** The ids of the scene's rig characters, or null when the context's rows are cut short (a big scene). */
export const rigIds = context => (context && complete(context) ? rigRows(context).map(row => row.id) : null);

/**
 * The character a motion task animates: the one it names; else the one rig character made since the task was
 * dispatched (motion.known: the rig characters there were then), which is the one its dependencies made; else the one
 * rig character its dependencies changed; else the scene's only rig character.
 * -> { id } or { reason } (the task fails with it, and the coordinator reads why).
 * context: the Studio context read at the task's start; deps: [{ changed: [keys or ids] }] of the done dependencies.
 */
export function motionSubject(motion, context, deps = []) {
	const rows = context?.entities ?? [], index = context?.entityIndex ?? rows, rig = rigRows(context);
	const have = rig.length ? `Rig characters here: ${rig.slice(0, 12).map(row => row.id).join(", ")}.` : "This scene has no rig character.";
	const named = motion?.characterId;
	if (named) {
		const row = rows.find(entry => entry?.kind === "character" && entry.id === named);
		// Rows the context cut short are not proof of absence: the engine checks the id against the editor.
		if (!row) return !complete(context) && index.some(entry => entry?.id === named && entry.kind !== "object") ? { id: named } : { reason: `motion task: no character ${named} in this scene. ${have}` };
		if (row.characterKind !== "rig") return { reason: `motion task: ${named} is a capsule figure with no skeleton, and the motion engine animates rig characters only. ${have} Make its poses in an ordinary task, or use a rig character.` };
		return { id: named };
	}
	const again = `${have} Dispatch it again with motion: { characterId }.`;
	const made = Array.isArray(motion?.known) && complete(context) ? rig.filter(row => !motion.known.includes(row.id)) : [];
	if (made.length === 1) return { id: made[0].id };
	if (made.length > 1) return { reason: `motion task: it names no character and ${made.length} rig characters were made since it was dispatched. ${again}` };
	const touched = new Set(deps.flatMap(dep => dep.changed ?? []).map(idOf)), changed = rig.filter(row => touched.has(row.id));
	if (changed.length === 1) return { id: changed[0].id };
	if (rig.length === 1) return { id: rig[0].id };
	return { reason: `motion task: it names no character and which one to animate is not clear. ${again}` };
}

/** The task's scope with its character in it (all four layers: an installed take replaces the take and clears her IK keys). */
export const motionScope = (scope, id) => [...new Set([...(scope ?? []), `character:${id}`])];

const RESUMED = "Studio reconnected after a disconnect. Check what is installed with track info and one render before you continue; do not assume your last commit landed.";

/** The header a motion task's run reads before its instructions, and the coordinator's design after them (the v4 prompt and the scene brief come first). */
const BUILD_DESIGN = "Start from this design: turn its phases into key poses and frame timing (step 1 of your work), then build it. Where the rig or the scene makes a detail impossible, keep its intent and say what you changed in your report.";

export function motionHeader(task, { deps = [], resume = null } = {}) {
	return [`<task id="${task.taskId}">`,
		`You are the motion task of a larger job: animate ${task.motion.characterId}. Other tasks build and edit the scene, so nothing but this character's take, and the poses of scene objects it handles inside that take, is yours to change.`,
		...deps.map(dep => `Earlier task ${dep.taskId} (${dep.title}) is done: ${dep.summary?.reply ?? ""}${dep.changed?.length ? ` It changed: ${dep.changed.join(", ")}.` : ""}`),
		...(resume?.note ? [RESUMED] : []),
		"When you finish, report to the coordinator in English in 2 to 4 sentences: what you made, and for each visible criterion in the instructions whether the judge views show it (met or unmet, with the measured value when there is one).",
		"End the report with one line: \"Unmet criteria: none\" when every criterion is met, or \"Unmet criteria: <the unmet ones>\".",
		"</task>", "", task.instructions, ...(task.motion.design ? ["", task.motion.design, BUILD_DESIGN] : [])].join("\n");
}
