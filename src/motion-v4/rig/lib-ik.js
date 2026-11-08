// Two-bone IK, foot planting and hand planting of the rig library.
// ik2 is analytic: the wrist or ankle goes to the target, the elbow or knee bends toward a pole, the
// fold (the angle between the two segments, 0 straight) stays inside the joint limits, and the
// lower bone always folds the anatomical way in the upper bone's own frame: the upper bone carries
// its rest apex direction (elbow back, knee forward) onto the side of the pole.
// Self-contained factory (see lib-math.js): it uses only M (mathLib()), K (fkLib()) and facts.
export function ikLib(M, K, facts) {
	const { add, sub, scale, dot, len, norm, dist } = M.v, { mul, apply, T, align, between } = M.m, { fromMat, toMat } = M.q;
	const { index, parent, restR, restPos, restQ, projOff } = K;
	const FOREARM_SHARE = 0.5;
	const sideName = side => {
		const s = String(side ?? "").toLowerCase();
		if (s === "l" || s === "left") return "Left";
		if (s === "r" || s === "right") return "Right";
		throw new Error(`side must be "l" or "r", got ${JSON.stringify(side)}`);
	};
	const isVec = v => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
	const isMat = R => Array.isArray(R) && Array.isArray(R[0]);
	const CHAINS = {};
	for (const S of ["Left", "Right"]) {
		const k = S === "Left" ? "l" : "r";
		CHAINS[`arm_${k}`] = { bones: [`${S}Arm`, `${S}ForeArm`, `${S}Hand`], kind: "elbow", apex: [0, 0, -1], arm: true };
		CHAINS[`leg_${k}`] = { bones: [`${S}UpLeg`, `${S}Leg`, `${S}Foot`], kind: "knee", apex: [0, 0, 1], arm: false };
	}
	for (const c of Object.values(CHAINS)) {
		[c.u, c.l, c.e] = c.bones.map(n => index[n]);
		c.a = len(restPos[c.l]);
		c.b = len(restPos[c.e]);
		c.a0 = norm(apply(restR[c.u], restPos[c.l]));
		c.e0 = norm(projOff(c.apex, c.a0));
		c.axisL = norm(restPos[c.e]);
	}
	const foldRange = (c, limits) => {
		if (limits === false) return [0, 180];
		if (limits && Array.isArray(limits.fold)) return limits.fold;
		return facts.limits[c.kind].fold;
	};
	/** Default bend direction: elbows back and down; knees forward, carried by the thigh's swing from straight down. */
	function defaultDir(pose, c, uDir) {
		const { fwd, up } = K.axes(pose);
		if (c.kind === "elbow") return sub(scale(fwd, -1), up);
		return apply(between(scale(up, -1), uDir), fwd);
	}

	function ik2(pose, chain, target, opts = {}) {
		const c = CHAINS[chain];
		if (!c) throw new Error(`ik2: chain must be one of ${Object.keys(CHAINS).join(", ")}, got ${JSON.stringify(chain)}`);
		if (!isVec(target)) throw new Error("ik2: target is a world point [x, y, z]");
		K.checkPose(pose);
		const wp = K.world(pose, parent[c.u]), A = add(wp.p, apply(wp.R, restPos[c.u]));
		const toT = sub(target, A), d = len(toT), a = c.a, b = c.b;
		const uDir = d > 1e-9 ? scale(toT, 1 / d) : norm(apply(K.world(pose, c.u).R, restPos[c.l]));
		const [lo, hi] = foldRange(c, opts.limits);
		const fold0 = 180 - Math.acos(M.clamp((a * a + b * b - d * d) / (2 * a * b), -1, 1)) / M.DEG;
		const fold = M.clamp(fold0, lo, hi), dd = Math.sqrt(a * a + b * b + 2 * a * b * Math.cos(fold * M.DEG));
		let pp = projOff(opts.pole ? sub(opts.pole, A) : defaultDir(pose, c, uDir), uDir);
		if (len(pp) < 1e-6) pp = projOff(sub(K.world(pose, c.l).p, A), uDir);
		if (len(pp) < 1e-6) pp = projOff(defaultDir(pose, c, uDir), uDir);
		pp = len(pp) < 1e-6 ? M.perp(uDir) : norm(pp);
		// the angle at the shoulder or hip from the fold itself (exact when straight, unlike the law of cosines)
		const cosA = (a + b * Math.cos(fold * M.DEG)) / dd, sinA = (b * Math.sin(fold * M.DEG)) / dd;
		const ax1 = add(scale(uDir, cosA), scale(pp, sinA)), e1 = add(scale(uDir, -sinA), scale(pp, cosA));
		const Ru = mul(align(c.a0, c.e0, ax1, e1), restR[c.u]);
		const Bp = add(A, scale(ax1, a)), Cp = add(A, scale(uDir, dd));
		const Rtmp = mul(Ru, toMat(restQ[c.l]));
		let Rl = mul(between(apply(Rtmp, restPos[c.e]), sub(Cp, Bp)), Rtmp), Re = null;
		if (opts.end) {
			Re = isMat(opts.end) ? opts.end : toMat(M.q.norm(opts.end));
			if (c.arm) {
				// the forearm takes a share of the hand's turn about the forearm, so the wrist twists less
				let q = fromMat(mul(mul(T(Rl), Re), T(toMat(restQ[c.e]))));
				if (q[3] < 0) q = q.map(x => -x);
				const tw = 2 * Math.atan2(dot([q[0], q[1], q[2]], c.axisL), q[3]);
				Rl = mul(M.m.fromAxisAngle(sub(Cp, Bp), FOREARM_SHARE * tw / M.DEG), Rl);
			}
		}
		pose.q[c.u] = fromMat(mul(T(wp.R), Ru));
		pose.q[c.l] = fromMat(mul(T(Ru), Rl));
		if (Re) pose.q[c.e] = fromMat(mul(T(Rl), Re));
		const error = dist(K.world(pose, c.e).p, target);
		return { reached: error < 1e-4, error, fold };
	}

	// Feet: heel and ball (the QA sole points) in the foot frame with the toes at rest.
	const SOLE = {}, PALM = {};
	for (const S of ["Left", "Right"]) {
		const L = facts.landmarks.sole[S], foot = L.heel[0], toe = L.ball[0], W = facts.restWorldPos;
		const heel = add(W[foot], apply(restR[foot], L.heel[1])), ball = add(W[toe], apply(restR[toe], L.ball[1]));
		const d0 = norm(sub(ball, heel)), mid = scale(add(heel, ball), 0.5);
		SOLE[S] = { foot, toe, ballLocal: L.ball[1], heelLocal: L.heel[1], d0, d0Local: apply(T(restR[foot]), d0), midLocal: apply(T(restR[foot]), sub(mid, W[foot])) };
		const h = index[`${S}Hand`], P = n => W[index[`${S}Hand${n}`]];
		const d = norm(sub(P("Middle1"), W[h])), l = norm(projOff(sub(P("Index1"), P("Pinky1")), d));
		const n = scale(M.v.cross(d, l), S === "Left" ? 1 : -1);
		PALM[S] = { hand: h, d0: d, n0: n, dLocal: apply(T(restR[h]), d), pc: facts.landmarks.palm[S][1] };
	}
	const yawDir = deg => [Math.sin(deg * M.DEG), 0, Math.cos(deg * M.DEG)];
	const onPlane = (v, n, fallback) => {
		let f = projOff(v, n);
		if (len(f) < 1e-6) f = projOff(fallback, n);
		return len(f) < 1e-6 ? M.perp(n) : norm(f);
	};

	/** IK so heel and ball lie on the plane through point (default: the floor under the foot), toes along yaw degrees; the toes go flat (rest). */
	function plantFoot(pose, side, opts = {}) {
		const S = sideName(side), F = SOLE[S];
		const wf = K.world(pose, F.foot), wt = K.world(pose, F.toe);
		const curMid = scale(add(add(wf.p, apply(wf.R, F.heelLocal)), add(wt.p, apply(wt.R, F.ballLocal))), 0.5);
		const point = opts.point ?? [curMid[0], 0, curMid[2]];
		if (!isVec(point)) throw new Error("plantFoot: point is [x, y, z]");
		const n = norm(opts.normal ?? [0, 1, 0]);
		const f1 = onPlane(opts.yaw !== undefined ? yawDir(opts.yaw) : apply(wf.R, F.d0Local), n, K.axes(pose).fwd);
		const Rf = mul(align(F.d0, [0, 1, 0], f1, n), restR[F.foot]);
		pose.q[F.toe] = restQ[F.toe].slice();
		const ankle = sub(point, apply(Rf, F.midLocal));
		const hip = K.world(pose, `${S}UpLeg`).p;
		const pole = opts.pole ?? add(scale(add(hip, ankle), 0.5), f1);
		return ik2(pose, `leg_${S === "Left" ? "l" : "r"}`, ankle, { pole, end: Rf, limits: opts.limits });
	}

	/** IK so the palm centre sits gap (default 0.02 m, the palm skin) off the surface at point, palm facing it (palm normal = -normal), fingers along forward. */
	function plantHand(pose, side, opts = {}) {
		const S = sideName(side), H = PALM[S], wh = K.world(pose, H.hand);
		const normal = norm(opts.normal ?? [0, 1, 0]), gap = opts.gap ?? 0.02;
		const cur = add(wh.p, apply(wh.R, H.pc)), point = opts.point ?? [cur[0], 0, cur[2]];
		if (!isVec(point)) throw new Error("plantHand: point is [x, y, z]");
		const d1 = onPlane(opts.forward ?? apply(wh.R, H.dLocal), normal, K.axes(pose).fwd);
		const Rh = mul(align(H.d0, H.n0, d1, scale(normal, -1)), restR[H.hand]);
		const wrist = sub(add(point, scale(normal, gap)), apply(Rh, H.pc));
		return ik2(pose, `arm_${S === "Left" ? "l" : "r"}`, wrist, { pole: opts.pole, end: Rh, limits: opts.limits });
	}
	return { ik2, plantFoot, plantHand, sideName, chains: Object.keys(CHAINS) };
}
