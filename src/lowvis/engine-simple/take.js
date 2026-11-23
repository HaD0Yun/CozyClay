// The frame a hand takes hold of a prop (a hold, spec-layers.js holdKeys), and a prop in one hand alone (engine.js).
//  - On the hold's own frame each named hand gets its place on the prop: `at`, else the point of the prop nearest the
//    hand where it is then, a wrist's pad off its surface. With over 0 (a hold's default), or when every named hand is
//    within a wrist's pad of its place, the hands take hold on that frame (a hand with no `at` stays where it is);
//    else they go to their places over `over` frames and take hold when that ends. Either way the prop is not moved to the hand: a hand still off its place pulls it there.
//  - A prop in one hand alone is fixed in that hand as it lies on the first frame the hand has it.
import { INDEX as J } from "../rig17.js";
import { add, clamp, len, mul, qConj, qMul, qRotate, sub } from "./math.js";
import { PAD } from "./prop-frame.js";
import { solveSized } from "./size.js";
import { ARM_LEN } from "./solve.js";

const HAND = [J.LeftHand, J.RightHand], ARM = [J.LeftArm, J.RightArm];
/** A point l in prop p's own frame brought to within pad of its box: the nearest point at most pad off its surface. */
const onBox = (p, l, pad) => {
	const q = l.map((v, n) => clamp(v, -p.size[n] / 2, p.size[n] / 2)), d = len(sub(l, q));
	return d > pad ? add(q, mul(sub(l, q), pad / d)) : l;
};

/** A hold event e of character c on its own frame f (e.wait, from holdKeys): settles each hand's place and when the
 *  hands take hold. Returns true when they take hold on frame f; else the event moves to the frame its `over` ends.
 *  The hand is where c ended the frame before (frame 0: at rest), the prop where it is at the start of frame f. */
export function settleHold(e, c, f, p) {
	const { over, hands } = e.wait, pose = c.world ?? solveSized(c.body[f], {}, c.s), pad = PAD * c.s;
	let off = 0;
	for (const h of hands) {
		const hand = qRotate(qConj(p.q), sub(pose.pos[HAND[h.i]], p.c));
		h.near = h.place.at === undefined;
		h.place.at ??= onBox(p, hand, pad);
		off = Math.max(off, len(sub(hand, h.place.at)));
	}
	delete e.wait;
	if (over > 0 && off > pad) { e.f = f + over; return false; }
	for (const h of hands) { // take hold now: no blend, the keep key from this frame (no at: where the hand is)
		if (h.blend) h.list.splice(h.list.indexOf(h.blend), 1);
		h.keep.f = f;
		if (h.near) delete h.keep.place;
		h.list.sort((a, b) => a.f - b.f || (a.auto ? 0 : 1) - (b.auto ? 0 : 1));
	}
	e.f = f;
	return true;
}

/** Prop p held in one hand alone (p.hand) by character c, after c's pose of this pass on frame f: fixed in the hand as
 *  it lay there on the first pass that has it (p.gq: its turn in the hand, p.grip: its centre from the wrist in the
 *  hand's frame), the wrist on its box grown by a wrist's pad. A wrist off that box pulls the prop to it on that frame:
 *  the hand's took (how far) and tookWhy, as share.js gives them a hand that takes hold of a shared prop. */
export function inHand(p, c, f) {
	const pose = c.poseNow, i = p.hand, hp = pose.pos[HAND[i]], hq = pose.quat[HAND[i]];
	if (!p.gq) {
		const l = qRotate(qConj(p.q), sub(hp, p.c)), g = onBox(p, l, PAD * c.s);
		p.gq = qMul(qConj(hq), p.q); p.grip = qRotate(p.gq, mul(g, -1));
		const beyond = len(sub(add(p.c, qRotate(p.q, g)), pose.pos[ARM[i]])) - ARM_LEN * c.s;
		p.took = { f, d: len(sub(l, g)), why: { slow: c.solved.slow[i], beyond, near: true } };
	}
	if (p.took.f === f) Object.assign(c.U.hands[i], { took: p.took.d, tookWhy: p.took.why, prop: p.id });
	p.q = qMul(hq, p.gq); p.c = add(hp, qRotate(hq, p.grip));
}
