// How a move's pelvis covers its distance over time (gait.js): the speed profile of a walk, run or push, and the pace
// of a counted move, whose plants are fitted to it.
import { EASE, clamp, mix, smooth } from "./math.js";

/** Distance travelled at frames 0..N for a move of length d that enters at speed vin and leaves at vout (m/frame);
 *  ta: frames of the speed-up and of the slow-down (at most a third of the move). */
export function warp(N, d, vin, vout, pulse = () => 1, ta = 12) {
	const Ta = Math.min(ta, N / 3), vc = Math.max(0, (d - (vin + vout) * Ta / 2) / (N - Ta));
	const v = t => (t < Ta ? mix(vin, vc, smooth(t / Ta)) : t > N - Ta ? mix(vc, vout, smooth((t - (N - Ta)) / Ta)) : vc) * pulse(t);
	const S = [0];
	for (let t = 0; t < N; t++) S.push(S[t] + (v(t) + v(t + 1)) / 2);
	return S.map(s => S[N] > 1e-9 ? s * d / S[N] : 0);
}

/** The share of a counted move's distance its pelvis has covered at frame t, its last plant landing at Tm (steps of
 *  stepT frames of gait G: { sw, pulse }): a named ease, a burst (out), or (over 36 frames) a steady speed between a
 *  speed-up and a slow-down that take the share of a step the default walk's do (12 frames of a 13-frame step, at
 *  least 12), else smooth. A slower step slows down over more frames, so its last full plant, which lands where the
 *  pelvis stops, is no further ahead of the pelvis than at the default pace. */
export function pace(Tm, stepT, { ease, burst }, G) {
	const E = EASE[ease] ?? (burst ? EASE.out : null), Nc = Math.ceil(Tm);
	if (E || Tm <= 36) return t => (E ?? smooth)(clamp(t / Tm));
	const W = warp(Nc, 1, 0, 0, t => 1 + G.pulse * Math.cos(2 * Math.PI * (t * Tm / Nc / stepT - 0.5 * G.sw)), Math.max(12, stepT * 12 / 13));
	return t => { const x = clamp(t / Tm) * Nc, i = Math.min(Nc - 1, Math.floor(x)); return mix(W[i], W[i + 1], x - i); };
}
