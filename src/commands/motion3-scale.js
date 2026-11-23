// A motion compile is made for the body the character stands as: its scale times its look's body (src/lowvis/studio/
// figure.js bodyScale). The job compiles on the rig at that size (rigs/index.js sizedRig), so the spec's places,
// the floor and the props are met in the world as written; the take then keeps its numbers in the rig's own size, as
// every take does (the stage, motion.sample and people.js draw a take times the body it plays on), and carries the size
// it was made for (take.scale, as a raw track does: physics-frames.js). A take made for one size and read on a body of
// another (the character resized after the install) is not measured by compiling again: motion.qa and motion.report
// say so; motion.sample reads the take's bones at the character's place and scale. A raw track (motion.v4.install)
// has no spec to compile: the reads that measure by compiling say so at any scale.
import { fail } from "./shared.js";
import { characterName } from "../character-name.js";
import { bodyScale, scaleOf } from "../lowvis/studio/figure.js";
import { sizedRig } from "../motion3/rigs/index.js";
import { ownSize, skeletonAt, unitTake } from "../motion3/rigs/posted.js";

const SAMPLE = "motion.sample reads the take's bones at the character's place and scale.";
const same = (a, b) => Math.abs(a - b) <= 1e-6;

/**
 * The compile job's body for `character`: { model, rigs } to send (the rig at the size it stands as, registered by the
 * job), and unit(result), which gives the take back in the rig's own size with its size on it (posted.js unitTake). At
 * the rig's own size: the character's model and the result as it is.
 */
export function compileBody(character) {
	const size = bodyScale(character), sized = ownSize(size) ? null : sizedRig(character.model, size);
	if (!sized) return { model: character.model, rigs: {}, unit: r => r };
	return { model: sized.id, rigs: { [sized.id]: sized.rig }, unit: r => (r?.take ? { ...r, take: unitTake(r.take, character.model, size) } : r) };
}

/** The skeleton of the body `character` stands as (posted.js skeletonAt): what a spec's named poses and skills are fitted to before the job. */
export const bodySkeleton = character => skeletonAt(character.model, bodyScale(character));

/** Throws TARGET_NOT_READY when `action` (a read that measures by compiling the installed take's spec again) cannot measure this body's take. */
export function measurable(character, take, action) {
	if (take.spec?.raw) fail("TARGET_NOT_READY", `${action} measures a take by compiling its motion spec again; ${characterName(character)}'s take was installed as a raw track and has no spec to compile, at any scale. ${SAMPLE}`);
	const made = take.scale ?? 1;
	if (!same(bodyScale(character), made)) fail("TARGET_NOT_READY", `${action} measures a take by compiling its motion spec again, for the body it was made for, at scale ${scaleOf(made, bodyScale({ model: character.model }))}; ${characterName(character)} is at scale ${character.scale ?? 1}, so that would not measure the take as it plays. ${SAMPLE}`);
}
