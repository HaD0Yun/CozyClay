// Small vector / quaternion / easing helpers for engine-simple. Pure JS, no dependencies.
import { qAxisAngle, qConj, qMul, qRotate } from "../rig17.js";

export { qConj, qMul, qRotate };
export const X = [1, 0, 0], Y = [0, 1, 0], Z = [0, 0, 1];
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len = a => Math.hypot(a[0], a[1], a[2]);
export const norm = (a, fallback = Y) => { const l = len(a); return l > 1e-9 ? mul(a, 1 / l) : fallback.slice(); };
export const mix = (a, b, t) => a + (b - a) * t;
export const mixV = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
export const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
export const smooth = t => { t = clamp(t); return t * t * (3 - 2 * t); };
export const rad = d => d * Math.PI / 180;
/** Wraps an angle to (-PI, PI]. */
export const wrap = a => { a = (a + Math.PI) % (2 * Math.PI); return (a < 0 ? a + 2 * Math.PI : a) - Math.PI; };

/** Easing curves by name; every one maps 0..1 to 0..1 ("over" overshoots by about 10% and settles). */
export const EASE = {
	linear: t => clamp(t),
	inout: smooth,
	in: t => clamp(t) ** 2,
	out: t => 1 - (1 - clamp(t)) ** 2,
	over: t => { t = clamp(t); const c = 1.70158; return 1 + (c + 1) * (t - 1) ** 3 + c * (t - 1) ** 2; },
};

export const qX = a => qAxisAngle(X, a);
export const qY = a => qAxisAngle(Y, a);

export function qSlerp(a, b, t) {
	let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
	if (d < 0) { b = b.map(v => -v); d = -d; }
	let wa = 1 - t, wb = t;
	if (d < 0.9995) { const th = Math.acos(d), s = Math.sin(th); wa = Math.sin((1 - t) * th) / s; wb = Math.sin(t * th) / s; }
	const q = a.map((v, i) => v * wa + b[i] * wb), l = Math.hypot(...q);
	return q.map(v => v / l);
}

/** Quaternion of the rotation matrix whose columns are the orthonormal, right-handed x, y, z. */
function qBasis(x, y, z) {
	const tr = x[0] + y[1] + z[2];
	let q;
	if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; q = [(y[2] - z[1]) / s, (z[0] - x[2]) / s, (x[1] - y[0]) / s, s / 4]; }
	else if (x[0] > y[1] && x[0] > z[2]) { const s = Math.sqrt(1 + x[0] - y[1] - z[2]) * 2; q = [s / 4, (y[0] + x[1]) / s, (z[0] + x[2]) / s, (y[2] - z[1]) / s]; }
	else if (y[1] > z[2]) { const s = Math.sqrt(1 + y[1] - x[0] - z[2]) * 2; q = [(y[0] + x[1]) / s, s / 4, (z[1] + y[2]) / s, (z[0] - x[2]) / s]; }
	else { const s = Math.sqrt(1 + z[2] - x[0] - y[1]) * 2; q = [(z[0] + x[2]) / s, (z[1] + y[2]) / s, s / 4, (x[1] - y[0]) / s]; }
	const l = Math.hypot(...q);
	return q.map(v => v / l);
}

/** Frame whose first axis is `axis` and whose second axis is `pole` made perpendicular to it. */
export function qFrame(axis, pole) {
	const x = norm(axis);
	let y = sub(pole, mul(x, dot(pole, x)));
	if (len(y) < 1e-6) y = cross(x, Math.abs(x[1]) < 0.9 ? Y : Z);
	y = norm(y);
	return qBasis(x, y, cross(x, y));
}
