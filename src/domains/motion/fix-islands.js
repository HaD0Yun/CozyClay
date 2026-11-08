// Fix islands on an installed take, for the motion owner (domains/motion.js) and Pose mode's Fix tools: a pose drag at a
// frame (Fix mode on) keys only the parts it moved, as delta keys over the take's own pose at that frame, tagged with the
// island's reach (motion/fix-weight.js weighs them). Each edit here is one undo entry of the motion owner.
import { bakeIkDragKey } from "../../motion/ik-drag.js";
import { FIX_REACH, islandsOf } from "../../motion/fix-weight.js";
import { fixModeOn } from "../../motion/fix-door.js";
import { decodeMotionKeys } from "./motion-intent-codec.js";
import { ko } from "../../locale.js";

/** One undo entry: mutate(keys) edits the decoded IK keys; `preimage` is the rig before the edit, for Undo to show. */
function editKeys(owner, characterId, mutate, preimage = null) {
	const keys = decodeMotionKeys(owner.layer(characterId).ikKeys);
	if (mutate(keys) === false) return false;
	const session = owner.beginAction(preimage ? new Map([[characterId, preimage]]) : null);
	try { session.run(() => owner.setKeys(characterId, keys)); session.commit(); } catch (error) { session.cancel(); throw error; }
	return true;
}

/** Pose drag end over a take (motion.js ikDragEnd): returns true when Fix mode took the drag. */
export function bakeFixIsland({ appContext, owner, motion, drag, preimage = null }) {
	if (!motion || !fixModeOn()) return false;
	const state = appContext.shared.ikStateRef.current, characterId = appContext.shared.activeChar.id, at = drag.frame;
	const keyed = bakeIkDragKey(state.chains, state.fkJoints, at, drag.ids, (rig, f) => appContext.shared.poseMemberAtFrame(rig, motion, null, f));
	if (!keyed?.size) return true;
	const layer = owner.layer(characterId), last = Math.max(0, (motion.frames ?? 1) - 1);
	const existing = islandsOf(layer.ikKeys).find((island) => island.frame === at);
	const fix = existing ? { id: existing.id, takeId: existing.takeId, before: existing.before, after: existing.after }
		: { id: `fix-${Math.random().toString(36).slice(2, 8)}`, takeId: layer.take?.studioTakeId ?? layer.take?.resourceId ?? null, before: Math.min(FIX_REACH, at), after: Math.min(FIX_REACH, last - at) };
	editKeys(owner, characterId, (keys) => {
		const entry = keys.get(at) ?? new Map();
		for (const [track, key] of keyed) entry.set(track, { ...key, fix: { ...fix }, blend: Math.max(1, fix.before, fix.after) });
		keys.set(at, entry);
	}, preimage);
	appContext.notify?.(ko(`Fix at frame ${at}: frames ${at - fix.before}–${at + fix.after} ease into it, the rest of the take stays`,
		`${at}프레임 보정: ${at - fix.before}–${at + fix.after}프레임이 부드럽게 이어지고 나머지 테이크는 그대로예요`,
		`第 ${at} 帧修正：第 ${at - fix.before}–${at + fix.after} 帧平滑过渡，其余片段不变`));
	return true;
}

/** A band edge drag: the island at `frame` now reaches `before` frames back and `after` frames on. */
export function setFixReach(owner, characterId, frame, before, after) {
	return editKeys(owner, characterId, (keys) => {
		const entry = keys.get(frame), fixed = entry && [...entry.values()].filter((key) => key.fix);
		if (!fixed?.length || (fixed[0].fix.before === before && fixed[0].fix.after === after)) return false;
		for (const key of fixed) { key.fix = { ...key.fix, before, after }; key.blend = Math.max(1, before, after); }
	});
}

/** Right-click on a band: the island's keys go (any plain key at that frame stays). */
export function removeFix(owner, characterId, frame) {
	return editKeys(owner, characterId, (keys) => {
		const entry = keys.get(frame);
		if (!entry || ![...entry.values()].some((key) => key.fix)) return false;
		for (const [track, key] of [...entry]) if (key.fix) entry.delete(track);
		if (!entry.size) keys.delete(frame);
	});
}
