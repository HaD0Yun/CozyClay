import { rangePinTracks } from "../../motion/range-pin.js";
import { ko } from "../../locale.js";

export function ensureRangePinState(state) {
	if (!state) return state;
	if (!(state.pins instanceof Map)) state.pins = new Map();
	if (!(state.pinResiduals instanceof Map)) state.pinResiduals = new Map();
	return state;
}
export function rangePinConflictFrames(draft, state) {
	if (!Number.isInteger(draft?.startFrame) || !Number.isInteger(draft?.endFrame) || draft.endFrame < draft.startFrame) return [];
	const tracks = rangePinTracks(draft), conflicts = [];
	for (let frame = draft.startFrame; frame <= draft.endFrame; frame += 1) {
		if (tracks.some((track) => { const key = state.keys.get(frame)?.get(track); return key && key.pin !== draft.id; })) conflicts.push(frame);
	}
	return conflicts;
}
export function overlappingRangePin(draft, state) {
	return [...ensureRangePinState(state).pins.values()].find((pin) => pin.id !== draft.id && rangePinTracks(pin).some((track) => rangePinTracks(draft).includes(track)) && Math.max(pin.startFrame, draft.startFrame) <= Math.min(pin.endFrame, draft.endFrame));
}
const sameValues = (a, b) => a === b || (Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, i) => Object.is(value, b[i])));
/** Two Pin previews show the same thing: the Pin panel re-previews after every frame commit, and an unchanged one must not re-render App (#1195). */
export function sameRangePinPreview(a, b) {
	return Boolean(a && b) && a.draft === b.draft && a.track === b.track && a.overlapError === b.overlapError && sameValues(a.target, b.target) && sameValues(a.conflictFrames, b.conflictFrames);
}
export function rangePinOverlapMessage(pin) {
	return pin ? ko(`A required body or limb track already has an overlapping pin (${pin.startFrame}–${pin.endFrame}).`, `필요한 몸통 또는 팔다리 파츠에 겹치는 고정이 있어요 (${pin.startFrame}–${pin.endFrame}).`, `所需的身体或肢体轨道上已有重叠的固定（${pin.startFrame}–${pin.endFrame}）。`) : "";
}
