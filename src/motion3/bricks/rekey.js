// Dense channel frames -> the fewest keys that bring every frame back within a tolerance, using the same monotone cubic
// (PCHIP) the compiler interpolates position channels with (compiler/channels.js). Greedy: the worst frame gets a key
// until none is off by more than the tolerance. Mid tolerance only: 1.5 cm, 2.5 deg, poles 0.08, foot pitch 4 deg.
const TOL = { point: 0.015, angle: 2.5, pole: 0.08, fpitch: 4 };

function tolFor(ch) {
	if (ch === "root" || /^(foot|hand)_[lr]$/.test(ch)) return TOL.point;
	if (/^(knee|elbow)_[lr]$/.test(ch)) return TOL.pole;
	return /^fpitch_/.test(ch) ? TOL.fpitch : TOL.angle;
}

function slopes(x, y) {
	const m = new Array(y.length).fill(0);
	for (let i = 1; i < y.length - 1; i++) {
		const h0 = x[i] - x[i - 1], h1 = x[i + 1] - x[i], d0 = (y[i] - y[i - 1]) / h0, d1 = (y[i + 1] - y[i]) / h1;
		if (d0 * d1 > 0) { const w1 = 2 * h1 + h0, w2 = h1 + 2 * h0; m[i] = (w1 + w2) / (w1 / d0 + w2 / d1); }
	}
	return m;
}

function evalAt(x, y, m, q) {
	if (q <= x[0]) return y[0];
	if (q >= x[x.length - 1]) return y[y.length - 1];
	let i = 0;
	while (q > x[i + 1]) i++;
	const h = x[i + 1] - x[i], t = (q - x[i]) / h, t2 = t * t, t3 = t2 * t;
	return (2 * t3 - 3 * t2 + 1) * y[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * y[i + 1] + (t3 - t2) * h * m[i + 1];
}

const comps = v => (Array.isArray(v) ? v : [v]);

/** Per-frame error of the curve through `keys` (indices into values) against every frame. */
function errors(values, keys) {
	const dims = comps(values[0]).length, err = new Array(values.length).fill(0);
	for (let d = 0; d < dims; d++) {
		const y = keys.map(k => comps(values[k])[d]), m = slopes(keys, y);
		values.forEach((v, i) => { err[i] += (evalAt(keys, y, m, i) - comps(v)[d]) ** 2; });
	}
	return err.map(Math.sqrt);
}

/**
 * values: one channel's dense values over a span, first and last fixed (they are the authored keys around the gap).
 * forced: indices that must be keys (a held foot's contact edges). Returns the interior indices to key.
 */
export function pickKeys(ch, values, forced = [], tolScale = 1) {
	const tol = tolFor(ch) * tolScale, keys = [0, values.length - 1, ...forced.filter(i => i > 0 && i < values.length - 1)];
	if (/^(knee|elbow)_[lr]$/.test(ch)) {
		// never interpolate across a pole that swings past ~60 deg between frames: key both sides of the swing
		for (let i = 1; i < values.length; i++) {
			const a = values[i - 1], b = values[i], c = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (Math.hypot(...a) * Math.hypot(...b) || 1);
			if (c < 0.5) keys.push(i - 1, i);
		}
	}
	let set = [...new Set(keys)].sort((a, b) => a - b);
	while (set.length < values.length) {
		const err = errors(values, set);
		let w = 0;
		for (let i = 1; i < err.length; i++) if (err[i] > err[w]) w = i;
		if (err[w] <= tol) break;
		set = [...set, w].sort((a, b) => a - b);
	}
	return set.filter(i => i > 0 && i < values.length - 1);
}
