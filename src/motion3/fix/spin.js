// Spin fix (spec.fix.spin): in the air nothing turns the body, so its angular momentum about the centre of mass stays
// what it left the ground with: a body that tucks spins faster, one that opens out slows (L = I w). Per flight
// (qa/flight-checks.js flights) whose keyed root turns MIN_TURN or more between the anchors A (the frame before takeoff) and
// B (the frame after landing), the root's turn (yaw, pitch, roll) is re-timed along its own path, the limbs keeping their
// own timing, so that the momentum
//   L(f) = h(f) + J(f) n w(f)  stays as near one vector c as a turn about the keyed axis n can (least squares, rates),
// where J is the whole-body inertia tensor about the centre of mass (qa/inertia.js), h the momentum the limbs carry
// against the root and w the root's turning speed; the keyed total turn from A to B is kept (sum w = the keyed angle) and
// the turn at A and at B stays as keyed. A body symmetric about n (a flip) has J n along n: L_n = h_n + I_n w holds one
// value. One that leans off n also carries momentum across n in proportion to w (J n off n): holding L_n alone scaled that
// with the turn rate, so |L| drifted more than keyed (a 360 deg spin jump leaning 16 deg, arms pulled in: 29.1% keyed, 29.2%
// held along n, 2.7% held as a vector; (max - min) / mean of |L| over the air run). The world targets that ride the
// body (the ankle and wrist targets, ballistic.js RIDERS) and the knee and elbow poles turn with the root, so the limbs
// keep their pose in the body; a foot's fyaw turns with the root's yaw. Three passes: measure, re-time, solve.
// A flight whose keyed turn turns back by more than BACK_SHARE of its total, whose limbs would turn the root backward
// (w <= 0 somewhere), on a rig missing a segment bone, that the re-time would put into what the keyed flight stayed out of
// (flight-gate.js) or leave drifting more than before and over SPIN_TOL (a turn too fast to read: 1080 deg in 12 frames)
// is left and reported (fixed.spin.left); QA SPIN still reads it. A run whose hips do not fall (FLOAT) is a staging error
// and stays for QA's arc hint, as in ballistic.js. A smaller reversal (a flip's overshoot before it lands) re-times along
// the turn's monotone envelope.
import { add, sub, scale, apply, dot, mul, rx, ry, rz, T } from "../compiler/math.js";
import { tiltFrame } from "../compiler/pose.js";
import { momentumOf, rotationVector } from "../qa/inertia.js";
import { runDrift, SPIN_TOL, MIN_TURN } from "../qa/flight-checks.js";
import { RIDERS, floats } from "./ballistic.js";
import { hitSays } from "./flight-gate.js";

/** The share of the total turn a keyed turn may run backward and still be one turn. */
const BACK_SHARE = 0.02;
const PASSES = 3, POLES = ["knee_l", "knee_r", "elbow_l", "elbow_r"], deg = r => (r * 180) / Math.PI;

/** The root's world turn at frame f from Euler channels e = { yaw, pitch, roll } (arrays of degrees). */
const turnOf = (e, f) => mul(ry(e.yaw[f]), mul(rx(e.pitch[f]), rz(e.roll[f])));
/** The frame pose.js reads the poles in: the tilt frame past upright, else the yaw. */
const poleFrame = (y, p, r) => tiltFrame(y, p, r)?.R ?? ry(y);

/** The keyed turn over A..B: { n (unit axis), theta[f - A] (rad along n, 0 at A), total }, { back: true } when it turns back, or null under MIN_TURN. */
function keyedTurn(e, A, B) {
	const steps = [];
	for (let f = A + 1; f <= B; f++) steps.push(rotationVector(mul(turnOf(e, f), T(turnOf(e, f - 1)))));
	const sum = steps.reduce((acc, v) => add(acc, v), [0, 0, 0]), size = Math.hypot(...sum);
	if (deg(size) < MIN_TURN) return null;
	const n = sum.map(v => v / size), theta = [0];
	for (const v of steps) theta.push(theta[theta.length - 1] + dot(v, n));
	const total = theta[theta.length - 1];
	let top = 0, back = 0;
	const envelope = theta.map(t => { top = Math.max(top, t); back = Math.max(back, top - t); return Math.min(top, total); });
	return back > BACK_SHARE * total ? { back: true } : { n, theta: envelope, total };
}

/** The fractional frame (A-based) where the keyed turn reaches angle t (theta the monotone envelope). */
function frameAtTurn(theta, t) {
	let i = 1;
	while (i < theta.length - 1 && theta[i] < t) i++;
	const span = theta[i] - theta[i - 1];
	return i - 1 + (span > 1e-12 ? Math.min(1, Math.max(0, (t - theta[i - 1]) / span)) : 0);
}

/** Per air frame a..b: the momentum the limbs carry (h) and the moment of inertia about n (I), and L_n, from the solved frames; null on a rig missing a segment bone. */
function measure(out, a, b, n, e) {
	const fps = out.fps ?? 24, f0 = out.f0 ?? 0, rows = [];
	for (let i = a; i <= b; i++) {
		const m = momentumOf(out.ctx.sk, out.frames, i, fps), f = i + f0;
		if (!m) return null;
		const w = dot(rotationVector(mul(turnOf(e, f + 1), T(turnOf(e, f - 1)))), n) * fps / 2, u = apply(m.J, n);
		rows.push({ h: sub(m.L, scale(u, w)), u });
	}
	return rows;
}

/** x of the n x n system M x = y (Gaussian elimination, partial pivoting). */
function solveLinear(M, y) {
	const A = M.map((row, i) => [...row, y[i]]), n = y.length;
	for (let c = 0; c < n; c++) {
		const p = A.slice(c).reduce((best, row, i) => (Math.abs(row[c]) > Math.abs(A[best][c]) ? c + i : best), c);
		[A[c], A[p]] = [A[p], A[c]];
		for (let r = c + 1; r < n; r++) { const k = A[r][c] / A[c][c]; for (let j = c; j <= n; j++) A[r][j] -= k * A[c][j]; }
	}
	const x = new Array(n).fill(0);
	for (let r = n - 1; r >= 0; r--) x[r] = (A[r][n] - A[r].slice(r + 1, n).reduce((s, v, j) => s + v * x[r + 1 + j], 0)) / A[r][r];
	return x;
}

/**
 * The root's turning speed per air frame (rad/s) that keeps L(f) = h(f) + w(f) u(f) nearest one vector c in least squares
 * (weights wt), with sum wt w = total * fps (the keyed turn): w = (u . (c - h) + lambda) / |u|^2, c and lambda from the
 * 4 x 4 normal equations. u = J n: about n alone (u along n) this is L_n = h_n + I w held at one value; a body whose
 * inertia is not symmetric about n (a lean) also carries momentum across n in proportion to w, which this weighs too.
 */
function rates(rows, wt, target) {
	const M = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], y = [0, 0, 0, target];
	rows.forEach(({ h, u }, f) => {
		const q = dot(u, u), uh = dot(u, h);
		for (let i = 0; i < 3; i++) {
			for (let j = 0; j < 3; j++) M[i][j] += wt[f] * ((i === j ? 1 : 0) - (u[i] * u[j]) / q);
			M[i][3] -= (wt[f] * u[i]) / q;
			M[3][i] += (wt[f] * u[i]) / q;
			y[i] += wt[f] * (h[i] - (u[i] * uh) / q);
		}
		M[3][3] += wt[f] / q;
		y[3] += (wt[f] * uh) / q;
	});
	const [c0, c1, c2, lambda] = solveLinear(M, y);
	return rows.map(({ h, u }) => (dot(u, sub([c0, c1, c2], h)) + lambda) / dot(u, u));
}

/**
 * A foot's [fyaw, fpitch] once the body turns by D from Euler `was` to `now`: its keyed toe direction (limbs.js orientFoot:
 * ry(fyaw) rx(fpitch) toe, turned by the tilt frame past upright) turned by D and read back in the new tilt frame, as
 * skills/flip.js footAim aims a foot. Shifting fyaw by the yaw alone kept fpitch against the old tilt, which is not the
 * body's frame while the tilt eases in: a one-frame ankle flick in the tuck (back tuck 79, 30, 60 deg against 75, 66, 66
 * keyed). `toe` is the rest ankle-to-toe vector (its sagittal part: the reading is exact when D changes nothing); `near`
 * the fyaw the turn of the whole circle is taken nearest to.
 */
function footTurned(toe, was, now, D, fy, fp, near) {
	const r0 = [0, toe[1], toe[2]], phi = Math.atan2(-toe[1], toe[2]), Tw = tiltFrame(was.yaw, was.pitch, was.roll), Tn = tiltFrame(now.yaw, now.pitch, now.roll);
	const x = apply(rx(fp), r0), want = Tw ? apply(Tw.R, apply(ry(fy - Tw.yaw), x)) : apply(ry(fy), x), d = Tn ? apply(T(Tn.R), apply(D, want)) : apply(D, want);
	const yaw = (Tn ? Tn.yaw : 0) + deg(Math.atan2(d[0], d[2]));
	return [yaw + 360 * Math.round((near - yaw) / 360), Math.max(-60, Math.min(90, deg(Math.atan2(-d[1], Math.hypot(d[0], d[2])) - phi)))];
}

/** Writes the re-timed turn at frame f (absolute): Euler at fractional frame u of the original track `orig`, riders, poles and feet turned with it. */
function retimeFrame(baked, orig, f, u, toes) {
	const lo = Math.floor(u), hi = Math.min(lo + 1, orig.yaw.length - 1), t = u - lo, lerp = ch => orig[ch][lo] + (orig[ch][hi] - orig[ch][lo]) * t;
	const e = { yaw: lerp("yaw"), pitch: lerp("pitch"), roll: lerp("roll") }, was = { yaw: orig.yaw[f], pitch: orig.pitch[f], roll: orig.roll[f] };
	const D = mul(mul(ry(e.yaw), mul(rx(e.pitch), rz(e.roll))), T(mul(ry(was.yaw), mul(rx(was.pitch), rz(was.roll)))));
	for (const ch of ["yaw", "pitch", "roll"]) if (baked[ch]) baked[ch][f] = e[ch];
	const root = orig.root[f];
	for (const ch of RIDERS.slice(1)) if (Array.isArray(orig[ch]?.[f])) baked[ch][f] = add(root, apply(D, sub(orig[ch][f], root)));
	const Pw = poleFrame(was.yaw, was.pitch, was.roll), Pn = poleFrame(e.yaw, e.pitch, e.roll);
	for (const ch of POLES) if (Array.isArray(orig[ch]?.[f])) baked[ch][f] = apply(T(Pn), apply(D, apply(Pw, orig[ch][f])));
	for (const k of ["l", "r"]) {
		if (typeof orig[`fyaw_${k}`]?.[f] !== "number") continue;
		if (typeof orig[`fpitch_${k}`]?.[f] !== "number" || !toes[k]) { baked[`fyaw_${k}`][f] = orig[`fyaw_${k}`][f] + e.yaw - was.yaw; continue; }
		const fy = orig[`fyaw_${k}`][f];
		[baked[`fyaw_${k}`][f], baked[`fpitch_${k}`][f]] = footTurned(toes[k], was, e, D, fy, orig[`fpitch_${k}`][f], fy + e.yaw - was.yaw);
	}
}

/**
 * Re-times the root's turn in each flight of `runs` (qa/flight-checks.js flights) so the angular momentum about the centre of mass stays
 * constant. -> { runs, frames, max (deg the turn moved at most), drift: [before, after] (the worst run, flight-checks.js
 * runDrift: what QA SPIN reads), at, left? ([{ at, why }]: flights it could not re-time), how } | null. `gate`, flight-gate.js,
 * says what a re-time entered.
 */
export function spinFix(out, engine, runs, gate) {
	const f0 = out.f0 ?? 0, fps = out.fps ?? 24, B0 = out.baked, at = [], left = [], { index: I, restWorldPos: P } = out.ctx.sk;
	const toes = Object.fromEntries(Object.entries({ l: "Left", r: "Right" }).map(([k, S]) => [k, I[`${S}ToeBase`] !== undefined && I[`${S}Foot`] !== undefined ? sub(P[I[`${S}ToeBase`]], P[I[`${S}Foot`]]) : null]));
	if (!["yaw", "pitch", "roll"].some(ch => B0[ch])) return null;
	const len = out.frames.length + f0, zero = () => new Array(len).fill(0);
	const e = { yaw: B0.yaw ?? zero(), pitch: B0.pitch ?? zero(), roll: B0.roll ?? zero() };
	let frames = 0, max = 0, before = 0, after = 0;
	for (const [a, b] of runs) {
		const A = a - 1 + f0, B = b + 1 + f0, turn = keyedTurn(e, A, B);
		if (!turn || floats(out, a, b)) continue;
		if (turn.back) { left.push({ at: `f${a + f0}-f${b + f0}`, why: "the keyed turn turns back inside the flight: left as keyed" }); continue; }
		const orig = Object.fromEntries(["yaw", "pitch", "roll", ...RIDERS, ...POLES, "fyaw_l", "fyaw_r", "fpitch_l", "fpitch_r"].map(ch => [ch, B0[ch] ? B0[ch].slice() : ch === "root" ? null : e[ch]?.slice()]));
		if (!orig.root) continue;
		const d0 = runDrift(out, a, b), solve = () => engine.solve(Array.from({ length: b - a + 1 }, (_, i) => a + f0 + i));
		let moved = 0, why = null;
		for (let pass = 0; pass < PASSES && !why; pass++) {
			const rows = measure(out, a, b, turn.n, e);
			if (!rows) { why = "the rig has no bone for a body segment, so its momentum cannot be read: left as keyed"; break; }
			const wt = rows.map((_, i) => (i === 0 || i === rows.length - 1 ? 1.5 : 1));
			const w = rates(rows, wt, turn.total * fps).map(v => v / fps);
			if (w.some(v => !(v > 0))) { why = "the limbs alone would turn the root backward: left as keyed"; break; }
			const ext = [w[0], ...w, w[w.length - 1]];
			let th = 0;
			for (let i = 1; i < ext.length - 1; i++) {
				th += (ext[i - 1] + ext[i]) / 2;
				const f = A + i, u = A + frameAtTurn(turn.theta, th);
				moved = Math.max(moved, Math.abs(deg(th - turn.theta[i])));
				retimeFrame(B0, orig, f, u, toes);
			}
			solve();
		}
		const hit = why ? null : gate(a, b), d1 = why ? 0 : runDrift(out, a, b);
		if (hit) why = `re-timed, it would ${hitSays(hit)} where the flight did not: left as it was`;
		else if (d1 > d0 && d1 > SPIN_TOL) why = `re-timed, it would drift more (${d0.toFixed(3)} -> ${d1.toFixed(3)}): left as it was`;
		if (why) {
			// as it was: every channel this run wrote goes back to its own values
			for (const [ch, v] of Object.entries(orig)) if (B0[ch] && v) for (let f = a + f0; f <= b + f0; f++) B0[ch][f] = v[f];
			solve();
			left.push({ at: `f${a + f0}-f${b + f0}`, why });
			continue;
		}
		before = Math.max(before, d0); after = Math.max(after, d1);
		at.push(`f${a + f0}-f${b + f0}`); frames += b - a + 1; max = Math.max(max, moved);
	}
	if (!at.length && !left.length) return null;
	return { runs: at.length, frames, max: Math.round(max * 10) / 10, drift: [Math.round(before * 1000) / 1000, Math.round(after * 1000) / 1000], at, ...(left.length ? { left } : {}),
		how: "the root's turn re-timed in the air so the angular momentum about the centre of mass stays constant (faster tucked, slower open), the keyed total turn kept" };
}
