// Retime (spec.fix.retime): where QA reports the motion too fast, the key intervals around it
// get longer, borrowing the frames from the neighbouring key intervals of the same window
// (slower or held stretches get shorter). Too fast means a one-frame pop, or a speed or
// acceleration limit the spec named in checks.limits (qa/style.js speedExcess); a fast but smooth
// motion is style and keeps its speed. Interpolation between keys scales with their spacing, so
// each interval is stretched by its own peak excess. The frame count and every key outside the
// windows stay where they are; the time map is kept on out.timeMap so frame-range checks follow.
// Flights (qa/flight-checks.js flights: air runs of 4 frames or more) are not retimed (#1124): their frames are fast because gravity makes them fast, and a
// stretched fall is slower than gravity (bench v2, 07 roof fall back r1: f90-97 stretched 1.6-2.8x over an exact 1 g
// parabola). An air frame is never too fast, and no window reaches into the key interval that holds a flight (held: a
// frame past the takeoff and landing anchors, to the keys around them; those two keys stay where they are, so every
// frame between them keeps its timing).
import { QA_LIMITS } from "../qa/checks.js";
import { speedExcess } from "../qa/style.js";

const HEADROOM = 1.1, MIN_RATE = 0.35, PASSES = 3;

/** e[i] = how many times too fast frame i is (speed ratio, or sqrt of the acceleration ratio); 0 in a flight. */
const excess = (out, air) => {
	const own = out.ctx.spec?.checks?.limits, e = speedExcess(out.ctx.sk, out, own, { ...QA_LIMITS, ...own });
	for (const [a, b] of air) for (let f = a; f <= b; f++) e[f] = 0;
	return e;
};

/**
 * The key intervals [p, q] that hold each flight (frames of out): the last key at or before a - 2 to the first at or after
 * b + 2. Retime reads the first solve, whose takeoff and landing the leg fixes can still move a frame (a toe-off sole 2 cm
 * up: the roof fall's flight read f32-f53 there and f31-f53 at the end), so a frame more on each side stays as keyed.
 */
const held = (air, keyFrames, n) => air.map(([a, b]) => [Math.max(0, ...keyFrames.filter(f => f <= a - 2)), Math.min(n - 1, ...keyFrames.filter(f => f >= b + 2))]);

/** Windows cut where they reach into a held interval: the parts outside it that still hold a too-fast frame. */
function outside(wins, holds, e) {
	let out = wins;
	for (const [p, q] of holds) {
		out = out.flatMap(([a, b]) => (b <= p || a >= q ? [[a, b]] : [[a, Math.min(b, p)], [Math.max(a, q), b]]).filter(([x, y]) => y - x >= 2 && e.slice(x + 1, y + 1).some(v => v > 1)));
	}
	return out;
}

/** Windows [a, b] (key frames) around each run of too-fast frames, merged where they overlap. */
function windows(e, keyFrames, n) {
	const out = [];
	for (let i = 1; i < n; i++) {
		if (e[i] <= 1) continue;
		let j = i;
		while (j + 1 < n && e[j + 1] > 1) j++;
		const w = Math.max(6, 2 * (j - i + 1));
		const a = Math.max(0, ...keyFrames.filter(f => f <= i - 1 - w)), b = Math.min(n - 1, ...keyFrames.filter(f => f >= j + w));
		if (out.length && a <= out[out.length - 1][1]) out[out.length - 1][1] = Math.max(out[out.length - 1][1], b);
		else out.push([a, b]);
		i = j;
	}
	return out;
}

/** New times for the breakpoints of window [a, b]: each interval scaled by max(peak excess, alpha). */
function spread(e, cuts) {
	const total = cuts[cuts.length - 1] - cuts[0];
	const segs = cuts.slice(1).map((k, i) => { let m = 0; for (let f = Math.floor(cuts[i]) + 1; f <= Math.ceil(k); f++) m = Math.max(m, e[f] ?? 0); return { len: k - cuts[i], need: HEADROOM * m }; });
	const sum = alpha => segs.reduce((acc, s) => acc + s.len * Math.max(s.need, alpha), 0);
	let lo = MIN_RATE, hi = 1;
	for (let it = 0; it < 40; it++) { const mid = (lo + hi) / 2; if (sum(mid) > total) hi = mid; else lo = mid; }
	const dur = segs.map(s => s.len * Math.max(s.need, lo)), scale = total / dur.reduce((acc, d) => acc + d, 0);
	const T = [cuts[0]];
	dur.forEach((d, i) => T.push(T[i] + d * scale));
	T[T.length - 1] = cuts[cuts.length - 1];
	return { T, stretch: Math.max(...dur.map((d, i) => (d * scale) / segs[i].len)) };
}

/** air: the take's flights (qa/flight-checks.js flights), whose key intervals stay as keyed. */
export function retime(out, engine, air = []) {
	const n = out.frames.length, maps = [];
	let segments = 0, stretch = 1;
	for (let pass = 0; pass < PASSES; pass++) {
		const e = excess(out, air), keyFrames = [...new Set(out.keys.map(k => k.f))].sort((p, q) => p - q);
		const wins = air.length ? outside(windows(e, keyFrames, n), held(air, keyFrames, n), e) : windows(e, keyFrames, n);
		if (!wins.length) break;
		const pieces = wins.map(([a, b]) => {
			const cuts = [...new Set([a, ...keyFrames.filter(f => f > a && f < b), b])].sort((p, q) => p - q), r = spread(e, cuts);
			stretch = Math.max(stretch, r.stretch);
			return { cuts, T: r.T };
		});
		segments += wins.length;
		const map = f => {
			for (const { cuts, T } of pieces) {
				if (f < cuts[0] || f > cuts[cuts.length - 1]) continue;
				let i = 0;
				while (i < cuts.length - 2 && f > cuts[i + 1]) i++;
				return T[i] + (T[i + 1] - T[i]) * (f - cuts[i]) / (cuts[i + 1] - cuts[i]);
			}
			return f;
		};
		maps.push(map);
		engine.rebake(out.keys.map(k => ({ ...k, f: map(k.f) })));
		engine.solve(engine.all());
	}
	if (!maps.length) return null;
	out.timeMap = f => maps.reduce((x, m) => m(x), f);
	const left = excess(out, air).filter(x => x > 1).length;
	return { windows: segments, maxStretch: Math.round(stretch * 100) / 100, stillFast: left, how: "key intervals around speed spikes stretched" };
}
