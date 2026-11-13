// Fix islands: a hand correction of one frame of an installed take (Pose mode's Fix, domains/motion/fix-islands.js).
// An island is the IK keys at one frame whose track keys carry `fix` = { id, takeId, before, after }: delta keys over the
// take (baseQ / basePos, the take's own pose at that frame), so evaluation is take pose + delta * weight(frame) and a new
// take keeps the same corrections. The weight is 1 on the key frame and eases smoothly to 0 across `before` frames back
// and `after` frames on; outside [frame - before, frame + after] it is exactly 0, so those frames are the take untouched.
// A HELD fix (`fix.hold` = { in, out }) keeps the keyed pose itself across its band: weight 1 from the key out to the last
// `in` / `out` frames of each side, which ease to 0 (0 = no ease, the band runs to the take's first or last frame), and
// ik.js applies the key's own rotations there instead of the delta, so the limb stays as posed while the take moves on.
// Pure: ik.js (ikEvaluate) and the node tests import it.

const smooth = (t) => t * t * (3 - 2 * t);

const islandWeight = (fix, back, gap, reach) => {
	if (!fix.hold) return smooth(1 - gap / (reach + 1));
	const ease = Math.min(reach, back ? fix.hold.in : fix.hold.out), plateau = reach - ease;
	return gap <= plateau ? 1 : smooth(1 - (gap - plateau) / (ease + 1));
};

/** Whether the fix that weighs most on `trackId` at `frame` is a held one (ik.js: apply the keyed pose, not the delta). */
export function fixHeld(keys, trackId, frame) {
	let best = 0, held = false;
	for (const [at, entry] of keys) {
		const fix = entry.get(trackId)?.fix;
		if (!fix) continue;
		const gap = Math.abs(frame - at), reach = frame < at ? fix.before : fix.after;
		if (gap > reach) continue;
		const weight = islandWeight(fix, frame < at, gap, reach);
		if (weight > best) { best = weight; held = Boolean(fix.hold); }
	}
	return held;
}

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
		if (gap <= reach) best = Math.max(best, islandWeight(key.fix, frame < at, gap, reach));
	}
	if (!found) return null;
	return ikState?.fixView === "original" ? 0 : best;
}

// The body parts a fix (or a plain IK key) belongs to: the timeline opens one row per part (TimelineFixIslands.jsx),
// so a head fix and an arm fix over the same frames never share a band.
export const FIX_PARTS = ["head", "torso", "leftArm", "rightArm", "leftLeg", "rightLeg", "other"];
const PART_OF = { neck: "head", head: "head", hips: "torso", spine: "torso", chest: "torso",
	leftFoot: "leftLeg", leftKnee: "leftLeg", rightFoot: "rightLeg", rightKnee: "rightLeg" };
/** The part of an IK / FK track id; hands, elbows, shoulders and fingers are the arm of their side. */
export const partOf = (track) => PART_OF[track] ?? (/^left/.test(track) ? "leftArm" : /^right/.test(track) ? "rightArm" : "other");

/** The frames of each part's plain (non-fix) keys: Map(part -> sorted frames). */
export function partKeyFrames(rows = []) {
	const out = new Map();
	for (const row of rows) for (const [track, key] of Object.entries(row.tracks ?? {})) {
		if (key.fix || track === "placement") continue;
		const part = partOf(track);
		if (!out.has(part)) out.set(part, new Set());
		out.get(part).add(row.frame);
	}
	return new Map([...out].map(([part, frames]) => [part, [...frames].sort((a, b) => a - b)]));
}

/** The corrections of a stored layer's IK key rows (motion-intent-codec.js shape), in frame order, for A/B, the original
 * ghost and Send fixes: { id, takeId, frame, before, after, start, end, tracks } with [start, end] clamped to the
 * timeline. A fix key (fix-keys.js) is one per pose key and reaches to its tracks' neighbouring keys; rest keys are none. */
export function islandsOf(rows = [], frameCount = Infinity) {
	const framesOf = new Map();
	for (const row of rows) for (const [track, key] of Object.entries(row.tracks ?? {})) if (key.fix) framesOf.set(track, [...(framesOf.get(track) ?? []), row.frame]);
	const out = [];
	for (const row of rows) {
		const tracks = Object.entries(row.tracks ?? {}).filter(([, key]) => key.fix && !key.fix.rest);
		if (!tracks.length) continue;
		const { id, takeId = null } = tracks[0][1].fix;
		const reach = ([track, key], side) => { if (!key.fix.kf) return key.fix[side < 0 ? "before" : "after"]; const near = framesOf.get(track).filter((f) => (side < 0 ? f < row.frame : f > row.frame)); return near.length ? Math.abs((side < 0 ? Math.max(...near) : Math.min(...near)) - row.frame) : 0; };
		const before = Math.max(...tracks.map((entry) => reach(entry, -1))), after = Math.max(...tracks.map((entry) => reach(entry, 1)));
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
