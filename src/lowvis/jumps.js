// One-frame jumps of a moving point: a step between two frames far outside the steps before and after it.
// Pure JS with no imports, for the writer's report (src/lowvis/pi/measure.mjs) and the Studio's take check
// (src/studio-agent-motion.js), so both measure the same thing.
//
// v(f) is the point's step from frame f - 1 to frame f. The jump into frame f is how far v(f) is from the nearer of
// v(f - 1) and v(f + 1), less half of how far those two are from each other: a step unlike both of its neighbours while
// they are like each other. In steps: a stop of one frame inside a steady move (v, 0, v) is v; a hop to a new place
// (0, d, 0) is d; a pop out and back (0, d, -d, 0) is d / 2 on both frames; a smooth speed-up, a start or a stop from
// a steady speed, or a turn back that stays turned (a hit) is near 0.

/** The least jump told, in metres (times a body's scale for its joints). */
export const JUMP = 0.05;

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = v => Math.hypot(v[0], v[1], v[2]);

/** The jump into each frame of one point: frames 2 .. F - 2 (the others have no step on both sides).
 *  at(f) -> [x, y, z]. Returns [{ f, size, steps: [|v(f-1)|, |v(f)|, |v(f+1)|] }] for every frame whose size is over min. */
export function jumpsOf(at, F, min = 0) {
	const out = [], p = Array.from({ length: F }, (_, f) => at(f)), v = f => sub(p[f], p[f - 1]);
	for (let f = 2; f <= F - 2; f++) {
		const a = v(f - 1), b = v(f), c = v(f + 1), size = Math.min(len(sub(b, a)), len(sub(b, c))) - len(sub(a, c)) / 2;
		if (size > min) out.push({ f, size, steps: [len(a), len(b), len(c)] });
	}
	return out;
}

/** The jumps of a group of points (the joints of one body, or one prop): tracks [{ part, at }], min in metres.
 *  -> null when no point jumps over min, else { part, f, size, steps } of the largest, with frames (how many frames
 *  have a jump over min in any part), first and last (those frames' range) and parts (the parts that jump, the
 *  largest first). */
export function groupJumps(tracks, F, min) {
	let worst = null;
	const frames = new Set(), parts = new Map();
	for (const { part, at } of tracks) for (const j of jumpsOf(at, F, min)) {
		frames.add(j.f);
		parts.set(part, Math.max(parts.get(part) ?? 0, j.size));
		if (!worst || j.size > worst.size) worst = { part, ...j };
	}
	if (!worst) return null;
	const list = [...frames];
	return { ...worst, frames: list.length, first: Math.min(...list), last: Math.max(...list), parts: [...parts].sort((a, b) => b[1] - a[1]).map(([part]) => part) };
}
