// The drawn shape of a prop: the scene's `parts` of a prop, each a box { name, at, size, turn? } in the prop's own frame
// (at: its centre from the prop's centre, along the axes of the prop's size; turn: [x, y, z] degrees, the Studio's XYZ
// order). The Studio measures them from what it draws (src/lowvis/studio/parts.js); a prop without parts is its box.
// What reads them, for every prop and every part alike (no part or object has a word of its own):
//  - a place on a part: {on: propId, part, at?} as a hand, elbow or foot target, a hold's `at` of a hand as {part, at?},
//    and a ride's {on, part, at?}: `at` from the part's centre along the prop's own axes (none: the part's centre).
//    resolveParts writes them as the prop's own {on, at} before the engine reads the spec. The same form with on: a
//    character id names a drawn part of that body (body-parts.js; the scene's `figure`, the look it is drawn in): at
//    from that part's centre in its joint's frame, written as {joint, of, at} (of left out on the own body).
//  - a seat: sit {on, part} sits on that part's top; sit {on} on a prop with parts sits on the highest drawn top under the
//    hips (spec-layers.js), the box top where nothing is drawn under them.
//  - a stand: a foot of a body action {on: propId} on a prop with parts stands on the drawn top under it (spec-layers.js).
//  - the distance of a point to the nearest part (src/lowvis/pi/gaps.mjs, inside.mjs).
// Pure JS: node, the browser and the sidecar.
import { qAxisAngle, qConj, qMul, qRotate } from "../rig17.js";
import { add, sub } from "./math.js";
import { bodyPartOf } from "./body-parts.js";

const RAD = Math.PI / 180;
const vec = v => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
/** The turn of a part ([x, y, z] degrees, applied X, then Y, then Z in the frame turned so far: the Studio's XYZ) as a quaternion. */
const turnOf = t => (vec(t) ? qMul(qMul(qAxisAngle([1, 0, 0], t[0] * RAD), qAxisAngle([0, 1, 0], t[1] * RAD)), qAxisAngle([0, 0, 1], t[2] * RAD)) : [0, 0, 0, 1]);

/** Throws on parts that cannot be read; where: the text that names the prop. */
export function checkParts(parts, where) {
	if (!Array.isArray(parts) || !parts.length) throw new Error(`${where}.parts: want a list of { name, at: [x, y, z], size: [w, h, d], turn?: [x, y, z] }`);
	parts.forEach((b, i) => {
		const bad = !b || typeof b.name !== "string" || !b.name || !vec(b.at) || !vec(b.size) || b.size.some(v => v <= 0) || (b.turn !== undefined && !vec(b.turn));
		if (bad) throw new Error(`${where}.parts[${i}]: want { name, at: [x, y, z], size: [w, h, d] over 0, turn?: [x, y, z] degrees }, got ${JSON.stringify(b)}`);
	});
}

/** The boxes of a scene prop's parts in its own frame ({ name, names, c, q, h }: names, the names a merged part answers
 *  to), or null when it has none. */
export function partBoxes(p) {
	if (!Array.isArray(p?.parts) || !p.parts.length) return null;
	return p.parts.map(b => ({ name: b.name, names: new Set([b.name, ...b.name.split("+")]), c: b.at.slice(), q: turnOf(b.turn), h: b.size.map(v => v / 2) }));
}

/** The box of part `name` of a prop with boxes `boxes` (partBoxes); throws a refusal that lists the parts there are. */
export function partOf(boxes, name, propId, where) {
	if (!boxes) throw new Error(`engine-simple: ${where}: part ${JSON.stringify(name)} of ${propId}: ${propId} has no parts (the Studio has drawn none for it, or its shape is its box); give at from its centre instead`);
	const box = boxes.find(b => b.name === name) ?? boxes.find(b => b.names.has(name));
	if (!box) throw new Error(`engine-simple: ${where}: ${propId} has no part ${JSON.stringify(name)}; its parts: ${boxes.map(b => b.name).join(", ")}`);
	return box;
}

const toLocal = (b, v) => qRotate(qConj(b.q), sub(v, b.c));

/** Signed distance from a prop-frame point to a part's box (below 0 inside it). */
export function partDistance(b, v) {
	const d = toLocal(b, v).map((x, k) => Math.abs(x) - b.h[k]);
	return Math.hypot(...d.map(x => Math.max(x, 0))) + Math.min(0, Math.max(...d));
}
/** The nearest part to a prop-frame point: { d (metres, 0 inside), part (its name) }, or null with no boxes. */
export function nearestPart(boxes, v) {
	let best = null;
	for (const b of boxes ?? []) { const d = Math.max(0, partDistance(b, v)); if (!best || d < best.d) best = { d, part: b.name }; }
	return best;
}

/** The top of a part's box over the vertical line through prop-frame [x, z] (prop-frame y), or null when the line misses it. */
export function topAt(b, x, z) {
	const o = toLocal(b, [x, 0, z]), d = qRotate(qConj(b.q), [0, 1, 0]);
	let lo = -Infinity, hi = Infinity;
	for (let k = 0; k < 3; k++) {
		if (Math.abs(d[k]) < 1e-12) { if (Math.abs(o[k]) > b.h[k]) return null; continue; }
		const t1 = (-b.h[k] - o[k]) / d[k], t2 = (b.h[k] - o[k]) / d[k];
		lo = Math.max(lo, Math.min(t1, t2)); hi = Math.min(hi, Math.max(t1, t2));
	}
	return lo <= hi ? hi : null;
}
/** The highest drawn top under a prop-frame point [x, z] no higher than `most` (prop frame), or null when none is. */
export function topUnder(boxes, x, z, most = Infinity) {
	let top = null;
	for (const b of boxes ?? []) { const y = topAt(b, x, z); if (y != null && y <= most + 1e-9 && (top == null || y > top)) top = y; }
	return top;
}

/** A place on a part written as the prop's own: { on, part, at?, ...rest } -> { on, at: the point, ...rest }; on a
 *  body's part (bodies: { <character id>: { look, s: its scale } }) as its joint's: { joint, of (but on self), at, ...rest }. */
function placeOf(to, props, where, bodies = {}, self = null) {
	if (typeof to?.on !== "string") throw new Error(`engine-simple: ${where}: {part} wants on: propId or characterId, got ${JSON.stringify(to)}`);
	if (to.at !== undefined && !vec(to.at)) throw new Error(`engine-simple: ${where}: at wants [x, y, z], got ${JSON.stringify(to.at)}`);
	const { part, ...rest } = to, body = Object.hasOwn(bodies, to.on) ? bodies[to.on] : null;
	if (!body) return { ...rest, at: add(partOf(props[to.on] ?? null, part, to.on, where).c, to.at ?? [0, 0, 0]) };
	const { on, ...other } = rest, b = bodyPartOf(body.look, part, on, where);
	return { ...other, joint: b.name, ...(on === self ? {} : { of: on }), at: add(b.c.map(v => v * body.s), to.at ?? [0, 0, 0]) };
}
const hasPart = t => t && typeof t === "object" && !Array.isArray(t) && t.part !== undefined;

/**
 * The spec with every place on a part written as a place on the prop or on the body's joint (placeOf); the spec itself
 * when it has none. def: the scene (its props' parts, its characters' scale, its figure). Throws a refusal for a part that is not there or a prop without parts; a sit's part
 * is checked here and read by the body layer.
 */
export function resolveParts(spec, def) {
	const text = JSON.stringify(spec ?? {});
	if (!text.includes("\"part\"")) return spec;
	const props = Object.fromEntries((def?.props ?? []).map(p => [p.id, partBoxes(p)])), out = {};
	const bodies = Object.fromEntries((def?.characters ?? []).map(c => [c.id, { look: def.figure, s: c.scale ?? 1 }]));
	for (const [id, acts] of Object.entries(spec)) {
		if (!Array.isArray(acts)) { out[id] = acts; continue; }
		out[id] = acts.map(a => {
			const [f, verb, o] = Array.isArray(a) ? a : [];
			if (!o || typeof o !== "object") return a;
			const where = `${id} ${verb} at frame ${f}`, next = { ...o };
			if (verb === "pose") for (const k of ["hands", "L", "R", "elbowL", "elbowR", "footL", "footR"]) { if (hasPart(o[k])) next[k] = placeOf(o[k], props, where, bodies, id); }
			if (verb === "hold" && o.at !== undefined) {
				const one = v => (hasPart(v) ? placeOf({ on: o.prop, ...v }, props, where).at : v);
				next.at = hasPart(o.at) ? one(o.at) : !Array.isArray(o.at) && o.at && typeof o.at === "object" ? Object.fromEntries(Object.entries(o.at).map(([k, v]) => [k, one(v)])) : o.at;
			}
			if (verb === "ride" && hasPart(o)) return [f, verb, placeOf(o, props, where, bodies, id)];
			if (verb === "sit" && o.part !== undefined) {
				if (typeof o.on !== "string") throw new Error(`engine-simple: ${where}: a sit on a part wants on: propId as well, got ${JSON.stringify(o)}`);
				partOf(props[o.on] ?? null, o.part, o.on, where);
			}
			return [f, verb, next];
		});
	}
	return out;
}

/** The scene with `figure`, the look its bodies are drawn in (a place on a body's part reads that look's parts,
 *  body-parts.js), when the spec names a part and the look is known; else the scene itself (the block look's parts). */
export const withFigure = (scene, spec, figure) => (figure && JSON.stringify(spec ?? {}).includes("\"part\"") ? { ...scene, figure } : scene);

/** The most a foot steps up onto a drawn top, and the most its height on the parts changes per frame (rig metres). */
const STEP = 0.5, RATE = 0.05;
/**
 * The body layer's frames (in place) with each foot on the drawn top under it on the frames of an action done on a prop
 * with parts: marks[f] = { prop (the engine's: c, turn, parts), seated } or none. A foot's floor is the highest drawn top
 * under the ankle that is no more than STEP over where that foot stood the frame before (the floor when none is); it
 * moves toward it by RATE a frame at most (on frame 0 it is there), and goes back to the floor the same way after. The
 * pelvis rises with the higher foot unless the body sits; the solver lowers it again until both planted feet reach.
 */
export function standOnParts(out, marks) {
	const lift = [0, 0];
	let up = 0;
	out.forEach((B, f) => {
		const m = marks[f], step = (v, to) => (f === 0 ? to : v + Math.max(-RATE, Math.min(RATE, to - v)));
		const feet = B.feet.map((ft, i) => {
			let to = 0;
			if (m) {
				const p = m.prop, x = ft.a[0] - p.c[0], z = ft.a[2] - p.c[2], cs = Math.cos(p.turn), sn = Math.sin(p.turn);
				const y = topUnder(p.parts, x * cs - z * sn, x * sn + z * cs, lift[i] - p.c[1] + STEP);
				to = y == null ? 0 : p.c[1] + y;
			}
			lift[i] = step(lift[i], to);
			return lift[i] ? { ...ft, a: [ft.a[0], ft.a[1] + lift[i], ft.a[2]], floor: (ft.floor ?? 0) + lift[i] } : ft;
		});
		up = step(up, m && !m.seated ? Math.max(...lift) : 0);
		if (lift[0] || lift[1] || up) out[f] = { ...B, p: [B.p[0], B.p[1] + up, B.p[2]], feet };
	});
}
