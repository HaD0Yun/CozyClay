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

/** A written count of `steps` plants of gait G (named gait) over L metres (n plants make n - 1 steps; a move takes 2 at
 *  least): each step takes sf frames, less when `room` frames do not hold them; a plant lands where the pelvis is, at
 *  its pace (how), in the middle of its stance (gait.js stepper); the last two land on the end spot, the feet together.
 *  Raised to the fewest plants whose steps are no longer than `longest` and whose feet, as they land and as they lift,
 *  are no further from the pelvis than a steady pace at steps of `longest` puts them (an ease that stops or starts at
 *  speed lands a foot far ahead or leaves one far behind). end: where the writer puts the last two instead, a stance
 *  the count is not fitted to: end.foot(k, n, off) = [across, along] the way of plant k's ankle off its pelvis spot
 *  (k = -1: the foot it starts from; off: with the end spots, else at home), end.hip = the hips' [across, along] off
 *  it. Its step onto them (ankle to the other ankle) and its foot's distance from the hips as it lands, on the floor,
 *  are told when over what the same feet at home do at those bounds. told: what differs from what was written
 *  (stepFrames: as written), with the lengths so computed. */
export function fitCount(L, steps, { sf, stepFrames, room, G, gait, how = {}, longest, end }) {
	const reach = longest * (1 - G.sw / 2), gap = (P, Q) => Math.hypot(P[0] - Q[0], P[1] - Q[1]), H = end && [0, 1].map(k => end.foot(k, 2, false));
	const bound = end && { step: Math.max(longest, ...H.map((h, i) => gap([h[0], h[1] + longest], H[1 - i]))), far: Math.max(reach, ...H.map(h => gap([h[0], h[1] + reach], end.hip))) };
	const plan = n => {
		const stepT = Math.min(sf, room / (n - 1 + G.sw)), u = pace((n - 1 + G.sw) * stepT, stepT, how, G), land = k => L * u((k + G.sw) * stepT);
		const spot = [0, ...Array.from({ length: n }, (_, k) => (k < n - 2 ? L * u((k + 1 + G.sw / 2) * stepT) : L))];
		let far = L * u(stepT); // the other standing foot lifts one step in
		for (let k = 0; k < n; k++) far = Math.max(far, Math.abs(spot[k + 1] - land(k)), k < n - 2 ? Math.abs(L * u((k + 2) * stepT) - spot[k + 1]) : 0);
		const at = k => { const o = end.foot(k, n, true); return [o[0], spot[k + 1] + o[1]]; }, hip = y => [end.hip[0], y + end.hip[1]];
		const sp = end && { step: Math.max(gap(at(n - 2), at(n - 3)), gap(at(n - 1), at(n - 2))), far: Math.max(gap(at(n - 2), hip(land(n - 2))), gap(at(n - 1), hip(L))) };
		const split = sp && { ...sp, long: sp.step > bound.step + 1e-6, wide: sp.far > bound.far + 1e-6 };
		return { n, stepT, far, split, step: Math.max(...spot.slice(1).map((x, k) => Math.abs(x - spot[k]))) };
	};
	const asked = plan(Math.max(2, steps)), top = Math.max(2, steps) + 64;
	let q = asked; // by the steps' length alone, then by the feet's distance from the pelvis too (told when that took more)
	while (q.step > longest + 1e-6 && q.n < top) q = plan(q.n + 1);
	let p = q;
	while ((p.step > longest + 1e-6 || p.far > reach + 1e-6) && p.n < top) p = plan(p.n + 1);
	const split = p.split && (p.split.long || p.split.wide) ? p.split : null;
	const info = { gait, steps: [steps, p.n], distance: L, step: asked.step, stepWalked: p.step, longest, far: p.n > q.n ? asked.far : null, reach, end: !!end, split, stepFrames: [stepFrames ?? null, p.stepT], need: (p.n - 1 + G.sw) * (stepFrames ?? p.stepT), room, pace: EASE[how.ease] ? how.ease : how.burst ? "burst" : null };
	return { n: p.n, stepT: p.stepT, info, told: p.n !== steps || split || (stepFrames != null && p.stepT < stepFrames - 0.05) ? info : null };
}
