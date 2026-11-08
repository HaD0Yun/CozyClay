// Bind skeletons of the bodies a take can be compiled for (tools/motion3/extract-rig.mjs), and rigs registered at run
// time (an adapted skeleton: adapt.js adaptRig).
import xBot from "./x-bot-tpose.json" with { type: "json" };
import yBot from "./y-bot-tpose.json" with { type: "json" };
import { createSkeleton } from "../compiler/skeleton.js";
import { registerBody } from "../body.js";
import { refitBody } from "./adapt-body.js";

const RIGS = { "x-bot-tpose": xBot, "y-bot-tpose": yBot };
const cache = new Map();
let reference = null;

/** Skeleton for a character model id, or null for a body motion3 cannot drive. */
export function skeletonFor(model) {
	if (!RIGS[model]) return null;
	if (!cache.has(model)) cache.set(model, createSkeleton(RIGS[model]));
	return cache.get(model);
}

/**
 * Makes rig JSON `rig` (x-bot-tpose.json's shape, e.g. adaptRig's rig) character model `id`: skeletonFor(id) answers its
 * skeleton (model `id`) from now on, and its collision body is the X Bot's fitted body refitted to its bones
 * (adapt-body.js). Registering an id again replaces the rig, its skeleton and its body.
 */
export function registerRig(id, rig) {
	if (typeof id !== "string" || !id) throw new Error("registerRig: id must be a non-empty string");
	if (!Array.isArray(rig?.bones) || !rig.landmarks) throw new Error(`registerRig: rig "${id}" needs bones and landmarks (x-bot-tpose.json's shape)`);
	RIGS[id] = { ...rig, model: id };
	cache.delete(id);
	reference ??= createSkeleton(xBot);
	registerBody(id, fileFit => refitBody(skeletonFor(id), reference, fileFit("x-bot-tpose")));
}
