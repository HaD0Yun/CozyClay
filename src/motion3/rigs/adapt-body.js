// The collision body of an adapted rig (rigs/index.js registerRig): the X Bot's fitted body (x-bot-tpose-body.json,
// body.js) refitted to the rig's bones. Each bone's signed distance grid is resampled through a linear map in that
// bone's bind frame (the adapted rig's bone frames are the X Bot's turned onto its bones, adapt-pose.js): along the bone
// by the bone's length ratio, across it by the girth ratio (the stature's), and for the trunk sideways by the hip width
// (Hips, Spine) or the shoulder width (Spine1, Spine2) ratio; the head scales whole with the head. Distances scale by
// the smaller of the across ratios; the limb skin radii by the girth. Without a mesh the girth is an estimate: a
// slender or heavy character reads the X Bot's build at its own height.
import { sub, len, dot, norm, scale, apply, T, dist } from "../compiler/math.js";

const TRUNK = /^(Spine\d?|Neck|Head)$/, MAX = 127;

function decode(text) {
	if (typeof text !== "string") return text;
	const bytes = typeof Buffer !== "undefined" ? Buffer.from(text, "base64") : Uint8Array.from(atob(text), c => c.charCodeAt(0));
	return new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** body.js's bone axis: the trunk child, a hand's middle knuckle, else the first child. */
const axisOf = (sk, b) => sk.children[b].find(j => TRUNK.test(sk.names[j])) ?? (/Hand$/.test(sk.names[b]) ? sk.index[`${sk.names[b]}Middle1`] : sk.children[b][0]);

function inverse(M) {
	const [[a, b, c], [d, e, f], [g, h, i]] = M, A = e * i - f * h, B = f * g - d * i, C = d * h - e * g, det = a * A + b * B + c * C;
	return [[A / det, (c * h - b * i) / det, (b * f - c * e) / det], [B / det, (a * i - c * g) / det, (c * d - a * f) / det], [C / det, (b * g - a * h) / det, (a * e - b * d) / det]];
}

/** g x I + (a - g) u u' + (w - g) l l' (u the unit bone axis, l the unit sideways axis across it, or null). */
function stretch(u, a, g, l, w) {
	return [0, 1, 2].map(i => [0, 1, 2].map(j => (i === j ? g : 0) + (a - g) * u[i] * u[j] + (l ? (w - g) * l[i] * l[j] : 0)));
}

/** Grid g (min, dims, data at `step`) resampled through M, its distances times k. */
function resample(g, step, M, k) {
	const src = decode(g.data), [nx, ny, nz] = g.dims, Mi = inverse(M), lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
	for (let c = 0; c < 8; c++) {
		const p = apply(M, [0, 1, 2].map(i => g.min[i] + ((c >> i) & 1) * (g.dims[i] - 1) * step));
		for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], p[i]); hi[i] = Math.max(hi[i], p[i]); }
	}
	const dims = [0, 1, 2].map(i => Math.ceil((hi[i] - lo[i]) / step - 1e-6) + 1), [mx, my, mz] = dims, data = new Int8Array(mx * my * mz);
	const at = (x, y, z) => src[(x * ny + y) * nz + z];
	const cell = (f, n) => { const c = Math.min(n - 1, Math.max(0, f)), i = Math.min(n - 2, Math.floor(c)); return [i, c - i]; };
	for (let x = 0; x < mx; x++) for (let y = 0; y < my; y++) for (let z = 0; z < mz; z++) {
		const q = apply(Mi, [lo[0] + x * step, lo[1] + y * step, lo[2] + z * step]);
		const [i, u] = cell((q[0] - g.min[0]) / step, nx), [j, v] = cell((q[1] - g.min[1]) / step, ny), [m, w] = cell((q[2] - g.min[2]) / step, nz);
		const c00 = at(i, j, m) * (1 - u) + at(i + 1, j, m) * u, c01 = at(i, j, m + 1) * (1 - u) + at(i + 1, j, m + 1) * u;
		const c10 = at(i, j + 1, m) * (1 - u) + at(i + 1, j + 1, m) * u, c11 = at(i, j + 1, m + 1) * (1 - u) + at(i + 1, j + 1, m + 1) * u;
		const d = ((c00 * (1 - v) + c10 * v) * (1 - w) + (c01 * (1 - v) + c11 * v) * w) * k;
		data[(x * my + y) * mz + z] = Math.max(-MAX, Math.min(MAX, Math.round(d)));
	}
	return { min: lo, dims, data };
}

/**
 * The fit (body.js's shape: { model, step, unit, grids, radii }) of skeleton sk, made from the X Bot's skeleton `ref`
 * and its fit `fit` (see the head of this file).
 */
export function refitBody(sk, ref, fit) {
	const P = (s, n) => s.restWorldPos[s.index[n]], ratio = (a, b) => dist(P(sk, a), P(sk, b)) / dist(P(ref, a), P(ref, b));
	const girth = P(sk, "HeadTop_End")[1] / P(ref, "HeadTop_End")[1], hips = ratio("LeftUpLeg", "RightUpLeg"), chest = ratio("LeftArm", "RightArm");
	const grids = {};
	for (const [name, g] of Object.entries(fit.grids)) {
		const b = ref.index[name], c = axisOf(ref, b), cn = ref.names[c];
		const u = norm(apply(T(ref.restWorldRot[b]), sub(ref.restWorldPos[c], ref.restWorldPos[b]))), a = ratio(name, cn);
		const side = apply(T(ref.restWorldRot[b]), [1, 0, 0]), across = sub(side, scale(u, dot(side, u)));
		const w = name === "Hips" || name === "Spine" ? hips : /^Spine[12]$/.test(name) ? chest : girth;
		const l = (TRUNK.test(name) || name === "Hips") && len(across) > 1e-6 ? norm(across) : null;
		const M = name === "Head" ? stretch(u, a, a, null, a) : stretch(u, a, girth, l, w);
		grids[name] = resample(g, fit.step, M, name === "Head" ? a : Math.min(girth, l ? w : girth));
	}
	const radii = Object.fromEntries(Object.entries(fit.radii).map(([name, prof]) => [name, prof.map(([t, r]) => [t, r * girth])]));
	return { model: sk.model, step: fit.step, unit: fit.unit, grids, radii };
}
