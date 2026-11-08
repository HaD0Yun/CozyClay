// Flight physics QA (#1124): what gravity and the conservation of angular momentum say about a body.
//   DROP  supported (not in an air run: a foot, a hand, a declared support or the skin on a surface carries it) and
//         going down, the hips accelerate down faster than DROP_LIMIT g for 2 frames or more. A support can only
//         push: with the ground under it a body falls at 1 g at most (the hips a little more as the legs fold), so a
//         faster drop is a keyed fall the support should have slowed. Bench v2 (2026-11-07, 06 trip run r1: the hips
//         fell at 1.5-2.3 g). value = the downward acceleration in g. The hint gives the time the drop needs at 1 g,
//         sqrt(2 h / g), or an earlier hand brace. A body turning over (the hips turn more than OVER deg in one go,
//         TURNING deg a frame or more: a cartwheel, a flip, a roll) swings its hips round what carries it, so their
//         height is not a fall: DROP leaves those frames (the flip skill's cartwheel dips its hips at 1.5-3.3 g).
//   SPIN  in a flight (flights: an air run of MIN_RUN frames or more, split where a hand is pinned, a frame on each
//         side) the angular momentum about the centre of mass (inertia.js) must stay what the body left the ground with,
//         read on the frames whose central difference stays in the air (the takeoff and landing frames carry the
//         push). value = how far it drifts at that frame from the run's mean along the mean's axis (deviations), as a
//         share of the mean or of SPIN_FLOOR kg m^2/s, whichever is larger;
//         SPIN_TOL is the share allowed. So a frame may drift 20% of the run's momentum, and never less than 16
//         kg m^2/s (70 kg body): legs tucked in a straight hop swing it by about 14 with no turn to re-time, a
//         standing back tuck carries about 60 and its keyed turn drifts 30-48. fix.spin (fix/spin.js) re-times the
//         root's turn so it holds (about 8 left after it).
//   POP   is left out on a flight's push-off and impact frames (contactFrames; qa/index.js drops them).
import { airRuns } from "./style.js";
import { momentumOf, rotationVector } from "./inertia.js";
import { mul, T } from "../compiler/math.js";

/** DROP: the hips' downward acceleration (g) a supported body may reach. */
export const DROP_LIMIT = 1.1;
/** SPIN: the share of the run's mean angular momentum one air frame may drift from it. */
export const SPIN_TOL = 0.2;
/** SPIN: kg m^2/s, the momentum a drift is measured against at least (SPIN_TOL of it: 16 kg m^2/s). */
const SPIN_FLOOR = 80;
/** Flights have at least this many frames (FLOAT's runs; fix/ballistic.js and fix/spin.js work on the same). */
const MIN_RUN = 4;
/** DROP: a body whose hips turn more than OVER deg in one go, TURNING deg a frame or more, is turning over. */
const OVER = 180, TURNING = 2;

/** A hand still in the world moves less than this (m) over two frames: it is planted on something. */
const STILL = 0.01;
/** True when a hand carries the body at frame index i: on its IK with its target held on an anchor or still in the world. */
function pinned(out, i) {
	const { c } = out.frames[i], f = i + (out.f0 ?? 0), n = out.frames.length + (out.f0 ?? 0);
	return ["l", "r"].some(k => {
		if (!(c[`armw_${k}`] >= 0.5)) return false;
		const w = Object.entries(c).reduce((s, [ch, v]) => (ch.startsWith("w_") && ch.endsWith(`_${k}`) && typeof v === "number" ? s + v : s), 0);
		if (w >= 0.5) return true;
		const h = out.baked?.[`hand_${k}`], p = h?.[Math.max(0, f - 1)], q = h?.[Math.min(n - 1, f + 1)];
		return Array.isArray(p) && Array.isArray(q) && Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]) < STILL;
	});
}

/**
 * The flights in air runs `runs` (style.js airRuns, indexes of out.frames): the runs split where a hand carries the
 * body (pinned: a vault's hands on a world point or an anchor, which style.js airRuns cannot see without a scene body),
 * kept when MIN_RUN frames or more with a frame on each side. SPIN, the push-off and impact frames and the flight fixes
 * (fix/ballistic.js, fix/spin.js) read these.
 */
export function flights(out, runs) {
	const n = out.frames.length, keep = [], add = (a, b) => { if (b - a + 1 >= MIN_RUN && a >= 1 && b <= n - 2) keep.push([a, b]); };
	for (const [a, b] of runs) {
		if (b - a + 1 < MIN_RUN) continue;
		let from = a;
		for (let i = a; i <= b; i++) if (pinned(out, i)) { add(from, i - 1); from = i + 1; }
		add(from, b);
	}
	return keep;
}

/** Angular momentum about the centre of mass per frame a..b of out (kg m^2/s vectors), or null at either end of the take. */
function momenta(out, a, b) {
	if (a < 1 || b > out.frames.length - 2) return null;
	const fps = out.fps ?? 24, Ls = [];
	for (let f = a; f <= b; f++) { const m = momentumOf(out.ctx.sk, out.frames, f, fps); if (!m) return null; Ls.push(m.L); }
	return Ls;
}

/**
 * Per frame a..b: how far L along the flight's mean momentum axis u is from the mean, |L . u - |mean|| / max(|mean|,
 * SPIN_FLOOR); null where the momentum cannot be read. The axis is the turn's: a keyed turn whose axis swings (the hit
 * skill's yaw and pitch at once) or a spin about a non-principal axis moves L off it, which no re-timing of the turn can
 * change, so SPIN leaves that out (the hit skill: L along u 27-31 kg m^2/s while its direction turns 40 deg).
 */
function deviations(out, a, b) {
	const Ls = momenta(out, a, b);
	if (!Ls) return null;
	const m = [0, 1, 2].map(k => Ls.reduce((s, L) => s + L[k], 0) / Ls.length), size = Math.hypot(...m), ref = Math.max(size, SPIN_FLOOR);
	if (size < 1e-9) return Ls.map(L => Math.hypot(...L) / ref);
	return Ls.map(L => Math.abs((L[0] * m[0] + L[1] * m[1] + L[2] * m[2]) / size - size) / ref);
}

/** The worst SPIN deviation over flight [a, b] (indexes of out.frames): the frames whose central difference stays in the air, a + 1 .. b - 1. */
export function runDrift(out, a, b) {
	const d = deviations(out, a + 1, b - 1);
	return d ? Math.max(...d) : 0;
}

/**
 * The POP frames (style.js popChecks: the acceleration over f-2..f) of each flight's push-off and impact: the frame
 * before takeoff A, the first air frame and the next, the frame after landing B and the two after it. A body leaving or
 * meeting the ground changes speed in a frame (an ankle stops on the floor, the knees take the landing), so a one-frame
 * acceleration there is contact, not an artifact; with the air frames on their arc (fix.ballistic) it stands out from
 * them (the flip skill's landing knee: 8 cm/f^2, read against 7 cm/f^2 of keyed air frames before the fix and 2 after).
 * The flights of `runs` (flights); frames index out.frames.
 */
export function contactFrames(out, runs) {
	const at = new Set();
	for (const [a, b] of flights(out, runs)) for (const f of [a - 1, a, a + 1, b + 1, b + 2, b + 3]) at.add(f);
	return at;
}

/** 1 on every frame of a turn over: a span the hips turn TURNING deg a frame or more in, OVER deg or more in all. */
function turningOver(out) {
	const F = out.frames, n = F.length, h = out.ctx.sk.index.Hips, over = new Uint8Array(n), step = new Float64Array(n);
	for (let f = 1; f < n; f++) step[f] = (Math.hypot(...rotationVector(mul(F[f].s.R[h], T(F[f - 1].s.R[h])))) * 180) / Math.PI;
	for (let f = 1; f < n; f++) {
		if (step[f] < TURNING) continue;
		let e = f, sum = 0;
		while (e < n && step[e] >= TURNING) sum += step[e++];
		if (sum >= OVER) over.fill(1, f - 1, e);
		f = e;
	}
	return over;
}

/** DROP and SPIN issues (frames index out.frames); runs = style.js airRuns of the take. */
export function flightChecks(out, checks = {}, runs = airRuns(out, checks.supports)) {
	const F = out.frames, n = F.length, I = out.ctx.sk.index, g = 9.81 / (out.fps ?? 24) ** 2, f0 = out.f0 ?? 0, issues = [];
	const skip = turningOver(out);
	for (const [a, b] of runs) skip.fill(1, a, b + 1);
	const y = f => F[f].s.P[I.Hips][1], down = new Float64Array(n);
	for (let f = 1; f < n - 1; f++) down[f] = skip[f] || y(f + 1) >= y(f - 1) ? 0 : -(y(f + 1) - 2 * y(f) + y(f - 1)) / g;
	for (let f = 1; f < n - 1; f++) {
		if (!(down[f] > DROP_LIMIT)) continue;
		let e = f;
		while (e + 1 < n - 1 && down[e + 1] > DROP_LIMIT) e++;
		if (e > f) for (let q = f; q <= e; q++) issues.push({ kind: "DROP", msg: `hips fall at ${down[q].toFixed(1)} g with support`, frame: q, value: +down[q].toFixed(4), limit: DROP_LIMIT });
		f = e;
	}
	for (const [a, b] of flights(out, runs)) {
		// the takeoff and the landing frame read the ground's push through their central difference: the frames between
		const d = deviations(out, a + 1, b - 1);
		if (d) d.forEach((v, i) => { if (v > SPIN_TOL) issues.push({ kind: "SPIN", msg: `angular momentum drifts in the air f${a + f0}-f${b + f0}`, frame: a + 1 + i, value: +v.toFixed(4), limit: SPIN_TOL }); });
	}
	return issues;
}

const r2 = x => (Math.round(x * 100) / 100).toFixed(2);

/** The descent around a DROP group: the frames where the hips start down and stop (moving down 1 mm a frame or more), and the height between. */
function descent(X, g) {
	const y = f => X.fr(f).s.P[X.I.Hips][1], lo = X.out.f0 ?? 0, hi = lo + X.out.frames.length - 1;
	let top = g.first, bottom = g.last;
	while (top > lo && y(top - 1) - y(top) > 1e-3) top--;
	while (bottom < hi && y(bottom) - y(bottom + 1) > 1e-3) bottom++;
	return { top, bottom, h: y(top) - y(bottom) };
}

export const flightHints = {
	DROP(X, g) {
		const { top, bottom, h } = descent(X, g), fps = X.out.fps ?? 24, t = Math.sqrt(2 * Math.max(0, h) / 9.81), need = Math.ceil(t * fps);
		return { cause: X.cause("root", g.worstFrame), hint: `the hips drop ${r2(h)} m over ${bottom - top} frames (f${top}-f${bottom}) at up to ${r2(g.worst)} g while a foot or the body is supported; a drop of h m takes sqrt(2h/g) = ${r2(t)} s (${need} frames) even at 1 g: key the root's low point at f${top + need} or later, or brace earlier: put a hand on the ground or an object before f${g.first} so the arms take the fall` };
	},
	SPIN(X, g) {
		const ch = ["pitch", "roll", "yaw"].find(c => X.keys(c).length) ?? "pitch";
		return { cause: X.cause(ch, g.worstFrame), hint: `in the air the angular momentum about the centre of mass drifts ${Math.round(g.worst * 100)}% from its mean over f${g.first}-f${g.last} (limit ${Math.round(SPIN_TOL * 100)}%): a body turns faster tucked and slower open (I w stays constant). fix.spin (on by default) re-times the root's ${ch} so it holds; with it off, key the ${ch} so the turn is fastest where the limbs are pulled in` };
	},
};
