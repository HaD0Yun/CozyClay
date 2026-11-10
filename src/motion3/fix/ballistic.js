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
// for QA's arc hint; a run that needs more than MAX_FIX (0.5 m), or whose arc enters what the frames before the flight
// fixes stayed out of (flight-gate.js: a hop keyed over a hurdle higher than its frames can carry it), keeps its frames
// and is reported instead (skipped: the apex an N-frame flight has, g N^2 / 8, and the frames the hips' own apex fits,
// sqrt(8 h / g)). Bench v2 (2026-11-07, 07 roof fall back r1): the agent's exact 1 g parabola came out 0.27 m off at f106
// after retime stretched its frames.
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
 * largest move), at, skipped?, how } | null when nothing moved and nothing was too far. `gate`, flight-gate.js, says what a
 * move entered (skipped: into, depth); the run gets its frames back. `prev`, the report of an earlier pass over the same
 * runs (before fix.spin), joins this one: its runs count as moved, its worst move stands; skipped is this pass's (a run the
 * earlier pass skipped and this one fixed is no longer skipped).
 */
export function ballisticFix(out, engine, runs, gate, prev = null) {
	const f0 = out.f0 ?? 0, g = 9.81 / (out.fps ?? 24) ** 2, done = new Set(prev?.at ?? []), at = [], skipped = [];
	let frames = 0, max = prev?.max ?? 0;
	const skip = (a, b, worst, c, why) => {
		const N = b - a + 2, h = Math.max(...c) - c[0];
		skipped.push({ at: `f${a + f0}-f${b + f0}`, off: round4(worst), apex: round4(g * N * N / 8), fits: h > 0 ? Math.round(Math.sqrt(8 * h / g)) : 0, ...why });
		return 0;
	};
	const move = (a, b) => {
		if (missingFall(out, a, b) > FLOAT_LIMIT) return 0;
		const d = arcShift(out, a, b);
		if (!d) return 0;
		const worst = Math.max(...d.map(v => Math.hypot(...v))), heights = () => out.frames.slice(a - 1, b + 2).map(fr => bodyCentre(out.ctx.sk, fr.s)[1]);
		if (worst > MAX_FIX) return skip(a, b, worst, heights());
		if (worst < 1e-4) return 0;
		const frames = Array.from({ length: b - a + 1 }, (_, i) => a + f0 + i), was = frames.map(f => RIDERS.map(ch => out.baked[ch]?.[f]));
		d.forEach((v, i) => shiftFrame(out.baked, frames[i], v));
		engine.solve(frames);
		const hit = gate(a, b);
		if (!hit) return worst;
		// the very values go back: fix/index.js reads a moved frame by a changed reference
		frames.forEach((f, i) => RIDERS.forEach((ch, k) => { if (Array.isArray(was[i][k])) out.baked[ch][f] = was[i][k]; }));
		engine.solve(frames);
		return skip(a, b, worst, heights(), hit);
	};
	for (const [a, b] of runs) {
		const label = `f${a + f0}-f${b + f0}`, worst = move(a, b);
		if (!worst && !done.has(label)) continue;
		at.push(label);
		frames += b - a + 1;
		max = Math.max(max, worst);
	}
	if (!at.length && !skipped.length) return null;
	return { runs: at.length, frames, max: round4(max), at, ...(skipped.length ? { skipped } : {}),
		how: `the centre of mass follows the gravity parabola between takeoff and landing at constant horizontal speed${skipped.length ? `; runs past ${MAX_FIX} m, or whose arc enters what the keyed flight did not (into), keep their frames and are reported (apex g N^2 / 8 for N frames; fits: the frames the keyed apex needs)` : ""}` };
}
