// The legs of a body in flight that left from a stride (air.js fly): on its last frame on the ground one foot stands
// (it pushes) and the other is off it (it swings). Then each foot follows what a person's does (air-data.js) by the
// share of the stretch it is in, sized to the leg and timed to this flight: the swinging foot from the frame it left the
// ground, its knee driving ahead by the take-off; in the air the push leg folds behind and comes forward while the lead
// foot reaches ahead and down; the lead foot comes down on the landing frame where the landing puts it, the push foot
// after it, as many frames later as the landing's give takes to its deepest. A leg moves no faster than the captured
// ones: a flight of fewer frames than theirs (and a lead foot that left the ground fewer frames before the take-off)
// has as much less of this, on top of the blend of air.js, which a body that leaves from both feet (or neither) keeps
// whole. Lengths are the rig body's.
import { ANKLE_HEIGHT, INDEX as J, OFFSET } from "../rig17.js";
import { add, clamp, mix, mixV, qMul, qRotate, qSlerp, qX, qY, smooth } from "./math.js";
import { LEG_LEN, SOLE, TOE } from "./solve.js";
import { FLIGHT, LEAD, LEAD_AIR, LEAD_BEFORE, PUSH_AIR, SECOND_DOWN } from "./air-data.js";

const LEG = LEG_LEN + ANKLE_HEIGHT, UPLEG = [J.LeftUpLeg, J.RightUpLeg];
const MOST_BEFORE = 12; // frames: a foot that left the ground longer before the take-off is taken over from 12 frames before it
/** A row of samples at even shares, at share u (linear between them). */
const at = (rows, u) => { const x = clamp(u) * (rows.length - 1), i = Math.min(rows.length - 2, Math.floor(x)); return mixV(rows[i], rows[i + 1], x - i); };

/** Which foot pushes on frame a of the body frames `out` (before the take-off moves them): the one that stands while the
 *  other does not; null when both or neither stand. */
export const pushFoot = B => (B.feet[0].planted !== B.feet[1].planted ? (B.feet[0].planted ? 0 : 1) : null);

/** The ankle and foot rotation of foot i on body frame B for the row value r = [outward, up, ahead, pitch] along fwd. */
function place(B, i, r, fwd) {
	const hip = add(B.p, qRotate(qY(B.yaw), OFFSET[UPLEG[i]])), side = i ? -1 : 1, left = [fwd[2], 0, -fwd[0]];
	const a = [0, 1, 2].map(k => hip[k] + LEG * (r[0] * side * left[k] + (k === 1 ? r[1] : 0) + r[2] * fwd[k]));
	return { a, q: qMul(qY(B.yaw), qX(r[3])) };
}
/** Foot f raised as far as its toe tip or heel is under y. */
function above(f, y) {
	const low = Math.min(...[TOE, SOLE].map(v => f.a[1] + qRotate(f.q, v)[1])), d = y - low;
	return d > 0 ? { ...f, a: [f.a[0], f.a[1] + d, f.a[2]] } : f;
}

/** The feet of a flight from frame a (the last on the ground) to b (the first again) in `out`, pushed by foot `push`
 *  (pushFoot of frame a before the take-off; null: nothing changes). fwd: the flight's way along the ground (unit,
 *  [x, 0, z]); lo: the first frame this flight may change before it (after the flight before); down: the frames the
 *  landing's give takes to its deepest; hi: the last frame it may change after it; s: the body's scale. */
export function strideLegs(out, { a, b, push, fwd, lo, down, hi, s = 1 }) {
	if (push == null) return;
	const lead = 1 - push, T = b - a, F = out.length, size = Math.sqrt(s); // a body of another size takes that many times the frames
	const few = clamp(T / (FLIGHT * size)); // a flight of fewer frames than the captured ones has as much less of their legs: a leg moves no faster than theirs
	const ground = ks => Math.min(...ks.filter(k => k >= 0 && k < F).flatMap(k => out[k].feet.map(ft => ft.a[1]))) - ANKLE_HEIGHT; // the floor under the feet there
	const yA = ground([a - 6, a - 4, a - 2, a]), yB = b < F ? ground([b, b + 2, b + 4, b + 6]) : yA;
	const set = (k, i, f) => { out[k] = { ...out[k], feet: out[k].feet.map((ft, n) => (n === i ? { ...ft, ...f, planted: false } : ft)) }; };
	// before the take-off: the lead foot from the frame it left the ground
	let l0 = a; while (l0 > lo && !out[l0].feet[lead].planted) l0--;
	l0 = Math.max(l0, a - MOST_BEFORE);
	const early = clamp((a - l0) / (LEAD * size)); // and a lead foot that left the ground fewer frames before the take-off than theirs is as much less of its way up by then
	for (let k = l0 + 1; k <= a; k++) {
		const c = (k - l0) / (a - l0), own = out[k].feet[lead], r = above(place(out[k], lead, at(LEAD_BEFORE, c), fwd), yA), w = smooth(c) * early * few;
		set(k, lead, { a: mixV(own.a, r.a, w), q: qSlerp(own.q, r.q, w) });
	}
	// in the air: the push foot from where it left, the lead foot toward where it comes down
	const A = out[a], Bf = out[Math.min(b, F - 1)], land = Bf.feet[lead], landOff = [0, 1, 2].map(k => land.a[k] - Bf.p[k]);
	const part = (own, f, w) => (w < 1 ? { a: mixV(own.a, f.a, w), q: qSlerp(own.q, f.q, w) } : f); // share w of the way from the foot the frame has (air.js: its blend) to f
	for (let k = a + 1; k < b && k < F; k++) {
		const u = (k - a) / T, y = u < 0.5 ? yA : yB, B = out[k], own = B.feet;
		const p = place(B, push, at(PUSH_AIR, u), fwd), w0 = smooth((k - a) / Math.min(3, T)), pa = A.feet[push];
		set(k, push, above(part(own[push], { a: mixV(add(B.p, [0, 1, 2].map(n => pa.a[n] - A.p[n])), p.a, w0), q: qSlerp(pa.q, p.q, w0) }, few), y));
		const l = place(B, lead, at(LEAD_AIR, u), fwd), w1 = smooth((u - 0.6) / 0.4);
		set(k, lead, above(part(own[lead], { a: mixV(l.a, add(B.p, landOff), w1), q: qSlerp(l.q, land.q, w1) }, few * mix(early, 1, smooth((k - a) / (LEAD * size)))), y));
	}
	// after the landing: the push foot comes down as many frames after the lead foot stands as the give takes to its deepest,
	// onto the foot the body frames have there
	const reaches = B => Math.hypot(...[0, 1, 2].map(n => add(B.p, qRotate(qY(B.yaw), OFFSET[UPLEG[lead]]))[n] - B.feet[lead].a[n])) <= 0.99 * LEG_LEN;
	let t = b; while (t < Math.min(hi, F - 1) && !(out[t].feet[lead].planted && reaches(out[t]))) t++; // the lead foot stands (the hips may come down to it after b)
	const g = Math.min(Math.round(few * (t - b + Math.max(1, Math.round(down)))), hi - b, F - 1 - b);
	if (!(g >= 1)) return;
	// the captured way down from where the flight left the foot, moved over the frames to end on the foot frame b + g has (standing, or the next action's)
	const last = PUSH_AIR.at(-1), d0 = SECOND_DOWN[0].map((v, n) => last[n] - v), stand = out[b + g].feet[push], e = place(out[b + g], push, SECOND_DOWN.at(-1), fwd);
	for (let k = b; k < b + g; k++) {
		const c = (k - b) / g, r = at(SECOND_DOWN, c).map((v, n) => v + d0[n] * (1 - c)), p = place(out[k], push, r, fwd), w = smooth(c);
		set(k, push, above(part(out[k].feet[push], { a: p.a.map((v, n) => v + (stand.a[n] - e.a[n]) * w), q: qSlerp(p.q, stand.q, w * w) }, few), yB));
	}
}
