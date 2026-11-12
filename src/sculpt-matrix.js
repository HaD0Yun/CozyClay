/**
 * 4x4 matrix arithmetic for sculpt recipes, without three.js so the recipe,
 * the report and the tests share it. Column-major, three.js layout, so the
 * geometry side can hand a matrix to Matrix4.fromArray without a transpose.
 * Rotations are degrees in XYZ order, three's default.
 */

const DEG = Math.PI / 180;

/** Translation × rotation (× uniform scale). A rotation that is not an array (a recipe that skipped
 * normalizeSculptRecipe, which refuses one) reads as no rotation, so the part still draws. */
export function composeMatrix(position, rotationDeg, scale = 1) {
	const [x, y, z] = (Array.isArray(rotationDeg) ? rotationDeg : [0, 0, 0]).map((deg) => deg * DEG);
	const a = Math.cos(x), b = Math.sin(x);
	const c = Math.cos(y), d = Math.sin(y);
	const e = Math.cos(z), f = Math.sin(z);
	const ae = a * e, af = a * f, be = b * e, bf = b * f;
	const s = scale;
	return [
		s * c * e, s * (af + be * d), s * (bf - ae * d), 0,
		s * -c * f, s * (ae - bf * d), s * (be + af * d), 0,
		s * d, s * -b * c, s * a * c, 0,
		position[0], position[1], position[2], 1,
	];
}

export const IDENTITY = Object.freeze(composeMatrix([0, 0, 0], [0, 0, 0]));

export function multiply(m, n) {
	const out = new Array(16);
	for (let col = 0; col < 4; col += 1) {
		for (let row = 0; row < 4; row += 1) {
			let sum = 0;
			for (let k = 0; k < 4; k += 1) sum += m[k * 4 + row] * n[col * 4 + k];
			out[col * 4 + row] = sum;
		}
	}
	return out;
}

export function applyMatrix(m, [x, y, z]) {
	return [
		m[0] * x + m[4] * y + m[8] * z + m[12],
		m[1] * x + m[5] * y + m[9] * z + m[13],
		m[2] * x + m[6] * y + m[10] * z + m[14],
	];
}

/** Inverse of a rotation + translation (no scale), the transpose trick. */
export function invertRigid(m) {
	const out = [m[0], m[4], m[8], 0, m[1], m[5], m[9], 0, m[2], m[6], m[10], 0, 0, 0, 0, 1];
	const [tx, ty, tz] = [m[12], m[13], m[14]];
	out[12] = -(out[0] * tx + out[4] * ty + out[8] * tz);
	out[13] = -(out[1] * tx + out[5] * ty + out[9] * tz);
	out[14] = -(out[2] * tx + out[6] * ty + out[10] * tz);
	return out;
}

/** S × m × S with S the reflection across x = 0: what a transform becomes on the mirrored side. */
export function reflectX(m) {
	const out = [...m];
	// Entries that pair x with y, z or w (row 0 or column 0, not both) change sign.
	for (const index of [1, 2, 3, 4, 8, 12]) out[index] = -out[index];
	return out;
}
