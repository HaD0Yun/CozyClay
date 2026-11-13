// Fix keys on an installed take, for the motion owner (domains/motion.js) and the timeline's part rows
// (motion/TimelineFixIslands.jsx): a pose drag at a frame (Fix mode on) keys only the parts it moved, as fix keys
// (motion/fix-keys.js: pose keys and rest keys, played as plain keyframes over the take). The first key on a track gets a
// rest key KEY_EASE frames each side, so one drag is one correction that eases in and out; after that every edit is one
// key: move it, copy it (the pose holds between the two), remove it. Merge writes a part's keys into the take itself and
// clears its row, so the next layer of keys starts from that motion. Each edit here is one undo entry of the motion owner.
import { bakeIkDragKey } from "../../motion/ik-drag.js";
import { holdBones, partOf } from "../../motion/fix-weight.js";
import { controlBones, isTakeV3 } from "../../motion3/playback.js";
import { sourcePatch } from "../../motion3/take-baked.js";
import { KEY_EASE, isFixKey, isRestKey } from "../../motion/fix-keys.js";
import { fixModeOn } from "../../motion/fix-door.js";
import { decodeMotionKeys, encodeMotionKeys } from "./motion-intent-codec.js";
import { ko } from "../../locale.js";

/** One undo entry: mutate(keys) edits the decoded IK keys; `preimage` is the rig before the edit, for Undo to show. */
function editKeys(owner, characterId, mutate, preimage = null) {
	const keys = decodeMotionKeys(owner.layer(characterId).ikKeys);
	if (mutate(keys) === false) return false;
	const session = owner.beginAction(preimage ? new Map([[characterId, preimage]]) : null);
	try { session.run(() => owner.setKeys(characterId, keys)); session.commit(); } catch (error) { session.cancel(); throw error; }
	return true;
}

const lastFrame = (owner, characterId) => Math.max(0, (owner.motionFor?.(characterId)?.frames ?? Infinity) - 1);
const newId = () => `fix-${Math.random().toString(36).slice(2, 8)}`;
const restKey = (fix) => ({ q: null, p: null, fix: { id: fix.id, takeId: fix.takeId ?? null, kf: true, rest: true } });
const setAt = (keys, frame, track, key) => { if (!keys.has(frame)) keys.set(frame, new Map()); keys.get(frame).set(track, key); };
const dropAt = (keys, frame, track) => { const entry = keys.get(frame); if (!entry?.delete(track)) return; if (!entry.size) keys.delete(frame); };
/** The frames `track` has a key on, in order. */
const framesOf = (keys, track) => [...keys].filter(([, entry]) => entry.has(track)).map(([frame]) => frame).sort((a, b) => a - b);
/** The fix-keyed tracks of `part` (every one when `at` is null, else those keyed at that frame). */
const partTracks = (keys, part, at = null) => [...new Set((at === null ? [...keys.values()] : [keys.get(at)].filter(Boolean)).flatMap((entry) => [...entry].filter(([track, key]) => isFixKey(key) && partOf(track) === part).map(([track]) => track)))];
/** A track left with rest keys only says nothing: its keys go. */
function dropEmptyTracks(keys, tracks) {
	for (const track of tracks) {
		const frames = framesOf(keys, track);
		if (frames.length && frames.every((frame) => isRestKey(keys.get(frame).get(track)))) for (const frame of frames) dropAt(keys, frame, track);
	}
}

/** Pose drag end over a take (motion.js ikDragEnd): returns true when Fix mode took the drag. */
export function bakeFixIsland({ appContext, owner, motion, drag, preimage = null }) {
	if (!motion || !fixModeOn()) return false;
	const state = appContext.shared.ikStateRef.current, characterId = appContext.shared.activeChar.id, at = drag.frame;
	const keyed = bakeIkDragKey(state.chains, state.fkJoints, at, drag.ids, (rig, f) => appContext.shared.poseMemberAtFrame(rig, motion, null, f));
	if (!keyed?.size) return true;
	const layer = owner.layer(characterId), last = Math.max(0, (motion.frames ?? 1) - 1), takeId = layer.take?.studioTakeId ?? layer.take?.resourceId ?? null;
	const fresh = { id: newId(), takeId, kf: true };
	editKeys(owner, characterId, (keys) => {
		for (const [track, key] of keyed) {
			const frames = framesOf(keys, track).filter((frame) => frame !== at);
			// a track that already holds other kinds of keys keeps them: the drag adds one more of those
			if (frames.some((frame) => !isFixKey(keys.get(frame).get(track)))) { setAt(keys, at, track, key); continue; }
			const had = keys.get(at)?.get(track), fix = isFixKey(had) ? { id: had.fix.id, takeId, kf: true } : { ...fresh };
			setAt(keys, at, track, { ...key, fix });
			// A side with no key yet, or whose neighbour is a far rest key, gets its own rest key: the new pose eases in
			// (and out) over KEY_EASE frames instead of across the whole gap. A neighbouring pose key is left to interpolate.
			const rest = (frame) => { if (frame >= 0 && frame <= last && frame !== at && !keys.get(frame)?.has(track)) setAt(keys, frame, track, restKey(fix)); };
			const prev = frames.filter((frame) => frame < at).at(-1), next = frames.find((frame) => frame > at);
			if (prev === undefined) { if (at > 0) rest(Math.max(0, at - KEY_EASE)); } else if (isRestKey(keys.get(prev).get(track)) && prev < at - KEY_EASE) rest(at - KEY_EASE);
			if (next === undefined) { if (at < last) rest(Math.min(last, at + KEY_EASE)); } else if (isRestKey(keys.get(next).get(track)) && next > at + KEY_EASE) rest(at + KEY_EASE);
		}
	}, preimage);
	// short: the toast sits over the timeline, and the dots it announces are right under it
	appContext.notify?.(ko(`Key at frame ${at}`, `${at}프레임에 키`, `第 ${at} 帧关键帧`));
	return true;
}

/** Drag a part's dot from `from` toward `to` (or copy it there, `copy`): every fix key the part has at `from` moves.
 * A pose key carries the rest keys right beside it, so its ease in and out keep their length: a move shifts both, a copy
 * leaves the source and pushes the rest key on the far side past the copy (the pose then holds between the two). A rest
 * key moves alone. Nothing crosses another key or leaves the take: the move stops one frame short. */
export function moveFixKey(owner, characterId, part, from, to, copy = false) {
	const last = lastFrame(owner, characterId), dir = Math.sign(Math.round(to) - from);
	if (!dir) return false;
	return editKeys(owner, characterId, (keys) => {
		const plans = partTracks(keys, part, from).map((track) => {
			const frames = framesOf(keys, track), at = frames.indexOf(from), pose = !isRestKey(keys.get(from).get(track));
			const beside = (step) => (frames[at + step] !== undefined && isRestKey(keys.get(frames[at + step]).get(track)) ? frames[at + step] : null);
			// what moves with the dot: for a pose key the rest keys beside it (a copy: only the one ahead of it)
			const carried = (pose ? (copy ? [beside(dir)] : [beside(-1), beside(1)]) : []).filter((frame) => frame !== null);
			const moving = copy ? carried : [from, ...carried], lead = dir > 0 ? Math.max(from, ...moving) : Math.min(from, ...moving);
			const beyond = frames.filter((frame) => !moving.includes(frame) && frame !== from && (dir > 0 ? frame > lead : frame < lead)), stop = dir > 0 ? Math.min(last + 1, ...beyond) : Math.max(-1, ...beyond);
			return { track, moving, room: Math.max(0, Math.abs(stop - lead) - 1) };
		});
		const shift = dir * Math.min(Math.abs(Math.round(to) - from), ...plans.map((plan) => plan.room));
		if (!plans.length || !shift) return false;
		for (const { track, moving } of plans) {
			const source = keys.get(from).get(track), lifted = moving.map((frame) => [frame, keys.get(frame).get(track)]);
			for (const [frame] of lifted) dropAt(keys, frame, track);
			for (const [frame, key] of lifted) setAt(keys, frame + shift, track, key);
			if (copy) setAt(keys, from + shift, track, { ...source, q: source.q?.map((q) => q.clone()) ?? null, p: source.p?.clone() ?? null, fix: { ...source.fix, id: newId() } });
		}
	});
}

/** Right-click on a dot: the part's fix keys at `frame` go. */
export function removeFixKey(owner, characterId, part, frame) {
	return editKeys(owner, characterId, (keys) => {
		const tracks = partTracks(keys, part, frame);
		if (!tracks.length) return false;
		for (const track of tracks) dropAt(keys, frame, track);
		dropEmptyTracks(keys, tracks);
	});
}

/** Shift-click on a part's row: a rest key at `frame` on every fix-keyed track of the part (the part is the take's there). */
export function addRestKey(owner, characterId, part, frame) {
	const last = lastFrame(owner, characterId), at = Math.max(0, Math.min(last, Math.round(frame)));
	return editKeys(owner, characterId, (keys) => {
		const tracks = partTracks(keys, part).filter((track) => !keys.get(at)?.has(track));
		if (!tracks.length) return false;
		for (const track of tracks) setAt(keys, at, track, restKey(keys.get(framesOf(keys, track)[0]).get(track).fix));
	});
}

/** Merge: write the fix keys of one body part (`part` null: every part) into the take itself. Each frame they reach is
 * posed as it plays now and written over the take's own frames (motion3/take-baked.js), and the keys go: that motion IS
 * the take from here on, the row is clean, and the next keys are a new layer over it. One undo entry.
 * Keys on bones the take does not carry (fingers) or on a track that also holds other kinds of keys stay as they are.
 * Returns { merged, left }: how many pose keys went in / stayed. */
export function mergeFixKeys(owner, characterId, part = null) {
	const state = owner.liveIkStates().get(characterId), rig = state?.rig, take = owner.motionFor(characterId), layer = owner.layer(characterId);
	const keys = decodeMotionKeys(layer.ikKeys);
	const poses = (map) => [...map.values()].reduce((count, entry) => count + new Set([...entry].filter(([track, key]) => isFixKey(key) && !isRestKey(key) && (!part || partOf(track) === part)).map(([track]) => partOf(track))).size, 0);
	const total = poses(keys);
	if (!rig || !state.chains || !isTakeV3(take) || !total) return { merged: 0, left: total };
	const { bones, hips } = controlBones(rig, take.bones), carried = new Set(bones.filter(Boolean)), last = take.frames - 1;
	const bonesOf = (track) => state.chains.get(track)?.bones ?? (state.fkJoints?.get(track) ? [state.fkJoints.get(track).bone] : null);
	const tracks = [...new Set([...keys.values()].flatMap((entry) => [...entry.keys()]))].filter((track) => (!part || partOf(track) === part)
		&& framesOf(keys, track).every((frame) => isFixKey(keys.get(frame).get(track))) && Boolean(bonesOf(track)?.every((bone) => carried.has(bone))));
	// the keys that merge, alone in a scratch key map: the pose they give is what gets written
	const only = new Map(), rest = new Map();
	for (const [at, entry] of keys) for (const [track, key] of entry) setAt(tracks.includes(track) ? only : rest, at, track, key);
	const merged = poses(only), left = total - merged;
	if (!merged) return { merged, left };
	// a track whose first (last) key is a pose key holds that pose back to the take's first (on to its last) frame
	let start = Infinity, end = -Infinity;
	for (const track of tracks) { const frames = framesOf(only, track); start = Math.min(start, isRestKey(only.get(frames[0]).get(track)) ? frames[0] : 0); end = Math.max(end, isRestKey(only.get(frames.at(-1)).get(track)) ? frames.at(-1) : last); }
	start = Math.max(0, start); end = Math.min(last, end);
	const B = bones.length, count = end - start + 1, rot = new Float32Array(count * B * 4), pos = new Float32Array(count * 3);
	const restore = holdBones(rig), saved = { keys: state.keys, tracked: state.tracked, fixView: state.fixView };
	try {
		Object.assign(state, { keys: only, tracked: new Set(tracks), fixView: "fixed" });
		for (let f = start; f <= end; f += 1) {
			owner.poseRigAt(characterId, f);
			bones.forEach((bone, b) => { const i = ((f - start) * B + b) * 4; if (bone) bone.quaternion.toArray(rot, i); else rot.set(take.rot.subarray((f * B + b) * 4, (f * B + b) * 4 + 4), i); });
			if (bones[hips]) for (let k = 0; k < 3; k += 1) pos[(f - start) * 3 + k] = bones[hips].position.getComponent(k) / 100;
			else pos.set(take.hips.subarray(f * 3, f * 3 + 3), (f - start) * 3);
		}
	} finally { Object.assign(state, saved); restore(); }
	// only the bones (and the hips) the keys moved go into the patch
	const moved = (b) => { for (let f = start; f <= end; f += 1) { const i = ((f - start) * B + b) * 4, j = (f * B + b) * 4; if (1 - Math.abs(rot[i] * take.rot[j] + rot[i + 1] * take.rot[j + 1] + rot[i + 2] * take.rot[j + 2] + rot[i + 3] * take.rot[j + 3]) > 1e-10) return true; } return false; };
	const changed = bones.map((_, b) => b).filter(moved);
	let hipsMoved = false;
	for (let i = 0; i < count * 3 && !hipsMoved; i += 1) hipsMoved = Math.abs(pos[i] - take.hips[start * 3 + i]) > 1e-6;
	const picked = new Float32Array(count * changed.length * 4);
	for (let f = 0; f < count; f += 1) changed.forEach((b, j) => picked.set(rot.subarray((f * B + b) * 4, (f * B + b) * 4 + 4), (f * changed.length + j) * 4));
	// the patch lives in the take's source frames, before its timing edit (cut, speed), so a later edit carries it along
	const patch = changed.length || hipsMoved ? sourcePatch({ bones: changed.map((b) => take.bones[b]), start, end, rot: picked, hips: hipsMoved ? pos : null }, layer.take?.edit ?? null, owner.fullMotionFor(characterId)?.frameCount ?? take.frameCount) : null;
	const withPatch = (descriptor) => (descriptor && patch ? { ...descriptor, baked: [...(descriptor.baked ?? []), patch] } : descriptor);
	const session = owner.beginAction();
	try { session.run(() => owner.writeLayer(characterId, { ikKeys: encodeMotionKeys(rest), take: withPatch(layer.take), fullTake: withPatch(layer.fullTake) })); session.commit(); } catch (error) { session.cancel(); throw error; }
	return { merged, left };
}
