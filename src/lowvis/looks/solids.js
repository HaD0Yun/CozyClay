// The solids of the looks that the inside measure reads (src/lowvis/pi/inside.mjs), with no three.js: the launcher and
// the agent sidecar import the measure, and the npm package ships without three (test/verify-package-agent-imports.mjs).
//
// drawn-solids.js keeps, per look, each solid's joint, corners and triangles as parts.js solidsOf takes them off the
// look as drawn (three's convex hull); the rest of a solid (its face normals, edges and the box around it) is worked
// out here with the same arithmetic as solidsOf, so the two give the same numbers. test/lowvis/verify-look-solids.mjs
// checks that they do for every look here, and with --write writes drawn-solids.js again from the looks.
import { DRAWN } from "./drawn-solids.js";

const key = a => a.map(x => x.toFixed(6)).join();

/** The unit normal of triangle [b, c, a] (solidsOf lists a face's corners from the head of its first edge, whose tail is
 *  a): (c - b) x (a - b), as three's Triangle.getNormal works it. */
function normalOf(v, [ib, ic, ia]) {
	const a = v[ia], b = v[ib], c = v[ic];
	const tx = c[0] - b[0], ty = c[1] - b[1], tz = c[2] - b[2], ux = a[0] - b[0], uy = a[1] - b[1], uz = a[2] - b[2];
	const x = ty * uz - tz * uy, y = tz * ux - tx * uz, z = tx * uy - ty * ux, l = x * x + y * y + z * z;
	if (!(l > 0)) return [0, 0, 0];
	const s = 1 / Math.sqrt(l);
	return [x * s, y * s, z * s];
}

/** A solid as solidsOf gives it ({ joint, v, t, n, e, c, h }) from its joint, corners v and triangles t. */
function solidOf({ joint, v, t }) {
	const normals = t.map(tri => normalOf(v, tri)), n = new Map(), e = new Map(), owner = new Map();
	// the face's edges run tail -> head: from its last corner to its first, then on round
	const edges = tri => tri.map((head, i) => [tri[(i + 2) % 3], head]);
	t.forEach((tri, f) => { for (const [p, q] of edges(tri)) owner.set(`${p},${q}`, f); });
	t.forEach((tri, f) => {
		n.set(key(normals[f]), normals[f]);
		for (const [tail, head] of edges(tri)) {
			const [p, q] = [tail, head].sort((x, y) => x - y);
			e.set(`${p},${q}`, [p, q, normals[f], normals[owner.get(`${head},${tail}`)]]);
		}
	});
	const lo = [0, 1, 2].map(k => Math.min(...v.map(p => p[k]))), hi = [0, 1, 2].map(k => Math.max(...v.map(p => p[k])));
	return { joint, v, t, n: [...n.values()], e: [...e.values()], c: lo.map((x, k) => (x + hi[k]) / 2), h: lo.map((x, k) => (hi[k] - x) / 2) };
}

/** { look: () => its solids }, for every look drawn-solids.js keeps. */
export const LOOK_SOLIDS = Object.freeze(Object.fromEntries(Object.entries(DRAWN).map(([look, rows]) => [look, () => rows.map(solidOf)])));
