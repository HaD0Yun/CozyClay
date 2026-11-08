// Vector, 3x3 and quaternion math of the rig library (rig.v, rig.m, rig.q).
// The factory body is self-contained: rigLibrarySource() ships its source text into QuickJS,
// so it must not use any module-level binding. Formulas match src/motion3/compiler/math.js
// (row-major 3x3 acting on column vectors, quaternions [x, y, z, w]), so FK gives the same numbers.
export function mathLib() {
	const DEG = Math.PI / 180;
	const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
	const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
	const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
	const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
	const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
	const len = a => Math.hypot(a[0], a[1], a[2]);
	const dist = (a, b) => len(sub(a, b));
	const norm = a => { const l = len(a); return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0]; };
	const lerp = (a, b, t) => (typeof a === "number" ? a + (b - a) * t : a.map((x, i) => x + (b[i] - x) * t));
	const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
	/** Any unit vector perpendicular to a. */
	const perp = a => norm(Math.abs(a[0]) < 0.9 ? cross(a, [1, 0, 0]) : cross(a, [0, 1, 0]));

	const I = () => [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
	function mul(A, B) {
		const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
		for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) C[i][j] = A[i][0] * B[0][j] + A[i][1] * B[1][j] + A[i][2] * B[2][j];
		return C;
	}
	const apply = (R, v) => [R[0][0] * v[0] + R[0][1] * v[1] + R[0][2] * v[2], R[1][0] * v[0] + R[1][1] * v[1] + R[1][2] * v[2], R[2][0] * v[0] + R[2][1] * v[1] + R[2][2] * v[2]];
	const T = R => [[R[0][0], R[1][0], R[2][0]], [R[0][1], R[1][1], R[2][1]], [R[0][2], R[1][2], R[2][2]]];
	const cols = (a, b, c) => [[a[0], b[0], c[0]], [a[1], b[1], c[1]], [a[2], b[2], c[2]]];
	/** Rotation by deg degrees about axis (Rodrigues), as math.js axisRot. */
	function axisRot(axis, deg) {
		const [x, y, z] = norm(axis), t = deg * DEG, c = Math.cos(t), s = Math.sin(t), k = 1 - c;
		return [[c + x * x * k, x * y * k - z * s, x * z * k + y * s], [y * x * k + z * s, c + y * y * k, y * z * k - x * s], [z * x * k - y * s, z * y * k + x * s, c + z * z * k]];
	}
	/** Orthonormal frame whose first column is d and second lies toward p. */
	function frame(d, p) {
		const a = norm(d);
		let b = sub(p, scale(a, dot(p, a)));
		if (len(b) < 1e-9) b = perp(a);
		b = norm(b);
		return cols(a, b, cross(a, b));
	}
	/** Rotation taking frame (d0, p0) onto frame (d1, p1). */
	const align = (d0, p0, d1, p1) => mul(frame(d1, p1), T(frame(d0, p0)));
	/** Shortest rotation taking direction a onto direction b. */
	function mBetween(a, b) {
		const u = norm(a), w = norm(b), c = cross(u, w), s = len(c), d = dot(u, w);
		if (s < 1e-12) return d > 0 ? I() : axisRot(perp(u), 180);
		return axisRot(c, Math.atan2(s, d) / DEG);
	}

	function fromMat(R) {
		const m00 = R[0][0], m11 = R[1][1], m22 = R[2][2], tr = m00 + m11 + m22;
		let x, y, z, w;
		if (tr > 0) { const s = 0.5 / Math.sqrt(tr + 1); w = 0.25 / s; x = (R[2][1] - R[1][2]) * s; y = (R[0][2] - R[2][0]) * s; z = (R[1][0] - R[0][1]) * s; }
		else if (m00 > m11 && m00 > m22) { const s = 2 * Math.sqrt(1 + m00 - m11 - m22); w = (R[2][1] - R[1][2]) / s; x = 0.25 * s; y = (R[0][1] + R[1][0]) / s; z = (R[0][2] + R[2][0]) / s; }
		else if (m11 > m22) { const s = 2 * Math.sqrt(1 + m11 - m00 - m22); w = (R[0][2] - R[2][0]) / s; x = (R[0][1] + R[1][0]) / s; y = 0.25 * s; z = (R[1][2] + R[2][1]) / s; }
		else { const s = 2 * Math.sqrt(1 + m22 - m00 - m11); w = (R[1][0] - R[0][1]) / s; x = (R[0][2] + R[2][0]) / s; y = (R[1][2] + R[2][1]) / s; z = 0.25 * s; }
		const l = Math.hypot(x, y, z, w);
		return [x / l, y / l, z / l, w / l];
	}
	function toMat(q) {
		const x = q[0], y = q[1], z = q[2], w = q[3];
		return [
			[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
			[2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
			[2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
		];
	}
	/** a * b: rotate by b, then by a (the same order as matrix products). */
	const qmul = (a, b) => [
		a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
		a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
		a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
		a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
	];
	const conj = q => [-q[0], -q[1], -q[2], q[3]];
	const qnorm = q => { const l = Math.hypot(q[0], q[1], q[2], q[3]); return l > 1e-12 ? [q[0] / l, q[1] / l, q[2] / l, q[3] / l] : [0, 0, 0, 1]; };
	function fromAxisAngle(axis, deg) {
		const a = norm(axis), h = deg * DEG / 2, s = Math.sin(h);
		return [a[0] * s, a[1] * s, a[2] * s, Math.cos(h)];
	}
	/** Euler angles in degrees; order "XYZ" means Rx * Ry * Rz (three.js and the scene records). */
	function fromEuler(e, order = "XYZ") {
		let q = [0, 0, 0, 1];
		for (const ch of String(order).toUpperCase()) {
			const k = "XYZ".indexOf(ch);
			if (k < 0) throw new Error(`fromEuler: bad order "${order}"`);
			const axis = [0, 0, 0];
			axis[k] = 1;
			q = qmul(q, fromAxisAngle(axis, e[k] ?? 0));
		}
		return q;
	}
	function slerp(a, b, t) {
		let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
		const c = d < 0 ? [-b[0], -b[1], -b[2], -b[3]] : b;
		d = Math.abs(d);
		if (d > 0.9995) return qnorm([0, 1, 2, 3].map(i => a[i] + (c[i] - a[i]) * t));
		const th = Math.acos(Math.min(1, d)), s = Math.sin(th), wa = Math.sin((1 - t) * th) / s, wb = Math.sin(t * th) / s;
		return [0, 1, 2, 3].map(i => a[i] * wa + c[i] * wb);
	}
	const qBetween = (a, b) => fromMat(mBetween(a, b));
	const qApply = (q, v) => apply(toMat(q), v);
	/** Angle in degrees between two directions. */
	const angle = (a, b) => Math.acos(clamp(dot(norm(a), norm(b)), -1, 1)) / DEG;

	return {
		DEG, clamp, angle, perp,
		v: { add, sub, scale, dot, cross, len, dist, norm, lerp, angle },
		m: { I, mul, apply, T, fromAxisAngle: axisRot, align, between: mBetween, fromQuat: toMat, toQuat: fromMat },
		q: { mul: qmul, conj, norm: qnorm, slerp, fromMat, toMat, fromAxisAngle, fromEuler, between: qBetween, apply: qApply },
	};
}
