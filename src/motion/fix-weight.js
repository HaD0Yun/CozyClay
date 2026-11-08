// Fix islands: a hand correction of one frame of an installed take (Pose mode's Fix, domains/motion/fix-islands.js).
// An island is the IK keys at one frame whose track keys carry `fix` = { id, takeId, before, after }: delta keys over the
// take (baseQ / basePos, the take's own pose at that frame), so evaluation is take pose + delta * weight(frame) and a new
// take keeps the same corrections. The weight is 1 on the key frame and eases smoothly to 0 across `before` frames back
// and `after` frames on; outside [frame - before, frame + after] it is exactly 0, so those frames are the take untouched.
// Pure: ik.js (ikEvaluate) and the node tests import it.

const smooth = (t) => t * t * (3 - 2 * t);
export const FIX_REACH = 6;

/** The island weight of `trackId` at `frame`, or null when the track has no fix key (or mixes in plain keys: those
 * keep the regular correction weight). An ikState showing the original take (`fixView: "original"`) weighs 0. */
export function fixWeight(keys, trackId, frame, ikState = null) {
	let found = false, best = 0;
	for (const [at, entry] of keys) {
		const key = entry.get(trackId);
		if (!key) continue;
		if (!key.fix) return null;
		found = true;
		const gap = Math.abs(frame - at), reach = frame < at ? key.fix.before : key.fix.after;
		if (gap <= reach) best = Math.max(best, smooth(1 - gap / (reach + 1)));
	}
	if (!found) return null;
	return ikState?.fixView === "original" ? 0 : best;
}

/** The islands of a stored layer's IK key rows (motion-intent-codec.js shape), in frame order:
 * { id, takeId, frame, before, after, start, end, tracks } with [start, end] clamped to the timeline. */
export function islandsOf(rows = [], frameCount = Infinity) {
	const out = [];
	for (const row of rows) {
		const tracks = Object.entries(row.tracks ?? {}).filter(([, key]) => key.fix);
		if (!tracks.length) continue;
		const { id, takeId = null, before, after } = tracks[0][1].fix;
		out.push({ id, takeId, frame: row.frame, before, after, start: Math.max(0, row.frame - before), end: Math.min(frameCount - 1, row.frame + after), tracks: tracks.map(([track]) => track) });
	}
	return out.sort((a, b) => a.frame - b.frame);
}

/** Every bone's local transform under `rig`, by node (a rig may hold two skeletons with the same bone names), and back. */
export function holdBones(rig) {
	const saved = [];
	rig?.traverse((node) => { if (node.isBone) saved.push([node, node.position.clone(), node.quaternion.clone()]); });
	return () => { for (const [node, position, quaternion] of saved) { node.position.copy(position); node.quaternion.copy(quaternion); } rig?.updateMatrixWorld(true); };
}
