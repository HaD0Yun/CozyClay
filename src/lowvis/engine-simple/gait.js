// Locomotion: every move is footsteps. A foot is either planted at a fixed world spot or swinging between two
// spots, so a planted foot cannot slide. The pelvis follows a path with a speed profile; each footstep lands where
// the pelvis will be in the middle of that foot's stance. Walk, run, turn on the spot, side / back steps, a lunge
// and gathering the feet are the same stepper with different paths and step plans.
//
// State between actions: st = { p: [x, z] pelvis ground point, yaw, feet: [L, R] of { g: [x, z], yaw } }.
import { INDEX as J, REST } from "../rig17.js";
import { EASE, clamp, mix, qMul, qRotate, qX, qY, rad, smooth, sub, wrap } from "./math.js";
import { SOLE, TOE } from "./solve.js";

export const STAND_Y = REST[J.Hips][1] - 0.012;
const HIP_FWD = REST[J.Hips][2], FOOT_X = REST[J.LeftFoot][0], FOOT_Z = REST[J.LeftFoot][2];
const SETTLE = 3; // frames kept still at the end of a move
const GAIT = {
	// stepFrames: frames per step; sw: swing time / step time (over 1 = flight phase); base, bobA: pelvis height
	walk: { stepFrames: 12, sw: 0.8, maxStride: 0.62, lift: 0.07, base: -0.035, bobA: 0.018, bobPh: 0.4, lean: 0.05, heelOff: 0.55, strike: -0.3, armZ: 0.2, armUp: 0, armFwd: 0, twist: 0.1, drop: 0, pitch: 0, bow: 0, trail: 0, toe: 0, pulse: 0 },
	run: { stepFrames: 9, sw: 1.25, maxStride: 1.2, lift: 0.15, base: -0.04, bobA: 0.035, bobPh: 0.15, lean: 0.26, heelOff: 0.45, strike: -0.05, armZ: 0.3, armUp: 0.2, armFwd: 0.06, twist: 0.18, drop: 0, pitch: 0, bow: 0, trail: 0, toe: 0, pulse: 0 },
	// push: a low, steep lean on the balls of the feet, which trail the hips; short steps; speed pulses with each step
	push: { stepFrames: 12, sw: 0.6, maxStride: 0.4, lift: 0.02, base: 0, bobA: 0.012, bobPh: 0.4, lean: 0, heelOff: 0, strike: 0, armZ: 0, armUp: 0, armFwd: 0, twist: 0, drop: 0.27, pitch: 0.62, bow: 0.22, trail: 0.6, toe: 0.5, pulse: 0.6 },
};
const KEYS = Object.keys(GAIT.walk);
const blend = ([r, p]) => Object.fromEntries(KEYS.map(k => [k, GAIT.walk[k] + r * (GAIT.run[k] - GAIT.walk[k]) + p * (GAIT.push[k] - GAIT.walk[k])]));

const dir2 = yaw => [Math.sin(yaw), Math.cos(yaw)];
const dist2 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const mix2 = (a, b, t) => [mix(a[0], b[0], t), mix(a[1], b[1], t)];
const yawTo = (a, b) => Math.atan2(b[0] - a[0], b[1] - a[1]);
/** Rest hand position in the pelvis frame, relative to the Hips joint (s = 1 left, -1 right). */
export const hang = s => [s * 0.22, -0.13, 0.02];
/** Ground point under the ankle of foot s when the pelvis ground point is c and the heading is yaw. */
export const home = (c, yaw, s) => { const [sn, cs] = dir2(yaw); return [c[0] + s * FOOT_X * cs + FOOT_Z * sn, c[1] - s * FOOT_X * sn + FOOT_Z * cs]; };

/** Ankle position and foot rotation. Toes down (pitch > 0) pivots on the toe tip, toes up pivots on the heel. */
export function footPose(g, lift, yaw, pitch) {
	const q = qMul(qY(yaw), qX(pitch)), [sn, cs] = dir2(yaw);
	const pivot = pitch > 0 ? [g[0] + sn * TOE[2], lift, g[1] + cs * TOE[2]] : [g[0], lift, g[1]];
	return { a: sub(pivot, qRotate(q, pitch > 0 ? TOE : SOLE)), q };
}

/** Standing body state on the state's feet. */
export function standB(st) {
	const [sn, cs] = dir2(st.yaw);
	return {
		p: [st.p[0] + sn * HIP_FWD, STAND_Y, st.p[1] + cs * HIP_FWD], q: qY(st.yaw), yaw: st.yaw, lean: 0, twist: 0,
		feet: st.feet.map(f => ({ ...footPose(f.g, 0, f.yaw, 0), planted: true })), hands: [hang(1), hang(-1)],
	};
}
export const hold = (st, n) => Array.from({ length: Math.max(0, n) }, () => st.lastB ? { ...st.lastB, p: st.lastB.p.slice() } : standB(st));

/** Plays a step plan [{ t0, dur, stepT, side }] over T frames along posAt(t) / yawAt(t). mixAt(t) is [run, push] weights (0, 0 = walk). */
function stepper(st, T, plan, posAt, yawAt, mixAt) {
	const swings = [[], []], cur = st.feet.map(f => ({ g: f.g.slice(), yaw: f.yaw }));
	plan.forEach((s, k) => {
		const nxt = plan[k + 2], tau = nxt ? (s.t0 + s.dur + nxt.t0) / 2 : T, yaw = yawAt(tau), [sn, cs] = dir2(yaw);
		const c = posAt(tau), trail = blend(mixAt(tau)).trail, from = cur[s.side];
		const o = s.off ?? [0, 0], h = home([c[0] - sn * trail, c[1] - cs * trail], yaw, s.side ? -1 : 1); // off: [left, forward] from the home spot
		const to = { g: [h[0] + o[0] * cs + o[1] * sn, h[1] - o[0] * sn + o[1] * cs], yaw: from.yaw + wrap(yaw - from.yaw) }, d = dist2(from.g, to.g);
		// sf: how much heel-toe roll the step gets (forward strides only); small and backward steps stay flat
		swings[s.side].push({ t0: s.t0, t1: s.t0 + s.dur, from, to, d, sf: clamp(((to.g[0] - from.g[0]) * sn + (to.g[1] - from.g[1]) * cs) / 0.5) });
		cur[s.side] = to;
	});
	const speed = t => dist2(posAt(t + 0.5), posAt(t - 0.5)) * 24;
	const frames = [], was = [0, 0];
	for (let t = 0; t < T; t++) {
		const [r, pw] = mixAt(t), P = blend([r, pw]), yaw = yawAt(t), c = posAt(t), [sn, cs] = dir2(yaw);
		const feet = swings.map((list, side) => {
			const sw = list.find(s => t >= s.t0 && t < s.t1);
			if (sw) {
				const u = (t - sw.t0) / (sw.t1 - sw.t0), e = mix(0.4 * u + 0.6 * smooth(u), u ** 1.4, r); // a run foot trails, then snaps forward
				const lift = (0.025 + P.lift * clamp(sw.d / 0.5)) * Math.sin(Math.PI * u ** mix(1, 0.75, r)) ** 1.6 * smooth(u / 0.3); // eased lift-off: no knee pop on the first frame
				was[side] = 0;
				return { ...footPose(mix2(sw.from.g, sw.to.g, e), lift, mix(sw.from.yaw, sw.to.yaw, smooth(u)), Math.max(P.toe, mix(sw.t0 < 2 ? 0 : P.heelOff, pw ? 0 : P.strike, smooth(u)) * sw.sf)), planted: false }; // the first step has no heel-off before it
			}
			const last = list.findLast(s => s.t1 <= t), next = list.find(s => s.t0 > t), at = last ? last.to : st.feet[side];
			// heel strike rolls off, the foot lies flat for at least one frame, then the heel lifts before the next step
			const stance = (next ? next.t0 : Infinity) - (last ? last.t1 : -Infinity), on = Math.min(2, 0.4 * stance), off = Math.min(4, 0.4 * stance);
			let pitch = 0;
			if (last && t - last.t1 < on) pitch = P.strike * last.sf * (1 - (t - last.t1) / on);
			if (next && next.t0 - t < off) pitch = P.heelOff * next.sf * smooth(1 - (next.t0 - t) / off);
			if (pw > 0 && pitch >= 0) pitch = Math.max(pitch, P.toe); // pushing: on the balls of the feet
			if (pitch * was[side] < 0) pitch = 0; // between rolling on the heel and on the toe the foot is flat for a frame
			was[side] = pitch;
			return { ...footPose(at.g, 0, at.yaw, pitch), planted: true };
		});
		const v = speed(t), act = clamp(v / 0.6), acc = (speed(t + 1) - speed(t - 1)) * 12;
		const step = plan.findLast(s => s.t0 <= t), ph = step ? (t - step.t0) / step.stepT : 0;
		// w: +1 left foot ahead, -1 right foot ahead; drives the arm swing and the pelvis / chest counter-twist
		const w = clamp(((feet[0].a[0] - feet[1].a[0]) * sn + (feet[0].a[2] - feet[1].a[2]) * cs) / 0.35, -1, 1) * act;
		const lean = act * P.lean + clamp(0.05 * acc, -0.12, 0.12) * (1 - pw);
		frames.push({
			p: [c[0] + sn * HIP_FWD, STAND_Y - P.drop + act * (P.base + P.bobA * Math.cos(2 * Math.PI * (ph - P.bobPh))), c[1] + cs * HIP_FWD],
			q: qMul(qY(yaw - 0.5 * P.twist * w), qX(0.35 * lean + P.pitch)), yaw, lean: 0.65 * lean + P.bow, twist: 1.2 * P.twist * w, feet,
			hands: [1, -1].map(s => [s * (0.22 - 0.03 * r), -0.13 + act * P.armUp + 0.03 * Math.abs(w), 0.02 + act * P.armFwd - s * w * P.armZ]),
		});
	}
	return { frames, st: { p: posAt(T), yaw: yawAt(T), feet: cur } };
}

function firstSide(st, D, dyaw) {
	const off = [1, -1].map((s, i) => dist2(st.feet[i].g, home(st.p, st.yaw, s)));
	if (Math.abs(off[0] - off[1]) > 0.02) return off[0] > off[1] ? 0 : 1;
	if (Math.abs(dyaw) > 0.05) return dyaw > 0 ? 0 : 1;
	const lat = D[0] * Math.cos(st.yaw) - D[1] * Math.sin(st.yaw);
	return lat < -0.05 ? 1 : 0;
}

/** Steps without following a path: turn on the spot, short / side / back moves, a lunge (steps: 1), feet together.
 *  first: "L" | "R" foot that starts; end: { L: [left, forward], R: [...] } final foot offsets (a split finish). */
export function shuffle(st, N, { to = st.p, yaw = st.yaw, steps, burst, first, end } = {}) {
	const dyaw = wrap(yaw - st.yaw), D = [to[0] - st.p[0], to[1] - st.p[1]], L = Math.hypot(D[0], D[1]);
	const still = L < 0.03 && Math.abs(dyaw) < 0.05;
	const away = [1, -1].filter((s, i) => dist2(st.feet[i].g, home(st.p, st.yaw, s)) > 0.02).length;
	const n = steps ?? (still ? away : Math.max(2, Math.ceil(L / 0.4) + 1, Math.ceil(Math.abs(dyaw) / rad(45)) + 1));
	if (!n || N < 4) return { frames: hold(st, N), st };
	const sw = GAIT.walk.sw, stepT = Math.min(L > 0.03 ? 13 : 11, (N - SETTLE) / (n - 1 + sw)), Tm = (n - 1 + sw) * stepT;
	const use = Math.min(N, Math.ceil(Tm + SETTLE)), ease = burst ? EASE.out : smooth, side = first ? (first === "R" ? 1 : 0) : firstSide(st, D, dyaw);
	const plan = Array.from({ length: n }, (_, k) => ({ t0: k * stepT, dur: sw * stepT, stepT, side: (side + k) % 2 }));
	if (end) for (const s of plan.slice(-2)) s.off = end[s.side ? "R" : "L"]; // the last step of each foot lands off its home spot
	const r = stepper(st, use, plan, t => mix2(st.p, to, ease(t / Tm)), t => st.yaw + dyaw * smooth(t / Tm), () => [0, 0]);
	return { frames: [...r.frames, ...hold(r.st, N - use)], st: r.st };
}

/** Smooth path through points with unit tangents; at(d) and yaw(d) by arc length. */
function buildPath(pts, dirs) {
	const P = [pts[0]], cum = [0], segEnd = [];
	for (let i = 0; i + 1 < pts.length; i++) {
		const A = pts[i], B = pts[i + 1], c = dist2(A, B);
		for (let k = 1; k <= 32; k++) {
			const u = k / 32, h00 = 2 * u ** 3 - 3 * u * u + 1, h10 = u ** 3 - 2 * u * u + u, h01 = 3 * u * u - 2 * u ** 3, h11 = u ** 3 - u * u;
			const p = [0, 1].map(a => h00 * A[a] + h10 * c * dirs[i][a] + h01 * B[a] + h11 * c * dirs[i + 1][a]);
			cum.push(cum.at(-1) + dist2(P.at(-1), p)); P.push(p);
		}
		segEnd.push(cum.at(-1));
	}
	const total = cum.at(-1);
	const at = d => {
		d = clamp(d, 0, total);
		let i = 1;
		while (i < cum.length - 1 && cum[i] < d) i++;
		const span = cum[i] - cum[i - 1];
		return mix2(P[i - 1], P[i], span > 1e-9 ? (d - cum[i - 1]) / span : 0);
	};
	return { at, segEnd, yaw: d => yawTo(at(d - 0.04), at(d + 0.04)) };
}

/** Distance travelled at frames 0..N for a move of length d that enters at speed vin and leaves at vout (m/frame). */
function warp(N, d, vin, vout, pulse = () => 1) {
	const Ta = Math.min(12, N / 3), vc = Math.max(0, (d - (vin + vout) * Ta / 2) / (N - Ta));
	const v = t => (t < Ta ? mix(vin, vc, smooth(t / Ta)) : t > N - Ta ? mix(vc, vout, smooth((t - (N - Ta)) / Ta)) : vc) * pulse(t);
	const S = [0];
	for (let t = 0; t < N; t++) S.push(S[t] + (v(t) + v(t + 1)) / 2);
	return S.map(s => S[N] > 1e-9 ? s * d / S[N] : 0);
}

const turnFrames = (d, N) => Math.min(N >> 1, Math.round(6 + 10 * Math.abs(d) / (Math.PI / 2)));

/** Walk / run chain along a curved path: segs = [{ kind, to, heading, N }]. Stops at the end of the last one. */
function travel(st, segs) {
	segs = segs.map(s => ({ ...s }));
	const out = [], n = segs.length, last = segs[n - 1];
	const all = [st.p, ...segs.map(s => s.to)];
	// direction of leg i of the route; a leg of no length (push in place, feet together) takes the nearest real one
	const legYaw = i => { for (let k = 0; k < n; k++) for (const j of [i + k, i - k]) if (j >= 0 && j < n && dist2(all[j], all[j + 1]) > 0.02) return yawTo(all[j], all[j + 1]); return st.yaw; };
	let d0 = wrap(legYaw(0) - st.yaw);
	if (Math.abs(d0) > rad(100)) { // facing away: turn on the spot first
		const Na = turnFrames(d0, segs[0].N), r = shuffle(st, Na, { yaw: st.yaw + d0 });
		out.push(...r.frames); st = r.st; segs[0].N -= Na; d0 = 0;
	}
	const pts = [st.p, ...segs.map(s => s.to)], yl = legYaw(n - 1);
	let post = null, Nb = 0, endDir = dir2(yl);
	if (last.heading != null) {
		if (Math.abs(wrap(last.heading - yl)) > rad(100)) { post = last.heading; Nb = turnFrames(wrap(post - yl), last.N); last.N -= Nb; }
		else endDir = dir2(last.heading);
	}
	const dirs = pts.map((p, i) => {
		if (i === 0) return dir2(Math.abs(d0) < rad(8) ? legYaw(0) : st.yaw);
		if (i === n) return endDir;
		return dir2(segs[i - 1].heading ?? (dist2(pts[i - 1], pts[i + 1]) > 0.02 ? yawTo(pts[i - 1], pts[i + 1]) : legYaw(i)));
	});
	const path = buildPath(pts, dirs), lens = segs.map((_, i) => path.segEnd[i] - (i ? path.segEnd[i - 1] : 0));
	segs.forEach((s, i) => {
		const G = GAIT[s.kind], end = i === n - 1;
		let k = Math.max(end ? 2 : 1, Math.round(s.N / G.stepFrames));
		s.use = s.N;
		if (lens[i] / k > G.maxStride) k = Math.ceil(lens[i] / G.maxStride) + (end ? 1 : 0);
		else if (end && lens[i] / k < 0.3) { k = Math.max(2, Math.ceil(lens[i] / 0.45) + 1); s.use = Math.min(s.N, Math.round(k * 13)); } // too slow: arrive early, then stand
		s.k = k;
	});
	const vb = i => i <= 0 || i >= n ? 0 : (lens[i - 1] / segs[i - 1].use + lens[i] / segs[i].use) / 2;
	const S = [0], plan = [];
	let side = firstSide(st, [pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]], d0);
	segs.forEach((s, i) => {
		const G = GAIT[s.kind], F0 = S.length - 1, base = S.at(-1);
		const stepT = i === n - 1 ? (s.use - SETTLE) / (s.k - 1 + G.sw) : s.use / s.k;
		const w = warp(s.use, lens[i], vb(i), vb(i + 1), t => 1 + G.pulse * Math.cos(2 * Math.PI * (t / stepT - 0.5 * G.sw)));
		for (let j = 0; j < s.k; j++, side ^= 1) plan.push({ t0: F0 + j * stepT, dur: G.sw * stepT, stepT, side });
		for (let t = 1; t <= s.use; t++) S.push(base + w[t]);
		s.F0 = F0;
	});
	const Tm = S.length - 1, tab = (A, t) => { t = clamp(t, 0, Tm); const i = Math.min(Tm - 1, Math.floor(t)); return mix(A[i], A[i + 1], t - i); };
	let prev = st.yaw - wrap(st.yaw - path.yaw(0));
	const yawRaw = S.map(s => (prev += wrap(path.yaw(s) - prev)));
	const dStart = st.yaw - yawRaw[0], dEnd = post == null && last.heading != null ? wrap(last.heading - yawRaw[Tm]) : 0;
	const yawTab = yawRaw.map((y, t) => y + dStart * (1 - smooth(t / 10)) + dEnd * smooth((t - (Tm - 10)) / 10));
	const kindAt = t => segs.findLast(s => s.F0 <= Math.max(0, t)).kind;
	const share = (kind, t, half) => { let a = 0; for (let d = -half; d <= half; d++) a += kindAt(t + d) === kind; return a / (2 * half + 1); };
	let r = stepper(st, Tm, plan, t => path.at(tab(S, t)), t => tab(yawTab, t), t => [share("run", t, 5), share("push", t - 9, 9)]); // the push posture comes on after its beat starts and goes after it ends
	out.push(...r.frames);
	const rest = last.N - last.use;
	if (post != null) { r = shuffle(r.st, Nb + rest, { yaw: post }); out.push(...r.frames); }
	else out.push(...hold(r.st, rest));
	return { frames: out, st: r.st };
}

/** One walk / run action or a chain of them. A single short, `facing` or `steps` move is a shuffle. */
export function locomote(st, segs) {
	const s = segs[0];
	if (segs.length === 1 && s.kind !== "push" && (s.facing != null || s.steps != null || s.end || s.first || dist2(st.p, s.to) < 0.5))
		return shuffle(st, s.N, { to: s.to, yaw: s.facing ?? s.heading ?? st.yaw, steps: s.steps, burst: s.burst, first: s.first, end: s.end });
	return travel(st, segs);
}
