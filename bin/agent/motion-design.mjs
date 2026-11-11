// The motion design step (#1138): before a motion task starts, the coordinator writes how a real person performs the
// action, and the motion task receives that design with its instructions. It is one tool, design_motion, whose fields
// are the questions an animator answers before touching the rig: where the person stands, how they hold things, the
// action as phases in time, what each part of the body does, where the weight and the force are, what must read.
// The tool checks that the design is concrete enough, keeps it under an id, and a motion dispatch must name that id
// (main-agent.mjs refuses one that does not): the coordinator cannot hand over a motion it has not thought through.
import { randomUUID } from "node:crypto";

const text = (maxLength, description) => ({ type: "string", maxLength, description });

/** design_motion as the coordinator's tool declaration: { name, description, properties, required }. */
export const DESIGN_TOOL = Object.freeze({
	name: "design_motion",
	description: "The motion design step (rule M10). Before a motion task, picture a real person doing exactly this action in this scene and write how they do it, in plain concrete words (which foot, which hand, how far, how long). Use the scene's real ids, sizes and positions: read them with inspect_studio first. Answers a designId; pass it as motion.designId when you dispatch the motion task, which receives the design.",
	properties: {
		action: text(300, "the action in the user's words, and in one line what the viewer should understand from it"),
		start: text(700, "the starting pose: where the person stands relative to what they act on (distance, which side), which way they face, the stance (feet width, which foot is forward) and how they hold or touch things at the start (which hand where, the grip)"),
		phases: { type: "array", minItems: 1, maxItems: 12, description: "the action in time order, from the first move to the settled end; a repeated move is written once with its count in rhythm",
			items: { type: "object", additionalProperties: false, required: ["name", "seconds", "body"], properties: {
				name: text(60, "what happens, e.g. reach for the axe, wind-up, strike, recover"),
				seconds: { type: "number", description: "how long this phase takes for a real person" },
				body: text(800, "what the body does in this phase, from the ground up: feet and legs, hips, spine, shoulders, arms and hands, head and eyes; which part leads and which follows"),
				weight: text(240, "where the weight is and how it shifts (from the back foot to the front foot, onto the toes)"),
				contacts: text(320, "what touches what: feet on the floor, each hand on a prop (where on it), a tool on its target, and what a handled object does") } } },
		power: text(500, "where the force starts and how it travels through the body (legs, hips, torso, arms), and what follows through after the main move"),
		rhythm: text(320, "the timing feel: what is slow, what is fast, where it holds, how many repeats"),
		mustRead: { type: "array", minItems: 1, maxItems: 6, items: text(160, "one thing"), description: "what a viewer must see for the action to read as real" },
		avoid: { type: "array", maxItems: 6, items: text(160, "one thing"), description: "what would make it look fake (arms only, sliding feet, a stiff spine, no anticipation)" },
	},
	required: ["action", "start", "phases", "power", "rhythm", "mustRead"],
});

const FPS = 24, MIN_PHASES = 3, MIN_BODY = 60, MIN_START = 40, MIN_POWER = 30, MAX_SECONDS = 60;
const words = value => (typeof value === "string" ? value.trim() : "");

/** What a design still lacks, as sentences the coordinator can act on; [] when it is concrete enough. */
export function designProblems(design) {
	const problems = [], phases = Array.isArray(design?.phases) ? design.phases : [];
	if (!words(design?.action)) problems.push("action: say the action in the user's words.");
	if (words(design?.start).length < MIN_START) problems.push("start: say where the person stands and faces, the stance, and how they hold or touch things before the first move.");
	if (phases.length < MIN_PHASES) problems.push(`phases: ${phases.length} is too few. A real action has at least a preparation, the main move and a recovery; write ${MIN_PHASES} or more phases in time order.`);
	phases.forEach((phase, i) => {
		const name = words(phase?.name) || `phase ${i + 1}`;
		if (!(phase?.seconds > 0) || phase.seconds > MAX_SECONDS) problems.push(`phases[${i}] (${name}): seconds must be how long it takes a real person (above 0, at most ${MAX_SECONDS}).`);
		if (words(phase?.body).length < MIN_BODY) problems.push(`phases[${i}] (${name}): body is too thin. Say what the legs, hips, spine, arms and hands, and head do, and which part leads.`);
	});
	const total = phases.reduce((sum, phase) => sum + (phase?.seconds > 0 ? phase.seconds : 0), 0);
	if (total > MAX_SECONDS) problems.push(`phases: ${total.toFixed(1)} s in all is longer than ${MAX_SECONDS} s; describe one pass of the action and give repeats in rhythm.`);
	if (words(design?.power).length < MIN_POWER) problems.push("power: say where the force starts and how it travels through the body.");
	if (!words(design?.rhythm)) problems.push("rhythm: say what is slow, what is fast and how many repeats.");
	if (!(Array.isArray(design?.mustRead) && design.mustRead.some(words))) problems.push("mustRead: name what the viewer must see for it to read as real.");
	return problems;
}

const sentence = value => { const said = words(value); return said && !/[.!?。]$/.test(said) ? `${said}.` : said; };
const listed = items => (Array.isArray(items) ? items.map(words).filter(Boolean) : []);

/** The design as the text a motion task reads: phases with their time and frame ranges at 24 fps. */
export function designText(design) {
	const phases = design.phases, total = phases.reduce((sum, phase) => sum + phase.seconds, 0);
	let at = 0;
	const rows = phases.map((phase, i) => {
		const from = at, to = (at += phase.seconds), f0 = Math.round(from * FPS), f1 = Math.max(f0, Math.round(to * FPS) - 1);
		return [`${i + 1}. ${words(phase.name)}: ${from.toFixed(1)}-${to.toFixed(1)} s (frames ${f0}-${f1}). Body: ${sentence(phase.body)}`,
			words(phase.weight) && `Weight: ${sentence(phase.weight)}`, words(phase.contacts) && `Contacts: ${sentence(phase.contacts)}`].filter(Boolean).join(" ");
	});
	const must = listed(design.mustRead), avoid = listed(design.avoid);
	return ["Motion design (how a real person does this action, written by the coordinator before this task):",
		`Action: ${sentence(design.action)}`, `Start: ${sentence(design.start)}`,
		`Phases (${total.toFixed(1)} s in all, about ${Math.round(total * FPS)} frames at ${FPS} fps):`, ...rows,
		`Power: ${sentence(design.power)}`, `Rhythm: ${sentence(design.rhythm)}`,
		`The viewer must read: ${must.join("; ")}.`, ...(avoid.length ? [`Avoid: ${avoid.join("; ")}.`] : [])].join("\n");
}

/**
 * createDesigns(store) -> { add(design) -> { designId, seconds, frames, phases } (throws INVALID_ARGUMENT with what is
 * missing), text(designId) -> the design's text or null }. store: a Map kept with the main session, so a design made
 * in one turn is still there when its motion task is dispatched in a later one.
 */
export function createDesigns(store = new Map()) {
	return {
		add(design) {
			const problems = designProblems(design);
			if (problems.length) throw Object.assign(new Error(`INVALID_ARGUMENT: the design is not concrete enough yet. ${problems.join(" ")}`), { code: "INVALID_ARGUMENT" });
			const designId = `design-${randomUUID().slice(0, 8)}`, seconds = design.phases.reduce((sum, phase) => sum + phase.seconds, 0);
			store.set(designId, designText(design));
			return { designId, seconds: +seconds.toFixed(1), frames: Math.round(seconds * FPS), phases: design.phases.length, next: "Dispatch the motion task with motion.designId set to this id." };
		},
		text: designId => store.get(designId) ?? null,
	};
}
