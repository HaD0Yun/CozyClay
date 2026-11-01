// Pose-mode placement keys in the cast owner (domains/cast.js): the motion owner's "placement" track, published per character like
// a take (render and gizmo read entry.placementKeys), and a move of a keyed character without a take turned into a placement key
// at the playhead (motion/placement-keys.js).
import { samplePlacement } from "../motion/placement-keys.js";

const SPOT = ['x', 'z', 'rot'];

/** onChange: the cast owner republishes its projection. */
export function createCastPlacements(onChange) {
	const placements = new Map();
	return {
		/** The entry with its placementKeys, when it has some. */
		withKeys: entry => { const placed = placements.get(entry.id); return placed?.length ? { ...entry, placementKeys: placed } : entry; },
		publish(characterId, rows) {
			if (JSON.stringify(placements.get(characterId) ?? []) === JSON.stringify(rows ?? [])) return;
			if (rows?.length) placements.set(characterId, rows); else placements.delete(characterId);
			onChange();
		},
		/** The patch left after a keyed character's x / z / rot became a placement key at frame (in the open action: one Undo). */
		redirect(appContext, characterId, frame, patch, hasTake) {
			const placed = placements.get(characterId), motion = appContext.storeDomain('motion');
			if (!placed?.length || hasTake || !motion || !SPOT.some(key => patch[key] !== undefined)) return patch;
			const at = samplePlacement(placed, frame), value = { x: patch.x ?? at.x, z: patch.z ?? at.z, rot: patch.rot ?? at.rot };
			appContext.recordAction('motion', () => motion.setPlacementKey(characterId, frame, value), null, true);
			return Object.fromEntries(Object.entries(patch).filter(([key]) => !SPOT.includes(key)));
		},
	};
}
