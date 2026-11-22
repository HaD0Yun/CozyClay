// One-frame jumps of a moving point: a step between two frames far outside the steps before and after it.
// Pure JS with no imports, for the writer's report (src/lowvis/pi/measure.mjs) and the Studio's take check
// (src/studio-agent-motion.js), so both measure the same thing.
//
// v(f) is the point's step from frame f - 1 to frame f. The jump into frame f is how far v(f) is from the nearer of
// v(f - 1) and v(f + 1), less half of how far those two are from each other: a step unlike both of its neighbours while
// they are like each other. In steps: a stop of one frame inside a steady move (v, 0, v) is v; a hop to a new place
// (0, d, 0) is d; a pop out and back (0, d, -d, 0) is d / 2 on both frames; a smooth speed-up, a start or a stop from
// a steady speed, or a turn back that stays turned (a hit) is near 0. A fast turn about a far pivot reads as a jump
// though no frame differs from its neighbours: a point 1 m from the pivot, 4.5 cm while it turns 45 degrees a frame,
// 7 cm on the frames a turn of 36 degrees a frame starts and stops.
//
// Both reports measure the points whose place is asked for as a whole: where a body is (its Hips joint) and where a
// prop is. A knee, an elbow, a hand or a foot is placed by the engine's own solving between those; its jumps are in
// most clips that walk, run or push, and no word of a spec and no Studio edit addresses them.

/** The least jump told, in metres (times a body's scale for its Hips joint). The Studio's verify_result description
 *  (src/studio-agent-protocol.js) states it as a number of its own: change both. */
export const JUMP = 0.05;

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = v => Math.hypot(v[0], v[1], v[2]);

/** The jump into each frame of one point over the frames a .. b - 1 (default: all F): those with a step on both sides.
 *  at(f) -> [x, y, z]. Returns [{ f, size, steps: [|v(f-1)|, |v(f)|, |v(f+1)|] }] for every frame whose size is over min. */
export function jumpsOf(at, F, min = 0, a = 0, b = F) {
	const out = [], p = [], v = f => sub(p[f], p[f - 1]);
	for (let f = a; f < b; f++) p[f] = at(f);
	for (let f = a + 2; f <= b - 2; f++) {
		if (![f - 2, f - 1, f, f + 1].every(k => p[k].every(Number.isFinite))) continue; // a place that is no number has no step
		const x = v(f - 1), y = v(f), z = v(f + 1), size = Math.min(len(sub(y, x)), len(sub(y, z))) - len(sub(x, z)) / 2;
		if (size > min) out.push({ f, size, steps: [len(x), len(y), len(z)] });
	}
	return out;
}

/** The jumps of a group of points (the props of a clip, or one body's Hips joint): tracks [{ part, at, runs? }], min in
 *  metres; runs: the stretches of frames [a, b) the point is measured over (default: all F); told(track, f): whether a
 *  jump into frame f of that track counts (default: every one).
 *  -> null when no point jumps over min, else { part, f, size, steps } of the largest, with frames (how many frames
 *  have a jump over min in any part), first and last (those frames' range) and parts (the parts that jump, the
 *  largest first). */
export function groupJumps(tracks, F, min, told = () => true) {
	let worst = null;
	const frames = new Set(), parts = new Map();
	for (const t of tracks) for (const [a, b] of t.runs ?? [[0, F]]) for (const j of jumpsOf(t.at, F, min, a, b)) {
		if (!told(t, j.f)) continue;
		frames.add(j.f);
		parts.set(t.part, Math.max(parts.get(t.part) ?? 0, j.size));
		if (!worst || j.size > worst.size) worst = { part: t.part, ...j };
	}
	if (!worst) return null;
	const list = [...frames];
	return { ...worst, frames: list.length, first: Math.min(...list), last: Math.max(...list), parts: [...parts].sort((a, b) => b[1] - a[1]).map(([part]) => part) };
}
