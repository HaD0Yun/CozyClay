// Key-authoring helpers for the beats motion3 has no skill for: a turn on the spot, a jog, a walk along an arc that
// ends at a given point. They only write ordinary motion3 keys ({ f, set }); the compiler does the rest.
// Conventions are motion3's: metres, Y up, heading 0 faces +Z, + turns toward +X (the character's left).
export const SCHEMA = "cozyclay.motion-spec.v1";

const rad = d => d * Math.PI / 180;
export const fwd = h => [Math.sin(rad(h)), 0, Math.cos(rad(h))];
export const leftOf = h => [Math.cos(rad(h)), 0, -Math.sin(rad(h))];
/** World point of a body-frame offset [left, up, forward] from floor point `at` = [x, z] at heading h. */
export function world(at, h, [l, u, f]) {
	const a = leftOf(h), b = fwd(h);
	return [at[0] + a[0] * l + b[0] * f, u, at[1] + a[2] * l + b[2] * f];
}
const smooth = t => { const x = Math.min(1, Math.max(0, t)); return x * x * (3 - 2 * x); };
const lerp = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

/** The feet of a neutral stance at `at`, heading h (standIdle's). */
export const stanceFeet = (B, at, h) => ({ foot_l: world(at, h, [0.09, B.ankleY, -0.03]), foot_r: world(at, h, [-0.09, B.ankleY, 0.03]) });

/** standIdle's whole key at `at`, heading h: use it to start or end a hand-keyed beat on a known pose. */
export function standSet(B, at, h) {
	return { root: [at[0], B.hipsY - 0.01, at[1]], yaw: h, pitch: 0, roll: 0, spine_yaw: 0, spine_pitch: 0, spine_roll: 0, head_yaw: 0, head_pitch: 0,
		...stanceFeet(B, at, h), fyaw_l: h, fyaw_r: h, fpitch_l: 0, fpitch_r: 0, knee_l: [0.05, 0, 1], knee_r: [-0.05, 0, 1],
		armw_l: 0, armw_r: 0, aswing_l: 0, aswing_r: 0, abend_l: 0, abend_r: 0, arm_hang: 1 };
}

/** Keys merged by frame (later sets win), sorted. */
export function mergeKeys(keys) {
	const by = new Map();
	for (const k of keys) { const f = Math.round(k.f); by.set(f, { ...(by.get(f) ?? {}), ...k.set }); }
	return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([f, set]) => ({ f, set }));
}

/**
 * A turn on the spot from heading h0 to h1 over frames f0..f1, the feet about `at`: in parts of at most 90 degrees, the
 * foot on the inside of the turn steps to its new place first, the body turns over it, the other foot follows.
 * `extra` is added to every key (arms that carry something). Starts and ends on the stance of stanceFeet.
 */
export function turnOnSpot(B, { f0, f1, at, h0, h1, lift = 0.05, extra = {} }) {
	const n = Math.max(1, Math.ceil(Math.abs(h1 - h0) / 90 - 1e-6)), keys = [], lead = h1 > h0 ? "l" : "r", trail = lead === "l" ? "r" : "l";
	const rootAt = dy => [at[0], B.hipsY - 0.01 - dy, at[1]];
	for (let i = 0; i < n; i++) {
		const a = f0 + (f1 - f0) * i / n, b = f0 + (f1 - f0) * (i + 1) / n, m = (a + b) / 2, ha = h0 + (h1 - h0) * i / n, hb = h0 + (h1 - h0) * (i + 1) / n, hm = (ha + hb) / 2;
		const A = stanceFeet(B, at, ha), Z = stanceFeet(B, at, hb), up = p => [p[0], p[1] + lift, p[2]];
		keys.push({ f: a, set: { root: rootAt(0), yaw: ha, roll: 0, [`foot_${lead}`]: A[`foot_${lead}`], [`foot_${trail}`]: A[`foot_${trail}`], fyaw_l: ha, fyaw_r: ha, fpitch_l: 0, fpitch_r: 0, ...extra } });
		keys.push({ f: (a + m) / 2, set: { [`foot_${lead}`]: up(lerp(A[`foot_${lead}`], Z[`foot_${lead}`], 0.5)), [`fyaw_${lead}`]: hm, [`foot_${trail}`]: A[`foot_${trail}`], [`fyaw_${trail}`]: ha, root: rootAt(0.015), yaw: ha + (hb - ha) * 0.2 } });
		keys.push({ f: m, set: { [`foot_${lead}`]: Z[`foot_${lead}`], [`fyaw_${lead}`]: hb, [`foot_${trail}`]: A[`foot_${trail}`], [`fyaw_${trail}`]: ha, [`fpitch_${trail}`]: 0, root: rootAt(0.02), yaw: hm, ...extra } });
		keys.push({ f: (m + b) / 2, set: { [`foot_${trail}`]: up(lerp(A[`foot_${trail}`], Z[`foot_${trail}`], 0.5)), [`fyaw_${trail}`]: hm, [`foot_${lead}`]: Z[`foot_${lead}`], [`fyaw_${lead}`]: hb, root: rootAt(0.015), yaw: ha + (hb - ha) * 0.8 } });
		keys.push({ f: b, set: { root: rootAt(0), yaw: hb, roll: 0, ...Z, fyaw_l: hb, fyaw_r: hb, fpitch_l: 0, fpitch_r: 0, ...extra } });
	}
	return mergeKeys(keys);
}

/**
 * A jog from `from` to `to` (both [x, z]) over frames f0..f1 at heading h: `steps` landings, each foot on the ground
 * for 0.7 of a step and both in the air for the rest, the hips low at mid-stance and high in the air, the trunk leaning,
 * the elbows bent and the arms pumping against the legs. Starts on a stance (standSet). With end "stride" it ends in
 * a stride about `to`, the right foot ahead, so a walk can go on from it; with "stand" the feet come together at `to`.
 */
export function jog(B, { f0, f1, from, to, h, steps = 10, lean = 9, arm = 38, end = "stride" }) {
	const D = Math.hypot(to[0] - from[0], to[1] - from[1]), N = steps + (steps % 2), keys = [], lead = 6, tail = end === "stand" ? 10 : 3;
	const p = (f1 - f0 - lead - tail) / (N - 1), last = 0.25, L = (D - 0.3 - last) / (N - 2);
	const sAt = i => (i === N - 1 ? D + last : 0.3 + i * L), tAt = i => f0 + lead + i * p;
	const foot = (s, k, up = 0) => world(from, h, [(k === "l" ? 1 : -1) * 0.06, B.ankleY + up, s]);
	const stand = standSet(B, from, h), stance = { l: -0.03, r: 0.03 };
	keys.push({ f: f0, set: { ...stand, abend_l: 10, abend_r: 10 } });
	// each landing i: foot k comes down at sAt(i), stays for 0.7 p, swings to its next landing
	const landed = { l: { s: stance.l, t: f0 - 0.7 * p + 2 }, r: { s: stance.r, t: f0 + lead - 0.7 * p + 0.35 * p } };
	for (let i = 0; i < N; i++) {
		const k = i % 2 ? "r" : "l", o = k === "l" ? "r" : "l", t = tAt(i), s = sAt(i), from0 = landed[k], lift = Math.max(f0 + 1, from0.t + 0.7 * p), size = Math.min(1, (s - from0.s) / 0.8);
		const fk = `foot_${k}`, fp = `fpitch_${k}`;
		keys.push({ f: lift, set: { [fk]: foot(from0.s + 0.02, k, 0.035), [fp]: 40 * size + 10 } });
		keys.push({ f: (lift + t) / 2, set: { [fk]: foot((from0.s + s) / 2 - 0.05 * size, k, 0.08 + 0.16 * size), [fp]: 35 * size } });
		if (t - lift > 4) keys.push({ f: t - 1, set: { [fk]: foot(s - 0.07 * size, k, 0.04), [fp]: -8 } });
		keys.push({ f: t, set: { [fk]: foot(s, k), [fp]: 0, [`fyaw_${k}`]: h } });
		if (i < N - 1) keys.push({ f: t + 0.45 * p, set: { [fk]: foot(s, k), [fp]: 0 } });
		landed[k] = { s, t };
		// the hips: behind the landing foot, lowest at mid-stance, highest in the air; the trunk leans with the pace
		const fade = Math.min(1, (i + 1) / 2) * (i >= N - 2 ? 0.5 : 1), next = i < N - 1 ? sAt(i + 1) : s, rs = u => s - 0.12 + (next - s) * u, y = dy => B.hipsY - dy;
		const root = (u, dy) => { const w = world(from, h, [0, 0, rs(u)]); return [w[0], y(dy), w[2]]; };
		keys.push({ f: t, set: { root: root(0, 0.045), pitch: lean * fade, yaw: h, roll: 0, spine_pitch: 4 * fade, head_pitch: -6 * fade,
			spine_yaw: (k === "l" ? -1 : 1) * 7 * fade, [`aswing_${o}`]: arm * fade, [`aswing_${k}`]: -0.8 * arm * fade, abend_l: 20 + 60 * fade, abend_r: 20 + 60 * fade } });
		if (i < N - 1) {
			keys.push({ f: t + 0.35 * p, set: { root: root(0.35, 0.075) } });
			keys.push({ f: t + 0.85 * p, set: { root: root(0.85, 0.015) } });
		}
	}
	const tl = tAt(N - 1);
	if (end === "stand") {
		const S = standSet(B, to, h), k = N % 2 ? "r" : "l";
		keys.push({ f: tl + 5, set: { [`foot_${k}`]: world(from, h, [(k === "l" ? 1 : -1) * 0.07, B.ankleY + 0.06, D]), root: [to[0], B.hipsY - 0.04, to[1]] } });
		keys.push({ f: f1, set: S });
	} else {
		// ends in a stride: the right foot ahead, the left behind on its ball, the hips between, the arms coming down
		const w = world(from, h, [0, 0, D + 0.05]);
		keys.push({ f: f1, set: { root: [w[0], B.hipsY - 0.04, w[2]], pitch: 3, roll: 0, spine_pitch: 0, spine_yaw: 0, head_pitch: 0, foot_r: foot(sAt(N - 1), "r"), fpitch_r: 0,
			foot_l: foot(sAt(N - 2), "l"), fpitch_l: 0, fyaw_l: h, fyaw_r: h, aswing_l: 0, aswing_r: 0, abend_l: 15, abend_r: 15, yaw: h } });
	}
	return mergeKeys(keys);
}

/**
 * walkTo args for a walk from floor point `from` at heading h0 that ends at `to` along one arc: the walk generator
 * turns its heading from h0 to h1 over turnDistance metres (a smoothstep), so h1 and the arc's length are solved
 * here. `side` picks the turn (+1 toward the character's left, -1 right; 0: the shorter). The strides are set so `steps`
 * steps cover the arc (the last step only closes the feet). -> { heading, turnDistance, steps, step, firstStep }
 */
export function arcTo(from, h0, to, steps, side = 0) {
	const dx = to[0] - from[0], dz = to[1] - from[1], bearing = Math.atan2(dx, dz) * 180 / Math.PI, d = Math.hypot(dx, dz);
	const chord = turn => {
		let x = 0, z = 0;
		for (let i = 0; i < 200; i++) { const a = rad(h0 + turn * smooth((i + 0.5) / 200)); x += Math.sin(a) / 200; z += Math.cos(a) / 200; }
		return { len: Math.hypot(x, z), dir: Math.atan2(x, z) * 180 / Math.PI };
	};
	const wrap = a => a - 360 * Math.round(a / 360);
	let best = null;
	for (const sg of side ? [side] : [1, -1]) {
		for (let turn = 0; Math.abs(turn) <= 300; turn += sg * 0.25) {
			const c = chord(turn), miss = Math.abs(wrap(c.dir - bearing));
			if (miss < 0.3) { if (!best || Math.abs(turn) < Math.abs(best.turn)) best = { turn, len: c.len }; break; }
		}
	}
	const r3 = v => Math.round(v * 1000) / 1000, path = best ? d / best.len : d, step = path / (steps - 2 + 0.8);
	return { heading: [h0, r3(best ? h0 + best.turn : bearing)], turnDistance: r3(best ? path : 0.4), steps, step: r3(step), firstStep: r3(0.8 * step) };
}

/** Number of lines of a spec builder's source (the size the report gives). */
export const linesOf = fn => String(fn).split("\n").length;
