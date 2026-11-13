// What a saved take v3 is: the motion spec, the character placement and the scene as the
// compiler saw it (motionScene boxes), never the baked Float32 arrays. Compiling is
// deterministic, so compiling the source again rebuilds the same bones: this follows the
// motion.compile install path step for step (pipeline compileSpec, then bakeTake). Searched
// open parameters are already resolved in the stored spec, so no search runs again.
import { compileSpec } from "../../motion3/pipeline.js";
import { bakeTake } from "../../motion3/take.js";
import { motionScene } from "../../motion3/scene.js";
import { skeletonFor } from "../../motion3/rigs/index.js";
import { isTakeV3 } from "../../motion3/playback.js";
import { normalizeTakeEdit } from "../../motion3/take-edit.js";
import { compileRawSource } from "../../motion-v4/track/literal.js";
import { normalizeBaked } from "../../motion3/take-baked.js";
export { renderTakeEdit } from "../../motion3/take-edit.js";

const TAKE_SCHEMA = "cozyclay.take.v3";
const SPEC_SCHEMA = "cozyclay.motion-spec.v1";
const TIMELINE_FPS = 24;
const plain = value => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const finite3 = value => Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);

/** The JSON source of an installed take v3 (null for any other motion). Skills, anchors and
 * hinges may read any scene object, so the whole compile scene is kept. */
export function takeSource(take, sceneObjects = []) {
	if (!isTakeV3(take) || !plain(take.spec)) return null;
	return structuredClone({ schema: TAKE_SCHEMA, rig: take.rig, spec: take.spec,
		placement: { position: take.placement?.position ?? [0, 0, 0], yaw: take.placement?.yaw ?? 0 }, scene: { ...motionScene(sceneObjects), ...(plain(take.people) ? { people: take.people } : {}) } });
}

/** A saved source (with the Studio take id it carried), checked and owned by the caller; null when it is not one. */
export function normalizeTakeSource(value) {
	if (!plain(value) || value.schema !== TAKE_SCHEMA || typeof value.rig !== "string") return null;
	if (!plain(value.spec) || value.spec.schema !== SPEC_SCHEMA || !Number.isFinite(value.spec.frames)) return null;
	if (!plain(value.placement) || !finite3(value.placement.position) || !Number.isFinite(value.placement.yaw)) return null;
	const objects = plain(value.scene?.objects) ? value.scene.objects : {}, others = plain(value.scene?.others) ? { others: value.scene.others } : {};
	// the joints a person anchor named when it was compiled (people.js keptPeople)
	const people = plain(value.scene?.people) && Object.values(value.scene.people).every(p => plain(p) && Array.isArray(p.names) && Array.isArray(p.P) && p.P.length === p.frames * p.names.length * 3) ? { people: value.scene.people } : {};
	return structuredClone({ schema: TAKE_SCHEMA, rig: value.rig, spec: value.spec,
		placement: { position: value.placement.position, yaw: value.placement.yaw }, scene: { objects, ...others, ...people },
		...(typeof value.takeId === "string" && value.takeId ? { takeId: value.takeId } : {}),
		...(normalizeTakeEdit(value.edit, value.spec.frames) ? { edit: normalizeTakeEdit(value.edit, value.spec.frames) } : {}),
		...(normalizeBaked(value.baked) ? { baked: normalizeBaked(value.baked) } : {}) }); // hand fixes merged into the take (take-baked.js)
}

/** What a scene saves for a motion layer's take descriptor: its source, take id and timing edit (take-edit.js), or null. */
export const savedTakeSource = descriptor => descriptor?.source ? { ...descriptor.source, takeId: descriptor.studioTakeId, ...(descriptor.edit ? { edit: descriptor.edit } : {}), ...(descriptor.baked ? { baked: descriptor.baked } : {}) } : null;

/** Compile a source back into the installed take (with `frames`, as motion.compile installs it).
 * Leniently: a field a later, stricter validator does not know never blocks loading a saved take. */
export function compileTakeSource(source) {
	if (source?.spec?.raw) return compileRawSource(source);
	const sk = skeletonFor(source?.rig);
	if (!sk || !plain(source.spec)) return null;
	const { out } = compileSpec({ fps: TIMELINE_FPS, ...source.spec }, { sk, scene: source.scene ?? { objects: {} } }, { lenient: true });
	const take = bakeTake(sk, out, source.placement, { spec: source.spec, prompt: source.spec.label ?? "" });
	return { ...take, frames: take.frameCount };
}
