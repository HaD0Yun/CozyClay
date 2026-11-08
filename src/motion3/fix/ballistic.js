// Ballistic fix (spec.fix.ballistic, #1124): off the ground nothing but gravity acts on the body, so its centre of mass
// rides a parabola between takeoff and landing and its horizontal speed stays the same. Per flight (qa/flight-checks.js
// flights: an air run of 4 frames or more, split where a hand is pinned), anchored at the frame just before takeoff (A) and the frame just after
// landing (B), the whole body moves by the difference each frame:
//   vertical    the gravity parabola through the centre of mass at A and at B (qa/ballistic.js ballisticArc, g fixed);
//   horizontal  the straight line from the centre of mass at A to B at constant speed.
// The whole body is the root and every world target that rides it (the ankle and wrist targets), so the limbs keep their
// pose and the frames are solved again. The frames on the ground keep their keys: the body leaves A and meets B at the
// arc's speed in one frame, a push-off and an impact (QA POP leaves those frames: qa/flight-checks.js contactFrames; an
// ease of the root over the supported frames around them moved the planted legs into pops of their own and the hips
// after landing off their keys). A run whose hips do not fall (FLOAT: under a quarter of g) is a staging error and stays
// for QA's arc hint; a run that needs more than MAX_FIX (0.5 m) is reported instead of fixed (skipped: the
// apex an N-frame flight has, g N^2 / 8, and the frames the hips' own apex fits, sqrt(8 h / g)). Bench v2 (2026-11-07,
// 07 roof fall back r1): the agent's exact 1 g parabola came out 0.27 m off at f106 after retime stretched its frames.
import { bodyCentre } from "../qa/com.js";
import { ballisticArc, MAX_FIX } from "../qa/ballistic.js";
import { missingFall, FLOAT_LIMIT } from "../qa/style.js";
import { round4 } from "./ease.js";

/** The channels that are world points riding the body: moved with the root. */
export const RIDERS = ["root", "foot_l", "foot_r", "hand_l", "hand_r"];

/** Moves every rider of frame f (absolute) by d (m). */
function shiftFrame(baked, f, d) {
	for (const ch of RIDERS) {
		const v = baked[ch]?.[f];
		if (Array.isArray(v)) baked[ch][f] = [v[0] + d[0], v[1] + d[1], v[2] + d[2]];
	}
}

/** The shift [dx, dy, dz] per frame a..b that puts the centre of mass on the parabola, or null without an arc. */
function arcShift(out, a, b) {
	const { sk } = out.ctx, A = a - 1, B = b + 1, g = 9.81 / (out.fps ?? 24) ** 2;
	const c = [];
	for (let f = A; f <= B; f++) c.push(bodyCentre(sk, out.frames[f].s));
	const arc = ballisticArc(c.map(p => p[1]), 1, b - a + 1, g, Infinity);
	if (!arc) return null;
	return arc.delta.map((dy, i) => {
		const t = (i + 1) / (B - A), p = c[i + 1];
		return [c[0][0] + (c[c.length - 1][0] - c[0][0]) * t - p[0], dy, c[0][2] + (c[c.length - 1][2] - c[0][2]) * t - p[2]];
	});
}

/**
 * Puts the centre of mass of each flight in `runs` (qa/flight-checks.js flights) on its parabola. -> { runs, frames, max (m, the
 * largest move), at, skipped?, how } | null when nothing moved and nothing was too far.
 */
export function ballisticFix(out, engine, runs) {
	const f0 = out.f0 ?? 0, g = 9.81 / (out.fps ?? 24) ** 2, at = [], skipped = [];
	let frames = 0, max = 0;
	for (const [a, b] of runs) {
		if (missingFall(out, a, b) > FLOAT_LIMIT) continue;
		const d = arcShift(out, a, b);
		if (!d) continue;
		const worst = Math.max(...d.map(v => Math.hypot(...v)));
		if (worst > MAX_FIX) {
			const N = b - a + 2, c = out.frames.slice(a - 1, b + 2).map(fr => bodyCentre(out.ctx.sk, fr.s)[1]), h = Math.max(...c) - c[0];
			skipped.push({ at: `f${a + f0}-f${b + f0}`, off: round4(worst), apex: round4(g * N * N / 8), fits: h > 0 ? Math.round(Math.sqrt(8 * h / g)) : 0 });
			continue;
		}
		if (worst < 1e-4) continue;
		d.forEach((v, i) => shiftFrame(out.baked, a + f0 + i, v));
		engine.solve(Array.from({ length: b - a + 1 }, (_, i) => a + f0 + i));
		at.push(`f${a + f0}-f${b + f0}`);
		frames += b - a + 1;
		max = Math.max(max, worst);
	}
	if (!at.length && !skipped.length) return null;
	return { runs: at.length, frames, max: round4(max), at, ...(skipped.length ? { skipped } : {}),
		how: `the centre of mass follows the gravity parabola between takeoff and landing at constant horizontal speed${skipped.length ? `; runs past ${MAX_FIX} m are reported, not fixed (apex g N^2 / 8 for N frames; fits: the frames the hips' apex needs)` : ""}` };
}
