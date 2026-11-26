// What each line came out as, measured on the clip's points (clip.js lines) and the fastened points the engine kept
// (line.js aux.lines): per span between two fastened points, whether it was pulled straight (taut: the two points
// further apart than the line between them, so the clip draws that span longer) or hung slack (its sag: how far its
// lowest point lies under the straight line between the two points); a fastening that took a point over 0.05 m away in
// one frame; a point fastened under the floor (kept on it); the line (its middle) inside a solid prop's box or drawn part.
import { qConj, qMul, qRotate } from "../rig17.js";

const TAUT = 0.02, DEEP = 0.025, SEEN = 3; // taut: within 2 % of straight; inside: deeper than 25 mm on 3 frames or more
const n2 = v => (Math.abs(v) < 0.005 ? 0 : v).toFixed(2);
const P = (pts, base, i) => [pts[base + i * 3], pts[base + i * 3 + 1], pts[base + i * 3 + 2]];
const label = a => `${a.kind === "over" ? "over " : ""}${a.name}`;

/** Per line: { id, spans: [{ key, a, b, frames, first, last, taut, over, overAt, arc, sag, sagAt }], inside: { prop, mm, at, frames } | null,
 *  jumps, floor, free: frames with no point fastened, lowest: the lowest point's height over the clip }. */
function lineReport(clip, aux) {
	const F = clip.frameCount;
	return (clip.lines ?? []).map(line => {
		const told = aux.lines?.[line.id], n = line.segments, seg = line.length / n, R = line.thick / 2, pts = line.points, spans = new Map();
		let free = 0, lowest = Infinity;
		const deep = new Map();
		for (let f = 0; f < F; f++) {
			const base = f * (n + 1) * 3, list = (told?.spans[f] ?? []).filter((a, k, all) => k === 0 || all[k - 1].i !== a.i);
			if (!list.length) free++;
			for (let i = 0; i <= n; i++) lowest = Math.min(lowest, pts[base + i * 3 + 1] - R);
			for (let k = 0; k + 1 < list.length; k++) {
				const a = list[k], b = list[k + 1], pa = P(pts, base, a.i), pb = P(pts, base, b.i), arc = (b.i - a.i) * seg, chord = Math.hypot(pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]);
				let sag = 0;
				for (let i = a.i + 1; i < b.i; i++) { const u = (i - a.i) / (b.i - a.i); sag = Math.max(sag, pa[1] + (pb[1] - pa[1]) * u - P(pts, base, i)[1]); }
				const key = `${label(a)} - ${label(b)}`, s = spans.get(key) ?? { key, a: label(a), b: label(b), frames: 0, first: f, last: f, taut: 0, over: 0, overAt: null, arc: 0, sag: 0, sagAt: null };
				s.frames++; s.last = f; s.arc = Math.max(s.arc, arc);
				if (chord >= (1 - TAUT) * arc) s.taut++;
				if (chord - arc > s.over) { s.over = chord - arc; s.overAt = f; }
				if (chord < (1 - TAUT) * arc && sag > s.sag) { s.sag = sag; s.sagAt = f; }
				spans.set(key, s);
			}
			for (const solid of aux.lineSolids ?? []) {
				const p = clip.props.find(q => q.id === solid.id), m = p.pos.length === 3 ? 0 : f, c = [p.pos[m * 3], p.pos[m * 3 + 1], p.pos[m * 3 + 2]], q = [p.quat[m * 4], p.quat[m * 4 + 1], p.quat[m * 4 + 2], p.quat[m * 4 + 3]];
				let worst = 0;
				for (const b of solid.boxes) {
					const bc = qRotate(q, b.c).map((v, k) => v + c[k]), iq = qConj(qMul(q, b.q));
					for (let j = 0; j <= 2 * n; j++) { // every point and the middle of every segment (a segment may pass through a thin box)
						const at = j % 2 ? P(pts, base, (j - 1) / 2).map((v, k) => (v + P(pts, base, (j + 1) / 2)[k]) / 2) : P(pts, base, j / 2);
						const l = qRotate(iq, at.map((v, k) => v - bc[k])), pen = Math.min(...[0, 1, 2].map(k => b.h[k] - Math.abs(l[k]))); // the line's middle inside the box
						worst = Math.max(worst, pen);
					}
				}
				if (worst > DEEP) { const d = deep.get(solid.id) ?? { prop: solid.id, mm: 0, at: f, frames: 0 }; d.frames++; if (worst * 1000 > d.mm) { d.mm = worst * 1000; d.at = f; } deep.set(solid.id, d); }
			}
		}
		const inside = [...deep.values()].filter(d => d.frames >= SEEN || d.at === 0 || d.at === F - 1).sort((x, y) => y.mm - x.mm)[0] ?? null;
		return { id: line.id, length: line.length, segments: n, spans: [...spans.values()], inside, jumps: told?.jumps ?? [], floor: told?.floor ?? [], free, lowest };
	});
}

/** The tool's lines block: one line per span, per fastening that jumped, per point under the floor, the deepest prop it is in. */
export function lineLines(clip, aux) {
	const report = lineReport(clip, aux);
	if (!report.length) return [];
	const out = ["lines (as the engine solved them):"];
	for (const r of report) {
		out.push(`- ${r.id}: ${r.length} m in ${r.segments} segments; ${r.free ? `no point fastened on ${r.free} frames (it falls and lies); ` : ""}lowest point ${n2(r.lowest)} m over the floor`);
		for (const s of r.spans) {
			const taut = s.taut ? `taut on ${s.taut} of ${s.frames} frames${s.over > 0.005 ? `, the two points up to ${n2(s.over)} m further apart than the ${n2(s.arc)} m of line between them (f${s.overAt}; drawn that much longer)` : ""}` : "";
			const slack = s.taut < s.frames ? `slack${s.taut ? " on the rest" : ""}, sag up to ${n2(s.sag)} m${s.sagAt != null ? ` (f${s.sagAt})` : ""}` : "";
			out.push(`  - f${s.first}-${s.last} between ${s.a} and ${s.b}: ${[taut, slack].filter(Boolean).join("; ")}`);
		}
		for (const j of r.jumps) out.push(`  - f${j.f}: its point at ${j.s} m went ${n2(j.d)} m to ${j.name} in one frame (it was not there when fastened)`);
		if (r.floor.length) { const w = r.floor.reduce((x, y) => (y.d > x.d ? y : x)); out.push(`  - its point at ${w.s} m (${w.name}) was asked under the floor on ${r.floor.length} frames, up to ${n2(w.d)} m (f${w.f}); kept on the floor`); }
		if (r.inside) out.push(`  - inside ${r.inside.prop} up to ${Math.round(r.inside.mm)} mm on ${r.inside.frames} frames (f${r.inside.at})`);
	}
	return out;
}
