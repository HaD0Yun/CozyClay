// What a body off the ground came out as, measured on the clip: each launch (air.js), and each other stretch of frames
// on which both feet of a body are off the floor and off every prop's box while its hips rise over 0.1 m and their
// upward speed changes by over 1 m/s in one frame at its start or end (a body lifted by tilt and shift, say). Speeds are
// those of the Hips joint between two frames.
import { ANKLE_HEIGHT, INDEX as J, JOINT_COUNT, REST, TIPS, qConj, qRotate } from "../rig17.js";

/** Times the body's scale. off (m): a foot whose sole and toe tip are over this far from the floor and from every prop's
 *  box is off them; rise (m): a stretch is told when the hips rise over this far in it (a running stride's flight rises
 *  less) and jolt (m/s): their upward speed changes by over this from one frame to the next as they leave or come down
 *  (in the five captured running jumps, 24 samples a second: 0.31 to 0.97). */
export const AIR = Object.freeze({ off: 0.03, rise: 0.1, jolt: 1 });
const OFF = AIR.off, RISE = AIR.rise;
const FOOT = [J.LeftFoot, J.RightFoot], LOW = [[0, -ANKLE_HEIGHT, 0], TIPS.LeftFoot.map((v, k) => v - REST[J.LeftFoot][k])]; // under the ankle, the toe tip

/** -> [{ who, a, b, launch: bool, frames, rise, up, along, down, at: [x, z], push, over, pushFrames, short, leave, land }]
 *  a, b: the first and last frame in the air; rise: the Hips' highest point over their height on frame a - 1 (m); up,
 *  along: their speed up and along the floor from a - 1 to a, down: from b to b + 1 (m/s); at: where they are on b + 1
 *  (down and at: null when b is the clip's last frame). A launch's up and down are the speeds on frame a - 1 and on
 *  frame b + 1 themselves; it also has the push before it, measured as the captured jumps' is (air.js PUSH): `up`
 *  squared over twice the Hips' rise `over` (m) from their lowest point in the 0.6 s on the ground before, pushFrames
 *  frames back (m/s2; null: they leave from that lowest point, or not upward), and short: the frames the engine had
 *  too few on the ground for its dip and push. Any other stretch has leave and land: the largest change of the Hips'
 *  upward speed from one frame to the next within a frame of a - 1 (and of b + 1), in m/s. */
export function airStretches(clip, aux) {
	const F = clip.frameCount, fps = clip.fps ?? 24, out = [];
	// how far point p is from a prop's box on frame f (under 0: inside it)
	const toBox = (o, p, f) => { const i = o.pos.length === 3 ? 0 : f, l = qRotate(qConj(Array.from(o.quat.slice(i * 4, i * 4 + 4))), [0, 1, 2].map(k => p[k] - o.pos[i * 3 + k])).map((v, k) => Math.abs(v) - o.size[k] / 2); return Math.hypot(...l.map(v => Math.max(v, 0))) + Math.min(0, Math.max(...l)); };
	for (const c of clip.characters) {
		const s = c.scale ?? 1, P = (f, j) => Array.from(c.pos.slice((f * JOINT_COUNT + j) * 3, (f * JOINT_COUNT + j) * 3 + 3)), Q = (f, j) => Array.from(c.quat.slice((f * JOINT_COUNT + j) * 4, (f * JOINT_COUNT + j) * 4 + 4));
		const vy = f => (f > 0 && f < F ? (P(f, J.Hips)[1] - P(f - 1, J.Hips)[1]) * fps : 0);
		const dv = f => Math.max(0, ...[f - 1, f, f + 1].filter(k => k >= 2 && k < F).map(k => Math.abs(vy(k) - vy(k - 1)))); // the largest one-frame change within a frame of f
		const one = (a, b) => {
			const h0 = P(Math.max(0, a - 1), J.Hips), h1 = P(a, J.Hips), e = b + 1 < F ? P(b + 1, J.Hips) : null, e0 = P(b, J.Hips);
			let top = -Infinity; for (let f = a; f <= b; f++) top = Math.max(top, P(f, J.Hips)[1]);
			return { who: c.id, a, b, frames: b - a + 1, rise: top - h0[1], up: (h1[1] - h0[1]) * fps, along: Math.hypot(h1[0] - h0[0], h1[2] - h0[2]) * fps, down: e && (e0[1] - e[1]) * fps, at: e && [e[0], e[2]] };
		};
		const mine = (aux.flights ?? []).filter(fl => fl.who === c.id && fl.f1 > fl.f0);
		for (const fl of mine) {
			const t = one(fl.f0, fl.f1 - 1), y = f => P(f, J.Hips)[1], g = fl.f0 - 1, e = t.b + 1;
			// a launch's speeds up and down: on the frame it leaves and the frame it comes down, from that frame and the two next to it in the air (exact on a parabola)
			if (g + 2 < F) t.up = (-3 * y(g) + 4 * y(g + 1) - y(g + 2)) * fps / 2;
			if (t.at) t.down = (3 * y(e) - 4 * y(e - 1) + y(e - 2)) * -fps / 2;
			const since = Math.max(0, g - Math.round(0.6 * fps), ...mine.filter(o => o.f1 <= g).map(o => o.f1)); // not back into the flight before it
			let low = g; for (let f = g - 1; f >= since; f--) if (y(f) < y(low)) low = f;
			const over = y(g) - y(low);
			out.push({ ...t, launch: true, push: over > 0 && t.up > 0 ? t.up * t.up / (2 * over) : null, over, pushFrames: g - low, short: fl.short });
		}
		const off = f => FOOT.every(j => LOW.every(o => { const p = P(f, j), d = qRotate(Q(f, j), o); for (let k = 0; k < 3; k++) p[k] += d[k] * s; return p[1] > OFF * s && clip.props.every(pr => toBox(pr, p, f) > OFF * s); }));
		for (let f = 1; f < F - 1; f++) {
			if (!off(f) || off(f - 1)) continue;
			let b = f; while (b + 1 < F && off(b + 1)) b++;
			if (b > f && b < F - 1 && !mine.some(fl => f <= fl.f1 && b >= fl.f0 - 1) && one(f, b).rise > RISE * s && Math.max(dv(f), dv(b + 1)) > AIR.jolt * s) out.push({ ...one(f, b), launch: false, leave: dv(f), land: dv(b + 1) }); // (beside a launch: its own take-off or landing)
			f = b;
		}
	}
	return out.sort((x, y) => x.a - y.a);
}

const n = (v, d = 2) => (Math.abs(v) < 0.5 * 10 ** -d ? 0 : v).toFixed(d), frames = k => `${k} frame${k === 1 ? "" : "s"}`;
/** The air block of the tool's text: one line per stretch; none without one. */
export function airLines(clip, aux) {
	const list = airStretches(clip, aux);
	return list.length ? ["air (what each launch, and each other stretch with both feet off the floor and every prop, came out as):", ...list.map(t => `- ${t.who} f${t.a}-${t.b} ${t.launch ? `launch: ${frames(t.frames)} in the air` : `feet off, no launch: ${frames(t.frames)}`}, hips up to ${n(t.rise)} m over the frame before; leave at ${n(t.up)} m/s up and ${n(t.along)} m/s along, ${t.at ? `come down at ${n(t.down)} m/s down over [${n(t.at[0])}, ${n(t.at[1])}]` : "in the air on the clip's last frame"}` +
		(t.launch ? (t.push == null ? "" : `; the push before it: ${n(t.push, 1)} m/s2 over ${n(t.over)} m in ${frames(t.pushFrames)}`) + (t.short ? `; ${frames(t.short)} on the ground short of the dip and push its take-off speed needs` : "")
			: `; their upward speed changes in one frame by ${n(t.leave)} m/s as they leave and by ${n(t.land)} m/s as they come down`))] : [];
}
