// Where a line is, for a hand target {on: lineId, at: metres along it} (share.js onPoint) and for line.js.
import { mixV } from "./math.js";

/** The key of the props map under which the engine keeps its lines (a symbol: no loop over the box props sees it). */
export const LINES = Symbol("lines");
export const point3 = (x, i) => [x[i * 3], x[i * 3 + 1], x[i * 3 + 2]];

/** The middle of line `id` of the props map as it ended the last frame solved (a look at a line: engine.js), or null
 *  when no line has that id. */
export const lineMiddle = (props, id) => { const l = props[LINES]?.get(id); return l ? linePoint(l, l.L / 2) : null; };

/** A world point of line l at s metres along it, as it ended the last frame solved. */
export function linePoint(l, s = 0) {
	const u = Math.max(0, Math.min(l.N, (Number.isFinite(s) ? s : 0) / l.seg)), i = Math.min(l.N - 1, Math.floor(u));
	return mixV(point3(l.x, i), point3(l.x, i + 1), u - i);
}
