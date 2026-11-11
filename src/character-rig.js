// A character the user imported with a skeleton of its own (not the X Bot or the Y Bot). The entry keeps what playback
// and compile need, so a project opens without re-reading the file:
//   model       "rig-<16 hex of the file's digest>-<template or auto>": one id per rig JSON (rigs/posted.js ensureRig).
//   adaptedRig  adaptRig's rig, the skeleton every compile runs on (commands/motion3.js rigOf, the worker's job.rigs).
//   rigImport   { assetId (the mesh- bytes in the asset store), name, template (forced, or null for detected),
//                 raw (the file's skeleton, rigs/read-skeleton.js), sources (each raw bone's node name),
//                 report (adaptRig's report: detected, missing, grounded, axes, retarget), unitsDetected, scaled }.
// Pure: no three.js, no DOM. registerCastRigs is the one place an imported rig becomes a model on the main thread.
// An entry is an imported character only when its retarget plan builds and a dry run plays (rigPlays): a project file,
// load_scenes or an agent patch can hand in a broken report or skeleton, and it must not reach render or compile.
import { ensureRig } from "./motion3/rigs/posted.js";
import { TEMPLATES } from "./motion3/rigs/templates.js";
import { createSkeleton, restState } from "./motion3/compiler/skeleton.js";
import { retargetPlan, retargetPose } from "./motion3/rigs/retarget.js";

const MODEL = /^rig-[0-9a-f]{16}-[a-z0-9-]+$/;
const plain = value => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const registered = new Map();

/** The templates a user may force (templates.js ids). */
export const RIG_TEMPLATE_IDS = Object.freeze(Object.keys(TEMPLATES));

/** True for the model id of an imported rig (registered or not). */
export const isImportedModel = model => MODEL.test(model ?? "");

/** The model id of an imported rig: its file and its template choice (null: detected). */
export function importedModelId(assetId, template = null) {
	const hex = String(assetId ?? "").replace(/^mesh-/, "").slice(0, 16);
	return `rig-${hex.padEnd(16, "0")}-${template && RIG_TEMPLATE_IDS.includes(template) ? template : "auto"}`;
}

const vec = (v, n) => Array.isArray(v) && v.length === n && v.every(Number.isFinite);
const shapeOk = (entry) => {
	const imp = entry?.rigImport, rig = entry?.adaptedRig;
	if (!isImportedModel(entry?.model) || !plain(rig) || !Array.isArray(rig.bones) || !plain(rig.landmarks) || !plain(imp)) return false;
	if (typeof imp.assetId !== "string" || !Array.isArray(imp.raw?.bones) || !Array.isArray(imp.sources) || imp.sources.length !== imp.raw.bones.length) return false;
	if (!imp.sources.every(name => typeof name === "string") || !imp.raw.bones.every(b => vec(b?.localQuat, 4) && vec(b?.localPos, 3))) return false;
	return plain(imp.report?.retarget) && plain(imp.report.retarget.Hips) && Array.isArray(imp.report?.axes);
};
const checked = new WeakMap(); // rigImport -> { rig: the adaptedRig it was checked with, ok }

/** True when the rig of `entry` builds its skeleton and retarget plan and plays its bind (no registering). */
function rigPlays(entry) {
	if (!shapeOk(entry)) return false;
	const hit = checked.get(entry.rigImport);
	if (hit?.rig === entry.adaptedRig) return hit.ok;
	let ok;
	try {
		const sk = createSkeleton({ ...entry.adaptedRig, model: entry.model }), { raw, report } = entry.rigImport;
		ok = retargetPose(retargetPlan(raw, report, sk), restState(sk)).quats.length === raw.bones.length;
	} catch {
		ok = false;
	}
	checked.set(entry.rigImport, { rig: entry.adaptedRig, ok });
	return ok;
}

/** True when `entry` carries a whole imported character whose rig plays: its model id, its rig and its rigImport. */
export const isImportedCharacter = entry => rigPlays(entry);

/**
 * { adaptedRig, rigImport } of an imported character (fresh copies), else null. An entry that names an imported rig
 * whose plan does not build is dropped here (scenes.js createCharacterEntry turns it into the default body), warned about.
 */
export function importedRigOf(entry) {
	if (isImportedCharacter(entry)) return structuredClone({ adaptedRig: entry.adaptedRig, rigImport: entry.rigImport });
	if (isImportedModel(entry?.model) || entry?.rigImport) console.warn(`[cozyclay] dropped the imported character ${entry?.id ?? ""}: its skeleton or adapter report is incomplete`);
	return null;
}

/**
 * Registers every imported character's rig (ensureRig: the same JSON registers nothing) and keeps its playback data
 * (with its retarget plan) by model id. Run before any take of theirs is compiled or drawn: on import, when a scene's
 * cast is read and before a compile reads the other characters. Returns `characters`. A rig whose plan does not build
 * registers nothing (its takes do not play, its compile is refused) and is warned about.
 */
export function registerCastRigs(characters) {
	for (const c of Array.isArray(characters) ? characters : []) {
		if (!isImportedModel(c?.model)) continue;
		try {
			if (!isImportedCharacter(c)) throw new Error("its skeleton or adapter report is incomplete");
			const sk = ensureRig(c.model, c.adaptedRig), { raw, sources, report } = c.rigImport, was = registered.get(c.model);
			if (was?.raw !== raw || was.sk !== sk) registered.set(c.model, { raw, sources, report, sk, plan: retargetPlan(raw, report, sk) });
		} catch (error) {
			console.warn(`[cozyclay] the imported rig ${c.model} could not be registered`, error);
		}
	}
	return characters;
}

/** { raw, sources, report, sk, plan } of a registered imported rig, else null (a built-in body, or not registered yet). */
export const importedRigData = model => registered.get(model) ?? null;
