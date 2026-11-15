// Small dependency-free vector / 3x3 / quaternion helpers for the motion3 compiler.
// Vectors are [x, y, z]; matrices are row-major [[...],[...],[...]] acting on column
// vectors (R v); quaternions are three.js order [x, y, z, w].

export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len = a => Math.hypot(a[0], a[1], a[2]);
export const dist = (a, b) => len(sub(a, b));
export function norm(a) {
	const l = len(a);
	return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
}
export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const rad = d => d * Math.PI / 180;
const deg = r => r * 180 / Math.PI;

export const I3 = () => [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
export function mul(A, B) {
	const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
	for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) C[i][j] = A[i][0] * B[0][j] + A[i][1] * B[1][j] + A[i][2] * B[2][j];
	return C;
}
export const apply = (R, v) => [R[0][0] * v[0] + R[0][1] * v[1] + R[0][2] * v[2], R[1][0] * v[0] + R[1][1] * v[1] + R[1][2] * v[2], R[2][0] * v[0] + R[2][1] * v[1] + R[2][2] * v[2]];
export const T = R => [[R[0][0], R[1][0], R[2][0]], [R[0][1], R[1][1], R[2][1]], [R[0][2], R[1][2], R[2][2]]];
const cols = (a, b, c) => [[a[0], b[0], c[0]], [a[1], b[1], c[1]], [a[2], b[2], c[2]]];

export function rx(d) { const t = rad(d), c = Math.cos(t), s = Math.sin(t); return [[1, 0, 0], [0, c, -s], [0, s, c]]; }
export function ry(d) { const t = rad(d), c = Math.cos(t), s = Math.sin(t); return [[c, 0, s], [0, 1, 0], [-s, 0, c]]; }
export function rz(d) { const t = rad(d), c = Math.cos(t), s = Math.sin(t); return [[c, -s, 0], [s, c, 0], [0, 0, 1]]; }

/** Rotation by `d` degrees about unit-normalised axis `ax` (Rodrigues). */
export function axisRot(ax, d) {
	const [x, y, z] = norm(ax), t = rad(d), c = Math.cos(t), s = Math.sin(t), k = 1 - c;
	return [[c + x * x * k, x * y * k - z * s, x * z * k + y * s], [y * x * k + z * s, c + y * y * k, y * z * k - x * s], [z * x * k - y * s, z * y * k + x * s, c + z * z * k]];
}

/** Orthonormal frame whose first column is d and second lies toward p. */
function frame(d, p) {
	const a = norm(d);
	let b = sub(p, scale(a, dot(p, a)));
	if (len(b) < 1e-9) b = sub([0, 1, 0], scale(a, a[1])), len(b) < 1e-9 && (b = sub([1, 0, 0], scale(a, a[0])));
	b = norm(b);
	return cols(a, b, cross(a, b));
}

/** Rotation taking frame (d0, p0) onto frame (d1, p1). */
export const align = (d0, p0, d1, p1) => mul(frame(d1, p1), T(frame(d0, p0)));

export function quatFromMat(R) {
	const m00 = R[0][0], m11 = R[1][1], m22 = R[2][2], tr = m00 + m11 + m22;
	let x, y, z, w;
	if (tr > 0) { const s = 0.5 / Math.sqrt(tr + 1); w = 0.25 / s; x = (R[2][1] - R[1][2]) * s; y = (R[0][2] - R[2][0]) * s; z = (R[1][0] - R[0][1]) * s; }
	else if (m00 > m11 && m00 > m22) { const s = 2 * Math.sqrt(1 + m00 - m11 - m22); w = (R[2][1] - R[1][2]) / s; x = 0.25 * s; y = (R[0][1] + R[1][0]) / s; z = (R[0][2] + R[2][0]) / s; }
	else if (m11 > m22) { const s = 2 * Math.sqrt(1 + m11 - m00 - m22); w = (R[0][2] - R[2][0]) / s; x = (R[0][1] + R[1][0]) / s; y = 0.25 * s; z = (R[1][2] + R[2][1]) / s; }
	else { const s = 2 * Math.sqrt(1 + m22 - m00 - m11); w = (R[1][0] - R[0][1]) / s; x = (R[0][2] + R[2][0]) / s; y = (R[1][2] + R[2][1]) / s; z = 0.25 * s; }
	const l = Math.hypot(x, y, z, w);
	return [x / l, y / l, z / l, w / l];
}

export function matFromQuat([x, y, z, w]) {
	return [
		[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
		[2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
		[2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
	];
}

/** Angle in degrees between two directions. */
export const angle = (a, b) => deg(Math.acos(clamp(dot(norm(a), norm(b)), -1, 1)));
