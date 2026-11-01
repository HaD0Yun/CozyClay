// Two things QA could not see, both seen in agent runs on MotionBricks fills (2026-10-30):
//   KEY       an authored key the take never reaches: the root or an ankle more than KEY_MISS off the key at its frame. The
//             slide fix held a planted ball over a kneel key and the knees stayed 0.4 m up while QA read clean.
//   TELEPORT  the hips covering more than TELEPORT m in one frame (7.2 m/s at 24 fps) and three times what they cover in the
//             frames beside it: a jump, not a fast move (a body a truck throws speeds up over frames). A take jumped 7.7 m/s at
//             f9 and QA ranked it the best of the round.
// Only keys the author wrote count (no src: fill keys and skill keys are generated), and a key counts as reached when the take
// passes within KEY_MISS of it within RETIME_SLACK frames (the retime fix moves keys a few frames).
import { isFillKey } from "../bricks/fill-src.js";

const KEY_MISS = 0.15, TELEPORT = 0.3, RETIME_SLACK = 3;
const CHANNELS = ["root", "foot_l", "foot_r"];

/** Issues (frames as out.frames indexes) for authored keys the take misses and for hips that jump. */
export function keyReachIssues(sk, out, spec) {
	const issues = [], f0 = out.f0 ?? 0, n = out.frames.length, baked = out.baked ?? {};
	for (const k of spec?.keys ?? []) {
		if (!k || k.src !== undefined || isFillKey(k) || !Number.isInteger(k.f) || k.f < f0 || k.f - f0 >= n) continue;
		for (const ch of CHANNELS) {
			const want = k.set?.[ch];
			if (!Array.isArray(want) || !baked[ch]) continue;
			let d = Infinity;
			for (let f = k.f - RETIME_SLACK; f <= k.f + RETIME_SLACK; f++) { const got = baked[ch][f]; if (Array.isArray(got)) d = Math.min(d, Math.hypot(want[0] - got[0], want[1] - got[1], want[2] - got[2])); }
			if (!Number.isFinite(d)) continue;
			if (d > KEY_MISS) issues.push({ kind: "KEY", msg: `${ch} ${(d * 100).toFixed(1)} cm off its key at f${k.f}`, frame: k.f - f0, value: +d.toFixed(4), limit: KEY_MISS });
		}
	}
	const I = sk.index.Hips, step = f => { const a = out.frames[f - 1]?.s.P[I], b = out.frames[f]?.s.P[I]; return a && b ? Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) : 0; };
	for (let f = 1; f < n; f++) {
		const d = step(f);
		if (d > TELEPORT && d > 3 * Math.max(step(f - 1), step(f + 1))) issues.push({ kind: "TELEPORT", msg: `Hips ${(d * (out.fps ?? 24)).toFixed(1)} m/s in one frame`, frame: f, value: +d.toFixed(4), limit: TELEPORT });
	}
	return issues;
}

/** explain.js hints: what to change for a missed key or a hips jump. */
export const keyReachHints = {
	KEY(X, g) {
		const [, ch, f] = /^(\w+) [\d.]+ cm off its key at f(\d+)$/.exec(g.subject) ?? [];
		return { cause: X.cause(ch ?? "root", Number(f ?? g.worstFrame)), hint: `the take never reaches this key: a planted foot held through it (the slide fix) or the limb cannot reach it. Give the move more frames before f${f}, move the key nearer the pose before it, or key the foot lifting on its way` };
	},
	TELEPORT(X, g) {
		return { cause: X.cause("root", g.worstFrame), hint: `the hips jump in one frame at f${g.worstFrame}: two keys around it disagree about the root, or a fill key does; remove or move the key at f${g.worstFrame}, or re-fill the gap around it (motion.fill with base and at)` };
	},
};
