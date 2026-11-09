// Body measures of the rig library on a world state (rig.fk(pose)): palm and sole planes, segment
// and whole-body centre of mass (the motion3 QA formulas: qa/com.js centerOfMass, qa/geometry.js
// solePoints, compiler/limbs.js palmAxes) and the extrapolated centre of mass (Hof).
// Self-contained factory (see lib-math.js): it uses only M (mathLib()), K (fkLib()) and facts.
export function bodyLib(M, K, facts) {
	const { add, sub, scale, dot, cross, norm } = M.v, { apply, T } = M.m;
	const { index, restR } = K;
	const sideName = side => {
		const s = String(side ?? "").toLowerCase();
		if (s === "l" || s === "left") return "Left";
		if (s === "r" || s === "right") return "Right";
		throw new Error(`side must be "l" or "r", got ${JSON.stringify(side)}`);
	};
	const checkState = s => {
		if (!s || !Array.isArray(s.P) || !Array.isArray(s.R)) throw new Error("expects a world state { P, R } from rig.fk(pose)");
		return s;
	};
	const bonePoint = (s, b, local) => add(s.P[b], apply(s.R[b], local));

	/** Palm centre p, out-of-palm normal n (the way the palm faces), finger direction d, thumb-side axis l. */
	function palm(state, side) {
		const s = checkState(state), S = sideName(side), h = index[`${S}Hand`], P = n => s.P[index[`${S}Hand${n}`]];
		const d = norm(sub(P("Middle1"), s.P[h]));
		let l = sub(P("Index1"), P("Pinky1"));
		l = norm(sub(l, scale(d, dot(l, d))));
		const n = scale(cross(d, l), S === "Left" ? 1 : -1);
		return { p: bonePoint(s, h, facts.landmarks.palm[S][1]), n, d, l };
	}
	/** The QA sole points heel, ball, tip and n, the sole's down normal (carried by the foot). */
	function sole(state, side) {
		const s = checkState(state), L = facts.landmarks.sole[sideName(side)];
		const foot = L.heel[0];
		return { heel: bonePoint(s, L.heel[0], L.heel[1]), ball: bonePoint(s, L.ball[0], L.ball[1]), tip: bonePoint(s, L.tip[0], L.tip[1]),
			n: norm(apply(s.R[foot], apply(T(restR[foot]), [0, -1, 0]))) };
	}
	/** Segment centres of mass: [{ id, mass, p }] (midpoint of each segment's two joints). */
	function segments(state) {
		const s = checkState(state);
		return facts.segments.map(g => ({ id: g.id, mass: g.mass, p: [0, 1, 2].map(k => (s.P[g.start][k] + s.P[g.end][k]) / 2) }));
	}
	/** Mass-weighted centre of mass [x, y, z]. */
	function com(state) {
		const s = checkState(state), c = [0, 0, 0];
		let total = 0;
		for (const { start, end, mass } of facts.segments) {
			const a = s.P[start], b = s.P[end];
			for (let k = 0; k < 3; k++) c[k] += mass * (a[k] + b[k]) / 2;
			total += mass;
		}
		return c.map(v => v / total);
	}
	/** Extrapolated centre of mass from the COM of two consecutive frames: com1 + v / omega on the ground plane. */
	function xcom(com0, com1, opts = {}) {
		const fps = opts.fps ?? 24, ground = opts.ground ?? 0, g = opts.g ?? 9.8;
		const h = com1[1] - ground;
		if (!(h > 1e-6)) throw new Error("xcom: the centre of mass must be above the ground");
		const v = [(com1[0] - com0[0]) * fps, (com1[2] - com0[2]) * fps], omega = Math.sqrt(g / h);
		return { xcom: [com1[0] + v[0] / omega, com1[2] + v[1] / omega], v, omega };
	}
	return { palm, sole, segments, com, xcom };
}
