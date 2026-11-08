// The timeline note's range guard. A message sent with a note chip names the
// frames it is about (frameStart..frameEnd, inclusive, on one character). Until
// the next message is sent, an agent edit of that character's motion keys, IK
// keys or timing that reaches outside those frames is refused where commands
// land (command-bus.js), with the frames it touched and the ones it may use.
// The author's own UI edits are never guarded. Pure: the node tests import it.
import { StudioProtocolError } from "./studio-agent-protocol.js";

let active = null, armed = [];

const valid = (range) => range && Number.isInteger(range.frameStart) && Number.isInteger(range.frameEnd) && range.characterId;

/** Arm the guard with the sent note's payload, or disarm it with null. `ranges` (fix marks: one per island) lists
 * every { characterId, frameStart, frameEnd } the message is about; an edit may use any of them. */
export function armNoteRangeGuard(note) {
	const ranges = (note?.ranges ?? [note]).filter(valid).map(({ characterId, frameStart, frameEnd }) => Object.freeze({ characterId, frameStart, frameEnd }));
	active = valid(note) && ranges.length ? Object.freeze({ characterId: note.characterId, frameStart: note.frameStart, frameEnd: note.frameEnd }) : null;
	armed = active ? ranges : [];
}

export const noteRangeGuard = () => active;

// Frame-addressed edits: the frames each one writes.
const FRAMES = {
	"character.setIkKey": (args) => [args.frame], "character.removeIkKey": (args) => [args.frame],
	"ik.setKey": (args) => [args.frame], "ik.removeKey": (args) => [args.frame], "ik.applyPose": (args) => [args.frame],
	"ik.moveKey": (args) => [args.from, args.to], "motion.cut": (args) => [args.frame], "motion.keyObject": (args) => [args.frame],
};
// Edits that rewrite the whole take or its timing: every frame moves or goes.
const WHOLE_TAKE = new Set(["character.clearIkKeys", "ik.clearKeys", "motion.set", "motion.clear", "motion.compile", "motion.fill", "motion.primitive",
	"motion.setSegmentSpeed", "motion.removeSegment", "motion.trim", "motion.resetTiming", "motion.rangePin.apply", "motion.rangePin.remove"]);

/** Throw when the armed note forbids this command; `request.origin` "ui" always passes. */
export function checkNoteRange(id, args, request) {
	const mine = args ? armed.filter((range) => range.characterId === args.characterId) : [];
	if (!mine.length || !request || request.origin === "ui") return;
	const { frameStart, frameEnd } = mine[0], allowed = `frames ${mine.map((range) => `${range.frameStart}-${range.frameEnd}`).join(", ")}`;
	// character.setPose with clearMotion clears the whole take and its IK keys (commands/cast.js applyPose)
	if (WHOLE_TAKE.has(id) || (id === "character.setPose" && args.clearMotion === true)) {
		throw new StudioProtocolError("INVALID_RANGE", `Refused by the timeline note: ${id} rewrites the whole take, but this message is about ${allowed} only. Key or correct the pose inside ${allowed} (character.setIkKey) instead.`, { noteRange: { frameStart, frameEnd } });
	}
	const outside = (FRAMES[id]?.(args) ?? []).filter((frame) => Number.isFinite(frame) && !mine.some((range) => frame >= range.frameStart && frame <= range.frameEnd));
	if (outside.length) {
		throw new StudioProtocolError("INVALID_RANGE", `Refused by the timeline note: ${id} touches frame ${outside.join(", ")}, outside the note's ${allowed}. Keep motion and IK edits inside ${allowed}.`, { noteRange: { frameStart, frameEnd } });
	}
}
