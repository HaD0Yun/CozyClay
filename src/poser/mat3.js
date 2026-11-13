// Row-major 3x3 rotation helpers on flat arrays. `o` arguments are element offsets, so one
// Float64Array can hold all 30 joints (`9 * j`). Outputs must not alias inputs unless a function says so.

/** out = a b */
export function mul(out, o, a, ao, b, bo) {
	for (let r = 0; r < 3; r += 1) {
		const a0 = a[ao + 3 * r], a1 = a[ao + 3 * r + 1], a2 = a[ao + 3 * r + 2];
		out[o + 3 * r] = a0 * b[bo] + a1 * b[bo + 3] + a2 * b[bo + 6];
		out[o + 3 * r + 1] = a0 * b[bo + 1] + a1 * b[bo + 4] + a2 * b[bo + 7];
		out[o + 3 * r + 2] = a0 * b[bo + 2] + a1 * b[bo + 5] + a2 * b[bo + 8];
	}
	return out;
}

/** out = aᵀ b */
export function mulTA(out, o, a, ao, b, bo) {
	for (let r = 0; r < 3; r += 1) {
		const a0 = a[ao + r], a1 = a[ao + 3 + r], a2 = a[ao + 6 + r];
		out[o + 3 * r] = a0 * b[bo] + a1 * b[bo + 3] + a2 * b[bo + 6];
		out[o + 3 * r + 1] = a0 * b[bo + 1] + a1 * b[bo + 4] + a2 * b[bo + 7];
		out[o + 3 * r + 2] = a0 * b[bo + 2] + a1 * b[bo + 5] + a2 * b[bo + 8];
	}
	return out;
}

/** out = a bᵀ */
export function mulTB(out, o, a, ao, b, bo) {
	for (let r = 0; r < 3; r += 1) {
		const a0 = a[ao + 3 * r], a1 = a[ao + 3 * r + 1], a2 = a[ao + 3 * r + 2];
		for (let c = 0; c < 3; c += 1) out[o + 3 * r + c] = a0 * b[bo + 3 * c] + a1 * b[bo + 3 * c + 1] + a2 * b[bo + 3 * c + 2];
	}
	return out;
}

/** out = a v (3-vectors); out may alias v. */
export function mulVec(out, o, a, ao, v, vo) {
	const x = v[vo], y = v[vo + 1], z = v[vo + 2];
	out[o] = a[ao] * x + a[ao + 1] * y + a[ao + 2] * z;
	out[o + 1] = a[ao + 3] * x + a[ao + 4] * y + a[ao + 5] * z;
	out[o + 2] = a[ao + 6] * x + a[ao + 7] * y + a[ao + 8] * z;
	return out;
}

/** out = aᵀ v (3-vectors); out may alias v. */
export function mulTVec(out, o, a, ao, v, vo) {
	const x = v[vo], y = v[vo + 1], z = v[vo + 2];
	out[o] = a[ao] * x + a[ao + 3] * y + a[ao + 6] * z;
	out[o + 1] = a[ao + 1] * x + a[ao + 4] * y + a[ao + 7] * z;
	out[o + 2] = a[ao + 2] * x + a[ao + 5] * y + a[ao + 8] * z;
	return out;
}

export function identity(out = new Float64Array(9), o = 0) {
	out.fill(0, o, o + 9);
	out[o] = out[o + 4] = out[o + 8] = 1;
	return out;
}

/** 6D (first two columns) -> rotation by Gram-Schmidt. */
export function decode6d(out, o, v, vo) {
	let x1 = v[vo], y1 = v[vo + 1], z1 = v[vo + 2];
	const n1 = Math.max(Math.hypot(x1, y1, z1), 1e-8);
	x1 /= n1; y1 /= n1; z1 /= n1;
	let x2 = v[vo + 3], y2 = v[vo + 4], z2 = v[vo + 5];
	const d = x1 * x2 + y1 * y2 + z1 * z2;
	x2 -= d * x1; y2 -= d * y1; z2 -= d * z1;
	const n2 = Math.max(Math.hypot(x2, y2, z2), 1e-8);
	x2 /= n2; y2 /= n2; z2 /= n2;
	out[o] = x1; out[o + 1] = x2; out[o + 2] = y1 * z2 - z1 * y2;
	out[o + 3] = y1; out[o + 4] = y2; out[o + 5] = z1 * x2 - x1 * z2;
	out[o + 6] = z1; out[o + 7] = z2; out[o + 8] = x1 * y2 - y1 * x2;
	return out;
}

/** Columns 0 and 1 of R as `[R00, R10, R20, R01, R11, R21]`. */
export function to6d(out, o, r, ro) {
	out[o] = r[ro]; out[o + 1] = r[ro + 3]; out[o + 2] = r[ro + 6];
	out[o + 3] = r[ro + 1]; out[o + 4] = r[ro + 4]; out[o + 5] = r[ro + 7];
	return out;
}

/** Rotation of a rotation vector (Rodrigues); a tiny θ² is floored at 1e-16 so the series stays finite. */
export function expMap(out, o, x, y, z) {
	const t2 = Math.max(x * x + y * y + z * z, 1e-16), t = Math.sqrt(t2);
	const a = Math.sin(t) / t, b = (1 - Math.cos(t)) / t2;
	// K² = v vᵀ - |v|² I for K = [v]x
	const n2 = x * x + y * y + z * z;
	out[o] = 1 + b * (x * x - n2); out[o + 1] = -a * z + b * x * y; out[o + 2] = a * y + b * x * z;
	out[o + 3] = a * z + b * x * y; out[o + 4] = 1 + b * (y * y - n2); out[o + 5] = -a * x + b * y * z;
	out[o + 6] = -a * y + b * x * z; out[o + 7] = a * x + b * y * z; out[o + 8] = 1 + b * (z * z - n2);
	return out;
}

/** Rot(axis, t) = I + sin t [axis]x + (1 - cos t) [axis]x² for a unit axis. */
export function axisAngle(out, o, x, y, z, t) {
	const s = Math.sin(t), c = 1 - Math.cos(t);
	out[o] = 1 + c * (x * x - 1); out[o + 1] = -s * z + c * x * y; out[o + 2] = s * y + c * x * z;
	out[o + 3] = s * z + c * x * y; out[o + 4] = 1 + c * (y * y - 1); out[o + 5] = -s * x + c * y * z;
	out[o + 6] = -s * y + c * x * z; out[o + 7] = s * x + c * y * z; out[o + 8] = 1 + c * (z * z - 1);
	return out;
}

/** Geodesic angle in degrees: acos(clip((trace(aᵀ b) - 1) / 2, -1, 1)). */
export function angleDeg(a, ao, b, bo) {
	let tr = 0;
	for (let k = 0; k < 9; k += 1) tr += a[ao + k] * b[bo + k];
	return (Math.acos(Math.min(1, Math.max(-1, (tr - 1) / 2))) * 180) / Math.PI;
}

/** Shortest-arc rotation taking direction `a` onto direction `b` (plain 3-arrays); returns [R, angle in rad]. */
export function shortestArc(a, b) {
	const na = Math.hypot(a[0], a[1], a[2]), nb = Math.hypot(b[0], b[1], b[2]);
	const u = [a[0] / na, a[1] / na, a[2] / na], v = [b[0] / nb, b[1] / nb, b[2] / nb];
	const k = cross(u, v), s = Math.hypot(k[0], k[1], k[2]), c = dot(u, v);
	const angle = Math.atan2(s, c), out = new Float64Array(9);
	if (s < 1e-12) {
		if (c > 0) return [identity(out), angle];
		// half turn about any axis orthogonal to u
		const p = Math.abs(u[0]) < 0.9 ? cross(u, [1, 0, 0]) : cross(u, [0, 1, 0]), n = Math.hypot(p[0], p[1], p[2]);
		return [axisAngle(out, 0, p[0] / n, p[1] / n, p[2] / n, Math.PI), angle];
	}
	return [axisAngle(out, 0, k[0] / s, k[1] / s, k[2] / s, angle), angle];
}

export function cross(a, b) {
	return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function dot(a, b) {
	return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function sub(a, b) {
	return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function norm(a) {
	return Math.hypot(a[0], a[1], a[2]);
}

/** 3x3 nested `[[..],[..],[..]]` -> flat row-major. */
export function fromRows(rows, out = new Float64Array(9), o = 0) {
	for (let r = 0; r < 3; r += 1) for (let c = 0; c < 3; c += 1) out[o + 3 * r + c] = rows[r][c];
	return out;
}
