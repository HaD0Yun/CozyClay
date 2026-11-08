// COLLIDE for the fingers (#1113): the phalanx capsules (geometry.js fingerCapsules) against the scene bodies, as
// "fingers_<k> x <id>". The hand capsule ends at HandMiddle3, so a fingertip in a box went unreported. The fingers are
// the hand's: a spec's allow entry for the hand ({ part: "hand", object }: reachGrip's on what it grips) lets them touch
// as deep, and one for "fingers" sets theirs alone. Fingers on a body's top are on the ground there, as a sole on it
// (foot-checks.js): through the top face they may sit QA_LIMITS.groundAllow in it, the floor's allowance (floor.js);
// through a side face the usual allowance holds.
import { dist, dot } from "../compiler/math.js";
import { boxNormal, fingerCapsules, sdBox, segPoints } from "./geometry.js";

const TOP = 0.7;

/**
 * Push COLLIDE "fingers_<k> x <id>" for each hand in each body at frame f. spheres: [id, box, centre, radius] of the
 * bodies (checks.js); allowed(part, id) the spec's allow depth or null; L.allow and L.groundAllow the defaults.
 */
export function fingerCollide(sk, s, f, spheres, L, allowed, push) {
	for (const side of ["Left", "Right"]) {
		const caps = fingerCapsules(sk, s, side);
		if (!caps.length) continue;
		const k = side === "Left" ? "l" : "r", part = `fingers_${k}`, wrist = s.P[sk.index[`${side}Hand`]];
		const reach = Math.max(...caps.map(([, , b, r]) => dist(wrist, b) + r));
		for (const [id, box, c, rb] of spheres) {
			if (dist(wrist, c) - rb > reach) continue;
			const own = allowed(part, id) ?? allowed(`hand_${k}`, id);
			let excess = -Infinity, worst = 0, limit = 0;
			for (const [, a, b, r] of caps) for (const p of segPoints(a, b, 4)) {
				const depth = r - sdBox(p, box);
				if (depth <= 0) continue;
				const lim = own ?? (dot(boxNormal(p, box), [0, 1, 0]) > TOP ? L.groundAllow : L.allow);
				if (depth - lim > excess) { excess = depth - lim; worst = depth; limit = lim; }
			}
			if (excess > 0) push("COLLIDE", `${part} x ${id}`, f, worst, limit);
		}
	}
}
