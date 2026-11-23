// The drawn shape of a Studio object as the motion writer is told it: parts, each a box { name, at, size, turn? }.
// tops.js measures one box per drawn mesh (browser); here, with no three.js (node, the sidecar, the browser):
//   mergeParts(parts, max) -> at most max parts: the two whose box around both grows least are one part, again and again
//   propParts(parts, { size, own, yaw }) -> { centre, base } | null: the parts of a prop, or null when its box is its shape
// A part: { name, at: [x, y, z] its centre, size: [w, h, d] along its own axes, turn?: [x, y, z] degrees (the Studio's
// XYZ order) }, in metres. An object's measured parts are in its own frame (base pivot, its turn and none of its scale);
// a prop's are in the prop's own frame from its box centre (as an {on, at} place on it, engine-simple/parts.js).
import { qAxisAngle, qMul, qRotate } from "../rig17.js";

/** The most parts one object is told with: about 1 to 1.5 k characters of JSON for one object. */
export const MAX_PARTS = 16;
const RAD = Math.PI / 180, r3 = v => Math.round(v * 1000) / 1000, r1 = v => Math.round(v * 10) / 10;
const quatOf = t => (t ? qMul(qMul(qAxisAngle([1, 0, 0], t[0] * RAD), qAxisAngle([0, 1, 0], t[1] * RAD)), qAxisAngle([0, 0, 1], t[2] * RAD)) : [0, 0, 0, 1]);
const axes = t => [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map(a => qRotate(quatOf(t), a));

/** The box around a part along the frame's axes: [min, max]. */
function bounds(b) {
	const A = axes(b.turn), half = b.size.map(v => v / 2), r = [0, 1, 2].map(k => half.reduce((s, h, n) => s + h * Math.abs(A[n][k]), 0));
	return [b.at.map((v, k) => v - r[k]), b.at.map((v, k) => v + r[k])];
}
const volume = (lo, hi) => (hi[0] - lo[0]) * (hi[1] - lo[1]) * (hi[2] - lo[2]);
/** A part turned by a multiple of 90 degrees about every axis (within about 1 degree) as one with no turn and its sides in order. */
function squared(b) {
	if (!b.turn) return b;
	const A = axes(b.turn);
	if (!A.every(a => a.every(v => Math.abs(v) < 0.02 || Math.abs(Math.abs(v) - 1) < 0.02))) return b;
	const [lo, hi] = bounds(b);
	return { name: b.name, at: b.at, size: hi.map((v, k) => v - lo[k]) };
}

/** The parts merged down to at most max (MAX_PARTS): a merged part is the box around both along the frame's axes, its
 *  name the names joined by "+" (engine-simple/parts.js answers to each). Rounded to the millimetre and 0.1 degree. */
export function mergeParts(parts, max = MAX_PARTS) {
	let list = parts.map(squared).map(b => ({ ...b, box: bounds(b) }));
	while (list.length > max) {
		let best = null;
		for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
			const a = list[i].box, b = list[j].box, lo = a[0].map((v, k) => Math.min(v, b[0][k])), hi = a[1].map((v, k) => Math.max(v, b[1][k]));
			const cost = volume(lo, hi) - volume(...a) - volume(...b);
			if (!best || cost < best.cost) best = { i, j, lo, hi, cost };
		}
		const { i, j, lo, hi } = best, name = `${list[i].name}+${list[j].name}`;
		list = [...list.filter((_, k) => k !== i && k !== j), { name, at: lo.map((v, k) => (v + hi[k]) / 2), size: hi.map((v, k) => v - lo[k]), box: [lo, hi] }];
	}
	return list.map(({ name, at, size, turn }) => ({ name, at: at.map(r3), size: size.map(v => Math.max(0.001, r3(v))), ...(turn && turn.some(v => Math.abs(v) >= 0.05) ? { turn: turn.map(r1) } : {}) }));
}

/**
 * The parts of a prop from its object's measured parts (own frame, base pivot), or null when there are none or the prop's
 * box is its shape (one part, square to it, within 10 mm of it on every side). size: the prop's box [w, h, d]; own: the
 * prop is the object's own box turned with it (scene.js turn flag), else the box square to the world: then the parts are
 * given only when the object stands at a turn of a multiple of 90 degrees about Y (yaw, degrees), turned with it.
 * -> { base: in the prop's frame from its base (y over it), centre: from its box centre (the scene's parts) }.
 */
export function propParts(parts, { size, own = true, yaw = 0 }) {
	if (!Array.isArray(parts) || !parts.length) return null;
	const quarter = Math.round(yaw / 90), turned = !own && Math.abs(yaw - 90 * quarter) > 0.5;
	if (turned) return null;
	// square to the world at a quarter turn: each part as the box around it along the world's axes (exact for an unturned part)
	const q = qAxisAngle([0, 1, 0], quarter * 90 * RAD), level = b => { const [lo, hi] = bounds(b), at = qRotate(q, b.at), r = qRotate(q, hi.map((v, k) => (v - lo[k]) / 2)).map(Math.abs); return { name: b.name, at, size: r.map(v => 2 * v) }; };
	const base = mergeParts(own || !quarter ? parts : parts.map(level));
	if (base.length === 1 && !base[0].turn && base[0].size.every((v, k) => Math.abs(v - size[k]) <= 0.01) && Math.hypot(base[0].at[0], base[0].at[1] - size[1] / 2, base[0].at[2]) <= 0.01) return null;
	return { base, centre: atCentre(base, size[1]) };
}
/** Parts given from a box's base as from its centre, for a box h tall. */
export const atCentre = (parts, h) => parts.map(b => ({ ...b, at: [b.at[0], r3(b.at[1] - h / 2), b.at[2]] }));
