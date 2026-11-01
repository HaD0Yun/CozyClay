// Planted-foot lock: while a heel or ball is planted (QA's own definition, over the ground under
// it: the floor or an object's top, qa/ground.js) and drifts less than
// 1 cm, the ankle target is shifted so the planted point stays where it landed. The foot pose
// depends only on the ankle target, fyaw and fpitch, so the shift moves the sole rigidly.
// A pivot (the planted point is the only one down: the heel is up over a planted ball, or the
// ball over a planted heel) is held whatever the drift: fyaw and fpitch then turn the foot about
// that point, as a batter's back foot turns on its ball, instead of about the ankle. A pivot that
// held more than 1 cm keeps holding while its point stays under PIVOT_H (a hover, not a step) and
// lets go no faster than EASE_STEP a frame.
import { add, sub } from "../compiler/math.js";
import { QA_LIMITS } from "../qa/checks.js";
import { groundSole } from "../qa/ground.js";
import { round4 } from "./ease.js";

// a pivot the keys carry farther than PIVOT_MAX is not a turn on the spot but the foot going somewhere (a kneel, a step back): let it go
const MAX_DRIFT = 0.01, DECAY = 4, PIVOT_H = 0.03, EASE_STEP = 0.02, PIVOT_MAX = 0.15;

export function lockFeet(out, engine) {
	const n = out.frames.length, H = QA_LIMITS.plantH;
	let plants = 0, pivots = 0, worst = 0;
	const touched = new Set();
	for (const [k, S] of [["l", "Left"], ["r", "Right"]]) {
		const ch = out.baked[`foot_${k}`];
		if (!ch) continue;
		const sole = out.frames.map((_, i) => groundSole(out, i, S));
		const planted = (i, key) => sole[i][key][1] < H && sole[i - 1][key][1] < H && Math.abs(sole[i][key][1] - sole[i - 1][key][1]) < 0.0005;
		const delta = Array.from({ length: n }, () => null);
		for (let i = 1; i < n;) {
			if (!planted(i, "ball") && !planted(i, "heel")) { i++; continue; }
			// one contact run: the ball wins over the heel; a switch re-anchors on the new point
			let key = null, ref = null, j = i, max = 0, last = [0, 0, 0], pivot = false;
			const run = [];
			const hold = jj => {
				const d = sub(ref, sole[jj][key]); d[1] = 0;
				last = d;
				run.push([jj, d]);
				max = Math.max(max, Math.hypot(d[0], d[2]));
			};
			for (; j < n && (planted(j, "ball") || planted(j, "heel")); j++) {
				const kj = planted(j, "ball") ? "ball" : "heel";
				pivot ||= sole[j][kj === "ball" ? "heel" : "ball"][1] >= H;
				// on a switch the new point is anchored where the previous frame's shift put it
				if (kj !== key) { key = kj; ref = add(sole[j - 1][key], last); }
				hold(j);
			}
			if (pivot && max >= MAX_DRIFT) for (; j < n && sole[j][key][1] < PIVOT_H; j++) hold(j);
			if (max > 2e-4 && (max < MAX_DRIFT || (pivot && max < PIVOT_MAX))) {
				plants++; worst = Math.max(worst, max);
				if (max >= MAX_DRIFT) pivots++;
				for (const [jj, d] of run) delta[jj] = d;
				const decay = Math.max(DECAY, Math.ceil(Math.hypot(last[0], last[2]) / EASE_STEP));
				for (let m = 1; m <= decay && j - 1 + m < n; m++) {
					if (delta[j - 1 + m]) break;
					const t = m / (decay + 1), e = 1 - t * t * (3 - 2 * t);
					delta[j - 1 + m] = [last[0] * e, 0, last[2] * e];
				}
			}
			i = j;
		}
		for (let i = 0; i < n; i++) {
			if (!delta[i]) continue;
			const f = out.f0 + i;
			ch[f] = add(ch[f], delta[i]);
			touched.add(f);
		}
	}
	if (!plants) return null;
	engine.solve([...touched]);
	return { plants, ...(pivots ? { pivots } : {}), frames: touched.size, max: round4(worst),
		how: pivots ? "planted heel/ball held in place; turning feet pivot on it" : "planted heel/ball held in place" };
}
