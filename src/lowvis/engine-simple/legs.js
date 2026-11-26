// The two legs of a posture change (sit, stand, kneel, idle): where each foot is set down and when each leg folds.
// One leg leads and the other follows a share of the change's frames later; the side of the pelvis over the leading
// leg goes first (down when the body lowers, up when it rises), so the two knees fold apart as each foot has them.
// Defaults from captured people sitting down, standing up and squatting (63 phases, 24 samples a second): the second
// knee passes half its bend 0.14 (lowering) and 0.10 (rising) of the change's frames after the first on average (median
// 0.06 and 0.04), and the pelvis rolls 2.9 degrees more at its most over a change than over the posture held (means).
// The default is at those means or under them; with nothing written the feet stay where they are.
import { ANKLE_HEIGHT, INDEX as J, OFFSET } from "../rig17.js";
import { add, len, mixV, qRotate, qSlerp, rad, smooth, sub, clamp } from "./math.js";
import { footPose, standB } from "./gait.js";
import { LEG_LEN } from "./solve.js";

const LAG = 0.12;   // share of the change's frames the second leg follows the first by, when none is written
const LAG_MOST = 0.5;      // the most a written lag is of the change: each leg keeps half the frames for its own change
const ROLL = rad(2.9);     // pelvis roll toward the leading leg at the largest gap between the legs at LAG
// The most the pelvis rolls in a change, however far apart the legs are: the mean of the largest roll in captured
// lowerings (sit-downs and squats, 34 phases).
export const ROLL_MOST = rad(8.5);
export const STEP = 11;    // frames a foot of `feet` takes to step to its spot (a walk's short step)
const LIFT = 0.05;         // m (scale 1) the stepping foot rises
const REACH = 0.99 * LEG_LEN;  // a planted ankle this far from its hip joint is in reach (the solve lowers the hips from 0.998)
const SPLIT = 0.95 * LEG_LEN;  // standing, the most a foot is set from under its hip joint along the floor (the hips come down to it)
const UPLEG = [J.LeftUpLeg, J.RightUpLeg];

/** A leg's own progress at u (0..1) of a change in which it starts at share d and the two legs take 1 - D each. */
const share = (u, d, D) => smooth((u - d) / (1 - D));
const gapAt = D => { let m = 0; for (let k = 0; k <= 200; k++) m = Math.max(m, share(k / 200, 0, D) - share(k / 200, D, D)); return m; };
const GAP = gapAt(LAG);

/** The legs of a posture change of n frames from state st: { lead: 0 (left) | 1 (right), D: the share the other leg
 *  follows by }. o.lead "L" | "R"; o.lag: frames (0: together; at most LAG_MOST of n). Default lead: the foot further
 *  behind the hips, else the right. */
export function legTiming(o, st, n) {
	const sn = Math.sin(st.yaw), cs = Math.cos(st.yaw), along = st.feet.map(f => f.g[0] * sn + f.g[1] * cs);
	const lead = o.lead === "L" ? 0 : o.lead === "R" ? 1 : Math.abs(along[0] - along[1]) > 0.02 ? (along[0] < along[1] ? 0 : 1) : 1;
	return { lead, D: o.lag == null ? LAG : clamp(o.lag / Math.max(1, n), 0, LAG_MOST) };
}

/** Each leg's progress at u: [left, right]. */
export const legsAt = (u, t) => [0, 1].map(i => share(u, i === t.lead ? 0 : t.D, t.D));

/** The pelvis roll (rad, about its forward axis; > 0 lifts its left) at u of a change that lowers (down) or raises the body. */
export function rollAt(u, t, down) {
	const e = legsAt(u, t), gap = e[t.lead] - e[1 - t.lead];
	return (t.lead === 0 ? -1 : 1) * (down ? 1 : -1) * Math.min(ROLL_MOST, ROLL * gap / GAP);
}

const hipJoint = (B, i, p = B.p) => add(p, qRotate(B.q, OFFSET[UPLEG[i]]));
/** Metres the planted foot of body state B that is furthest out is past its leg's reach from its hip joint (0 or
 *  under: every planted foot is in reach, so the solve does not lower the hips for it). */
export const beyond = B => Math.max(...B.feet.map((f, i) => (f.planted ? len(sub(f.a, hipJoint(B, i))) - REACH : -Infinity)));

/** The state with the pelvis' ground point moved by the half steps its feet took while it sat or knelt (stepFeet):
 *  where it stands when it next stands up, walks or turns. */
export const settled = st => (st.owed ? { ...st, p: [st.p[0] + st.owed[0], st.p[1] + st.owed[1]], owed: undefined } : st);

/** feet { L?: [left, forward], R?: [...] } (metres in the body frame from where that foot stands; k: that share of
 *  each step): each named foot steps that far, the leading one first, from the posture the body is in, and stays planted
 *  there; no further than the legs reach in that posture. Standing, the pelvis goes with it half as far (it stays
 *  between the feet); seated or kneeling it stays, and goes there when the body next stands (st.owed, settled).
 *  -> { frames, st, asked: { L?, R?: the floor spot [x, z] written } } */
export function stepFeet(st, feet, lead, k = 1) {
	const frames = [], asked = {}, order = (lead === 0 ? [0, 1] : [1, 0]).filter(i => Array.isArray(feet[i ? "R" : "L"]));
	const sn = Math.sin(st.yaw), cs = Math.cos(st.yaw), standing = !st.lastB, next = { ...st, p: st.p.slice(), feet: st.feet.slice() };
	let B = st.lastB ?? standB(st);
	for (const i of order) {
		const [x, z] = feet[i ? "R" : "L"], h = st.feet[i].g, w = [x * cs + z * sn, -x * sn + z * cs], flat = v => Math.hypot(v[0], v[2]);
		asked[i ? "R" : "L"] = [h[0] + w[0], h[1] + w[1]];
		// the share t of the step at which every leg still reaches: standing, both from the pelvis moved half as far
		const fits = t => {
			const a = [h[0] + w[0] * t, ANKLE_HEIGHT, h[1] + w[1] * t];
			if (!standing) return len(sub(a, hipJoint(B, i))) <= REACH;
			const p = add(B.p, [w[0] * t / 2, 0, w[1] * t / 2]);
			return flat(sub(a, hipJoint(B, i, p))) <= SPLIT && flat(sub(B.feet[1 - i].a, hipJoint(B, 1 - i, p))) <= SPLIT;
		};
		let t = k;
		if (!fits(t)) { let lo = 0; for (let n = 0; n < 20; n++) { const m = (lo + t) / 2; if (fits(m)) lo = m; else t = m; } t = lo; }
		const g = [h[0] + w[0] * t, h[1] + w[1] * t], half = [w[0] * t / 2, 0, w[1] * t / 2];
		const from = B.feet[i], to = { ...footPose(g, 0, st.feet[i].yaw, 0), planted: true }, move = standing ? half : [0, 0, 0];
		for (let f = 1; f <= STEP; f++) {
			const u = f / STEP, e = smooth(u), a = mixV(from.a, to.a, e);
			a[1] += LIFT * Math.sin(Math.PI * u);
			const feetNow = B.feet.slice(); feetNow[i] = f === STEP ? to : { a, q: qSlerp(from.q, to.q, e), planted: false };
			frames.push({ ...B, p: add(B.p, move.map(v => v * e)), feet: feetNow });
		}
		B = frames.at(-1);
		next.feet[i] = { g, yaw: st.feet[i].yaw };
		if (standing) next.p = [next.p[0] + half[0], next.p[1] + half[2]];
		else next.owed = [(next.owed?.[0] ?? 0) + half[0], (next.owed?.[1] ?? 0) + half[2]];
	}
	if (next.lastB) next.lastB = B;
	return { frames, st: next, asked };
}
