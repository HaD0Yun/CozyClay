// Timing edits on an installed take (take-edit.js): cut it into segments, play a segment faster
// or slower, drop one, trim the ends, or restore the full take. The compiled take stays as it
// is; the edit rides its descriptor, so Undo, save/load and export all see the same timing.
// IK correction keys pinned to timeline frames move with the poses they address.
import { fail, characterOf } from "./shared.js";
import { shotsFollowingTake } from "../timeline-extent.js";
import { createTakeEdit, isIdentityEdit, remapFrameKeys, removeSegment, setSegmentSpeed, splitTakeEdit, takeEditDuration, takeEditLayout, trimTakeEdit } from "../motion3/take-edit.js";

const id = { type: "string", minLength: 1 }, frame = { type: "integer", minimum: 0 };
const timing = (actionId, label, description, properties) => ({ id: actionId, label, description, kind: "mutation", undoDomain: "motion",
	input: { type: "object", properties: { characterId: id, ...properties }, required: ["characterId", ...Object.keys(properties)], additionalProperties: false } });
const SEGMENTS = "The receipt output lists the segments ({ id, sourceStart, sourceEnd, speed, timelineStart, timelineEnd }) and the new frame count.";

export const timingDeclarations = [
	timing("motion.cut", "Cut motion segment", `Cut the installed take into two segments at a timeline frame, so each part can get its own speed. ${SEGMENTS}`, { frame }),
	timing("motion.setSegmentSpeed", "Set segment speed", `Play one segment faster or slower: 0.1-4 in 0.1 steps (0.5 = half-speed slow motion, 2 = double speed). The timeline grows or shrinks with it. ${SEGMENTS}`,
		{ segmentId: id, speed: { type: "number", minimum: 0.1, maximum: 4 } }),
	timing("motion.removeSegment", "Remove motion segment", `Drop one segment from the take; the rest close the gap. ${SEGMENTS}`, { segmentId: id }),
	timing("motion.trim", "Trim motion", `Keep timeline frames start..end (inclusive) of the take. ${SEGMENTS}`, { start: frame, end: frame }),
	timing("motion.resetTiming", "Restore full take timing", `Undo every cut, speed change and trim: the take plays as compiled. ${SEGMENTS}`, {}),
];

/** The take descriptor with this edit; an identity edit leaves no key (authored intent stays plain). */
function withEdit(take, edit, frames) {
	const next = { ...take };
	delete next.edit;
	return isIdentityEdit(edit, frames) ? next : { ...next, edit };
}

function nextEdit(action, edit, args, frames) {
	const known = () => edit.some(segment => segment.id === args.segmentId) || fail("INVALID_ARGUMENT", `No segment ${args.segmentId}; segments: ${edit.map(segment => segment.id).join(", ")}.`);
	if (action === "motion.cut") {
		const next = splitTakeEdit(edit, args.frame);
		return next !== edit ? next : fail("INVALID_RANGE", `Frame ${args.frame} is not inside a segment (0 < frame < ${takeEditDuration(edit)}, not on a segment start).`);
	}
	if (action === "motion.setSegmentSpeed") { known(); return setSegmentSpeed(edit, args.segmentId, args.speed); }
	if (action === "motion.removeSegment") { known(); return edit.length > 1 ? removeSegment(edit, args.segmentId) : fail("INVALID_ARGUMENT", "Use motion.clear to remove the last segment."); }
	if (action === "motion.trim") {
		try { return trimTakeEdit(edit, args.start, args.end); } catch (error) { return fail("INVALID_RANGE", error.message); }
	}
	return createTakeEdit(frames);
}

export function registerTiming(registry, ports, available) {
	const owner = () => ports.storeDomain("motion");
	for (const declaration of timingDeclarations) registry.register({ ...declaration, available, run(args) {
		const { characterId } = args;
		characterOf(ports, characterId);
		const row = owner().layer(characterId), full = owner().fullMotionFor(characterId);
		if (!row.take || !full) fail("TARGET_NOT_READY", "Load a take for this character first.");
		const previous = row.take.edit ?? createTakeEdit(full.frames), edit = nextEdit(declaration.id, previous, args, full.frames);
		if (edit !== previous) {
			owner().writeLayer(characterId, { take: withEdit(row.take, edit, full.frames), ikKeys: remapFrameKeys(row.ikKeys, previous, edit) });
			// a shot that ended with the take ends with it again, so the timeline length follows the take both ways
			ports.storeDomain("cast")?.syncTimeline?.(shots => shotsFollowingTake(shots, takeEditDuration(previous) - 1, takeEditDuration(edit) - 1));
		}
		return { affectedIds: [characterId], summary: declaration.label, output: { frames: takeEditDuration(edit), segments: takeEditLayout(edit) } };
	} });
}
