// The facts of one reach entry (aux.reach[characterId][frame][slot]): how far a limb is from the target its action gave
// it and what the engine knows on that frame about why: the target's distance from the joint the limb hangs from
// against the limb's length, whether the wrist was held back by its top speed, whether the wrist's own place keeps an
// elbow off its target, how far under the lowest an ankle can be a foot's target lies. engine.js and own-body.js build
// the entries; src/lowvis/pi/measure.mjs turns them into the reasons of the "reach:" rows. Nothing here knows a motion.
import { INDEX as J, OFFSET } from "../rig17.js";
import { add, dot, len, mul, norm, sub } from "./math.js";
import { ASSIST_BEND } from "./solve.js";

const L = j => len(OFFSET[j]);
const UPPER = L(J.LeftForeArm), FORE = L(J.LeftHand);
/** Per slot of a reach row (L hand, R hand, L foot, R foot, L elbow, R elbow): the joint measured, the joint the limb
 *  hangs from, the limb's length at scale 1 (the farthest the measured joint can be from that joint; an elbow is always
 *  exactly that far: `exact`), and the names the reasons use. */
export const LIMBS = [
	{ end: J.LeftHand, root: J.LeftArm, length: UPPER + FORE, part: "arm", from: "shoulder", joint: "wrist" },
	{ end: J.RightHand, root: J.RightArm, length: UPPER + FORE, part: "arm", from: "shoulder", joint: "wrist" },
	{ end: J.LeftFoot, root: J.LeftUpLeg, length: L(J.LeftLeg) + L(J.LeftFoot), part: "leg", from: "hip", joint: "ankle" },
	{ end: J.RightFoot, root: J.RightUpLeg, length: L(J.RightLeg) + L(J.RightFoot), part: "leg", from: "hip", joint: "ankle" },
	{ end: J.LeftForeArm, root: J.LeftArm, length: UPPER, part: "upper arm", from: "shoulder", joint: "elbow", exact: true },
	{ end: J.RightForeArm, root: J.RightArm, length: UPPER, part: "upper arm", from: "shoulder", joint: "elbow", exact: true },
];

/** The nearest an elbow can come to `t` with the shoulder at `sh` and the wrist at `w` (upper arm and forearm of scale s):
 *  the elbow lies on a circle about the line from the shoulder to the wrist. */
function elbowCircle(sh, w, t, s = 1) {
	const l1 = UPPER * s, l2 = FORE * s, D = Math.max(1e-6, len(sub(w, sh))), dir = norm(sub(w, sh));
	const a = (l1 * l1 - l2 * l2 + D * D) / (2 * D), h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
	const v = sub(t, sh), across = sub(v, mul(dir, dot(v, dir)));
	const p = add(add(sh, mul(dir, a)), len(across) > 1e-9 ? mul(norm(across), h) : [0, 0, 0]);
	return len(sub(t, p));
}

/**
 * One reach entry of slot `slot` for character c on its solved pose c.solved (the space the pose is solved in; all
 * points in metres). t: the target. more: { slow: the wrist was held back by its top speed on this frame, wrist: the
 * wrist's own target is set (for an elbow), floor: metres the target lies under the lowest the ankle can be }.
 * -> { key, d, t, r: the root joint, beyond: metres the target lies past the limb's length from the root (below 0:
 *      inside it), circle?: for an elbow whose wrist has a target, the nearest the elbow can come to t, bend: for an
 *      arm, the reach assist's hinge (rad), spent?: it was hinged as far as it goes, ...more }
 */
export function reachEntry(c, slot, key, t, more = {}) {
	const S = LIMBS[slot], pos = c.solved.pos, r = pos[S.root], out = { key, d: len(sub(pos[S.end], t)), t, r, beyond: len(sub(t, r)) - S.length * c.s };
	if (S.exact && more.wrist) out.circle = elbowCircle(r, pos[slot === 4 ? J.LeftHand : J.RightHand], t, c.s);
	if (S.part !== "leg" && c.solved.assist) { out.bend = c.solved.assist.bend; if (out.bend >= ASSIST_BEND - 1e-6) out.spent = true; }
	for (const [k, v] of Object.entries(more)) if (v) out[k] = v;
	return out;
}
