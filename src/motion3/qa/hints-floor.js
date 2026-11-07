// Hints for the body above the soles in the floor and the fingers in a body (#1113), { cause, hint, fix? } as the
// other hints-*.js:
//   GROUND "<part> below floor" (floor.js): fingers_<k>: the hand points them into the floor, so the wrist flex
//          (wflex_<k>, within its range) that lays them along it with the palm still out of it, else the hand up;
//          hand_<k>, farm_<k>: what drives that hand up by the depth; the legs, the trunk, the head and an upper arm:
//          the root up by the depth (a knee or an elbow on the floor rides the hips). "<Side> sole below floor" is
//          hints-contact.js's.
//   COLLIDE "fingers_<k> x <id>" (finger-collide.js): the hand out of the body along its normal at the deepest phalanx;
//          any other COLLIDE is hints-object.js's (a carried object) and hints-contact.js's.
import { scale } from "../compiler/math.js";
import { wrist } from "../compiler/limbs.js";
import { boxNormal, fingerCapsules, sdBox, segPoints } from "./geometry.js";
import { floorDepths } from "./floor.js";
import { contactHints, moveHint } from "./hints-contact.js";
import { objectHints } from "./hints-object.js";
import { m3 } from "./fmt.js";

const MARGIN = 0.003, FLEX_MAX = 70, FLEX_STEP = 5;

/**
 * The wflex_<k> value (deg, within its range) for hand k at f: the nearest to the frame's that keeps the fingers and the
 * palm within `limit` of the floor, else the one that leaves them least deep. { now, value, depth } or null when no turn
 * gains a centimetre (a hand whose wrist turns no further, or fingers that point down across it).
 */
function bestFlex(X, k, f, limit, worst) {
	const S = k === "l" ? "Left" : "Right", { s, c } = X.fr(f), now = c[`wflex_${k}`] ?? 0;
	let best = null;
	for (let v = -FLEX_MAX; v <= FLEX_MAX; v += FLEX_STEP) {
		const t = { P: s.P.map(p => p.slice()), R: s.R.map(r => r.map(row => row.slice())) };
		wrist(X.sk, t, S, 0, v - now);
		const deep = floorDepths(X.sk, t), depth = Math.max(deep.get(`fingers_${k}`) ?? -1, deep.get(`hand_${k}`) ?? -1), clear = depth <= limit - MARGIN;
		const better = !best || (clear && (!best.clear || Math.abs(v - now) < Math.abs(best.value - now))) || (!best.clear && !clear && depth < best.depth);
		if (better) best = { now, value: v, depth, clear };
	}
	return best && (best.clear || best.depth < worst - 0.01) ? best : null;
}

function groundHint(X, g, part) {
	const f = g.worstFrame, up = [0, g.worst + 0.001, 0], arm = /^(fingers|hand|farm)_([lr])$/.exec(part), why = ` (${part} ${m3(g.worst)} m under the floor)`;
	if (arm?.[1] === "fingers") {
		const k = arm[2], flex = bestFlex(X, k, f, g.limit, g.worst);
		if (flex) {
			const rest = flex.clear ? "they lie along it with the palm on it" : `${m3(flex.depth)} m are left: raise the hand that much too (${moveHint(X, `hand_${k}`, f, [0, flex.depth + 0.001, 0]).hint})`;
			return { cause: X.cause(`wflex_${k}`, f), hint: `wflex_${k}: key ${flex.value} deg at f${f} (now ${m3(flex.now)}): the hand points the fingers ${m3(g.worst)} m into the floor; turned so, ${rest}`,
				fix: { channel: `wflex_${k}`, f, value: flex.value } };
		}
		const r = moveHint(X, `hand_${k}`, f, up, why);
		return { ...r, hint: `${r.hint}; or turn the hand so the fingers lie along the floor (wflex_${k}, wtwist_${k}) or curl them (a fingers_${k} preset)` };
	}
	if (arm) return moveHint(X, `hand_${arm[2]}`, f, up, why);
	// a knee, a hip, the back, an elbow or the head on the floor: the body is too low there
	const r = moveHint(X, "root", f, up, why);
	return { ...r, hint: `${r.hint}; a part that lies on the floor touches it, it does not sink into it` };
}

function fingersHint(X, g, k, id) {
	const f = g.worstFrame, box = X.out?.objectsAt(X.rel(f))[id];
	if (!box) return null;
	let deepest = null;
	for (const [, a, b, r] of fingerCapsules(X.sk, X.fr(f).s, k === "l" ? "Left" : "Right")) for (const p of segPoints(a, b, 4)) {
		const d = r - sdBox(p, box);
		if (!deepest || d > deepest.d) deepest = { d, p };
	}
	if (!deepest) return null;
	const r = moveHint(X, `hand_${k}`, f, scale(boxNormal(deepest.p, box), g.worst - g.limit + MARGIN), ` (the fingers out of ${id})`);
	// fix.penetration pushes the hand and forearm capsules only: a hand pushed back for its fingertips lifted planted palms off the
	// crate and the holds they pressed (bench push-crate and wall-climb takes, which set it), so it is not offered here
	r.hint += `; or a fingers_${k} preset that keeps them on its face (flat on a face, grip round a bar)`;
	return r;
}

export const floorHints = {
	GROUND(X, g) {
		const part = /^(\S+) below floor$/.exec(g.subject)?.[1];
		return part ? groundHint(X, g, part) : contactHints.GROUND(X, g);
	},
	COLLIDE(X, g) {
		const [, k, id] = /^fingers_([lr]) x (.+)$/.exec(g.subject) ?? [];
		return k ? fingersHint(X, g, k, id) : objectHints.COLLIDE(X, g);
	},
};
