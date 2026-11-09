// The walk's hips, heel rise and swings (walk.js), hips first, the way a person walks:
// - fitPelvis: the hips' height, as high as the legs holding them allow with the knee a person keeps through
//   stance. A leg reaching for the floor straightens in terminal swing (REACH_IN periods before its strike) and
//   strikes a little bent; it gives as the weight comes on (loading, LOAD_SPAN periods) and is nearly straight at
//   mid-stance. Once the hips pass over a planted foot it no longer holds them down: its heel rises instead
//   (fitTrail). The height runs on a C2 cubic spline (no kink) through a trough at each heel strike and the highest
//   point the limit allows a quarter to a half of the way to the next strike (a person's hips top out as they pass
//   over the foot, then fall with the flat foot's reach); no half-step bends it harder than CURVE, and an extremum
//   comes down until the whole curve stays under the limit. Across the floor the hips
//   keep the walk's path (walk.js keys), blurred XZ_BLUR frames so their speed has no kink.
// - fitTrail: from the hips passing over a planted foot to its lift-off the heel rises, about the ball, just as
//   far as the leg needs to reach with the stance knee and then the push-off knee (from walk.js's heel-off frame
//   to KNEE_TOEOFF at lift-off), never lowered, never faster than PITCH_RATE a frame and never past PITCH_MAX
//   (beyond about 60 deg the toes sit behind the ankle and QA reads a bent knee as bending backward); out of reach
//   even then, the toe comes off the floor, the foot drawn toward the hip, as a person's does once the other foot
//   is down.
// - fitSwing: each swing on a clamped cubic spline from that lift-off, through walk.js's swing keys, into the strike;
//   the foot's pitch follows the shank on the way.
// The knee schedule eases with the walk's pace (brisk): a stroll strikes, loads and pushes off with straighter knees.
import { bakeChannels } from "./channels.js";
import { soleHeel } from "./skeleton.js";
import { add, sub, scale, len, dot, apply, rx, ry, rz } from "./math.js";

// knee flexion (deg): at the strike, the loading peak, mid-stance, and at lift-off (TRAIL_POW shapes the push-off:
// slow while the other foot is in the air, fast once it lands); a quick walk (period down to FAST frames from SLOW)
// bends them FAST_MORE further, as a person's knees give more the faster they walk
const KNEE_STRIKE = 18, KNEE_LOAD = 22, KNEE_MID = 7, KNEE_TOEOFF = 45, TRAIL_POW = 1, LOAD_SPAN = 0.4, PITCH_MAX = 50, PITCH_RATE = 15;
const SLOW = 13, FAST = 9, FAST_MORE = { strike: 4, load: 4, mid: 3, toeOff: 5 };
// a slow walk keeps the knees straighter (a person strolling strikes and loads nearly straight-legged): the schedule
// eases from STROLL at a pace of PACE[0] (walk.js's pace: 1 = 0.5 m per 20 frames) up to the one above at PACE[1]
const STROLL = { strike: 2, load: 14, mid: 7, toeOff: 48, pow: 1.8 }, PACE = [1, 2.2];
/** 0 at a stroll's pace, 1 at a brisk walk's, smooth between. */
export const brisk = pace => { const t = Math.min(1, Math.max(0, ((pace ?? PACE[1]) - PACE[0]) / (PACE[1] - PACE[0]))); return t * t * (3 - 2 * t); };
const SOFT = 0.004, EASE = 8, BELOW_STAND = 0.008, REACH_IN = 0.35, MARGIN = 0.001, XZ_BLUR = 2;
// a strike's trough is the lowest limit from 2 frames before it to TROUGH_SPAN periods after (its loading)
const TROUGH_SPAN = 0.25, PEAK = [0.25, 0.5], CURVE = 0.008, smoother = t => t * t * t * (t * (6 * t - 15) + 10);
// the keys fitSwing writes, so a second pass reads walk.js's swing keys only
const SWUNG = new WeakSet();

/**
 * Appends a root key per frame between f0 and end to `out` (the walk's keys). ground: per foot, its spans on
 * the ground, { a, b, strike, heel }: from a (a heel strike, or f0) to b (its lift-off), heel the frame its
 * heel starts up before that lift; start the src of keys before the first step. The keys keep the root's path across the
 * floor; only its height changes.
 */
/** A foot pitched `deg` about a point on the ground (its heel or ball), heading yw: where the ankle goes. */
export const pivot = (p, yw, deg, from) => add(p, apply(ry(yw), apply(rx(deg), apply(ry(-yw), sub(from, p)))));

/** The leg's reach at a knee flexion, the hip joints from the hips, and the knee schedule of a walk of this period. */
function legOf(sk, period, pace) {
	const I = sk.index, P = sk.restWorldPos;
	const a = len(sub(P[I.LeftLeg], P[I.LeftUpLeg])), b = len(sub(P[I.LeftFoot], P[I.LeftLeg]));
	const q = Math.min(1, Math.max(0, (SLOW - period) / (SLOW - FAST))), u = brisk(pace), mix = (s, k) => s + (k - s) * u;
	const strike = mix(STROLL.strike, KNEE_STRIKE) + q * FAST_MORE.strike, load = mix(STROLL.load, KNEE_LOAD) + q * FAST_MORE.load;
	const mid = mix(STROLL.mid, KNEE_MID) + q * FAST_MORE.mid, toeOff = mix(STROLL.toeOff, KNEE_TOEOFF) + q * FAST_MORE.toeOff;
	return {
		reach: deg => Math.sqrt(a * a + b * b + 2 * a * b * Math.cos((deg * Math.PI) / 180)),
		hipOff: { l: sub(P[I.LeftUpLeg], P[I.Hips]), r: sub(P[I.RightUpLeg], P[I.Hips]) },
		strike, load, mid, trail: u => mid + (toeOff - mid) * Math.min(1, Math.max(0, u)) ** mix(STROLL.pow, TRAIL_POW),
	};
}
const hipAt = (ch, f, off) => add(ch.root[f], apply(ry(ch.yaw?.[f] ?? 0), apply(rz(ch.roll?.[f] ?? 0), off)));

export function fitPelvis(sk, out, { f0, end, period, pace, ground, start }) {
	const I = sk.index, P = sk.restWorldPos;
	const { reach, hipOff, strike, load, mid, trail } = legOf(sk, period, pace);
	const lead = Math.max(2, Math.round(REACH_IN * period));
	const knee = (g, f) => {
		if (f < g.a) return strike;
		if (g.heel !== undefined && f >= g.heel) return trail((f - g.heel) / Math.max(1, g.b - g.heel));
		// loading: from the strike's knee up to the loading peak half way through LOAD_SPAN, then down to mid-stance's
		const u = (f - g.a) / period / LOAD_SPAN;
		return g.strike && u < 1 ? (u < 0.5 ? strike : mid) + (load - (u < 0.5 ? strike : mid)) * Math.sin(Math.PI * u) : mid;
	};
	const ch = bakeChannels(out, end + 1), top = P[I.Hips][1] - BELOW_STAND;
	// the path across the floor, blurred twice (ends held), so the forward speed has no kink
	let xz = ch.root.map(r => [r[0], r[2]]);
	for (let pass = 0; pass < 2; pass++) xz = xz.map((p, f) => {
		if (f <= f0 || f >= end) return p;
		let sx = 0, sz = 0, w = 0;
		for (let d = -3 * XZ_BLUR; d <= 3 * XZ_BLUR; d++) { const g = Math.min(end, Math.max(f0, f + d)), k = Math.exp(-(d * d) / (2 * XZ_BLUR * XZ_BLUR)); sx += k * xz[g][0]; sz += k * xz[g][1]; w += k; }
		const t = Math.min(1, (f - f0) / EASE, (end - f) / EASE), e = t * t * (3 - 2 * t);
		return [p[0] + (sx / w - p[0]) * e, p[1] + (sz / w - p[1]) * e];
	});
	// the highest the hips may be at frame f, eased in from the pose before the walk and out into the stand after it
	const limit = f => {
		const root = [xz[f][0], ch.root[f][1], xz[f][1]], yaw = ch.yaw?.[f] ?? 0, roll = ch.roll?.[f] ?? 0, ys = [];
		for (const k of ["l", "r"]) {
			const g = ground[k].find(x => f >= x.a - (x.strike ? lead : 0) && f <= x.b);
			// once the hips pass over a planted foot it no longer holds them down: its heel rises as far as it must and
			// past PITCH_MAX its toe leaves the floor (fitTrail)
			if (!g || (g.free !== undefined && f >= g.free)) continue;
			const ankle = ch[`foot_${k}`][f], off = apply(ry(yaw), apply(rz(roll), hipOff[k]));
			const d = reach(knee(g, f)), dh = Math.hypot(root[0] + off[0] - ankle[0], root[2] + off[2] - ankle[2]);
			if (dh < d) ys.push(ankle[1] + Math.sqrt(d * d - dh * dh) - off[1]);
		}
		if (!ys.length) return top;
		const m = Math.min(...ys), fit = Math.min(top, m - SOFT * Math.log(ys.reduce((s, y) => s + Math.exp(-(y - m) / SOFT), 0))) - MARGIN;
		const t = Math.min(1, (f - f0) / EASE, (end - f) / EASE), w = t * t * (3 - 2 * t);
		return root[1] + (fit - root[1]) * w;
	};
	// the frame the hips pass over each planted foot (its ankle along the foot's heading)
	for (const k of ["l", "r"]) for (const g of ground[k]) {
		if (g.heel === undefined || !g.flat) continue;
		const fw = apply(ry(g.yw), [0, 0, 1]);
		let f = Math.max(f0 + 1, g.a);
		while (f < g.heel && (xz[f][0] - g.flat[0]) * fw[0] + (xz[f][1] - g.flat[2]) * fw[2] < 0) f++;
		g.free = f;
	}
	const low = [];
	for (let f = f0; f <= end; f++) low[f] = limit(f);
	// extrema: the pose before the walk, a trough over each strike's loading, the highest point between, the stand after
	const loadSpan = Math.max(2, Math.round(TROUGH_SPAN * period)), lowest = (a, b) => { let m = a; for (let f = a; f <= b; f++) if (low[f] < low[m]) m = f; return m; };
	const strikes = [...new Set(["l", "r"].flatMap(k => ground[k].filter(g => g.strike && g.a > f0 + 2 && g.a < end - 2).map(g => g.a)))].sort((p, q) => p - q);
	const knots = [{ f: f0, y: low[f0] }];
	strikes.forEach((a, n) => {
		const t = lowest(Math.max(knots.at(-1).f + 2, a - 2), Math.min(end - 2, a + loadSpan));
		// the peak between two troughs: of the frames PEAK of the way between them, the one whose highest smootherstep rise
		// from the last trough and fall to this one both stay under the limit is highest (smootherstep stands in for the
		// spline here: it is the flatter of the two at each end)
		if (n > 0) {
			const A = knots.at(-1), B = { f: t, y: low[t] }, span = B.f - A.f;
			let best = null;
			for (let c = Math.ceil(A.f + PEAK[0] * span); c <= Math.floor(A.f + PEAK[1] * span); c++) {
				let top = low[c];
				for (let f = A.f + 1; f < c; f++) { const w = smoother((f - A.f) / (c - A.f)); if (w > 1e-6) top = Math.min(top, A.y + (low[f] - A.y) / w); }
				for (let f = c + 1; f < B.f; f++) { const w = smoother((f - c) / (B.f - c)); if (w < 1 - 1e-6) top = Math.min(top, (low[f] - B.y * w) / (1 - w)); }
				if (!best || top > best.y) best = { f: c, y: top };
			}
			if (best && best.y > Math.max(A.y, B.y)) knots.push(best);
		}
		if (t > knots.at(-1).f) knots.push({ f: t, y: low[t] });
	});
	knots.push({ f: end, y: low[end] });
	// no half-step bends the hips harder than CURVE (a spline's turn is about 2 rise / frames^2): a peak
	// too high for the frames it has to the next trough comes down
	for (let n = 1; n + 1 < knots.length; n++) {
		const K = knots[n], room = Math.min(...[knots[n - 1], knots[n + 1]].map(o => o.y + (CURVE * (K.f - o.f) ** 2) / 2));
		if (K.y > Math.max(knots[n - 1].y, knots[n + 1].y)) K.y = Math.min(K.y, room);
	}
	// the spline through the knots; a segment that rises past the limit lowers its higher knot by the excess
	let y = [];
	for (let pass = 0; pass < 30; pass++) {
		let worst = 0;
		const S = spline(knots.map(K => K.f), knots.map(K => K.y), 0, 0);
		for (let n = 0; n + 1 < knots.length; n++) {
			const A = knots[n], B = knots[n + 1];
			let ex = 0;
			for (let f = A.f; f <= B.f; f++) { y[f] = S(f); ex = Math.max(ex, y[f] - low[f]); }
			if (ex > 0.0003) { const hi = A.y > B.y && n > 0 ? A : B.f === end ? A : B; if (hi.f !== f0 && hi.f !== end) { hi.y -= ex; worst = Math.max(worst, ex); } }
		}
		if (!worst) break;
	}
	for (let f = f0; f <= end; f++) y[f] = Math.min(y[f], low[f]);
	// each key names the step it falls in, so QA's causes and hints still point at that step of the walk
	const steps = out.filter(k => / step \d+$/.test(k.src ?? "")).sort((p, q) => p.f - q.f);
	let i = 0, src = start;
	for (let f = f0 + 1; f < end; f++) {
		while (i < steps.length && steps[i].f <= f) src = steps[i++].src;
		out.push({ f, set: { root: [xz[f][0], y[f], xz[f][1]] }, src });
	}
}

/**
 * The planted foot's heel rise, once the hips are set (fitPelvis): each frame from the hips passing over it to lift-off
 * pitches the foot about its ball just far enough that the leg reaches it with the knee the stance keeps (mid-stance's,
 * then the push-off's from walk.js's heel-off frame), so the heel comes up when the leg needs it to; never lowering the
 * heel again and never past PITCH_MAX. Its keys replace walk.js's scheduled rise on the same frames.
 */
export function fitTrail(sk, out, { end, period, pace, ground }) {
	const { reach, hipOff, trail } = legOf(sk, period, pace), ch = bakeChannels(out, end + 1);
	const srcAt = new Map(out.map(x => [x.f, x.src]));
	for (const k of ["l", "r"]) for (const g of ground[k]) {
		if (g.free === undefined || !Number.isFinite(g.b) || g.b > end) continue;
		// the pitch each frame needs (never lowering), then raised ahead of any rise faster than PITCH_RATE a frame
		const need = [], frames = [];
		let prev = 0;
		for (let f = g.free; f <= g.b; f++) {
			const hip = hipAt(ch, f, hipOff[k]), want = reach(trail((f - g.heel) / Math.max(1, g.b - g.heel)));
			const far = p => len(sub(hip, pivot(g.ball, g.yw, p, g.flat))) - want;
			let lo = prev, hi = PITCH_MAX;
			if (far(lo) <= 0) hi = lo;
			else if (far(hi) <= 0) for (let n = 0; n < 24; n++) { const m = (lo + hi) / 2; if (far(m) > 0) lo = m; else hi = m; }
			prev = hi; need.push(hi); frames.push({ f, hip, want });
		}
		let pitch = need.map((_, i) => Math.max(...need.slice(i).map((p, j) => p - j * PITCH_RATE)));
		// eased (never under the need): the rise starts and ends without a kink, which would jolt the knee
		for (let pass = 0; pass < 2; pass++) pitch = pitch.map((p, i) => Math.max(need[i], ((pitch[i - 1] ?? 0) + p + (pitch[i + 1] ?? p)) / 3));
		frames.forEach(({ f, hip, want }, i) => {
			// out of reach even at PITCH_MAX: the toe comes off the floor, the foot drawn toward the hip to the push-off knee
			let ankle = pivot(g.ball, g.yw, pitch[i], g.flat);
			const gap = len(sub(hip, ankle)) - want;
			if (gap > 0) ankle = add(ankle, scale(sub(hip, ankle), gap / len(sub(hip, ankle))));
			out.push({ f, set: { [`foot_${k}`]: ankle, [`fpitch_${k}`]: pitch[i], [`fyaw_${k}`]: g.yw }, src: srcAt.get(f) });
		});
	}
}

/** A clamped cubic spline through (xs, ys) with end slopes d0, dn: C2 inside, so a path through it has no kinks. */
function spline(xs, ys, d0, dn) {
	const n = xs.length - 1, h = xs.slice(1).map((x, i) => x - xs[i]), a = [], b = [], c = [], r = [];
	for (let i = 0; i <= n; i++) {
		if (i === 0) { a[i] = 0; b[i] = 2 * h[0]; c[i] = h[0]; r[i] = 6 * ((ys[1] - ys[0]) / h[0] - d0); }
		else if (i === n) { a[i] = h[n - 1]; b[i] = 2 * h[n - 1]; c[i] = 0; r[i] = 6 * (dn - (ys[n] - ys[n - 1]) / h[n - 1]); }
		else { a[i] = h[i - 1]; b[i] = 2 * (h[i - 1] + h[i]); c[i] = h[i]; r[i] = 6 * ((ys[i + 1] - ys[i]) / h[i] - (ys[i] - ys[i - 1]) / h[i - 1]); }
	}
	for (let i = 1; i <= n; i++) { const m = a[i] / b[i - 1]; b[i] -= m * c[i - 1]; r[i] -= m * r[i - 1]; }
	const M = []; M[n] = r[n] / b[n];
	for (let i = n - 1; i >= 0; i--) M[i] = (r[i] - c[i] * M[i + 1]) / b[i];
	return x => {
		let i = 0; while (i < n - 1 && x > xs[i + 1]) i++;
		const t = x - xs[i], H = h[i], A = (xs[i + 1] - x) / H, B = t / H;
		return A * ys[i] + B * ys[i + 1] + ((A ** 3 - A) * M[i] + (B ** 3 - B) * M[i + 1]) * H * H / 6;
	};
}

// the swing foot keeps the ankle near neutral, as a person's does: its pitch follows the shank (SWING_DORSI deg toes-up
// of it), eased in from the toe-off's pitch over FOLLOW_IN of the swing and out into the strike's over FOLLOW_OUT, the
// ball held BALL_CLEAR m over its flat height away from the ends, the pitch no more than PITCH_MAX (a foot kept level would flap at the ankle as the shank swings)
const SWING_DORSI = 3, FOLLOW_IN = 0.35, FOLLOW_OUT = 0.2, BALL_CLEAR = 0.03, HEEL_FREE = 0.04, HEEL_LOW = 0.025, HOVER = 0.001, deg = r => (r * 180) / Math.PI;
const ease = x => { const t = Math.min(1, Math.max(0, x)); return t * t * (3 - 2 * t); };

/** The shank's tilt (deg, + with the ankle behind the knee) of a leg from hip H to ankle A, thigh a, shank b, knee forward fw. */
function shankTilt(H, A, fw, a, b) {
	const d = sub(A, H), L = Math.min(a + b - 1e-6, Math.max(Math.abs(a - b) + 1e-6, len(d))), u = scale(d, 1 / len(d));
	let v = sub(fw, scale(u, dot(fw, u)));
	v = scale(v, 1 / (len(v) || 1));
	const c = (a * a + L * L - b * b) / (2 * a * L), K = add(H, add(scale(u, a * c), scale(v, a * Math.sqrt(Math.max(0, 1 - c * c))))), sh = sub(A, K);
	return deg(Math.atan2(-dot(sh, fw), -sh[1]));
}

/**
 * Each swing (lift-off to the next strike of that foot), once the toe-off is set (fitTrail): the ankle runs on a
 * clamped cubic spline from the lift-off, at the speed the push-off leaves it with, through walk.js's swing keys
 * (the heel kicked up behind, mid-swing, over the strike) into the strike at the heel rocker's speed, keyed every
 * frame: the knee and the foot move without the kinks per-channel keys leave where the path turns. Given the skeleton
 * (the last pass, the hips set), each frame's foot pitch follows the shank too.
 */
export function fitSwing(out, { end, ground, sk }) {
	const ch = bakeChannels(out, end + 2), srcAt = new Map(out.map(x => [x.f, x.src]));
	const I = sk?.index, P = sk?.restWorldPos, a = sk && len(sub(P[I.LeftLeg], P[I.LeftUpLeg])), b = sk && len(sub(P[I.LeftFoot], P[I.LeftLeg]));
	for (const k of ["l", "r"]) {
		const spans = ground[k], side = k === "l" ? "Left" : "Right";
		const hipOff = sk && sub(P[I[`${side}UpLeg`]], P[I.Hips]), ball = sk && sub(P[I[`${side}ToeBase`]], P[I[`${side}Foot`]]), ballY = sk && P[I[`${side}ToeBase`]][1];
		const heel = sk && [0, soleHeel(sk)[1] - P[I[`${side}Foot`]][1], -soleHeel(sk)[0]]; // QA's heel point from the ankle
		for (let n = 0; n + 1 < spans.length; n++) {
			const g = spans[n], h = spans[n + 1];
			if (!Number.isFinite(g.b) || !h.strike || h.a > end || h.a - g.b < 3) continue;
			const via = [...new Set(out.filter(x => !SWUNG.has(x) && x.f > g.b && x.f < h.a && x.set[`foot_${k}`]).map(x => x.f))].sort((p, q) => p - q);
			const xs = [g.b, ...via, h.a], foot = ch[`foot_${k}`], at = f => foot[Math.max(0, Math.min(foot.length - 1, f))];
			const v0 = sub(at(g.b), at(g.b - 1)), vn = sub(at(h.a + 1), at(h.a));
			const axes = [0, 1, 2].map(i => spline(xs, xs.map(f => at(f)[i]), v0[i], vn[i]));
			const yawAt = f => ch[`fyaw_${k}`]?.[f] ?? 0, pitchAt = f => ch[`fpitch_${k}`]?.[f] ?? 0;
			const follow = (f, p) => shankTilt(hipAt(ch, f, hipOff), p, apply(ry(yawAt(f)), [0, 0, 1]), a, b) - SWING_DORSI;
			const span = h.a - g.b, off0 = sk && pitchAt(g.b) - follow(g.b, at(g.b)), off1 = sk && pitchAt(h.a) - follow(h.a, at(h.a));
			let prevP = pitchAt(g.b), heelPrev = Infinity;
			for (let f = g.b + 1; f < h.a; f++) {
				const p = axes.map(e => e(f)), set = { [`foot_${k}`]: p };
				if (sk) {
					// never past PITCH_MAX (QA would read the bent knee as bending backward)
					let pitch = Math.min(PITCH_MAX, follow(f, p) + off0 * (1 - ease((f - g.b) / (FOLLOW_IN * span))) + off1 * (1 - ease((h.a - f) / (FOLLOW_OUT * span))));
					// the ball no lower than its flat height plus BALL_CLEAR (eased in and out over 3 frames at the ends)
					const floor = ballY + BALL_CLEAR * ease(Math.min(f - g.b, h.a - f) / 3), ballAt = d => p[1] + apply(rx(d), ball)[1];
					if (ballAt(pitch) < floor) { let lo = -30, hi = pitch; for (let it = 0; it < 20; it++) { const m = (lo + hi) / 2; if (ballAt(m) < floor) hi = m; else lo = m; } pitch = lo; }
					// toes up lowers the heel: it comes no lower than HEEL_LOW (or the walk's keys, if they had it lower), so the strike
					// lands when it did and the heel never skims the floor
					const was = pitchAt(f), heelAt = d => p[1] + apply(rx(d), heel)[1], low = Math.min(HEEL_FREE, Math.max(heelAt(was), HEEL_LOW));
					if (pitch < was && heelAt(pitch) < low) { let lo = pitch, hi = was; for (let it = 0; it < 20; it++) { const m = (lo + hi) / 2; if (heelAt(m) < low) lo = m; else hi = m; } pitch = hi; }
					// the heel comes down onto the floor, not along it: in the last two frames, a low heel that would drop less than
					// HOVER since the frame before (the ball floor above can tip the toes down here, more so the longer the foot)
					// runs its pitch monotonically into the strike's
					if (f > h.a - 3 && heelAt(pitch) < HEEL_LOW && heelPrev - heelAt(pitch) < HOVER) { const pa = pitchAt(h.a); pitch = Math.min(Math.max(pitch, Math.min(prevP, pa)), Math.max(prevP, pa)); }
					prevP = pitch; heelPrev = heelAt(pitch);
					set[`fpitch_${k}`] = pitch;
				}
				const key = { f, set, src: srcAt.get(f) };
				SWUNG.add(key); out.push(key);
			}
		}
	}
}
