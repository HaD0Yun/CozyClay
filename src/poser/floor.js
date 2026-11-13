// Keeps the body out of the floor after the IK: any joint below y = 0 is raised by turning bones, never by moving
// the root. Each turn is capped by how far that bone has already turned since the IK; toe tips can roll last.
import { angleDeg, axisAngle, mul, mulTA, mulVec } from "./mat3.js";
import { JOINT_COUNT, fk } from "./skeleton.js";

const LIMB_BY_MIDDLE = new Map([[23, [22, 23, 24]], [27, [26, 27, 28]], [12, [11, 12, 13]], [18, [17, 18, 19]]]);
const TOE_BALLS = [25, 29];
const DEG = Math.PI / 180;
const wrap = (t) => Math.atan2(Math.sin(t), Math.cos(t));

/**
 * `L` locals and `root` from the IK, `rest` layout, optional `toeTips` (for each side, where the tip of the toes
 * sits in the toe joint's own frame). Returns `{ L, G, P }` (fresh arrays).
 */
export function hardFloor(sk, Lin, root, rest, { toeTips = null, floorY = 0 } = {}) {
	const L = Float64Array.from(Lin), start = Float64Array.from(Lin);
	const G = new Float64Array(9 * JOINT_COUNT), P = new Float64Array(3 * JOINT_COUNT);
	const order = [...sk.names.keys()].sort((a, b) => sk.depth[a] - sk.depth[b] || a - b);
	const ctx = { sk, L, G, P, root, rest, floorY };
	for (let pass = 0; pass < 3; pass += 1) {
		fk(sk, L, root, rest, G, P);
		let lowest = Infinity;
		for (let j = 0; j < JOINT_COUNT; j += 1) lowest = Math.min(lowest, P[3 * j + 1]);
		if (lowest >= floorY - 1e-6) break;
		for (const j of order) {
			if (j === 0 || P[3 * j + 1] >= floorY) continue;
			const limb = LIMB_BY_MIDDLE.get(j);
			if (limb) {
				const budget = 45 - angleDeg(start, 9 * limb[0], L, 9 * limb[0]);
				if (budget <= 1e-3) continue;
				swing(ctx, limb[0], limb[1], limb[2], budget);
			} else {
				const q = sk.parents[j], budget = 60 - angleDeg(start, 9 * q, L, 9 * q);
				if (budget <= 1e-3) continue;
				roll(ctx, q, j, budget);
			}
			fk(sk, L, root, rest, G, P);
		}
	}
	if (toeTips) TOE_BALLS.forEach((ball, side) => roll(ctx, ball, toeTips[side], 60));
	fk(sk, L, root, rest, G, P);
	return { L, G, P };
}

// turn the pivot's global rotation by t about a world axis, and store the matching local
function turn(ctx, pivot, axis, t) {
	const { sk, L, G } = ctx, R = axisAngle(new Float64Array(9), 0, axis[0], axis[1], axis[2], t), Gp = new Float64Array(9);
	mul(Gp, 0, R, 0, G, 9 * pivot);
	const q = sk.parents[pivot];
	if (q < 0) L.set(Gp, 0);
	else mulTA(L, 9 * pivot, G, 9 * q, Gp, 0);
}

/**
 * Raise a point below the floor by turning its parent bone in place. `tip` is either a child joint's index or a point
 * carried by the pivot (given in the pivot's own frame); the turn is the smallest one that lifts it, at most `limit`
 * degrees.
 */
function roll(ctx, pivot, tip, limit) {
	const { sk, L, G, P, root, rest, floorY } = ctx;
	fk(sk, L, root, rest, G, P);
	const pp = [P[3 * pivot], P[3 * pivot + 1], P[3 * pivot + 2]];
	let tipPos;
	if (typeof tip === "number") tipPos = [P[3 * tip], P[3 * tip + 1], P[3 * tip + 2]];
	else { const o = mulVec([0, 0, 0], 0, G, 9 * pivot, tip, 0); tipPos = [pp[0] + o[0], pp[1] + o[1], pp[2] + o[2]]; }
	const bone = [tipPos[0] - pp[0], tipPos[1] - pp[1], tipPos[2] - pp[2]], bl = Math.hypot(...bone);
	if (bl < 1e-6 || tipPos[1] >= floorY) return;
	const b = bone.map((v) => v / bl), g9 = 9 * pivot;
	let x = [G[g9], G[g9 + 3], G[g9 + 6]];
	const xb = x[0] * b[0] + x[1] * b[1] + x[2] * b[2];
	x = [x[0] - xb * b[0], x[1] - xb * b[1], x[2] - xb * b[2]];
	if (Math.hypot(...x) < 1e-4) x = [b[2], 0, -b[0]]; // fallback axes: up, then forward, crossed with the bone
	if (Math.hypot(...x) < 1e-4) x = [-b[1], b[0], 0];
	const xn = Math.hypot(...x);
	x = x.map((v) => v / xn);
	const A = bone[1], B = x[2] * bone[0] - x[0] * bone[2], amp = Math.hypot(A, B);
	if (amp < 1e-9) return;
	const want = floorY - pp[1], phi = Math.atan2(A, B);
	let candidates;
	if (Math.abs(want) <= amp) { const base = Math.asin(want / amp); candidates = [base - phi, Math.PI - base - phi]; }
	else candidates = [Math.PI / 2 - phi];
	const lifting = candidates.map(wrap).filter((t) => A * Math.cos(t) + B * Math.sin(t) > A + 1e-9);
	if (!lifting.length) return;
	let t = lifting.reduce((best, c) => (Math.abs(c) < Math.abs(best) ? c : best));
	t = Math.max(-limit * DEG, Math.min(limit * DEG, t));
	turn(ctx, pivot, x, t);
}

/** For a knee or elbow under the floor: spin the limb around its hip-to-ankle (shoulder-to-wrist) axis until clear. */
function swing(ctx, a, m, e, limit) {
	const { sk, L, G, P, root, rest, floorY } = ctx;
	fk(sk, L, root, rest, G, P);
	if (P[3 * m + 1] >= floorY) return;
	const pa = [P[3 * a], P[3 * a + 1], P[3 * a + 2]];
	let axis = [P[3 * e] - pa[0], P[3 * e + 1] - pa[1], P[3 * e + 2] - pa[2]];
	const al = Math.hypot(...axis);
	if (al < 1e-6) return;
	axis = axis.map((v) => v / al);
	const am = [P[3 * m] - pa[0], P[3 * m + 1] - pa[1], P[3 * m + 2] - pa[2]];
	const proj = am[0] * axis[0] + am[1] * axis[1] + am[2] * axis[2];
	const c = [pa[0] + axis[0] * proj, pa[1] + axis[1] * proj, pa[2] + axis[2] * proj];
	const u = [P[3 * m] - c[0], P[3 * m + 1] - c[1], P[3 * m + 2] - c[2]];
	const vy = axis[2] * u[0] - axis[0] * u[2]; // height of axis x u
	const amp = Math.hypot(u[1], vy);
	if (amp < 1e-9) return;
	const phi = Math.atan2(u[1], vy), base = Math.asin(Math.max(-1, Math.min(1, (floorY - c[1]) / amp)));
	const options = [base - phi, Math.PI - base - phi].map(wrap);
	let t = Math.abs(options[0]) <= Math.abs(options[1]) ? options[0] : options[1];
	t = Math.max(-limit * DEG, Math.min(limit * DEG, t));
	turn(ctx, a, axis, t);
}
