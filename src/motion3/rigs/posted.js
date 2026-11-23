// A rig that travels with its character: an adapted skeleton (adapt.js adaptRig's rig) the project file keeps reaches
// every compile as data, because the compile worker shares no module state with the editor. A compile job carries
// the rig JSON (compile-job.js) and each thread registers it here before it compiles (the editor's in
// commands/motion3.js); the same JSON again registers nothing, so the skeleton, its plans and its collision body stay
// cached from job to job. A changed rig registers anew (rigs/index.js registerRig).
import { registerRig, skeletonFor, sizedRig } from "./index.js";

/** The bodies motion3 ships (rigs/index.js): a character on one carries no rig, and the MotionBricks fill runs on these only. */
const BUILT_IN = new Set(["x-bot-tpose", "y-bot-tpose"]);
const posted = new Map();

export const isBuiltInRig = model => BUILT_IN.has(model);

/**
 * ensureRig(model, rig) -> skeletonFor(model): registers rig JSON `rig` as character model `model` unless this same JSON
 * is registered as it already. A built-in model refuses a rig (INVALID_ARGUMENT); registerRig's own checks throw too.
 */
export function ensureRig(model, rig) {
	if (BUILT_IN.has(model)) throw Object.assign(new Error(`${model} is a built-in rig: its character carries no rig`), { code: "INVALID_ARGUMENT" });
	const key = JSON.stringify(rig);
	if (posted.get(model) !== key) {
		posted.delete(model);
		registerRig(model, rig);
		posted.set(model, key);
	}
	return skeletonFor(model);
}

/** Whether a body `size` times its rig's own is the rig's own body: a compile for it runs on the rig as shipped. */
export const ownSize = size => !(size > 0) || Math.abs(size - 1) <= 1e-6;

/**
 * The skeleton a compile for a body `size` times model `model`'s own runs on (a take's scale, or a character's scale
 * times its look's body): the rig itself at its own size, else the rig at that size (index.js sizedRig), registered on
 * this thread unless it is. null for a body motion3 cannot drive.
 */
export function skeletonAt(model, size = 1) {
	if (ownSize(size)) return skeletonFor(model);
	const sized = sizedRig(model, size);
	return sized && ensureRig(sized.id, sized.rig);
}

/**
 * A take baked on model `model`'s rig at `size` (skeletonAt), as every take is kept: its numbers in the rig's own size
 * (the stage, motion.sample and people.js draw a take times the body it plays on) and the size it was made for
 * (take.scale, as a raw track carries it: physics-frames.js). At the rig's own size: the take itself.
 */
export const unitTake = (take, model, size) => (ownSize(size) ? take : { ...take, rig: model, hips: take.hips.map(v => v / size), scale: size });
