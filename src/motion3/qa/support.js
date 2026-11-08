// What carries a body whose soles are off the ground, from the skin model (#1125), for FLOAT (style.js airRuns): any
// skin but the feet (the trunk, the neck, the head, an arm or a leg: floor.js visitSkin) within NEAR of the ground
// under it (the floor or an object's top, ground.js), or a palm or a finger within NEAR of a scene body (one it holds or
// presses: a bar, a hold, a crate's side). A body part that near a surface is not in the air; one farther than NEAR
// from every surface is, and FLOAT judges those frames.
// Physics bench v2 (2026-11-07): the joint capsules carried the body only by the trunk within 4 cm and the hands' joints
// within 6 cm, so FLOAT stayed open where knees, shins, forearms, the head or the back lay on the floor: trip-run r1
// f61-94 (the skin 1.4-4.8 cm over the floor there, then 5.5 cm on the two frames before the feet came down), rolls r1
// f38-42 (the head on the mat), crawl r1 beside GROUND groups that said the same body was in the floor. Lying bodies
// the agents had placed by the capsules ride 3-4.4 cm over the floor on the skin (rolls r1 f49-59), so NEAR is 5 cm,
// not the 2 cm a resting skin sits at: what lies 2-5 cm over a surface is a gap, not a flight.
import { T } from "../compiler/math.js";
import { groundY } from "./ground.js";
import { visitSkin } from "./floor.js";

/** A body part within this (m) of a surface is on it, not in the air. */
export const NEAR = 0.05;
const HAND = /^(hand|fingers)_[lr]$/, HAND_JOINTS = ["LeftHand", "RightHand"], HAND_REACH = 0.25;
/** ground.js SINK: a top up to this far over a point is still the ground under it. A box whose up is within 8 deg of the world's has a flat top. */
const SINK = 0.05, UPRIGHT = 0.99;
/** No skin lies farther than this (m) below the lowest joint: 15.2 cm at most on the 30 bench v2 takes (rolls r2 f36). */
const SKIN_REACH = 0.2;

/** Signed distance from (x, y, z) to box b (geometry.js sdBox, without its arrays: the skin's points every frame); b = { box, RT } (RT: box.R transposed). */
export function boxDist({ box: { pos, half }, RT }, x, y, z) {
	const px = x - pos[0], py = y - pos[1], pz = z - pos[2];
	const d0 = Math.abs(RT[0][0] * px + RT[0][1] * py + RT[0][2] * pz) - half[0];
	const d1 = Math.abs(RT[1][0] * px + RT[1][1] * py + RT[1][2] * pz - half[1]) - half[1];
	const d2 = Math.abs(RT[2][0] * px + RT[2][1] * py + RT[2][2] * pz) - half[2];
	return Math.hypot(Math.max(d0, 0), Math.max(d1, 0), Math.max(d2, 0)) + Math.min(Math.max(d0, d1, d2), 0);
}

/** The obstacle boxes at frame index f: { box, RT (box.R transposed), c (centre), r (bounding radius), top (an upright box's top centre, else null) }. */
function boxesAt(out, f) {
	return Object.values(out.objectsAt(f)).filter(b => b.half && !b.ignore).map(box => ({ box, RT: T(box.R), r: Math.hypot(...box.half),
		c: [box.pos[0] + box.R[0][1] * box.half[1], box.pos[1] + box.R[1][1] * box.half[1], box.pos[2] + box.R[2][1] * box.half[1]],
		top: box.R[1][1] > UPRIGHT ? [0, 1, 2].map(i => box.pos[i] + 2 * box.half[1] * box.R[i][1]) : null }));
}

/** How high (m) (x, low, z) stands over box b's top when the vertical through it meets the top, else null; ground.js topOver for any other turn. */
function overTop(out, f, b, x, low, z) {
	if (b.top === null) { const g = groundY(out, f, [x, low, z]); return g > 0 ? low - g : null; }
	const { box: { pos, half }, RT } = b, px = x - pos[0], pz = z - pos[2];
	if (!(Math.abs(RT[0][0] * px + RT[0][2] * pz) <= half[0] && Math.abs(RT[2][0] * px + RT[2][2] * pz) <= half[2])) return null;
	// the top's height over (x, z): a tilted top slopes along its own up (RT[1]), so it is read at the point, not at its centre
	const n = RT[1], y = b.top[1] - (n[0] * (x - b.top[0]) + n[2] * (z - b.top[2])) / n[1];
	return low - y;
}

/** True when the skin carries the body at frame index f of out: a part within NEAR of the ground under it, or a hand on a scene body. */
export function skinCarries(out, f) {
	const sk = out.ctx.sk, s = out.frames[f].s, low = Math.min(...s.P.map(p => p[1])) - SKIN_REACH;
	// the floor first, on the heights alone (none of the skin is SKIN_REACH below the lowest joint)
	if (low < NEAR && visitSkin(sk, s, (_, x, y, z, r) => y - r < NEAR)) return true;
	const boxes = boxesAt(out, f);
	if (!boxes.length) return false;
	// a hand on a body (a bar, a hold, a crate's side), then any skin on a top: up to ground.js SINK in it is on it
	const held = boxes.filter(b => HAND_JOINTS.some(j => Math.hypot(...[0, 1, 2].map(i => s.P[sk.index[j]][i] - b.c[i])) < b.r + HAND_REACH));
	if (held.length && visitSkin(sk, s, (_, x, y, z, r) => held.some(b => boxDist(b, x, y, z) - r < NEAR), p => HAND.test(p))) return true;
	const high = Math.max(...boxes.map(b => b.c[1] + b.r)) + NEAR;
	return low < high && visitSkin(sk, s, (_, x, y, z, r) => y - r < high && boxes.some(b => { const h = overTop(out, f, b, x, y - r, z); return h !== null && h > -SINK && h < NEAR; }));
}
