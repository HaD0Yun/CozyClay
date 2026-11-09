// A character the user imported with a skeleton of its own (not the X Bot or the Y Bot). The entry keeps what playback
// and compile need, so a project opens without re-reading the file:
//   model       "rig-<16 hex of the file's digest>-<template or auto>": one id per rig JSON (rigs/posted.js ensureRig).
//   adaptedRig  adaptRig's rig, the skeleton every compile runs on (commands/motion3.js rigOf, the worker's job.rigs).
//   rigImport   { assetId (the mesh- bytes in the asset store), name, template (forced, or null for detected),
//                 raw (the file's skeleton, rigs/read-skeleton.js), sources (each raw bone's node name),
//                 report (adaptRig's report: detected, missing, grounded, axes, retarget), unitsDetected, scaled }.
// Pure: no three.js, no DOM. registerCastRigs is the one place an imported rig becomes a model on the main thread.
import { ensureRig } from "./motion3/rigs/posted.js";
import { TEMPLATES } from "./motion3/rigs/templates.js";

const MODEL = /^rig-[0-9a-f]{16}-[a-z0-9-]+$/;
const plain = value => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const registered = new Map();

/** The templates a user may force (templates.js ids). */
export const RIG_TEMPLATE_IDS = Object.freeze(Object.keys(TEMPLATES));

/** The model id of an imported rig: its file and its template choice (null: detected). */
export function importedModelId(assetId, template = null) {
	const hex = String(assetId ?? "").replace(/^mesh-/, "").slice(0, 16);
	return `rig-${hex.padEnd(16, "0")}-${template && RIG_TEMPLATE_IDS.includes(template) ? template : "auto"}`;
}

/** True when `entry` carries a whole imported character: its model id, its rig and its rigImport. */
export function isImportedCharacter(entry) {
	const imp = entry?.rigImport;
	if (!MODEL.test(entry?.model ?? "") || !plain(entry.adaptedRig) || !Array.isArray(entry.adaptedRig.bones) || !plain(imp)) return false;
	if (typeof imp.assetId !== "string" || !Array.isArray(imp.raw?.bones) || !Array.isArray(imp.sources) || imp.sources.length !== imp.raw.bones.length) return false;
	return plain(imp.report?.retarget) && Array.isArray(imp.report?.axes);
}

/** { adaptedRig, rigImport } of an imported character (fresh copies), else null. */
export const importedRigOf = entry => (isImportedCharacter(entry) ? structuredClone({ adaptedRig: entry.adaptedRig, rigImport: entry.rigImport }) : null);

/**
 * Registers every imported character's rig (ensureRig: the same JSON registers nothing) and keeps its playback data
 * by model id. Run before any take of theirs is compiled or drawn: on import and when a scene's cast is read.
 * Returns `characters`. A rig that does not register is left out (its takes do not play) and warned about.
 */
export function registerCastRigs(characters) {
	for (const c of Array.isArray(characters) ? characters : []) {
		if (!c?.adaptedRig || !c.rigImport || !MODEL.test(c.model ?? "")) continue;
		try {
			ensureRig(c.model, c.adaptedRig);
			const { raw, sources, report } = c.rigImport;
			if (registered.get(c.model)?.raw !== raw) registered.set(c.model, { raw, sources, report });
		} catch (error) {
			console.warn(`[cozyclay] the imported rig ${c.model} could not be registered`, error);
		}
	}
	return characters;
}

/** { raw, sources, report } of a registered imported rig, else null (a built-in body, or not registered yet). */
export const importedRigData = model => registered.get(model) ?? null;
