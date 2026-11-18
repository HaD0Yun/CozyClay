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
 *  speed lands a foot far ahead or leaves one far behind). end: the writer puts the last two on end spots instead, a
 *  stance the count is not fitted to (endSplit tells what it did). told: what differs from what was written
 *  (stepFrames: as written), with the lengths so computed. */
export function fitCount(L, steps, { sf, stepFrames, room, G, gait, how = {}, longest, end }) {
	const reach = longest * (1 - G.sw / 2);
	const plan = n => {
		const stepT = Math.min(sf, room / (n - 1 + G.sw)), u = pace((n - 1 + G.sw) * stepT, stepT, how, G), land = k => L * u((k + G.sw) * stepT);
		const spot = [0, ...Array.from({ length: n }, (_, k) => (k < n - 2 ? L * u((k + 1 + G.sw / 2) * stepT) : L))];
		let far = L * u(stepT); // the other standing foot lifts one step in
		for (let k = 0; k < n; k++) far = Math.max(far, Math.abs(spot[k + 1] - land(k)), k < n - 2 ? Math.abs(L * u((k + 2) * stepT) - spot[k + 1]) : 0);
		return { n, stepT, far, step: Math.max(...spot.slice(1).map((x, k) => Math.abs(x - spot[k]))) };
	};
	const asked = plan(Math.max(2, steps)), top = Math.max(2, steps) + 64;
	let q = asked; // by the steps' length alone, then by the feet's distance from the pelvis too (told when that took more)
	while (q.step > longest + 1e-6 && q.n < top) q = plan(q.n + 1);
	let p = q;
	while ((p.step > longest + 1e-6 || p.far > reach + 1e-6) && p.n < top) p = plan(p.n + 1);
	const info = { gait, steps: [steps, p.n], distance: L, step: asked.step, stepWalked: p.step, longest, far: p.n > q.n ? asked.far : null, reach, end: !!end, stepFrames: [stepFrames ?? null, p.stepT], need: (p.n - 1 + G.sw) * (stepFrames ?? p.stepT), room, pace: EASE[how.ease] ? how.ease : how.burst ? "burst" : null };
	return { n: p.n, stepT: p.stepT, info, told: p.n !== steps || (stepFrames != null && p.stepT < stepFrames - 0.05) ? info : null };
}

/** What a move's plants onto the writer's end spots did on the floor, as the stepper placed them (ends: [{ g: its
 *  ankle's spot, home: where it lands without the end spot, other: the other foot's spot, hip: the Hips joint as it
 *  lands }]): the step onto them (ankle to the other ankle) and the foot's distance from the hips. Told (else null)
 *  when over the bounds of gait G (named gait) that way: the step over that of a foot at home (H: [left, ahead] of
 *  the pelvis spot) stepping the longest, `longest`, in direction u past the other; a foot further from the Hips
 *  joint (hip) than one that lands a steady pace's distance ahead of the pelvis, behind it by the gait's trail, and
 *  than where that foot lands without its end spot (own, when that is further). */
export function endSplit(ends, gait, longest, G, u, H, hip) {
	if (!ends?.length) return null;
	const gap = (P, Q) => Math.hypot(P[0] - Q[0], P[1] - Q[1]), l = Math.hypot(...u), d = [u[0] / l, u[1] / l], ahead = (h, k, back = 0) => [h[0] + k * d[0], h[1] + k * d[1] - back];
	const reach = longest * (1 - G.sw / 2), bound = { step: Math.max(longest, ...H.map((h, i) => gap(ahead(h, longest), H[1 - i]))), far: Math.max(reach, ...H.map(h => gap(ahead(h, reach, G.trail), hip))) };
	const far = ends.map(e => gap(e.g, e.hip)), own = ends.map(e => gap(e.home, e.hip)), over = far.map((f, i) => f - Math.max(bound.far, own[i])), k = over.indexOf(Math.max(...over));
	const split = { gait, step: Math.max(...ends.map(e => gap(e.g, e.other))), far: Math.max(...far), longest, reach: bound.far, own: own[k] > bound.far ? own[k] : null };
	const long = split.step > bound.step + 1e-6, wide = over[k] > 1e-6;
	return long || wide ? { ...split, long, wide } : null;
}
