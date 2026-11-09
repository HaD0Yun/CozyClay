// Flight physics QA (#1124): what gravity and the conservation of angular momentum say about a body.
//   DROP  supported (not in an air run: a foot, a hand, a declared support or the skin on a surface carries it), the
//         hips accelerate down faster than DROP_LIMIT g for 2 frames or more, going down or up. A support can only
//         push: with the ground under it a body falls at 1 g at most (the hips a little more as the legs fold), so a
//         faster drop is a keyed fall the support should have slowed, and a rise that stops faster than 1 g is a body
//         the support would have had to pull down. Bench v2 (2026-11-07, 06 trip run r1: the hips fell at 1.5-2.3 g).
//         value = the downward acceleration in g. The hint gives the time the drop needs at 1 g, sqrt(2 h / g), or an
//         earlier hand brace; for a rise, the time stopping it needs at 1 g, v / g. A body turning over (the hips' up
//         axis tilts more than OVER deg in one go, TURNING deg a frame or more: a cartwheel, a flip, a roll; a turn about
//         the vertical, a pirouette, is none) swings its hips round what carries it, so their height is not a fall: DROP
//         leaves those frames (the flip skill's cartwheel dips its hips at 1.5-3.3 g).
//   SPIN  in a free span of an air run (freeSpans: MIN_RUN frames or more, split where a hand carries the body; a flight, or
//         one the take's start or end cuts) the angular momentum about the centre of mass (inertia.js) must stay what the
//         body left the ground with, read on the frames whose central difference stays in the air (the takeoff and landing
//         frames carry the push). value = how far it drifts at that frame from the run's mean along the mean's axis u (deviations), as a
//         share of the larger of |mean| and I_u * SPIN_OMEGA, I_u the run's mean whole-body inertia about u; SPIN_TOL
//         is the share allowed. As turn rates (L / I_u): a frame may turn 20% faster or slower than the run's momentum
//         allows, and never less than 20% of SPIN_OMEGA (2.5 rad/s) off it when the body turns slower than that. A
//         twisting spin jump (I_u about 1.8 kg m^2) keyed at an even rate with its arms pulled in drifts 5.6 kg m^2/s
//         (0.245); a back tuck about 60 kg m^2/s, its keyed turn 35 (0.40), about 7 after fix.spin (fix/spin.js re-times
//         the root's turn so it holds); legs tucked in a hop with no turn swing it by up to 11 (0.19, nothing to re-time).
//   POP   is left out on the push-off and impact frames of a flight fix.ballistic moved (contactFrames; qa/index.js drops them).
import { airRuns, missingFall, FLOAT_LIMIT } from "./style.js";
import { momentumOf } from "./inertia.js";
import { apply, dot, T } from "../compiler/math.js";
import { isFollow } from "../carried.js";
import { handOf, moverOf } from "../object-pose.js";

/** DROP: the hips' downward acceleration (g) a supported body may reach. */
export const DROP_LIMIT = 1.1;
/** SPIN: the share of the run's mean angular momentum one air frame may drift from it. */
export const SPIN_TOL = 0.2;
/** SPIN: rad/s (two turns a second, a flip's rate): a drift is measured against at least the momentum I_u * SPIN_OMEGA. */
const SPIN_OMEGA = 4 * Math.PI;
/** Flights have at least this many frames (FLOAT's runs; fix/ballistic.js and fix/spin.js work on the same). */
const MIN_RUN = 4;
/** DROP: a body whose hips' up axis tilts more than OVER deg in one go, TURNING deg a frame or more, is turning over. */
const OVER = 180, TURNING = 2;

/** A hand still in the world moves less than this (m) over two frames: it is planted on something. */
const STILL = 0.01;

/**
 * True when anchor `name` can carry the body at absolute frame f: a world point, another character, or a scene object
 * this body does not take along. A body, bone, segment, landmark or prop anchor rides the body, and so does an object in
 * the hand or following a bone: a hand on them carries nothing.
 */
function anchorCarries(out, name, f) {
	const { spec, scene } = out.ctx, a = spec?.anchors?.[name];
	if (a?.kind === "world" || a?.kind === "person") return true;
	return a?.kind === "object" && !isFollow(spec.objects?.[moverOf(spec, scene, a.object)]) && handOf(out, a.object, f) === null;
}

/** True when a hand carries the body at frame index i: on its IK, its target held on a carrying anchor, or (off its anchors) still in the world. */
function pinned(out, i) {
	const { c } = out.frames[i], f = i + (out.f0 ?? 0), n = out.frames.length + (out.f0 ?? 0);
	return ["l", "r"].some(k => {
		if (!(c[`armw_${k}`] >= 0.5)) return false;
		let on = 0, carrying = 0;
		for (const [ch, v] of Object.entries(c)) {
			if (!ch.startsWith("w_") || !ch.endsWith(`_${k}`) || typeof v !== "number") continue;
			on += v;
			if (anchorCarries(out, ch.slice(2, -2), f)) carrying += v;
		}
		if (carrying >= 0.5) return true;
		// the hand follows an anchor that rides the body: whatever its unused world target does says nothing
		if (on >= 0.5) return false;
		const h = out.baked?.[`hand_${k}`], p = h?.[Math.max(0, f - 1)], q = h?.[Math.min(n - 1, f + 1)];
		return Array.isArray(p) && Array.isArray(q) && Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]) < STILL;
	});
}

/** MIN_RUN frames or more: a walk's one-frame lift is no flight. */
const longRuns = runs => runs.filter(([a, b]) => b - a + 1 >= MIN_RUN);

/**
 * The air runs retime leaves alone (fix/retime.js): MIN_RUN frames or more whose hips fall, whatever a hand holds and
 * wherever the take ends. Retime reads the first solve, where a body the leg fixes will put back on the ground reads as a
 * run with its hips held up (bench-box2 f44-f140: 99% of g missing, no air run in the final frames), which is no fall to protect.
 */
export const fallingRuns = (out, runs) => longRuns(runs).filter(([a, b]) => missingFall(out, a, b) <= FLOAT_LIMIT);

/**
 * The spans of air runs `runs` (style.js airRuns, indexes of out.frames) no hand carries the body in (pinned: a vault's
 * hands on a world point or an anchor, which style.js airRuns cannot see without a scene body), MIN_RUN frames or more.
 * SPIN reads these: a span the take's start or end cuts still holds its momentum.
 */
function freeSpans(out, runs) {
	const keep = [], add = (a, b) => { if (b - a + 1 >= MIN_RUN) keep.push([a, b]); };
	for (const [a, b] of longRuns(runs)) {
		let from = a;
		for (let i = a; i <= b; i++) if (pinned(out, i)) { add(from, i - 1); from = i + 1; }
		add(from, b);
	}
	return keep;
}

/**
 * The flights in air runs `runs`: the free spans with a frame on each side, the takeoff and landing the flight fixes
 * (fix/ballistic.js, fix/spin.js) anchor on. A span the take cuts has no such frame, so the fixes leave it.
 */
export function flights(out, runs) {
	return freeSpans(out, runs).filter(([a, b]) => a >= 1 && b <= out.frames.length - 2);
}

/** The momentum about the centre of mass per frame a..b of out ({ L kg m^2/s, J kg m^2 }), or null at either end of the take or on a rig missing a segment bone. */
function momenta(out, a, b) {
	if (a < 1 || b > out.frames.length - 2) return null;
	const fps = out.fps ?? 24, Ms = [];
	for (let f = a; f <= b; f++) { const m = momentumOf(out.ctx.sk, out.frames, f, fps); if (!m) return null; Ms.push(m); }
	return Ms;
}

/** u . J . u: the inertia of J about unit axis u. */
const about = (J, u) => [0, 1, 2].reduce((s, i) => s + u[i] * (J[i][0] * u[0] + J[i][1] * u[1] + J[i][2] * u[2]), 0);

/**
 * Per frame a..b: how far L along the flight's mean momentum axis u is from the mean, |L . u - |mean|| / max(|mean|,
 * I_u SPIN_OMEGA), I_u the mean inertia about u (a third of the trace when the mean is 0: no axis); null where the
 * momentum cannot be read. The axis is the turn's: a keyed turn whose axis swings (the hit skill's yaw and pitch at once)
 * or a spin about a non-principal axis moves L off it, which no re-timing of the turn can change, so SPIN leaves that
 * out (the hit skill: L along u 27-31 kg m^2/s while its direction turns 40 deg).
 */
function deviations(out, a, b) {
	const Ms = momenta(out, a, b);
	if (!Ms) return null;
	const m = [0, 1, 2].map(k => Ms.reduce((s, { L }) => s + L[k], 0) / Ms.length), size = Math.hypot(...m), u = m.map(x => x / (size || 1));
	const Iu = Ms.reduce((s, { J }) => s + (size < 1e-9 ? (J[0][0] + J[1][1] + J[2][2]) / 3 : about(J, u)), 0) / Ms.length;
	const ref = Math.max(size, Iu * SPIN_OMEGA, 1e-9);
	if (size < 1e-9) return Ms.map(({ L }) => Math.hypot(...L) / ref);
	return Ms.map(({ L }) => Math.abs(L[0] * u[0] + L[1] * u[1] + L[2] * u[2] - size) / ref);
}

/** The worst SPIN deviation over free span [a, b] (indexes of out.frames): the frames whose central difference stays in the air, a + 1 .. b - 1. */
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
 * Only the flights fix.ballistic moved (out.flightRuns, fix/index.js flightFixes), at the frames it moved them: the speed
 * step is where the move ends, and QA's own reading of the same air frames can differ by a frame once the body has moved
 * (a hand that was still on its plant no longer is). A flight left as keyed reads POP as any take does. Frames index out.frames.
 */
export function contactFrames(out) {
	const at = new Set();
	for (const [a, b] of out.flightRuns ?? []) for (const f of [a - 1, a, a + 1, b + 1, b + 2, b + 3]) at.add(f);
	return at;
}

/** 1 on every frame of a turn over: a span the hips' up axis tilts TURNING deg a frame or more in, OVER deg or more in all. */
function turningOver(out) {
	const F = out.frames, n = F.length, h = out.ctx.sk.index.Hips, over = new Uint8Array(n), step = new Float64Array(n);
	// the hips' up axis in the world: the rest pose's world up carried by the hips' turn from rest
	const rest = apply(T(out.ctx.sk.restWorldRot[h]), [0, 1, 0]), up = f => apply(F[f].s.R[h], rest);
	for (let f = 1; f < n; f++) step[f] = (Math.acos(Math.max(-1, Math.min(1, dot(up(f), up(f - 1))))) * 180) / Math.PI;
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
	for (let f = 1; f < n - 1; f++) down[f] = skip[f] ? 0 : -(y(f + 1) - 2 * y(f) + y(f - 1)) / g;
	for (let f = 1; f < n - 1; f++) {
		if (!(down[f] > DROP_LIMIT)) continue;
		let e = f;
		while (e + 1 < n - 1 && down[e + 1] > DROP_LIMIT) e++;
		if (e > f) for (let q = f; q <= e; q++) issues.push({ kind: "DROP", msg: `hips ${y(q + 1) > y(q - 1) ? "stop rising" : "fall"} at ${down[q].toFixed(1)} g with support`, frame: q, value: +down[q].toFixed(4), limit: DROP_LIMIT });
		f = e;
	}
	for (const [a, b] of freeSpans(out, runs)) {
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

/** The rise a DROP group brakes: the frame the hips stop rising (1 mm a frame), their fastest rise before it (m/frame). */
function rise(X, g) {
	const y = f => X.fr(f).s.P[X.I.Hips][1], lo = X.out.f0 ?? 0, hi = lo + X.out.frames.length - 1;
	let top = g.first, v = 0;
	while (top < hi && y(top + 1) - y(top) > 1e-3) top++;
	for (let f = g.first; f > lo && y(f) - y(f - 1) > 1e-3; f--) v = Math.max(v, y(f) - y(f - 1));
	return { top, v };
}

export const flightHints = {
	DROP(X, g) {
		const fps = X.out.fps ?? 24, y = f => X.fr(f).s.P[X.I.Hips][1], w = g.worstFrame ?? g.first;
		if (y(w + 1) > y(w - 1)) {
			const { top, v } = rise(X, g), t = (v * fps) / 9.81, need = Math.ceil(t * fps);
			return { cause: X.cause("root", w), hint: `the hips stop a rise of ${r2(v * fps)} m/s by f${top} at up to ${r2(g.worst)} g while a foot or the body is supported; a support only pushes, so stopping v m/s takes v/g = ${r2(t)} s (${need} frames) even at 1 g: ease the root into its top over ${need} frames or more, or let the feet leave the ground (a hop)` };
		}
		const { top, bottom, h } = descent(X, g), t = Math.sqrt(2 * Math.max(0, h) / 9.81), need = Math.ceil(t * fps);
		return { cause: X.cause("root", g.worstFrame), hint: `the hips drop ${r2(h)} m over ${bottom - top} frames (f${top}-f${bottom}) at up to ${r2(g.worst)} g while a foot or the body is supported; a drop of h m takes sqrt(2h/g) = ${r2(t)} s (${need} frames) even at 1 g: key the root's low point at f${top + need} or later, or brace earlier: put a hand on the ground or an object before f${g.first} so the arms take the fall` };
	},
	SPIN(X, g) {
		const ch = ["pitch", "roll", "yaw"].find(c => X.keys(c).length) ?? "pitch";
		return { cause: X.cause(ch, g.worstFrame), hint: `in the air the angular momentum about the centre of mass drifts ${Math.round(g.worst * 100)}% from its mean over f${g.first}-f${g.last} (limit ${Math.round(SPIN_TOL * 100)}%): a body turns faster tucked and slower open (I w stays constant). fix.spin (on by default) re-times the root's ${ch} so it holds; with it off, key the ${ch} so the turn is fastest where the limbs are pulled in` };
	},
};
