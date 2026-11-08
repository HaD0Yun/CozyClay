// Contact runs of the v4 measure tool: an end (palm, fingertips, sole point, knee, elbow, buttocks,
// head top) is in contact with the floor or a box while its skin gap (signed distance minus the
// end's radius) is at most GAP, for MIN_FRAMES frames or more. slide is the largest travel of the
// point along the surface over the run, read in the surface's own frame (a moving box carries the
// frame), so a foot planted on a moving platform does not slide. On the floor and on a box top that
// is the horizontal travel.
import { apply, sub, scale, dot, len, T } from "../../motion3/compiler/math.js";
import { boxNormal } from "../../motion3/qa/geometry.js";
import { contactEnds } from "./probes.js";
import { surfacesAt, sdTo } from "./penetration.js";

const GAP = 0.02, MIN_FRAMES = 2;
const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;

/** Point p in the frame of surface sf (the box's base pivot and rotation; the floor is the world). */
const local = (sf, p) => (sf.box ? apply(T(sf.box.R), sub(p, sf.box.pos)) : p);

/** The surface normal at the run's first point, in the surface's own frame. */
const normalOf = (sf, p) => (sf.box ? apply(T(sf.box.R), boxNormal(p, sf.box)) : [0, 1, 0]);

/**
 * contactRuns(out, { from, to, parts, against, gap, minFrames }) -> { runs }
 * runs: { end, against, from, to, minGap (m), slide (m) }, by end then start frame.
 * parts (contact end names) and against (surface ids): Sets, or null for all.
 */
export function contactRuns(out, { from = 0, to = out.frames.length - 1, parts = null, against = null, gap = GAP, minFrames = MIN_FRAMES } = {}) {
	const sk = out.ctx.sk, open = new Map(), runs = [];
	const close = (key, run) => {
		open.delete(key);
		if (run.to - run.from + 1 >= minFrames) runs.push({ end: run.end, against: run.against, from: run.from, to: run.to, minGap: round(run.minGap, 4), slide: round(run.slide, 4) });
	};
	for (let f = from; f <= to; f++) {
		const seen = new Set();
		let ends = contactEnds(sk, out.frames[f].s);
		if (parts) ends = ends.filter(e => parts.has(e.end));
		for (const sf of surfacesAt(out, f, against)) for (const e of ends) {
			let best = Infinity, at = 0;
			e.pts.forEach((p, i) => {
				const g = sdTo(sf, p, e.r + gap) - e.r;
				if (g < best) { best = g; at = i; }
			});
			if (best > gap) continue;
			const key = `${e.end}|${sf.id}`;
			let run = open.get(key);
			if (!run) {
				const q0 = local(sf, e.pts[at]);
				run = { end: e.end, against: sf.id, from: f, to: f, minGap: best, slide: 0, at, q0, n: normalOf(sf, e.pts[at]) };
				open.set(key, run);
			}
			const d = sub(local(sf, e.pts[run.at] ?? e.pts[at]), run.q0), along = sub(d, scale(run.n, dot(d, run.n)));
			run.to = f;
			run.minGap = Math.min(run.minGap, best);
			run.slide = Math.max(run.slide, len(along));
			seen.add(key);
		}
		for (const [key, run] of open) if (!seen.has(key)) close(key, run);
	}
	for (const [key, run] of open) close(key, run);
	runs.sort((a, b) => a.end.localeCompare(b.end) || a.from - b.from);
	return { runs };
}
