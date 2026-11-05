// A face lying in the deck plane z-fights with the deck (#1075): a floor slab
// whose bottom is at y=0 flickers in captures and playback. Placement lifts a
// solid object standing on the deck by DECK_LIFT_M when its bottom would land
// within DECK_SNAP_M of the deck, the same 3 mm the agent prompt asks between
// coplanar faces. Objects stacked on another object are never lifted.
import { isEmptyObject } from './scene-objects.js';
import { EFFECT_KIND } from './effects/effect-record.js';

export const DECK_LIFT_M = 0.003;
const DECK_SNAP_M = 1e-3;

/**
 * The y that lifts `entity` off the deck, or null when it stays where it is.
 * bottomOf() answers the entity's lowest world y (called only for solid,
 * free-standing objects: no empty, light, effect, route or attachment).
 */
export function deckLiftY(entity, bottomOf, deckY = 0) {
	if (!entity.renderer || entity.attach || entity.path || isEmptyObject(entity) || entity.renderer === EFFECT_KIND) return null;
	const bottom = bottomOf();
	return Math.abs(bottom - deckY) > DECK_SNAP_M ? null : entity.y + deckY + DECK_LIFT_M - bottom;
}

/** The receipt warning for the objects a batch lifted off the deck, or []. */
export function floorLiftWarnings(ids, nameOf) {
	if (!ids.length) return [];
	const who = ids.length === 1 ? nameOf(ids[0]) : `${ids.length} objects`;
	return [{ code: 'FLOOR_LIFT', ...(ids.length === 1 ? { id: ids[0] } : { count: ids.length }), message: [...`${who} lifted ${DECK_LIFT_M * 1000} mm off the deck so a bottom face does not z-fight with it`].slice(0, 120).join('') }];
}
