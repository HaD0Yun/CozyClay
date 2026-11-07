// Hints for the body above the soles in the floor and the fingers in a body (#1113), { cause, hint, fix? } as the
// other hints-*.js:
//   GROUND "<part> below floor" (floor.js): fingers_<k>: the hand points them into the floor, so the wrist flex
//          (wflex_<k>, within its range) that lays them along it with the palm still out of it, else the hand up;
//          hand_<k>, farm_<k>: what drives that hand up by the depth. The sunk limb moves first (#1125), judged on the
//          compiler's solve of the worst frame with the move keyed (GAIN or more out of the floor): a thigh or a shin:
//          foot_<k> up by the depth (a leg lying along the floor); an upper arm: its hand up (the elbow rides it; a hand
//          on an anchor or a fit moves as moveHint says); the neck or the head: the nearest head_pitch that clears it.
//          The root goes up when the trunk itself (the hips, the torso, a shoulder) is under the floor, by the trunk's
//          depth, and as the last resort for a limb no move of its own lifts (a kneeling knee rides the hips). A part on
//          the floor carries the body (support.js), so a frame GROUND names is never a FLOAT frame, and the depth a hint
//          lifts leaves the part on the floor. Physics bench v2 crawl r1: "root up" for thighs, an elbow and shins while
//          FLOAT said the same body floated, both open in 34 of 45 intervals. "<Side> sole below floor" is hints-contact.js's.
//   COLLIDE "fingers_<k> x <id>" (finger-collide.js): the hand out of the body along its normal at the deepest phalanx;
//          any other COLLIDE is hints-object.js's (a carried object) and hints-contact.js's.
import { add, scale } from "../compiler/math.js";
import { wrist } from "../compiler/limbs.js";
import { solveFrame } from "../compiler/compile.js";
import { channelsAt } from "../compiler/channels.js";
import { boxNormal, fingerCapsules, sdBox, segPoints } from "./geometry.js";
import { floorDepths } from "./floor.js";
import { contactHints, moveHint } from "./hints-contact.js";
import { objectHints } from "./hints-object.js";
import { m3 } from "./fmt.js";

const MARGIN = 0.003, FLEX_MAX = 70, FLEX_STEP = 5, PITCH_MAX = 60, PITCH_STEP = 10, GAIN = 0.005;
const TRUNK = /^(hips|torso_lo|torso_hi|shoulder_[lr])$/;
const FLOOR_WORDS = "a part that lies on the floor touches it, it does not sink into it";

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
	const deep = floorDepths(X.sk, X.fr(f).s), trunk = [...deep].filter(([p]) => TRUNK.test(p)).reduce((m, e) => (e[1] > m[1] ? e : m), [null, -1]);
	if (TRUNK.test(part) || trunk[1] > g.limit) {
		// the trunk itself in the floor: the root up by the trunk's depth, and the limb for what it leaves
		const lift = TRUNK.test(part) ? g.worst : trunk[1], r = moveHint(X, "root", f, [0, lift + 0.001, 0], ` (${TRUNK.test(part) ? part : trunk[0]} ${m3(lift)} m under the floor)`);
		const rest = g.worst - lift > g.limit ? `; ${part} stays ${m3(g.worst - lift)} m in after it: then ${limbMove(part)}` : "";
		return { ...r, hint: `${r.hint}; ${FLOOR_WORDS}${rest}` };
	}
	return limbHint(X, g, part, up, why);
}

/** What lifts a limb part on its own: a leg's foot, an upper arm's hand, the head's pitch (+ looks down: the way off the floor depends on the side it lies on). */
const limbMove = part => (/^(thigh|shin)_/.test(part) ? `foot_${part.slice(-1)} up` : /^uarm_/.test(part) ? `hand_${part.slice(-1)} up`
	: "turn the head off the floor with head_pitch (+ looks down: lying on the back, + lifts the head)");

/** The deepest (m) of `parts` under the floor at absolute frame f solved with channel ch keyed `value` (the compiler's solve of that frame). */
function depthWith(X, f, ch, value, parts) {
	const deep = floorDepths(X.sk, solveFrame(X.out.ctx, { ...channelsAt(X.out.baked, f), [ch]: value }, f).s);
	return Math.max(...parts.map(p => deep.get(p) ?? -1));
}

/** GROUND on a limb above the elbow or the hands (a thigh, a shin, an upper arm, the neck, the head) with the trunk out of the floor. */
function limbHint(X, g, part, up, why) {
	const f = g.worstFrame, k = part.slice(-1), c0 = channelsAt(X.out.baked, f);
	let tried;
	if (/^(thigh|shin)_[lr]$/.test(part)) {
		const foot = c0[`foot_${k}`], d = Array.isArray(foot) ? depthWith(X, f, `foot_${k}`, add(foot, up), [`thigh_${k}`, `shin_${k}`]) : null;
		if (d !== null && d < g.worst - GAIN) { const r = moveHint(X, `shin_${k}`, f, up, why); return { ...r, hint: `${r.hint}: the knee rides the foot, the hips stay` }; }
		tried = foot ? `foot_${k} up leaves the knee in: it rides the hips there` : `the leg is FK (no foot_${k})`;
	} else if (/^uarm_[lr]$/.test(part)) {
		// an IK hand on its own target is solved with it raised; one on an anchor or a fit moves as moveHint says
		const hand = c0[`hand_${k}`], own = X.hand(k, f).ch === `hand_${k}` && Array.isArray(hand), d = own ? depthWith(X, f, `hand_${k}`, add(hand, up), [part]) : null;
		if (!own || d < g.worst - GAIN) { const r = moveHint(X, part, f, up, why); return { ...r, hint: `${r.hint}: the elbow rides the hand, the shoulders stay` }; }
		tried = `hand_${k} up leaves the elbow in: it rides the shoulder there`;
	} else {
		// the neck or the head on the floor: turned off it at the neck (head_pitch, + looks down), the smallest turn that clears it
		const now = c0.head_pitch ?? 0, turns = [];
		for (let t = PITCH_STEP; t <= PITCH_MAX; t += PITCH_STEP) turns.push(now + t, now - t);
		for (const v of turns.filter(v => Math.abs(v) <= 120)) {
			const d = depthWith(X, f, "head_pitch", v, ["head", "neck"]);
			if (d <= g.limit - MARGIN) return { cause: X.cause("head_pitch", f), hint: `head_pitch: key ${m3(v)} deg at f${f} (now ${m3(now)})${why}: the head turns off the floor, the body stays`, fix: { channel: "head_pitch", f, value: v } };
		}
		tried = `no head_pitch within ${PITCH_MAX} deg lifts it`;
	}
	const r = moveHint(X, "root", f, up, why);
	return { ...r, hint: `${r.hint} (${tried}); ${FLOOR_WORDS}` };
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
