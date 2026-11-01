// Body-angle spikes out of a MotionBricks fill: on a few frames the decoded pelvis can turn wildly (stairs + box bench,
// 2026-10-31: yaw 180 -> 200 -> 82 -> 235 -> 124 deg over f207-f213 while stepping down with a box), and the compiler then spins
// the body through the box and flips both knees (QA FLIP 106 deg, KNEE, COLLIDE torso x box). A frame whose angle is more than
// SPIKE deg off the median of its WINDOW neighbours is an outlier; outlier runs are redrawn as a straight line between the good
// frames around them. A slower spin (a full turn over 4-8 frames, the same bench at f196-f214) is no outlier: the heading
// (yaw) stays within MAX_TURN deg of the compiler's curve between the authored keys, which is where the author faced the body.
// Only the root angles: the limbs follow them.
const CHANNELS = ["yaw", "pitch", "roll"], WINDOW = 3, SPIKE = 15, MAX_TURN = 45;
const wrap = d => d - 360 * Math.round(d / 360);
const median = xs => { const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/**
 * dense: the fill's rows (row i is frame fa + i); baked: the compiled channels without this gap's fill. Unwraps each root angle,
 * holds the heading near the authored curve, redraws outlier runs; returns dense, changed in place.
 */
export function despikeAngles(dense, baked, fa) {
	const n = dense.length;
	for (const ch of CHANNELS) {
		if (!dense.every(r => Number.isFinite(r[ch]))) continue;
		const v = dense.map(r => r[ch]), ref = ch === "yaw" ? baked?.yaw : null;
		for (let i = 1; i < n; i++) v[i] -= 360 * Math.round((v[i] - v[i - 1]) / 360);
		if (ref && v.every((_, i) => Number.isFinite(ref[fa + i]))) for (let i = 0; i < n; i++) v[i] = ref[fa + i] + Math.max(-MAX_TURN, Math.min(MAX_TURN, wrap(v[i] - ref[fa + i])));
		const bad = v.map((x, i) => Math.abs(x - median(v.slice(Math.max(0, i - WINDOW), i + WINDOW + 1))) > SPIKE);
		bad[0] = bad[n - 1] = false; // the ends sit on the authored keys
		for (let i = 1; i < n - 1; i++) {
			if (!bad[i]) continue;
			let j = i;
			while (j < n - 1 && bad[j]) j++;
			for (let k = i; k < j; k++) v[k] = v[i - 1] + (v[j] - v[i - 1]) * (k - i + 1) / (j - i + 1);
			i = j;
		}
		v.forEach((x, i) => { dense[i][ch] = x; });
	}
	return dense;
}
