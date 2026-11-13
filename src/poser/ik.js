// Pulls the network's pose onto its handles: 12 damped Levenberg-Marquardt steps over a rotation vector per joint
// plus the root position. The Jacobian takes each joint's change as a small turn in that joint's global frame
// (cheap, and close enough for damped steps); each step is solved on the small row system through the Woodbury identity.
import { expMap, mul } from "./mat3.js";
import { JOINT_COUNT, fk } from "./skeleton.js";

const N = 3 * JOINT_COUNT + 3, MAX_ROWS = 3 * 20 + 4;
const IK_DEFAULTS = Object.freeze({ wLook: 50, wFloor: 5, prior: 0.15, damping: 0.001, iterations: 12, ladder: [1, 10, 100, 1000, 10000, 100000] });

/** One solver instance with its buffers allocated once; `solve` runs on every pointer move. */
export function createIk(sk, options = {}) {
	const o = { ...IK_DEFAULTS, ...options };
	const chain = sk.names.map((_, j) => { const c = []; for (let k = j; k >= 0; k = sk.parents[k]) c.push(k); return c; });
	const L = new Float64Array(9 * JOINT_COUNT), G = new Float64Array(9 * JOINT_COUNT), P = new Float64Array(3 * JOINT_COUNT);
	const ex = new Float64Array(9), root = new Float64Array(3);
	const J = new Float64Array(MAX_ROWS * N), r = new Float64Array(MAX_ROWS), g = new Float64Array(N), y = new Float64Array(N);
	const A1 = new Float64Array(MAX_ROWS * MAX_ROWS), A2 = new Float64Array(MAX_ROWS * MAX_ROWS), M = new Float64Array(MAX_ROWS * MAX_ROWS);
	const z = new Float64Array(MAX_ROWS), step = new Float64Array(N), cand = new Float64Array(N), x = new Float64Array(N);
	let L0, r0, rest, pos, look, wFloor;

	function setPose(v) {
		for (let j = 0; j < JOINT_COUNT; j += 1) {
			expMap(ex, 0, v[3 * j], v[3 * j + 1], v[3 * j + 2]);
			mul(L, 9 * j, L0, 9 * j, ex, 0);
		}
		root[0] = r0[0] + v[90]; root[1] = r0[1] + v[91]; root[2] = r0[2] + v[92];
		fk(sk, L, root, rest, G, P);
	}

	// unit(G_j a) and unit(t - p_j) for a look row, written into `out` (6 numbers)
	function lookDirs(row, out) {
		const j = row.joint, a = row.aim, o9 = 9 * j;
		let ax = G[o9] * a[0] + G[o9 + 1] * a[1] + G[o9 + 2] * a[2], ay = G[o9 + 3] * a[0] + G[o9 + 4] * a[1] + G[o9 + 5] * a[2];
		let az = G[o9 + 6] * a[0] + G[o9 + 7] * a[1] + G[o9 + 8] * a[2];
		const na = Math.max(Math.hypot(ax, ay, az), 1e-6);
		ax /= na; ay /= na; az /= na;
		let dx = row.target[0] - P[3 * j], dy = row.target[1] - P[3 * j + 1], dz = row.target[2] - P[3 * j + 2];
		const nd = Math.max(Math.hypot(dx, dy, dz), 1e-6);
		out[0] = ax; out[1] = ay; out[2] = az; out[3] = dx / nd; out[4] = dy / nd; out[5] = dz / nd;
		return out;
	}
	const dirs = new Float64Array(6);

	function energy(v) {
		setPose(v);
		let e = 0;
		for (const row of pos) {
			const j = row.joint, dx = P[3 * j] - row.target[0], dy = P[3 * j + 1] - row.target[1], dz = P[3 * j + 2] - row.target[2];
			e += row.w * (dx * dx + dy * dy + dz * dz);
		}
		for (const row of look) {
			lookDirs(row, dirs);
			e += o.wLook * ((dirs[0] - dirs[3]) ** 2 + (dirs[1] - dirs[4]) ** 2 + (dirs[2] - dirs[5]) ** 2);
		}
		for (const f of sk.footJoints) { const d = Math.max(0, -P[3 * f + 1]); e += wFloor * d * d; }
		let prior = 0;
		for (let k = 0; k < 90; k += 1) prior += v[k] * v[k];
		return e + o.prior * prior;
	}

	// writes s * (-[v]x G_k) for every k in `ks` into rows m..m+2 (or only the y row when `yOnly`)
	function rotBlock(m, ks, vx, vy, vz, s, fromPoint, yOnly) {
		for (const k of ks) {
			const gk = 9 * k;
			let x0 = vx, y0 = vy, z0 = vz;
			if (fromPoint) { x0 = vx - P[3 * k]; y0 = vy - P[3 * k + 1]; z0 = vz - P[3 * k + 2]; }
			for (let c = 0; c < 3; c += 1) {
				const g0 = G[gk + c], g1 = G[gk + 3 + c], g2 = G[gk + 6 + c], col = 3 * k + c;
				if (yOnly) { J[m * N + col] = s * (-z0 * g0 + x0 * g2); continue; }
				J[m * N + col] = s * (z0 * g1 - y0 * g2);
				J[(m + 1) * N + col] = s * (-z0 * g0 + x0 * g2);
				J[(m + 2) * N + col] = s * (y0 * g0 - x0 * g1);
			}
		}
	}

	// J_w and r_w at the pose last set by setPose; returns the row count
	function linearise() {
		let m = 0;
		for (const row of pos) {
			const j = row.joint, s = Math.sqrt(Math.max(row.w, 0));
			J.fill(0, m * N, (m + 3) * N);
			rotBlock(m, chain[j], P[3 * j], P[3 * j + 1], P[3 * j + 2], s, true, false);
			for (let a = 0; a < 3; a += 1) { J[(m + a) * N + 90 + a] = s; r[m + a] = s * (P[3 * j + a] - row.target[a]); }
			m += 3;
		}
		const sl = Math.sqrt(Math.max(o.wLook, 0));
		for (const row of look) {
			lookDirs(row, dirs);
			J.fill(0, m * N, (m + 3) * N);
			rotBlock(m, chain[row.joint], dirs[0], dirs[1], dirs[2], sl, false, false);
			for (let a = 0; a < 3; a += 1) r[m + a] = sl * (dirs[a] - dirs[3 + a]);
			m += 3;
		}
		const sf = Math.sqrt(Math.max(wFloor, 0));
		for (const f of sk.footJoints) {
			if (!(P[3 * f + 1] < 0) || sf === 0) continue;
			J.fill(0, m * N, (m + 1) * N);
			rotBlock(m, chain[f], P[3 * f], P[3 * f + 1], P[3 * f + 2], sf, true, true);
			J[m * N + 91] = sf;
			r[m] = sf * P[3 * f + 1];
			m += 1;
		}
		return m;
	}

	// step = -(JᵀJ + D)⁻¹ g with D = diag(dRot on 90, dRoot on 3), via M = I + J D⁻¹ Jᵀ
	function solveStep(m, dRot, dRoot) {
		const iRot = 1 / dRot, iRoot = 1 / dRoot;
		for (let k = 0; k < N; k += 1) y[k] = g[k] * (k < 90 ? iRot : iRoot);
		for (let i = 0; i < m; i += 1) {
			let s = 0;
			for (let k = 0; k < N; k += 1) s += J[i * N + k] * y[k];
			z[i] = s;
			for (let j = 0; j <= i; j += 1) M[i * m + j] = (i === j ? 1 : 0) + iRot * A1[i * MAX_ROWS + j] + iRoot * A2[i * MAX_ROWS + j];
		}
		cholSolve(M, m, z);
		for (let k = 0; k < N; k += 1) {
			let s = 0;
			for (let i = 0; i < m; i += 1) s += J[i * N + k] * z[i];
			step[k] = -(y[k] - s * (k < 90 ? iRot : iRoot));
		}
	}

	function gramians(m) {
		for (let i = 0; i < m; i += 1) {
			for (let j = 0; j <= i; j += 1) {
				let s = 0;
				for (let k = 0; k < 90; k += 1) s += J[i * N + k] * J[j * N + k];
				A1[i * MAX_ROWS + j] = s;
				A2[i * MAX_ROWS + j] = J[i * N + 90] * J[j * N + 90] + J[i * N + 91] * J[j * N + 91] + J[i * N + 92] * J[j * N + 92];
			}
		}
	}

	/**
	 * `L0` locals, `r0` root, `rest` layout, `rows` from encodeQuery (centred). Returns `{ L, root, G, P, info }` (fresh
	 * arrays); `info` holds the per-step error and damping.
	 */
	function solve(L0in, r0in, restIn, rows, { floor = true } = {}) {
		L0 = L0in; r0 = r0in; rest = restIn; wFloor = floor ? o.wFloor : 0;
		pos = rows.filter((row) => row.type === 0).map((row) => ({ ...row, w: 1 / Math.max(row.tol, 1e-3) }));
		look = rows.filter((row) => row.type === 2);
		x.fill(0);
		let eCur = energy(x);
		const before = diagnostics(x);
		let d = Math.max(o.damping, 1e-4);
		for (let it = 0; it < o.iterations; it += 1) {
			setPose(x);
			const m = linearise();
			for (let k = 0; k < N; k += 1) {
				let s = 0;
				for (let i = 0; i < m; i += 1) s += J[i * N + k] * r[i];
				g[k] = s + (k < 90 ? o.prior * x[k] : 0);
			}
			gramians(m);
			let accepted = false;
			for (const factor of o.ladder) {
				const lambda = d * factor;
				solveStep(m, lambda + o.prior, lambda);
				for (let k = 0; k < N; k += 1) cand[k] = x[k] + step[k];
				const e = energy(cand);
				if (e < eCur) { x.set(cand); eCur = e; d = Math.max(0.5 * lambda, 1e-6); accepted = true; break; }
			}
			if (!accepted) d *= 1e6;
		}
		const after = diagnostics(x);
		let maxDelta = 0;
		for (let j = 0; j < JOINT_COUNT; j += 1) maxDelta = Math.max(maxDelta, Math.hypot(x[3 * j], x[3 * j + 1], x[3 * j + 2]));
		setPose(x);
		const info = { errBeforeCm: before.err, errAfterCm: after.err, maxDeltaDeg: (maxDelta * 180) / Math.PI, lookBeforeDeg: before.look, lookAfterDeg: after.look };
		return { L: L.slice(), root: root.slice(), G: G.slice(), P: P.slice(), info };
	}

	function diagnostics(v) {
		setPose(v);
		let num = 0, den = 0, lookDeg = 0;
		for (const row of pos) {
			const j = row.joint;
			num += row.w * Math.hypot(P[3 * j] - row.target[0], P[3 * j + 1] - row.target[1], P[3 * j + 2] - row.target[2]);
			den += row.w;
		}
		for (const row of look) {
			lookDirs(row, dirs);
			const c = dirs[0] * dirs[3] + dirs[1] * dirs[4] + dirs[2] * dirs[5];
			lookDeg += (Math.acos(Math.min(1, Math.max(-1, c))) * 180) / Math.PI;
		}
		return { err: (100 * num) / Math.max(den, 1e-8), look: lookDeg };
	}

	return { solve };
}

// In-place Cholesky solve of the symmetric positive definite m x m system (lower triangle of A, row stride m).
function cholSolve(A, m, b) {
	for (let j = 0; j < m; j += 1) {
		let s = A[j * m + j];
		for (let k = 0; k < j; k += 1) s -= A[j * m + k] * A[j * m + k];
		const djj = Math.sqrt(s);
		A[j * m + j] = djj;
		for (let i = j + 1; i < m; i += 1) {
			let t = A[i * m + j];
			for (let k = 0; k < j; k += 1) t -= A[i * m + k] * A[j * m + k];
			A[i * m + j] = t / djj;
		}
	}
	for (let i = 0; i < m; i += 1) {
		let s = b[i];
		for (let k = 0; k < i; k += 1) s -= A[i * m + k] * b[k];
		b[i] = s / A[i * m + i];
	}
	for (let i = m - 1; i >= 0; i -= 1) {
		let s = b[i];
		for (let k = i + 1; k < m; k += 1) s -= A[k * m + i] * b[k];
		b[i] = s / A[i * m + i];
	}
}
