// The standing foot of a step stays put inside a fill. The model's contact labels can drop a foot the author keeps in one place
// at both ends of a gap, so it drifts or both feet leave the ground (stairs + box bench, 2026-11-01: FLOAT 73 and SLIDE 23 frames, and a
// walk that read as shuffling). A foot keyed at the same spot and heading at both ends of a gap is the author's support for that
// gap: its ankle and angles run straight between the gap's two ends. The foot the author moves keeps the model's path and lift, but
// not its heading: the end correction took the long way round at +-180 deg (130 -> 30 -> 180 deg in 4 frames, the ankle whipping
// round), so a swinging foot turns the short way between the two ends. Its toe-down stops at MAX_PITCH: near 50 deg the foot points
// straight down, level-the-sole has no up to read and the foot flips 180 deg in a frame (limbs.js orientFoot).
const NEAR = 0.01, TURN = 1, MAX_PITCH = 40;
const ease = t => t * t * (3 - 2 * t);
const keyed = (authored, f, ch) => authored.filter(k => k.f === f && k.set?.[ch] !== undefined).at(-1)?.set[ch];

/** dense: the fill's rows for frames fa..fb. authored: the spec's authored keys. Returns dense, changed in place. */
export function holdStance(dense, fa, fb, authored) {
	const last = dense.length - 1;
	for (const k of ["l", "r"]) {
		const a = keyed(authored, fa, `foot_${k}`), b = keyed(authored, fb, `foot_${k}`);
		const still = Array.isArray(a) && Array.isArray(b) && Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) <= NEAR && Math.abs((keyed(authored, fa, `fyaw_${k}`) ?? 0) - (keyed(authored, fb, `fyaw_${k}`) ?? 0)) <= TURN;
		if (!still) {
			const y = `fyaw_${k}`, p = `fpitch_${k}`, s = dense[0]?.[y], e = dense[last]?.[y];
			if (Number.isFinite(s) && Number.isFinite(e)) { const d = e - s - 360 * Math.round((e - s) / 360); dense.forEach((row, i) => { row[y] = s + d * ease(last ? i / last : 0); }); }
			dense.forEach(row => { if (row[p] > MAX_PITCH) row[p] = MAX_PITCH; });
			continue;
		}
		for (const ch of [`foot_${k}`, `fyaw_${k}`, `fpitch_${k}`]) {
			const s = dense[0]?.[ch], e = dense[last]?.[ch];
			if (s === undefined || e === undefined) continue;
			dense.forEach((row, i) => { const u = last ? i / last : 0; row[ch] = Array.isArray(s) ? s.map((v, c) => v + (e[c] - v) * u) : s + (e - s) * u; });
		}
	}
	return dense;
}
