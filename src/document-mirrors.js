// The active scene's shot document and stage envelope, read from the stores at
// the moment they are used. App used to rebuild both during render, so a
// synchronous command read them one render behind: the Studio binding folds
// them into the scene revision (stage and scenes documents), the receipt
// answered revision N, and the next render moved the scene to N+1 by itself
// when the mirrors caught up. An agent's next write, admitted at the receipt's
// revision.after (a motion install, a cast move, a shot edit), then met
// STALE_SCENE although nothing had changed.
import { createShotAuthoringDocument } from "./shot-authoring.js";
import { savedTakeSource } from "./domains/motion/take-source.js";

// IK edits (Pose mode, IK keys, range pins) ride into the saved stage with each character.
const ikEditsOf = row => (!row || (!row.ikKeys?.length && !row.ikPins?.length) ? null : { keys: row.ikKeys, pins: row.ikPins ?? [], pinResiduals: row.ikPinResiduals ?? [] });

/** Ref-shaped mirrors (`.current`) for the scene snapshot and the stage domain.
 * `actorStageRef.current` keeps the envelope App (or the stage domain) last set
 * and always answers the cast as it is now: sessionMotion is stripped (baked
 * takes are session-only and far too heavy for the stage envelope); a take v3
 * persists as its source (spec, placement). */
export function createDocumentMirrors(appContext) {
	const cast = () => appContext.storeDomain("cast")?.projection() ?? appContext.live.characters ?? [];
	const activeWaypoints = list => (list.find(entry => entry.id === appContext.storeDomain("cast")?.activeId) ?? list[0])?.layer?.waypoints ?? [];
	const shotDocumentRef = {
		get current() {
			const shots = appContext.storeDomain("shot");
			return createShotAuthoringDocument({ shots: shots?.read() ?? [], waypoints: activeWaypoints(cast()), frameCount: shots?.state().frameCount ?? null });
		},
	};
	let envelope = null;
	const stageCharacters = () => {
		const layers = appContext.storeDomain("motion")?.read() ?? null;
		return cast().map(({ sessionMotion, placementKeys, ...entry }) => {
			const row = layers?.find(layer => layer.id === entry.id);
			return { ...entry, ikEdits: ikEditsOf(row), motionTake: savedTakeSource(row?.take) };
		});
	};
	const actorStageRef = {
		get current() { return envelope && { ...envelope, characters: stageCharacters() }; },
		set current(value) { envelope = value; },
	};
	return { shotDocumentRef, actorStageRef };
}
