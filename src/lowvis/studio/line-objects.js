// A clip's line (clip.js lines) as Studio objects: one thin box per segment, named "<line id>~<k>", each moved by a
// track of a take as any prop that moves (install.js), so the Studio draws, plays, saves and loads it with no object of
// a new kind. scene.js tells such a set back as the one line it is (studioLines), not as its segments, and outside the
// count of props it lists. Browser-safe and node-safe.

/** The name of segment k of line id, and its reading: [line id, k] or null. */
const segmentName = (id, k) => `${id}~${String(k).padStart(2, "0")}`;
const SEGMENT = /^(.+)~(\d{2,})$/;
const segmentOf = name => { const m = SEGMENT.exec(String(name ?? "")); return m ? [m[1], Number(m[2])] : null; };

/** The segments of clip line l as clip props: { id, size: [length + thick, thick, thick], pos: [F*3], quat: [F*4], by,
 *  shown? }, each a box along its own X from point k to point k + 1 on every frame. */
export function lineSegments(l, F) {
	const n = l.segments, t = l.thick, out = Array.from({ length: n }, (_, k) => ({ id: segmentName(l.id, k), size: [l.length / n + t, t, t], pos: new Float32Array(F * 3), quat: new Float32Array(F * 4), ...(l.by ? { by: l.by } : {}), ...(l.shown ? { shown: l.shown } : {}) }));
	for (let f = 0; f < F; f++) lineBoxes(l, f).forEach((b, k) => { out[k].pos.set(b.c, f * 3); out[k].quat.set(b.q, f * 4); });
	return out;
}

/** Line l of a clip on frame f as boxes { c, q, size }, one per segment from its point k to k + 1 (its own X along
 *  that), as long as the segment and as thick as the line plus that thickness along it (at least min thick). */
export function lineBoxes(l, f, min = 0) {
	const out = [], t = Math.max(min, l.thick), o = f * (l.segments + 1) * 3, P = i => [l.points[o + i * 3], l.points[o + i * 3 + 1], l.points[o + i * 3 + 2]];
	for (let i = 0; i < l.segments; i++) {
		const a = P(i), b = P(i + 1), d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], n = Math.hypot(...d) || 1, x = d.map(v => v / n), w = 1 + x[0], h = Math.hypot(x[2], x[1], w) || 1;
		out.push({ c: a.map((v, k) => (v + b[k]) / 2), q: w < 1e-6 ? [0, 0, 1, 0] : [0, -x[2] / h, x[1] / h, w / h], size: [n + t, t, t] }); // q: the turn that takes +X along the segment
	}
	return out;
}

/** The lines among the Studio's object rows: the segments named by segmentName of a line the scene of a playing take
 *  has (lines: Map(id -> that scene's line prop)), and any other whole set of them (4 or more, numbered from 0 with none
 *  missing: a line no take plays any more), whose length and thickness are then read off the boxes themselves.
 *  -> { props: [{ id, line, at }], ids: { <line id>: { ids: [Studio ids in order], length, thick } }, rows: Set of the
 *  rows taken }. at: the middle of the segments' places as the Studio holds them now. */
export function studioLines(rows, lines) {
	const sets = new Map(), r3 = v => Math.round(v * 1000) / 1000, fin = v => (Number.isFinite(v) ? v : 1);
	for (const row of rows) {
		const seg = row && !row.hidden ? segmentOf(row.name) : null;
		if (seg) (sets.get(seg[0]) ?? sets.set(seg[0], []).get(seg[0])).push({ k: seg[1], row });
	}
	const props = [], ids = {}, taken = new Set();
	for (const [id, list] of sets) {
		list.sort((a, b) => a.k - b.k);
		const whole = list.length >= 4 && list.every((e, k) => e.k === k), box = list[0].row, thick = fin(box.height) * fin(box.scaleY); // a segment's box: [its length + thick, thick, thick]
		const line = lines.get(id)?.line ?? (whole && thick > 0 ? { length: r3(list.length * (fin(box.footprint?.width) * fin(box.scaleX) - thick)), thick: r3(thick) } : null);
		if (!line || !(line.length > 0)) continue;
		const mean = k => r3(list.reduce((s, e) => s + (Number(e.row[k]) || 0), 0) / list.length);
		props.push({ id, line: { length: line.length, thick: line.thick }, at: [mean("x"), r3(mean("y") + line.thick / 2), mean("z")] });
		ids[id] = { ids: list.map(e => e.row.id), length: line.length, thick: line.thick };
		for (const e of list) taken.add(e.row);
	}
	return { props, ids, rows: taken };
}
