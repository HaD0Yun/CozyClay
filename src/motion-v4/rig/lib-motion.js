// Timing, interpolation, blending, free flight and rigid poses of the rig library.
// Time in ballistic, launch and arc is seconds (frame / 24); curve keys are in frames.
// Self-contained factory (see lib-math.js): it uses only M (mathLib()) and K (fkLib()).
export function motionLib(M, K) {
	const { add, sub, scale } = M.v, { mul, apply, T } = M.m;
	const isNum = x => typeof x === "number";
	const EASE = {
		linear: t => t,
		in: t => t * t,
		out: t => 1 - (1 - t) * (1 - t),
		inOut: t => (t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t)),
		smooth: t => t * t * (3 - 2 * t),
		smoother: t => t * t * t * (t * (6 * t - 15) + 10),
	};
	function ease(t, kind = "smooth") {
		const fn = EASE[kind];
		if (!fn) throw new Error(`ease: kind must be one of ${Object.keys(EASE).join(", ")}`);
		return fn(M.clamp(t, 0, 1));
	}
	/** Cubic Hermite between p0 and p1 with tangents m0, m1 (per unit t); scalars or arrays. */
	function hermite(p0, p1, m0, m1, t) {
		const t2 = t * t, t3 = t2 * t, h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t, h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
		if (isNum(p0)) return h00 * p0 + h10 * m0 + h01 * p1 + h11 * m1;
		return p0.map((x, i) => h00 * x + h10 * m0[i] + h01 * p1[i] + h11 * m1[i]);
	}
	const vsub = (a, b) => (isNum(a) ? a - b : a.map((x, i) => x - b[i]));
	const vscale = (a, s) => (isNum(a) ? a * s : a.map(x => x * s));
	/** Value at frame f of keys [{ f, v, m? }] (m: value per frame); Catmull-Rom tangents where m is absent; held past the ends. */
	function curve(keys, f) {
		if (!Array.isArray(keys) || !keys.length) throw new Error("curve: keys is [{ f, v, m? }, ...]");
		const k = keys.slice().sort((a, b) => a.f - b.f);
		if (f <= k[0].f) return k[0].v;
		if (f >= k[k.length - 1].f) return k[k.length - 1].v;
		const tan = i => {
			if (k[i].m !== undefined) return k[i].m;
			const a = k[Math.max(0, i - 1)], b = k[Math.min(k.length - 1, i + 1)];
			return vscale(vsub(b.v, a.v), 1 / (b.f - a.f));
		};
		let i = 0;
		while (k[i + 1].f < f) i++;
		const span = k[i + 1].f - k[i].f;
		return hermite(k[i].v, k[i + 1].v, vscale(tan(i), span), vscale(tan(i + 1), span), (f - k[i].f) / span);
	}
	/** Per-bone slerp from pose a to pose b, hips lerp; bones: only these bones (and the hips when Hips is listed). */
	function blend(a, b, t, opts = {}) {
		K.checkPose(a);
		K.checkPose(b);
		const out = K.clone(a), list = opts.bones ? opts.bones.map(K.bi) : null;
		for (const i of list ?? a.q.map((_, j) => j)) out.q[i] = M.q.slerp(a.q[i], b.q[i], t);
		if (!list || list.includes(K.HIPS)) out.hips = M.v.lerp(a.hips, b.hips, t);
		return out;
	}
	/** Position at time t (s) of a body thrown from p0 with velocity v0. */
	const ballistic = (p0, v0, t, g = 9.8) => add(add(p0, scale(v0, t)), [0, -0.5 * g * t * t, 0]);
	/** Launch velocity that flies from p0 to p1 in T seconds. */
	function launch(p0, p1, T_, g = 9.8) {
		if (!(T_ > 0)) throw new Error("launch: T must be > 0 seconds");
		return add(scale(sub(p1, p0), 1 / T_), [0, 0.5 * g * T_, 0]);
	}
	/** Launch velocity v0 and flight time T (s) of the arc from p0 to p1 whose top is at height apex (world y). */
	function arc(p0, p1, apex, g = 9.8) {
		if (!(apex >= p0[1] && apex >= p1[1])) throw new Error("arc: apex must be at or above both end points");
		const up = Math.sqrt(2 * g * (apex - p0[1])), t1 = up / g, t2 = Math.sqrt(2 * (apex - p1[1]) / g), T_ = t1 + t2;
		if (!(T_ > 0)) throw new Error("arc: the arc has no flight time");
		return { v0: [(p1[0] - p0[0]) / T_, up, (p1[2] - p0[2]) / T_], T: T_ };
	}
	const rigid = p => ({ pos: p.pos ?? p.p, R: p.R ?? M.q.toMat(p.quat) });
	/** a * b for rigid poses { pos, R } (or { pos, quat }, or rig.world's { p, R }). */
	const compose = (a, b) => { a = rigid(a); b = rigid(b); return { pos: add(a.pos, apply(a.R, b.pos)), R: mul(a.R, b.R) }; };
	/** a^-1 * b: b in a's frame. */
	const relative = (a, b) => { a = rigid(a); b = rigid(b); return { pos: apply(T(a.R), sub(b.pos, a.pos)), R: mul(T(a.R), b.R) }; };
	return { ease, hermite, curve, slerp: M.q.slerp, blend, ballistic, launch, arc, compose, relative };
}
