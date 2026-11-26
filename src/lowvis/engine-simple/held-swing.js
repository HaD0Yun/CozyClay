// A hand held through a travel (engine.js). A hand target holds until a later key of that hand, so a body-frame target
// ([x,y,z]) keyed before a walk or a run begins would keep the hand still on the trunk through it and take the gait's
// arm out of the arm. Such a target lies where a free hand would be, or somewhere else. The gait moves a free hand
// away from where it hangs at a stand (gait.js hang): it swings, and in a run it is held bent and up. A held target
// moves as far as the free hand does on that frame: all of it on the line that a free hand hanging at a stand covers
// fore and aft as it swings at this pace (gait.js B.swingZ), none from REACH times the body's scale away from that
// line, in between in proportion. What the writer wrote for the travel stands as written: a target keyed on the
// travel's first frame or during it, any other target form, the place a hold or a carry left a hand at, a hand that
// holds a prop (or held one in this travel under this key) and, by the part of the arm an elbow target has, an arm
// with one. Only the arm moves: the reach assist goes on following the key's own point (solve.js `swing`, `led`), and
// while the gait moves a hand, or the hand goes back to its key's point after it, its reach row is not measured.
import { BODY } from "./spec-layers.js";
import { hang } from "./gait.js";
import { EASE, add, clamp, len, mul, qRotate, sub } from "./math.js";

const MOVING = new Set(["walk", "run", "push"]);
/** m (at scale 1): a held target this far or further from that line takes none of the gait's arm. */
const REACH = 0.15;

/** The spans [first frame, frame after the last) of every travel (consecutive walk, run and push actions), in order.
 *  acts: the character's actions, sorted; F: the clip's frames. */
export function travelSpans(acts, F) {
	const out = [];
	for (const [f, verb] of acts) {
		if (!BODY.has(verb)) continue;
		const m = MOVING.has(verb), open = out.at(-1)?.[1] === Infinity;
		if (m && !open) out.push([f, Infinity]);
		else if (!m && open) out.at(-1)[1] = f;
	}
	if (out.at(-1)?.[1] === Infinity) out.at(-1)[1] = F;
	return out;
}

/** Whether hand i of character c holds a prop: alone, in a carry, or as one of the hands that share one (share.js). */
const holds = (c, i, props) => Object.values(props).some(p => (p.holder === c.id && (p.hand == null || p.hand === i)) || p.grips?.some(g => g.c === c && g.i === i));
/** The part (0..1) of an arm that an elbow target has on frame f: the blend of its elbow key from the key before it. */
function elbowed(list, f) {
	const n = list.findLastIndex(q => q.f <= f), e = list[n], on = q => (q && q.to !== "rest" ? 1 : 0);
	if (!e) return 0;
	const w = e.over > 0 ? EASE[e.ease](clamp((f - e.f) / e.over)) : 1;
	return (1 - w) * on(list[n - 1]) + w * on(e);
}

/** The share of the gait's arm that hand i of character c had on the frame before f (0: none). */
export const swungBefore = (c, i, f) => { const m = c.swung?.[i]; return (m?.f === f ? m.was.free : m?.f === f - 1 ? m.free : 0) ?? 0; };

/** The world offset that hand i of character c gets on frame f from the gait's arm (null: none). k: the hand's active
 *  key, w: its blend weight. A key that begins in the travel and blends away from the place of a key that has ended
 *  goes on moving by the share the hand had on the frame before it, less as it blends (one cut into starts where the
 *  hand is, its move and all); the part of a blend that still comes from the key before moves by that key's share.
 *  On the frames after the gait lets a hand go at a pace (a travel that ends moving, an elbow key), until the hand is
 *  back on its key's point at the hands' top speed, the offset is zero and not none. */
export function heldSwing(c, i, k, w, f, B, props) {
	const span = c.travels.find(([a, b]) => f >= a && f < b), mem = (c.swung ??= [{}, {}])[i], s = c.s, rest = hang(i ? -1 : 1);
	if (mem.f !== f) Object.assign(mem, { was: mem.f === f - 1 ? { g: mem.g, free: mem.free, back: mem.back } : {}, f }); // a frame is solved twice: `was` is the frame before
	const list = c.keys[i ? "R" : "L"], before = list[list.indexOf(k) - 1], prev = k.from && before && k.f - before.f >= before.over ? before : null;
	k.swung ??= (prev && mem.was.g) || 0;
	let g = 0;
	if (span && holds(c, i, props)) k.gripped = span[0];
	if (span && B.swingZ && k.f >= span[0]) g = (1 - w) * k.swung;
	else if (span && B.swingZ && k.gripped !== span[0]) {
		const a = mul(add(rest, [0, 0, B.swingZ[0]]), s), b = mul(add(rest, [0, 0, B.swingZ[1]]), s); // the line a free hand hanging at a stand covers as it swings at this pace
		const share = q => (q && q.f < span[0] && Array.isArray(q.to) && !q.pair && !q.place && !q.auto ? clamp(1 - toSegment(q.to, a, b) / (REACH * s)) : 0);
		g = (1 - w) * share(prev) + w * share(k);
	}
	const free = g > 0 ? g * (1 - elbowed(c.keys[i ? "elbowR" : "elbowL"], f)) : 0;
	Object.assign(mem, { g, free, back: !(free > 0) && (mem.was.free > 0 || (!!mem.was.back && c.pose?.slow[i] > 0)) });
	return free > 0 ? qRotate(B.q, mul(sub(B.hands[i], mul(rest, s)), free)) : mem.back ? [0, 0, 0] : null;
}

/** The distance from point t to the segment from a to b. */
function toSegment(t, a, b) {
	const d = sub(b, a), l2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2], u = l2 > 0 ? clamp(((t[0] - a[0]) * d[0] + (t[1] - a[1]) * d[1] + (t[2] - a[2]) * d[2]) / l2) : 0;
	return len(sub(t, add(a, mul(d, u))));
}
