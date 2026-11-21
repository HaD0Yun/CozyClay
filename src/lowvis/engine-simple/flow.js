// Flow between the keys of one field of the upper layer. A key's blend is a cubic from where it starts to its target
// (the inout ease is that cubic with no speed at either end). Where an inout key starts on the frame an inout key of
// the same field ends, the two pass the shared target at one speed instead of stopping on it: the speed a curve
// editor's clamped automatic tangent gives, per component, from the target before, this one and the one after (0 in a
// component that turns back there, and never more than keeps each blend from overshooting its target). A key that
// starts while the key before it still blends starts at the speed the field has. The value at every key's start and
// end frame is unchanged; only the frames between differ. What the flow adds to a hand goes to the solver apart from
// the blend (h.flow): the reach assist follows the blend without it, so the body bends and lowers as the targets ask.
import { INDEX as J } from "../rig17.js";
import { clamp, qRotate, qY, sub } from "./math.js";

/** The part of a blend at u (0..1) over T frames that the start speed m0 and the end speed m1 (per frame) add. */
export function flowAdd(m0, m1, u, T) {
	if (!m0 && !m1) return null;
	u = clamp(u);
	const a = T * (u ** 3 - 2 * u * u + u), b = T * (u ** 3 - u * u);
	const at = k => a * (m0 ? at0(m0, k) : 0) + b * (m1 ? at0(m1, k) : 0);
	return typeof (m0 ?? m1) === "number" ? at(-1) : (m0 ?? m1).map((_, k) => at(k));
}
const at0 = (m, k) => k < 0 ? m : m[k];

/** The speed per frame at b, between a blend from a to b over t0 frames and one from b to c over t1 frames (numbers or
 *  same-length arrays): the mean slope, 0 where the slopes differ in sign, at most 3 times the smaller slope. */
function passSpeed(a, b, c, t0, t1) {
	const one = (x, y, z) => {
		const d0 = (y - x) / t0, d1 = (z - y) / t1;
		if (d0 * d1 <= 0) return 0;
		const m = (t1 * d0 + t0 * d1) / (t0 + t1);
		return Math.sign(m) * Math.min(Math.abs(m), 3 * Math.abs(d0), 3 * Math.abs(d1));
	};
	return typeof b === "number" ? one(a, b, c) : b.map((v, k) => one(a[k], v, c[k]));
}

/** Whether key b of a field flows on from key a (the key before it): both inout, a over frames that end where b starts. */
const flows = (a, b) => !!a && !!b && a.ease === "inout" && b.ease === "inout" && a.over > 0 && b.over > 0 && b.f === a.f + a.over;
/** A start speed m kept only in the coordinates where it goes toward the target (from a to b over T frames), at most
 *  3 times the blend's own mean slope there, so the blend does not pass its target. */
const toward = (m, a, b, T) => { const one = (v, x, y) => v * (y - x) > 0 ? Math.sign(v) * Math.min(Math.abs(v), 3 * Math.abs(y - x) / T) : 0; return typeof m === "number" ? one(m, a, b) : m.map((v, k) => one(v, a[k], b[k])); };
const minus = (a, b) => typeof a === "number" ? a - b : a.map((v, k) => v - b[k]);
const plus = (a, b) => typeof a === "number" ? a + b : a.map((v, k) => v + b[k]);

/** The start of key k of a scalar field (list: its keys in order) at frame f: k.from, and its start and end speeds
 *  k.m0, k.m1. last, before: the field's value on the frame before and the one before that (undefined: never set). */
export function startScalar(list, k, f, last, before, zero) {
	const i = list.indexOf(k), prev = list[i - 1], next = list[i + 1], done = prev && f - prev.f >= prev.over;
	k.from = done ? prev.to : last ?? zero;
	if (done && flows(prev, k)) k.m0 = prev.m1;
	else if (prev && !done && k.ease === "inout" && k.over > 0 && last !== undefined && before !== undefined) { k.from = plus(last, minus(last, before)); k.m0 = toward(minus(last, before), k.from, k.to, k.over); } // cut into: on at its speed
	if (flows(k, next)) k.m1 = passSpeed(k.from, k.to, next.to, k.over, next.over);
}

/** A speed m (per frame, an array) made no longer than most. */
const atMost = (m, most) => { const l = Math.hypot(...m); return l > Math.max(0, most) ? m.map(v => v * Math.max(0, most) / l) : m; };
/** The longest a speed at one end of a blend from x to y over T frames may be for no step of the blend to pass cap:
 *  what the blend's own fastest step (1.5 times its mean, the inout ease) leaves of it. A blend that is at the cap by
 *  itself gets none: it needs its slow end to arrive on its frame. */
const room = (cap, x, y, T) => cap - 1.5 * Math.hypot(...minus(y, x)) / T;

/** The speeds of hand key k (list: that hand's keys) as it starts, in the body frame: k.m0 from the key before (prev:
 *  that key when it has ended, null when it is cut into) or from vel (the hand's own move on the frame before), k.m1
 *  toward the next key. cap: the most a hand moves in a frame unless its key says fast; a speed stays within what
 *  keeps the steps of the two blends that share the target under it, so the hand is on that target on its frame. k.from is
 *  where it starts (null: the rest pose, left with no speed; here is where the hand is then); at(key) is a key's
 *  target in the body frame on this frame. */
export function startHand(list, k, prev, vel, cap, at, here) {
	const i = list.indexOf(k), next = list[i + 1], pinned = q => !q || q.pair || q.to === "keep" || q.to === "rest";
	if (pinned(k) || !(k.from ?? here)) return;
	if (k.from && prev && flows(prev, k)) k.m0 = prev.m1;
	const b = at(k);
	if (k.from && !prev && i > 0 && vel && k.ease === "inout" && k.over > 0 && b) { const m = k.fast ? vel : atMost(vel, cap); k.from = plus(k.from, m); k.m0 = toward(m, k.from, b, k.over); }
	const c = !pinned(next) && flows(k, next) ? at(next) : null, a = k.from ?? here;
	if (b && c) k.m1 = atMost(passSpeed(a, b, c, k.over, next.over), next.fast ? Infinity : Math.min(room(cap, a, b, k.over), room(cap, b, c, next.over)));
}

/** After a frame of character c (c.pose: its solved pose, c.prevB: its body state): where its hands are in its body
 *  frame (c.handAt) and how far they moved since the frame before (c.handVel, null on the first frame). */
export function handsMoved(c) {
	const at = [J.LeftHand, J.RightHand].map(j => qRotate(qY(-c.prevB.yaw), sub(c.pose.pos[j], c.prevB.p)));
	c.handVel = c.handAt ? at.map((p, i) => sub(p, c.handAt[i])) : null;
	c.handAt = at;
}
