// A leg is a length: the pelvis is never further from a planted ankle than the leg reaches (the solve lowers it to
// that). It moves as a body does, without a jolt: the pelvis comes down to the height a frame needs over the REACH_EASE
// frames before and goes back up over those after (a cosine bell, never under that height), so a foot that lands far
// ahead lowers the hips smoothly instead of for one frame. The frames of a walk, run or push along a path (gait.js
// travel) are marked; once the body layer is whole (size.js) the marked frames in a row know each other as they then
// are, and the solve (solve.js) lowers a frame by the need of the frames around it with this frame's layers on them:
// hips that a pose key or a crouch already holds lower are not lowered again, hips held higher come down as smoothly.
// The steps on the spot and to end spots keep the solve's own lowering.
const REACH_EASE = 4;

/** gait.js travel: marks its frames (body states B). Each has its own mark; a copy of a frame shares its mark. */
export function reachMarked(frames) {
	for (const B of frames) B.reach = {};
	return frames;
}

/** size.js: the finished body frames of one character, in order. The marked frames in a row get in their mark
 *  { set: those frames together, t: this one's place }. A later frame that shares a mark is a copy made for another
 *  time (a flight starts as the frame before it): it is no frame of a travel and loses the mark. */
export function reachTogether(frames) {
	const seen = new Set();
	let set = null;
	for (const B of frames) {
		const mark = B.reach;
		if (!mark || seen.has(mark)) { if (mark) delete B.reach; set = null; continue; }
		seen.add(mark); set ??= { frames: [], over: [], high: null };
		mark.set = set; mark.t = set.frames.push(B) - 1;
	}
	return frames;
}

/** solve.js: metres the frame of a travel with mark { set, t } is lowered for the frames around it. overOf(B): metres
 *  the pelvis of body-layer frame B is over its planted feet's reach with this frame's layers on it (under 0: room
 *  left; null: no foot planted); plain: this frame has no layer that moves the pelvis, so what overOf gives is every
 *  such frame's and is kept; highOf(B): the Hips' height over the floor in the body layer. */
export function reachAround({ set, t }, overOf, plain, highOf) {
	set.high ??= set.frames.map(highOf);
	let lower = 0;
	for (let k = -REACH_EASE; k <= REACH_EASE; k++) {
		const B = k && set.frames[t + k];
		if (!B) continue;
		const need = plain ? (set.over[t + k] === undefined ? (set.over[t + k] = overOf(B)) : set.over[t + k]) : overOf(B);
		// its part of that frame's need, and no lower than that frame then is
		if (need > 0) lower = Math.max(lower, Math.min(need * Math.cos(Math.PI * k / (2 * REACH_EASE + 2)) ** 2, need - (set.high[t + k] - set.high[t])));
	}
	return lower;
}
