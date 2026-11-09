// Air runs against gravity (v4 qa). Old QA's FLOAT catches a body that falls too slowly; nothing
// caught one that falls too fast (research wave-2-Vraw: a v3 fall sped up at 4-5 g and passed QA).
// For each air run of 4+ frames (style.js airRuns), airAccel reads the mean vertical acceleration of
// the hips on the run's inner frames, in g (1 = free fall), and lists the runs outside 0.8-1.25 g.
// Frames in rows are absolute (out.f0 added); run indexes inside this file are out.frames indexes.
import { airRuns } from "../../motion3/qa/style.js";

/** Gravity in m/s^2. */
const G = 9.81;
/** Mean fall in g outside [LOW, HIGH] is listed. */
const LOW = 0.8, HIGH = 1.25;
/** Runs this short have too few inner frames for a mean. */
const MIN_FRAMES = 4;

const runsCache = new WeakMap();

/**
 * The air runs of out ([a, b] indexes of out.frames, style.js airRuns with the spec's supports), cached per out.
 * Without the skin support (#1125): a run is the whole flight from the frame the soles leave the ground to the last
 * frame before they come back, which is what the fall in g (runG) and the landing frames (impact.js) are read against.
 * With it, a hand still within 5 cm of a box on the first and last frame of a jump cut the run by a frame at each end,
 * and the landing two frames later no longer counted as its impact.
 */
export function runsOf(out) {
	if (!runsCache.has(out)) runsCache.set(out, airRuns(out, out.ctx.spec?.checks?.supports, { skin: false }));
	return runsCache.get(out);
}

/**
 * The hips fall on the inner frames a+1..b-1 of run [a, b], in g per frame: minus the second
 * difference of Hips y over g / fps^2 (1 = free fall, 0 = no fall, < 0 = speeding up upward).
 */
export function runG(out, a, b) {
	const F = out.frames, hips = out.ctx.sk.index.Hips, g = G / (out.fps ?? 24) ** 2, rows = [];
	const y = f => F[f].s.P[hips][1];
	for (let f = a + 1; f < b; f++) rows.push(-(y(f + 1) - 2 * y(f) + y(f - 1)) / g);
	return rows;
}

const mean = xs => xs.reduce((s, x) => s + x, 0) / xs.length;

/** Air runs of 4+ frames whose mean hips fall is under 0.8 g or over 1.25 g: [{ from, to, g }], frames absolute. */
export function airAccel(out) {
	const f0 = out.f0 ?? 0, rows = [];
	for (const [a, b] of runsOf(out)) {
		if (b - a + 1 < MIN_FRAMES) continue;
		const g = mean(runG(out, a, b));
		if (g < LOW || g > HIGH) rows.push({ from: a + f0, to: b + f0, g: Math.round(g * 1000) / 1000 });
	}
	return rows;
}
