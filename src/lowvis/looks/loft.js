// Lofts for the mannequin looks. A part is a stack of cross-sections along an axis: a form cut with a knife, then
// brushed over once. The tables give few sections with few corners; the drawn mesh rounds them off:
//   around   a closed smooth curve through a section's POINTS corners, drawn with DRAWN corners
//   along    rings between two table rows that are more than LEDGE apart, on a monotone cubic (no overshoot);
//            rows closer than that keep their straight wall, so a ledge that is meant stays a ledge
//   shading  facets that meet at less than CREASE are blended (see `brushed`); sharper edges stay crisp
//   cut ends a small 45 degree bevel between the wall and the end face, so the rim catches the light
//   creases  a row named in `hard` is a cut line: the curves do not bend through it and its edge stays crisp
//
// A table section is a closed polygon of POINTS corners around the part's axis, given either as POINTS radii (corner
// k at k * 30 degrees from the part's front toward its side: an oval, an egg) or as POINTS points [front, side] in the
// section's plane (a rounded rectangle with flat faces). Corner 0 is the front ridge, corner 6 the back.
// Points in space are plain [x, y, z] arrays in the caller's space.
import * as THREE from "three";

export const POINTS = 12; // corners of a section in the tables
const DRAWN = POINTS * 2; // corners of a drawn section: one more between every two of the table's
const LEDGE = 0.026; // m: two table rows no further apart than this keep one straight wall between them
const STEP_EDGE = 0.013; // m: two rows no further apart than this are a step; the curves beside it do not bend into it
const STEP = 0.03; // m between drawn rings where the rows are further apart (at least one ring goes in between)
const BEVEL = 0.003; // m, the bevel at a cut end
const CREASE = Math.cos((60 * Math.PI) / 180); // facets that meet at less than 60 degrees are blended

const add = (a, b, k = 1) => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = a => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/** Monotone cubic through (xs, ys): returns f(i, x) for x between xs[i] and xs[i + 1]. Flat where the data is flat. */
function monotone(xs, ys) {
	const n = xs.length, h = [], d = [], m = new Array(n);
	for (let i = 0; i + 1 < n; i++) { h[i] = xs[i + 1] - xs[i]; d[i] = (ys[i + 1] - ys[i]) / h[i]; }
	m[0] = d[0]; m[n - 1] = d[n - 2];
	for (let i = 1; i + 1 < n; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (3 * (h[i - 1] + h[i])) / ((2 * h[i] + h[i - 1]) / d[i - 1] + (h[i] + 2 * h[i - 1]) / d[i]);
	return (i, x) => {
		const u = (x - xs[i]) / h[i], u2 = u * u, u3 = u2 * u;
		return ys[i] * (2 * u3 - 3 * u2 + 1) + h[i] * m[i] * (u3 - 2 * u2 + u) + ys[i + 1] * (3 * u2 - 2 * u3) + h[i] * m[i + 1] * (u3 - u2);
	};
}

/** A table row [t, offsetSide, offsetFront, radii or points] with its section as POINTS points [front, side]. */
const pointed = ([t, os, of, shape]) => [t, os, of, shape.map((r, k) => (Array.isArray(r) ? r : [r * Math.cos((2 * Math.PI * k) / POINTS), r * Math.sin((2 * Math.PI * k) / POINTS)]))];

/** A run of rows [t, offsetSide, offsetFront, points] with rings added between rows that are more than LEDGE apart.
 * A run of two rows is one straight wall: a flat plane where the sections have flat faces. */
function smooth(rows) {
	if (rows.length < 3) return rows;
	const ts = rows.map(r => r[0]), curve = get => monotone(ts, rows.map(get));
	const os = curve(r => r[1]), of = curve(r => r[2]);
	const pts = Array.from({ length: POINTS }, (_, k) => [curve(r => r[3][k][0]), curve(r => r[3][k][1])]);
	const out = [];
	for (let i = 0; i + 1 < rows.length; i++) {
		out.push(rows[i]);
		const gap = ts[i + 1] - ts[i], n = gap <= LEDGE ? 1 : Math.max(2, Math.round(gap / STEP));
		for (let j = 1; j < n; j++) { const t = ts[i] + (gap * j) / n; out.push([t, os(i, t), of(i, t), pts.map(([u, v]) => [u(i, t), v(i, t)])]); }
	}
	return [...out, rows.at(-1)];
}

/** The drawn rows of a part: its table rows, smoothed run by run. A step (two rows within STEP_EDGE) ends a run, and
 * so does a row at a `hard` t: that row closes one run and opens the next, so the surface turns there. */
function dense(rows, hard) {
	const out = [];
	for (let i = 1, from = 0, shared = false; i <= rows.length; i++) {
		const last = i === rows.length, step = !last && rows[i][0] - rows[i - 1][0] <= STEP_EDGE;
		const crease = !last && !step && i - 1 > from && hard.some(h => Math.abs(h - rows[i - 1][0]) < 1e-9);
		if (!last && !step && !crease) continue;
		const run = smooth(rows.slice(from, i));
		out.push(...(shared ? run.slice(1) : run));
		from = crease ? i - 1 : i;
		shared = crease;
	}
	return out;
}

/** A section's outline as DRAWN points [front, side] in its plane: the table's corners and, between every two, the
 * middle of the closed centripetal Catmull-Rom curve through them. Corners need not be evenly spaced: a long flat
 * face next to a tight corner stays flat, and the corner stays round. */
function outline(p) {
	const out = [], gap = (a, b) => Math.max(1e-6, Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1])));
	const mix = (a, b, ta, tb, t) => [(a[0] * (tb - t) + b[0] * (t - ta)) / (tb - ta), (a[1] * (tb - t) + b[1] * (t - ta)) / (tb - ta)];
	for (let k = 0; k < POINTS; k++) {
		const a = p[(k + POINTS - 1) % POINTS], b = p[k], c = p[(k + 1) % POINTS], d = p[(k + 2) % POINTS];
		const t1 = gap(a, b), t2 = t1 + gap(b, c), t3 = t2 + gap(c, d), t = (t1 + t2) / 2;
		const a1 = mix(a, b, 0, t1, t), a2 = mix(b, c, t1, t2, t), a3 = mix(c, d, t2, t3, t);
		out.push(b, mix(mix(a1, a2, 0, t2, t), mix(a2, a3, t1, t3, t), t1, t2, t));
	}
	return out;
}

/**
 * Corner normals of a triangle soup after one pass of the brush: at every corner, the area-weighted mean of the
 * facet normals that share its point and its group and lie within the crease angle of its own facet's normal.
 * Groups keep a bevel and a cut end face apart from the wall, so their edges stay crisp.
 */
function brushed(position, normal, group) {
	const key = v => `${group[v]}|${Math.round(position[v * 3] * 1e5)},${Math.round(position[v * 3 + 1] * 1e5)},${Math.round(position[v * 3 + 2] * 1e5)}`;
	const at = new Map(); // group and point -> [[nx, ny, nz, area], ...] of the triangles that meet there
	for (let v = 0; v < group.length; v += 3) {
		const p = k => [position[(v + k) * 3], position[(v + k) * 3 + 1], position[(v + k) * 3 + 2]];
		const area = Math.hypot(...cross(sub(p(1), p(0)), sub(p(2), p(0)))) / 2;
		for (let k = 0; k < 3; k++) {
			const id = key(v + k);
			if (!at.has(id)) at.set(id, []);
			at.get(id).push([normal[v * 3], normal[v * 3 + 1], normal[v * 3 + 2], area]);
		}
	}
	const out = new Array(normal.length);
	for (let v = 0; v < group.length; v++) {
		const i = v * 3;
		let m = [0, 0, 0];
		for (const [x, y, z, area] of at.get(key(v))) if (x * normal[i] + y * normal[i + 1] + z * normal[i + 2] >= CREASE) m = add(m, [x, y, z], area);
		m = unit(m);
		out[i] = m[0]; out[i + 1] = m[1]; out[i + 2] = m[2];
	}
	return out;
}

function geometryOf(position, normal, color) {
	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
	geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normal, 3));
	geometry.setAttribute("color", new THREE.Float32BufferAttribute(color, 3));
	return geometry;
}

/**
 * The geometry of one part: brushed corner normals and one grey vertex colour per facet.
 *   origin, axis, side, front   the part's frame
 *   rows                        sections in order along the axis: [t, offsetSide, offsetFront, shape], t in metres
 *                               from origin, the offsets move the section's centre off the axis, shape has POINTS
 *                               radii or POINTS points [front, side]
 *   hard                        t of the rows that are creases: a cut line with a crisp edge all round
 *   start, end                  the end faces: "cut" (in the darker `endTone`, behind a bevel, with a crisp rim) or
 *                               "flat" (in the body tone, blended into the wall where the wall closes in on it)
 * userData.front holds the front ridge at every drawn section as { p, n, t }, n the surface normal there.
 */
export function loft({ origin, axis, side, front, rows, hard = [], start = "cut", end = "cut", endTone = 0.8 }) {
	const a = unit(axis), s = unit(sub(side, a.map(v => v * dot(side, a))));
	let f = sub(front, a.map(v => v * dot(front, a)));
	f = unit(sub(f, s.map(v => v * dot(f, s))));
	const sections = dense(rows.map(pointed), hard).map(([t, os, of, pts]) => ({ t, os, of, pts: outline(pts) }));
	// A cut end: the wall stops one bevel short of the end, and the end face is one bevel smaller all round.
	const smaller = (sec, b) => ({ ...sec, pts: sec.pts.map(([u, v]) => { const k = 1 - b / Math.hypot(u, v); return [u * k, v * k]; }) });
	const bevel = sec => Math.min(BEVEL, Math.min(...sec.pts.map(([u, v]) => Math.hypot(u, v))) / 4);
	if (start === "cut") { const e = sections[0], b = bevel(e); sections.splice(0, 1, smaller(e, b), { ...e, t: e.t + b }); }
	if (end === "cut") { const e = sections.at(-1), b = bevel(e); sections.splice(-1, 1, { ...e, t: e.t - b }, smaller(e, b)); }

	const centres = sections.map(({ t, os, of }) => add(add(add(origin, a, t), s, os), f, of));
	const rings = sections.map(({ pts }, i) => pts.map(([u, v]) => add(add(centres[i], f, u), s, v)));
	// Corners run from the front toward the side. Which way that turns round the axis depends on the frame's
	// handedness (a right limb mirrors a left one), and decides the order that makes a facet face outward.
	const turned = dot(cross(s, f), a) > 0;

	const position = [], normal = [], color = [], group = [];
	/** One facet through `points` (given so that it faces outward in a left-handed frame), fanned from its first corner. */
	const facet = (points, tone = 1, g = 0) => {
		const order = turned ? [...points].reverse() : points;
		let n = [0, 0, 0];
		order.forEach((p, i) => { const q = order[(i + 1) % order.length]; n = add(n, [(p[1] - q[1]) * (p[2] + q[2]), (p[2] - q[2]) * (p[0] + q[0]), (p[0] - q[0]) * (p[1] + q[1])]); });
		if (Math.hypot(...n) < 1e-12) return; // no area
		n = unit(n);
		for (let i = 1; i + 1 < order.length; i++) for (const p of [order[0], order[i], order[i + 1]]) { position.push(...p); normal.push(...n); color.push(tone, tone, tone); group.push(g); }
	};
	// Groups: 1 and 2 the bevels, 3 and 4 the cut end faces, 10 and up the wall (and a flat end), one group between
	// every two creases.
	const lastWall = rings.length - 2, wall = i => 10 + hard.filter(h => sections[i].t >= h - 1e-9).length;
	for (let i = 0; i <= lastWall; i++) for (let k = 0; k < DRAWN; k++) {
		const k1 = (k + 1) % DRAWN;
		facet([rings[i][k], rings[i][k1], rings[i + 1][k1], rings[i + 1][k]], 1, i === 0 && start === "cut" ? 1 : i === lastWall && end === "cut" ? 2 : wall(i));
	}
	// End faces, fanned from the section's centre (a section may be a little hollow between two corners). A face
	// looks away from the part: the start face against the axis (its ring runs the other way round), the end face along it.
	const cap = (ring, centre, isCut, g, flip) => {
		for (let k = 0; k < DRAWN; k++) facet(flip ? [centre, ring[(k + 1) % DRAWN], ring[k]] : [centre, ring[k], ring[(k + 1) % DRAWN]], isCut ? endTone : 1, g);
	};
	cap(rings[0], centres[0], start === "cut", start === "cut" ? 3 : wall(0), true);
	cap(rings.at(-1), centres.at(-1), end === "cut", end === "cut" ? 4 : wall(lastWall), false);

	const geometry = geometryOf(position, brushed(position, normal, group), color);
	const line = rings.map(ring => ring[0]);
	geometry.userData.front = line.map((p, i) => {
		const n = unit(cross(sub(line[Math.min(i + 1, line.length - 1)], line[Math.max(i - 1, 0)]), s));
		return { p, n: dot(n, f) < 0 ? n.map(v => -v) : n, t: sections[i].t };
	});
	return geometry;
}

/** A thin strip lying on a surface along `line` ([{ p, n }]), `width` wide and lifted `lift` off it: an engraved line. */
export function ribbon(line, width, lift, tone) {
	const position = [], normal = [], color = [];
	const edge = line.map(({ p, n }, i) => {
		const across = unit(cross(n, sub(line[Math.min(i + 1, line.length - 1)].p, line[Math.max(i - 1, 0)].p)));
		return [-1, 1].map(k => add(add(p, n, lift), across, (k * width) / 2));
	});
	for (let i = 0; i + 1 < edge.length; i++) for (const [j, k] of [[i, 0], [i, 1], [i + 1, 1], [i, 0], [i + 1, 1], [i + 1, 0]]) {
		position.push(...edge[j][k]); normal.push(...line[j].n); color.push(tone, tone, tone);
	}
	return geometryOf(position, normal, color);
}
