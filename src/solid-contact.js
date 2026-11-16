// Contact between posed things, read from what the viewport draws (solid-shape.js) instead of one box per record: how
// deep one body stands inside another (the placement check's overlap) and which drawn surface holds a body up (its
// support gap). A record's box is mostly air for a table, a chair, a bench, a counter or a stair, so two boxes cross
// where nothing touches: a chair tucked under a table, a cup on a counter beside the counter's machine, a body on a seat,
// feet on a step. A character is its posed bone points (the editor's bounds port): they lie inside the flesh, so a
// body resting on a seat keeps them above it and a body standing in a table puts them inside it.
import { objectSize } from './object-size.js';
import { solidOf } from './solid-shape.js';
import { mul, rx, ry, rz } from './motion3/compiler/math.js';

/** Deeper than this (m) is inside; less is touching: a foot set on a step, a cup on a table top, a counter set into a 2 cm
 * floor slab (seen in agent sets). An estimate: a couple of centimetres do not show in a picture. */
const TOUCH_M = 0.03;
/** A bone lies under a few centimetres of flesh: one this deep (m) in a solid puts the skin well inside it, a shin through a
 * 5 cm bench seat among them, while bones of a body resting on a seat or a step stay above its surface. */
const BONE_M = 0.015, LIMB_STEP_M = 0.01;
/** Two bodies share space when this share of one's bone points lies within BODY_GAP_M of the other's: hands that meet or
 * an arm round a back are a few points, a body standing in another is most of them. */
const BODY_SHARE = 0.25, BODY_GAP_M = 0.1;
const IDENTITY = [[1, 0, 0], [0, 1, 0], [0, 0, 1]], GRID = 8;
const pointOf = p => (Array.isArray(p) ? p : [p.x, p.y, p.z]);

/** Where an object stands as a motion box ({ pos: base centre, R, half }: motion3/scene.js) with its solid (null: the box is
 * the shape); a carried or routed object is the world box worldBox() answers ({ min, max } or null), with no solid. */
export function contactBody(o, worldBox) {
	if (o.attach || o.path) {
		const box = worldBox();
		return box && { box: { pos: [(box.min.x + box.max.x) / 2, box.min.y, (box.min.z + box.max.z) / 2], R: IDENTITY, half: ['x', 'y', 'z'].map(a => (box.max[a] - box.min[a]) / 2) } };
	}
	const size = objectSize(o);
	if (!(size.width > 0 && size.height > 0 && size.depth > 0)) return null;
	return { box: { pos: [o.x ?? 0, o.y ?? 0, o.z ?? 0], R: mul(rx(o.rotX ?? 0), mul(ry(o.rot ?? 0), rz(o.rotZ ?? 0))), half: [size.width / 2, size.height / 2, size.depth / 2] }, solid: solidOf(o) };
}

/** p in the box's own frame, from its centre. */
function inBox(box, p) {
	const d = [0, 1, 2].map(i => p[i] - box.pos[i] - box.R[i][1] * box.half[1]);
	return [0, 1, 2].map(i => box.R[0][i] * d[0] + box.R[1][i] * d[1] + box.R[2][i] * d[2]);
}
const boxDepth = (box, p) => Math.max(0, Math.min(...inBox(box, p).map((v, i) => box.half[i] - Math.abs(v))));

/** How far the world point p lies inside the body (0 outside). */
function depthIn(body, p) {
	const q = pointOf(p);
	return body.solid?.depth(body.box, q) ?? boxDepth(body.box, q);
}

/** The highest world height at which the body reaches into region ({ min, max } as [x, y, z], world axes), or null: its drawn
 * surface, else its box (a box reaches in when any of it lies inside the region's footprint and height). */
export function topIn(body, region) {
	const drawn = body.solid?.top(body.box, region);
	if (drawn !== undefined && drawn !== null) return drawn;
	if (drawn === null && body.solid && body.solid.depth(body.box, region.min) !== null) return null;
	const { pos, R, half } = body.box, corners = [-1, 1].flatMap(x => [0, 2].flatMap(y => [-1, 1].map(z => [0, 1, 2].map(i => pos[i] + R[i][0] * x * half[0] + R[i][1] * y * half[1] + R[i][2] * z * half[2])))), lo = i => Math.min(...corners.map(c => c[i])), hi = i => Math.max(...corners.map(c => c[i]));
	if (![0, 2].every(i => lo(i) < region.max[i] && hi(i) > region.min[i]) || lo(1) > region.max[1] || hi(1) < region.min[1]) return null;
	return Math.min(hi(1), region.max[1]);
}

const near = (box, p, pad = TOUCH_M) => ['x', 'y', 'z'].every((a, i) => p[i] >= box[a].min - pad && p[i] <= box[a].max + pad);
const gap = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
/** A body's bone points as [x, y, z, r] and, where its bones are known ([parent, child] index pairs), points every LIMB_STEP_M
 * along each bone: a shin through a bench seat lies between the knee and the ankle. r: the drawn radius round the point (a
 * capsule figure's radii), else 0 (a rig's bones lie under flesh the editor does not measure). */
const limbs = ({ points, bones = [], radii = null }) => {
	const p = points.map((q, i) => [...pointOf(q), radii?.[i] ?? 0]), along = (a, b) => { const n = Math.ceil(gap(a, b) / LIMB_STEP_M); return Array.from({ length: Math.max(0, n - 1) }, (_, s) => a.map((v, k) => v + ((s + 1) / n) * (b[k] - v))); };
	return [...p, ...bones.flatMap(([i, j]) => (p[i] && p[j] ? along(p[i], p[j]) : []))];
};
// The share counts the body, not its bone count: bones closer than BODY_GAP_M are one point first, or two hands that meet
// (a rig's 65 bones hold 40 finger bones) read as two bodies standing in each other. Two bone points meet within BODY_GAP_M;
// a point with a drawn radius reaches that much further (half of BODY_GAP_M stands for the flesh round a rig's bone).
const thin = points => points.reduce((kept, p) => (kept.some(q => gap(p, q) < BODY_GAP_M) ? kept : [...kept, p]), []);
const reach = p => p[3] || BODY_GAP_M / 2;
const shares = (a, b) => { const own = thin(a); return own.filter(p => b.some(q => gap(p, q) < reach(p) + reach(q))).length >= BODY_SHARE * own.length; };
/** How deep a ball of radius r round p reaches into the body: its centre's depth plus r when the centre is inside, else the
 * deepest of its six surface points along the world axes. */
const AXES = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const ballDepth = (body, p) => { const at = depthIn(body, p.slice(0, 3)); return at > 0 || !p[3] ? at + (at > 0 ? p[3] : 0) : Math.max(...AXES.map(e => depthIn(body, [0, 1, 2].map(k => p[k] + e[k] * p[3])))); };

/**
 * How deep two posed things stand inside each other, in metres: 0 when they only touch (TOUCH_M or less). a and b are
 * { body } (contactBody) for an object or { points, bones } (posed bone points, [parent, child] pairs) for a character; null for either, or a character
 * without bone points, answers null (the caller's box overlap stands); two characters answer 1 when they share space. boxA, boxB: their world boxes as { x: { min, max },
 * y, z }; only what lies where the two meet is read.
 */
export function interpenetration(a, b, boxA, boxB) {
	if (!a || !b || (!a.body && !a.points?.length) || (!b.body && !b.points?.length)) return null;
	const within = Object.fromEntries(['x', 'y', 'z'].map(k => [k, { min: Math.max(boxA[k].min, boxB[k].min), max: Math.min(boxA[k].max, boxB[k].max) }]));
	// Two drawn bodies (capsule figures: centre lines and radii) are inside each other where their surfaces cross by more than TOUCH_M.
	if (a.radii && b.radii) { const pa = limbs(a), pb = limbs(b), deepest = Math.max(0, ...pa.flatMap(p => pb.map(q => p[3] + q[3] - gap(p, q)))); return deepest > TOUCH_M ? deepest : 0; }
	const pts = x => limbs({ points: x.points, radii: x.radii });
	if (a.points && b.points) return shares(pts(a), pts(b)) || shares(pts(b), pts(a)) ? 1 : 0;
	if (a.points || b.points) {
		// a bone point counts BONE_M deep (the skin is already inside); a drawn surface counts past TOUCH_M, as two solids do
		const [own, body] = a.points ? [a, b.body] : [b, a.body], points = limbs(own), floor = own.radii ? TOUCH_M : BONE_M;
		const deepest = Math.max(0, ...points.filter(p => near(within, p, TOUCH_M + p[3])).map(p => ballDepth(body, p)));
		return deepest > floor ? deepest : 0;
	}
	// The space both boxes share, sampled on a grid: where a point is inside both shapes, the deeper of its two depths. Two
	// faces pressed together share a layer as thin as the overlap, so both depths stay under its thickness; a table top
	// through a crate shares the top's slab, and the crate is deep around it.
	let deepest = 0;
	const at = (k, i) => within[k].min + ((i + 0.5) / GRID) * (within[k].max - within[k].min);
	for (let i = 0; i < GRID; i++) for (let j = 0; j < GRID; j++) for (let k = 0; k < GRID; k++) {
		const p = [at('x', i), at('y', j), at('z', k)], inA = depthIn(a.body, p);
		if (inA > 0) { const inB = depthIn(b.body, p); if (inB > 0) deepest = Math.max(deepest, inA, inB); }
	}
	return deepest > TOUCH_M ? deepest : 0;
}
