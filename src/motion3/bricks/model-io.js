// The MotionBricks SOMA model's tensors: SOMA poses -> the seven inputs, the raw output -> SOMA poses.
// A port of the upstream encode/decode kernels (Apache-2.0): the poses are turned so the last context pose faces +X
// with its hips over the origin, and the output is turned back. No endpoint correction here (fill.js corrects the
// channels instead). SOMA space throughout.
import { sub, add, cross, norm, apply, mul, T } from "../compiler/math.js";
import { SID, somaFK } from "./soma.js";

const FPS = 30, NJ = 30, FEAT = 366, ROT0 = 5 + (NJ - 1) * 3;
export const MIN_TOKENS = 6, MAX_TOKENS = 16;

const rotY = t => { const c = Math.cos(t), s = Math.sin(t); return [[c, 0, s], [0, 1, 0], [-s, 0, c]]; };

function heading(P) {
	const r = P[SID.RightLeg], l = P[SID.LeftLeg], ax = r[0] - l[0], az = r[2] - l[2], n = Math.hypot(ax, az);
	return n > 1e-6 ? Math.atan2(az / n, -ax / n) : 0;
}

/**
 * poses: 4 context + 1..4 target SOMA poses { P, R } (30 fps apart within each group). tokens: allowed token counts.
 * Returns { feed: { name: { data, dims, type } }, align } for one request.
 */
export function encodePoses(poses, tokens) {
	const nTarget = poses.length - 4, slots = [...poses];
	while (slots.length < 8) slots.push(slots[slots.length - 1]);
	const ctx = slots[3], cur = heading(ctx.P), Ap = [ctx.P[0][0], 0, ctx.P[0][2]], AR = rotY(cur - Math.PI / 2), Ai = T(AR);
	const pos = slots.map(p => p.P.map(q => apply(Ai, sub(q, Ap)))), rots = slots.map(p => p.R.map(R => mul(Ai, R)));
	const gr = new Float32Array(8 * 5), lr = new Float32Array(8 * 4), lp = new Float32Array(8 * 267);
	for (let f = 0; f < 8; f++) {
		const nx = f === 3 ? f : Math.min(f + 1, 7), h = heading(pos[f]), hn = heading(pos[nx]), dh = Math.atan2(Math.sin(hn - h), Math.cos(hn - h));
		const hip = pos[f][0];
		gr.set([hip[0], hip[1], hip[2], Math.cos(h), Math.sin(h)], f * 5);
		lr.set([dh * FPS, (pos[nx][0][0] - hip[0]) * FPS, (pos[nx][0][2] - hip[2]) * FPS, hip[1]], f * 4);
		for (let j = 1; j < NJ; j++) lp.set([pos[f][j][0] - hip[0], pos[f][j][1], pos[f][j][2] - hip[2]], f * 267 + (j - 1) * 3);
		for (let j = 0; j < NJ; j++) { const R = rots[f][j]; lp.set([R[0][0], R[1][0], R[2][0], R[0][1], R[1][1], R[2][1]], f * 267 + 87 + j * 6); }
	}
	const m = Int32Array.from({ length: 8 }, (_, i) => +(i < 4 + nTarget)), ml = m.slice();
	ml[3] = 0; ml[3 + nTarget] = 0;
	const allowed = Int32Array.from({ length: MAX_TOKENS - MIN_TOKENS + 1 }, (_, i) => +tokens.includes(i + MIN_TOKENS));
	const f32 = (data, dims) => ({ data, dims, type: "float32" }), i32 = (data, dims) => ({ data, dims, type: "int32" });
	const feed = {
		global_root_values: f32(gr, [1, 8, 5]), has_global_root_values: i32(m, [1, 8]),
		local_root_values: f32(lr, [1, 8, 4]), has_local_root_values: i32(ml, [1, 8]),
		local_poses: f32(lp, [1, 8, 267]), has_local_poses: i32(m.slice(), [1, 8]),
		allowed_pred_num_tokens: i32(allowed, [1, MAX_TOKENS - MIN_TOKENS + 1]),
	};
	return { feed, align: { Ap, AR } };
}

function rot6d(o, at) {
	const x = norm([o[at], o[at + 1], o[at + 2]]), z = norm(cross(x, [o[at + 3], o[at + 4], o[at + 5]])), y = cross(z, x);
	return [[x[0], y[0], z[0]], [x[1], y[1], z[1]], [x[2], y[2], z[2]]];
}

/** Raw output (Float32Array 64 x 366) and the chosen token count -> the 4n-6 valid frames as SOMA poses { P, R, contacts }. */
export function decodeMotion(out, tokens, { Ap, AR }) {
	const frames = [];
	for (let k = 0; k < tokens * 4 - 6; k++) {
		const o = (3 + k) * FEAT, R = [];
		for (let j = 0; j < NJ; j++) R.push(mul(AR, rot6d(out, o + ROT0 + j * 6)));
		const root = add(Ap, apply(AR, [out[o], out[o + 1], out[o + 2]]));
		const contacts = Array.from(out.subarray(o + FEAT - 4, o + FEAT), v => Math.max(0, Math.min(1, v)));
		frames.push({ P: somaFK(root, R), R, contacts });
	}
	return frames;
}
