// What stands between a camera and the character at a frame. A contact sheet of a walled set can be all wall (door kick
// scene, 2026-11-01: 3 of 4 front tiles and 5 of 6 shot tiles showed no character) and nothing said so. Own views draw
// what blocks them see-through and name it; a shot camera sheet names it, because the shot is what the export shows.
// Pure over a compile result (compileSpec .out): straight rays from the eye to the joints against the scene's boxes.
import { sub, dot } from "./compiler/math.js";

const EPS = 1e-6;
// Share of the joints a box must hide to count: a hand resting on a table is not the table hiding the character.
const MIN_HIDDEN = 0.05;

/** Where a segment from eye to p enters a box { pos (base centre), R, half }, as 0..1 of its length; null when it misses. */
function entry(eye, p, box) {
	const axis = i => [box.R[0][i], box.R[1][i], box.R[2][i]];
	const c = [0, 1, 2].map(i => box.pos[i] + box.R[i][1] * box.half[1]);
	const d = sub(p, eye), o = sub(eye, c);
	let lo = 0, hi = 1;
	for (let i = 0; i < 3; i++) {
		const a = axis(i), start = dot(o, a), step = dot(d, a), h = box.half[i];
		if (Math.abs(step) < EPS) { if (Math.abs(start) > h) return null; continue; }
		const t0 = (-h - start) / step, t1 = (h - start) / step;
		lo = Math.max(lo, Math.min(t0, t1));
		hi = Math.min(hi, Math.max(t0, t1));
		if (lo > hi) return null;
	}
	return lo;
}

/** The ids of the boxes that hide each point from eye: { id: count of points }. */
export function hiddenBy(boxes, eye, points, skip = new Set()) {
	const by = {};
	for (const [id, box] of Object.entries(boxes)) {
		if (!box?.half || box.ignore || box.carried || skip.has(id)) continue;
		for (const p of points) if (entry(eye, p, box) !== null) by[id] = (by[id] ?? 0) + 1;
	}
	return by;
}

/**
 * What hides the character from eye at frame f: { share (0..1 of its joints behind any box), by: [ids that hide at least
 * MIN_HIDDEN of them, or that hide a focus point] }. focus: [{ p, own }] points that must show too, own the bodies they are on.
 */
export function blockersAt(out, eye, f, focus = []) {
	const joints = out.frames?.[f - (out.f0 ?? 0)]?.s.P ?? [], boxes = out.ctx.objectsAt?.(f) ?? {};
	if (!joints.length) return { share: 0, by: [] };
	const by = hiddenBy(boxes, eye, joints), ids = new Set(Object.keys(by).filter(id => by[id] / joints.length >= MIN_HIDDEN));
	for (const { p, own } of focus) for (const id of Object.keys(hiddenBy(boxes, eye, [p], new Set(own)))) ids.add(id);
	const hidden = joints.filter(p => Object.keys(hiddenBy(boxes, eye, [p])).length).length;
	return { share: Math.round((hidden / joints.length) * 100) / 100, by: [...ids].sort() };
}
