// The instances of one row's kind: a row names its worst instance, and the others of the same key come with it, so a
// kind's instances reach the writer together (told.mjs) and each is compared with itself at the next compile.
// instance: { a, b (its first and last frame), value (the row's unit), frame (its worst), tag (how the answer names
// it), of? (the action it is of when its frames move with that action: told.mjs takes two of one action as one),
// note? (a row's note when this instance is the one the row names), settled? (reach-why.mjs settledBy: false, or how
// far its value may move before told.mjs tells it again) }

/** The instances of one limb's reach entries, one per action (the entry's key, the action's frame): list = the entries
 *  by frame (null where it has none), value(e) = the miss in metres. Only an action whose worst is over least.
 *  -> [{ key, a, b, frames (over 10 mm), v, f }], the worst first (in frame order among equals, as measure.mjs's worst). */
export function byAction(list, value, least) {
	const acts = new Map();
	list.forEach((e, f) => {
		if (!e) return;
		const k = acts.get(e.key) ?? acts.set(e.key, { key: e.key, a: f, b: f, frames: 0, v: 0, f: null }).get(e.key), v = value(e);
		k.b = f;
		if (e.d > 0.01) k.frames++;
		if (v > Math.max(k.v, least)) Object.assign(k, { v, f });
	});
	return [...acts.values()].filter(k => k.f != null).sort((x, y) => y.v - x.v);
}

/** The runs of a set of frames: values = Map(frame -> value); frames closer than gap (in frames) are one run.
 *  -> [{ a, b, value, frame }], the worst first. */
export function runsOf(values, gap = 1) {
	const out = [];
	for (const f of [...values.keys()].sort((x, y) => x - y)) {
		const r = out.at(-1), v = values.get(f);
		if (r && f - r.b <= gap) { r.b = f; if (v > r.value) Object.assign(r, { value: v, frame: f }); } else out.push({ a: f, b: f, value: v, frame: f });
	}
	return out.sort((x, y) => y.value - x.value);
}

/** A run's name in an answer. */
export const spanTag = r => (r.a === r.b ? `f${r.a}` : `f${r.a}-${r.b}`);
/** Whether two instances share a frame. */
export const overlaps = (x, y) => x.a <= y.b && y.a <= x.b;
