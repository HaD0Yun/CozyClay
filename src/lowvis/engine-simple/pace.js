// How a move's pelvis covers its distance over time (gait.js): the speed profile of a walk, run or push, and the pace
// of a counted move, whose plants are fitted to it.
import { EASE, clamp, mix, smooth } from "./math.js";

/** Distance travelled at frames 0..N for a move of length d that enters at speed vin and leaves at vout (m/frame; null:
 *  at its steady speed, with no slow-down); ta: frames of the speed-up and of the slow-down (at most a third of the move). */
export function warp(N, d, vin, vout, pulse = () => 1, ta = 12) {
	const Ta = Math.min(ta, N / 3), keep = vout == null, vc = Math.max(0, keep ? (d - vin * Ta / 2) / (N - Ta / 2) : (d - (vin + vout) * Ta / 2) / (N - Ta));
	const v = t => (t < Ta ? mix(vin, vc, smooth(t / Ta)) : t > N - Ta && !keep ? mix(vc, vout, smooth((t - (N - Ta)) / Ta)) : vc) * pulse(t);
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
 *  (stepFrames: as written), with the lengths so computed; stepPlan: the plan's longest step along the pelvis path. */
export function fitCount(L, steps, { sf, stepFrames, room, G, gait, how = {}, longest, end }) {
	const reach = longest * (1 - (G.swLong ?? G.sw) / 2); // swLong: the swing share of the pace whose step is the longest
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
	const info = { gait, steps: [steps, p.n], distance: L, step: asked.step, stepPlan: p.step, longest, far: p.n > q.n ? asked.far : null, reach, end: !!end, stepFrames: [stepFrames ?? null, p.stepT], need: (p.n - 1 + G.sw) * (stepFrames ?? p.stepT), room, pace: EASE[how.ease] ? how.ease : how.burst ? "burst" : null };
	return { n: p.n, stepT: p.stepT, info, told: p.n !== steps || (stepFrames != null && p.stepT < stepFrames - 0.05) ? info : null };
}

const gap = (P, Q) => Math.hypot(P[0] - Q[0], P[1] - Q[1]);
const most = (list, key) => list.reduce((a, b) => (b[key] > a[key] ? b : a));

/** What a move's plants onto the writer's end spots did on the floor, against the same move without them (lands:
 *  every plant as the stepper lands it, in order: { side, g: its ankle, other: the other ankle, hip: the Hips joint,
 *  home: on an end spot, where the ankle lands without it }). Without them each end plant lands at home, and steps from
 *  the other foot's home when that foot's last plant was on an end spot too; nothing else of the move changes. Each
 *  plant is weighed against itself without them; the end spots made a plant when they moved its foot, or lengthened
 *  its step, by over tol (m). Told (else null) only what a plant they made does over tol more than it does without them,
 *  and past the bounds of gait G (named gait) that way: a step longer than both a foot at home (H: [left, ahead] of the
 *  pelvis spot) stepping the longest, `longest`, in direction u past the other, and that plant's step without them
 *  (was, named when past that bound); a foot further from the Hips joint (hip) than both one that lands a steady pace's
 *  distance ahead of the pelvis, behind it by the gait's trail, and that foot without its end spot (own, named when
 *  past that bound). step: the longest step past the bound (else the longest of a plant they made); far: the foot
 *  furthest past the bound (else the furthest foot they moved). */
export function endSplit(lands, gait, longest, G, u, H, hip, tol = 0.04) {
	const l = Math.hypot(...u), d = [u[0] / l, u[1] / l], ahead = (h, k, back = 0) => [h[0] + k * d[0], h[1] + k * d[1] - back];
	const reach = longest * (1 - (G.swLong ?? G.sw) / 2), bound = { step: Math.max(longest, ...H.map((h, i) => gap(ahead(h, longest), H[1 - i]))), far: Math.max(reach, ...H.map(h => gap(ahead(h, reach, G.trail), hip))) };
	const last = [null, null], made = [];
	for (const e of lands ?? []) {
		const o = last[1 - e.side], other = o?.home ? [e.other[0] + o.home[0] - o.g[0], e.other[1] + o.home[1] - o.g[1]] : e.other;
		const p = e.home && { step: gap(e.g, e.other), was: gap(e.home, other), far: gap(e.g, e.hip), own: gap(e.home, e.hip), moved: gap(e.g, e.home) };
		if (p && (p.moved > tol || p.step > p.was + tol)) made.push({ ...p, over: Math.min(p.far - bound.far, p.far - p.own - tol) });
		last[e.side] = e;
	}
	const longs = made.filter(e => e.step > bound.step + 1e-6 && e.step > e.was + tol), wides = made.filter(e => e.over > 1e-6);
	if (!longs.length && !wides.length) return null;
	const moved = made.filter(e => e.moved > tol), changed = made.filter(e => Math.abs(e.step - e.was) > tol), s = most(longs.length ? longs : changed.length ? changed : made, "step"), f =most(wides.length ? wides : moved.length ? moved : made, wides.length ? "over" : "far");
	return { gait, step: s.step, far: f.far, longest, reach: bound.far, own: wides.length && f.own > bound.far ? f.own : null, was: longs.length && s.was > bound.step ? s.was : null, long: longs.length > 0, wide: wides.length > 0 };
}
