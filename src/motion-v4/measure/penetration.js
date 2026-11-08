// Penetration table of the v4 measure tool: how deep each body part goes into the floor (y = 0)
// and into every scene box, per frame. depth = max over the part's probes of r - signed distance
// (qa/geometry.js sdBox, or p.y for the floor). Rows deeper than the tolerance are kept.
import { sdBox } from "../../motion3/qa/geometry.js";
import { len } from "../../motion3/compiler/math.js";
import { bodyProbes } from "./probes.js";

const FLOOR = { id: "floor", box: null };
const prepared = new WeakMap();
const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;

/**
 * Surfaces of frame i: the floor, then every scene box of out.objectsAt(i) (the filter of
 * qa/ground.js), each with its centre and bounding radius. against: a Set of ids, or null for all.
 */
export function surfacesAt(out, i, against = null) {
	const objs = out.objectsAt(i);
	let list = prepared.get(objs);
	if (!list) {
		list = [FLOOR, ...Object.entries(objs).filter(([, b]) => b?.half && !b.ignore).map(([id, box]) => {
			const h = box.half[1], c = [box.pos[0] + box.R[0][1] * h, box.pos[1] + box.R[1][1] * h, box.pos[2] + box.R[2][1] * h];
			return { id, box, c, r: len(box.half) };
		})];
		prepared.set(objs, list);
	}
	return against ? list.filter(sf => against.has(sf.id)) : list;
}

/** Signed distance from p to surface sf, or Infinity when it is surely more than `limit`. */
export function sdTo(sf, p, limit = Infinity) {
	if (!sf.box) return p[1];
	if (Math.hypot(p[0] - sf.c[0], p[1] - sf.c[1], p[2] - sf.c[2]) - sf.r > limit) return Infinity;
	return sdBox(p, sf.box);
}

/** The worst row per key (part or surface), with the number of frames that key has rows on. */
function worstBy(rows, key, other) {
	const best = new Map(), frames = new Map();
	for (const r of rows) {
		if (!(best.get(r[key])?.depth >= r.depth)) best.set(r[key], r);
		(frames.get(r[key]) ?? frames.set(r[key], new Set()).get(r[key])).add(r.f);
	}
	return [...best.values()].sort((a, b) => b.depth - a.depth)
		.map(r => ({ [key]: r[key], [other]: r[other], f: r.f, depth: r.depth, frames: frames.get(r[key]).size }));
}

/**
 * penetrationRows(out, { from, to, parts, against, skin, tolerance }) -> { rows, worstByPart, worstBySurface, tolerance }
 * rows: { f, part, against, depth (m), point (the deepest probe, world) }, by frame.
 * parts and against: Sets of names, or null for all.
 */
export function penetrationRows(out, { from = 0, to = out.frames.length - 1, parts = null, against = null, skin = false, tolerance = 0.01 } = {}) {
	const sk = out.ctx.sk, rows = [];
	for (let f = from; f <= to; f++) {
		// a skin point at most `reach` from the bone's grid centre goes deeper than the tolerance
		// only where the centre is nearer a surface than reach - tolerance
		const surfaces = surfacesAt(out, f, against), lim = r => r - tolerance;
		const near = (c, reach) => surfaces.some(sf => sdTo(sf, c, lim(reach)) < lim(reach));
		let probes = bodyProbes(sk, out.frames[f].s, { skin, near });
		if (parts) probes = probes.filter(q => parts.has(q.part));
		for (const sf of surfaces) {
			const best = new Map();
			for (const q of probes) {
				const depth = q.r - sdTo(sf, q.p, q.r - tolerance);
				if (depth > tolerance && !(best.get(q.part)?.depth >= depth)) best.set(q.part, { depth, p: q.p });
			}
			for (const [part, b] of best) rows.push({ f, part, against: sf.id, depth: round(b.depth, 4), point: b.p.map(v => round(v, 3)) });
		}
	}
	return { rows, worstByPart: worstBy(rows, "part", "against"), worstBySurface: worstBy(rows, "against", "part"), tolerance };
}
