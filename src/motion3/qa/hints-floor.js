// Hints for the body above the soles in the floor and the fingers in a body (#1113), { cause, hint, fix? } as the
// other hints-*.js:
//   GROUND "<part> below floor" (floor.js): fingers_<k>: the hand points them into the floor, so the wrist flex
//          (wflex_<k>, within its range) that lays them along it with the palm still out of it, else the hand up;
//          hand_<k>, farm_<k>: what drives that hand up by the depth. The sunk limb moves first (#1125), each move judged
//          on the compiler's solve of the worst frame with it keyed (bestMove: of those that clear it the one that moves the
//          body least, else the one that leaves least once it gains GAIN; none that sinks another part or bends a knee
//          backward): a thigh or a shin: foot_<k> up by the depth (a leg lying along the floor), knee_<k> turned up,
//          foot_<k> away from the hip (a kneeling knee opens); an upper arm: its hand up (a hand on an anchor or a fit moves
//          as moveHint says), elbow_<k> turned up; the neck or the head: head_pitch. A pole the agent's keys hold turns on
//          that hold. The root goes up only when the trunk itself (the hips, the torso, a shoulder) is under the floor, by
//          the trunk's depth: a limb no move of its own lifts gets no fix, the root staying. A part on the floor carries the
//          body (support.js), so a frame GROUND names is never a FLOAT frame, and the depth a hint lifts leaves the part on
//          the floor. Physics bench v2 crawl r1: "root up" for thighs, an elbow and shins while FLOAT said the same body
//          floated, both open in 34 of 45 intervals; a root lift for an upper arm (its hand up leaving the elbow in) took a
//          prone trunk lying 0.8 cm over the floor 2-4 cm off it. "<Side> sole below floor" is hints-contact.js's.
//   COLLIDE "fingers_<k> x <id>" (finger-collide.js): the hand out of the body along its normal at the deepest phalanx;
//          any other COLLIDE is hints-object.js's (a carried object) and hints-contact.js's.
import { add, angle, apply, dist, dot, len, norm, ry, scale, sub, T } from "../compiler/math.js";
import { wrist } from "../compiler/limbs.js";
import { solveFrame } from "../compiler/compile.js";
import { channelsAt } from "../compiler/channels.js";
import { tiltFrame } from "../compiler/pose.js";
import { boxNormal, fingerCapsules, sdBox, segPoints } from "./geometry.js";
import { floorDepths } from "./floor.js";
import { contactHints, moveHint } from "./hints-contact.js";
import { objectHints } from "./hints-object.js";
import { m3, vec } from "./fmt.js";

const MARGIN = 0.003, FLEX_MAX = 70, FLEX_STEP = 5, PITCH_MAX = 60, PITCH_STEP = 10, GAIN = 0.005;
/**
 * A pole turned toward world up: these shares of its length added (6-48 deg); a foot moved away from its hip: these (m).
 * Bench v2 crawl r1 and trip-run r1 (the 17 limbs a root lift was offered for): the elbow 15-29 deg up clears a prone
 * upper arm 1.5-3.1 cm in, the knee 7-30 deg up a kneeling knee 1-1.8 cm in, the foot 2 cm back trip-run's f57 knee
 * (its pole first flips past 41 deg); the turns past 48 deg sank the fingers or the forearm.
 */
const POLE_UP = [0.15, 0.3, 0.5, 0.75], AWAY = [0.02, 0.04, 0.06, 0.1];
/** pose.js's rest poles (a pole not keyed): the knee forward, the elbow down and back, in the body frame. */
const KNEE_REST = [0, 0, 1], ELBOW_REST = [0, -1, -0.3], SIDE_NAMES = ["Left", "Right"];
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
	return limbHint(X, g, part, up, why, trunk);
}

/** What lifts a limb part on its own: a leg's foot or knee, an upper arm's hand or elbow, the head's pitch (+ looks down: the way off the floor depends on the side it lies on). */
const limbMove = part => (/^(thigh|shin)_/.test(part) ? `foot_${part.slice(-1)} up or knee_${part.slice(-1)} turned up` : /^uarm_/.test(part) ? `hand_${part.slice(-1)} up or elbow_${part.slice(-1)} turned up`
	: "turn the head off the floor with head_pitch (+ looks down: lying on the back, + lifts the head)");

/** checks.js KNEE "bends backward" at state s on side S: the knee off the hip-ankle line against the toes (across the shin once the pelvis tilts past 60 deg). */
function kneeBack(sk, s, S) {
	const I = sk.index, th = s.P[I[`${S}UpLeg`]], kn = s.P[I[`${S}Leg`]], an = s.P[I[`${S}Foot`]];
	let toe = sub(s.P[I[`${S}ToeBase`]], an);
	if (norm(sub(s.P[I.Spine], s.P[I.Hips]))[1] < 0.5) { const shin = norm(sub(an, kn)); toe = sub(toe, scale(shin, dot(toe, shin))); } else toe[1] = 0;
	return angle(sub(kn, th), sub(an, kn)) > 3 && dot(sub(kn, scale(add(th, an), 0.5)), toe) < -0.002;
}

/** World up in the frame pose.js reads the knee and elbow poles in (the root's yaw, with its pitch and roll once the body tilts: tiltFrame). */
function poleUp(c) {
	const n = v => (Number.isFinite(v) ? v : 0);
	return apply(T(tiltFrame(n(c.yaw), n(c.pitch), n(c.roll))?.R ?? ry(n(c.yaw))), [0, 1, 0]);
}

/**
 * The move that takes `part` out of the floor at the worst frame, judged on the compiler's solve of that frame with each
 * of `moves` keyed: { ...move, d } with d the part's depth left (the deepest of `parts`). Of those that clear it (MARGIN
 * under the allowance) the one that moves the body least (its farthest joint), else the one that leaves the least once it
 * gains GAIN; never one that sinks another part past the allowance deeper than it was or bends a knee backward
 * (checks.js KNEE) that did not. null when none gains GAIN.
 */
function bestMove(X, g, parts, moves) {
	const f = g.worstFrame, c0 = channelsAt(X.out.baked, f), solve = set => solveFrame(X.out.ctx, { ...c0, ...set }, f).s, s0 = solve({}), d0 = floorDepths(X.sk, s0);
	const back0 = SIDE_NAMES.map(S => kneeBack(X.sk, s0, S));
	let best = null;
	for (const move of moves) {
		const s = solve(move.set), d1 = floorDepths(X.sk, s), d = Math.max(...parts.map(p => d1.get(p) ?? -1));
		if (!(d < g.worst - GAIN) || [...d1].some(([p, v]) => !parts.includes(p) && v > Math.max(d0.get(p) ?? -1, g.limit) + MARGIN)) continue;
		if (SIDE_NAMES.some((S, i) => !back0[i] && kneeBack(X.sk, s, S))) continue;
		const clear = d <= g.limit - MARGIN, cost = Math.max(...s.P.map((p, j) => dist(p, s0.P[j])));
		if (!best || (clear && (!best.clear || cost < best.cost)) || (!clear && !best.clear && d < best.d)) best = { ...move, d, clear, cost };
	}
	return best;
}

/** The pole channel ch (rest: its value unkeyed) turned toward world up by the POLE_UP steps: moves for bestMove, each with its turn (deg). */
function poleTurns(c0, ch, rest) {
	const p = Array.isArray(c0[ch]) ? c0[ch] : rest, up = scale(poleUp(c0), len(p));
	return POLE_UP.map(t => { const v = add(p, scale(up, t)).map(x => Math.round(x * 100) / 100); return { ch, set: { [ch]: v }, now: p, value: v, turn: Math.round(angle(v, p)), keyed: Array.isArray(c0[ch]) }; });
}

/** The keys that hold channel ch at one value through frame f, one on each side of it: { first, last, at (the one before f) }, else null. */
function holdAt(X, ch, f) {
	const keys = (X.out.keys ?? []).filter(k => Array.isArray(k.set?.[ch])).sort((a, b) => a.f - b.f), i = keys.findLastIndex(k => k.f <= f);
	const same = k => k.set[ch].every((v, j) => Math.abs(v - keys[i].set[ch][j]) <= 1e-6);
	if (i < 0 || i + 1 >= keys.length || !same(keys[i + 1])) return null;
	let a = i, b = i + 1;
	while (a > 0 && same(keys[a - 1])) a--;
	while (b + 1 < keys.length && same(keys[b + 1])) b++;
	return { first: keys[a], last: keys[b], at: keys[i] };
}

/**
 * A pole move's hint: key the turned pole at f. A pole the agent's keys hold through f turns on those keys (the fix sits
 * on the agent's key before f, so patch.js moves the hold whole): a key added at f alone bent the elbow back and forth
 * between the hold's keys, and the next stroke of a crawl sank the same (bench v2 crawl r1, the elbows held f68-351).
 */
function poleHint(X, f, m, joint, stays, why) {
	const hold = m.keyed ? holdAt(X, m.ch, f) : null, on = hold && /^keys\[\d+\]$/.test(hold.at.src ?? "") ? Math.round(hold.at.f) : f;
	const held = hold ? `, held f${Math.round(hold.first.f)}-${Math.round(hold.last.f)}${on !== f ? ": turn that hold" : ""}` : "";
	return { cause: X.cause(m.ch, f), hint: `${m.ch}: key ${vec(m.value)} at f${f} (now ${vec(m.now)}${held})${why}: the ${joint} turns ${m.turn} deg up off the floor, the ${stays} stay`,
		fix: m.keyed ? { channel: m.ch, f: on, delta: sub(m.value, m.now) } : { channel: m.ch, f, value: m.value } };
}

/**
 * GROUND on a limb above the elbow or the hands (a thigh, a shin, an upper arm, the neck, the head) with the trunk out of
 * the floor (trunk: its deepest part, [part, depth]): that limb's own moves only, never the root (#1125: a root lift took
 * a trunk lying on the floor 2-4 cm off it). A leg: its foot up, its knee turned up, its foot away from the hip (the knee
 * opens); an upper arm: its hand up, its elbow turned up; the neck or the head: its pitch. None that takes it out: no fix.
 */
function limbHint(X, g, part, up, why, trunk) {
	const f = g.worstFrame, k = part.slice(-1), c0 = channelsAt(X.out.baked, f), left = m => (m.d > g.limit ? `; it leaves ${m3(m.d)} m in` : "");
	let tried, ch;
	if (/^(thigh|shin)_[lr]$/.test(part)) {
		const foot = c0[`foot_${k}`];
		ch = `foot_${k}`;
		if (!Array.isArray(foot)) tried = `the leg has no foot_${k} target to move`;
		else {
			const hip = X.fr(f).s.P[X.I[`${k === "l" ? "Left" : "Right"}UpLeg`]], away = norm([foot[0] - hip[0], 0, foot[2] - hip[2]]);
			const turns = poleTurns(c0, `knee_${k}`, KNEE_REST), m = bestMove(X, g, [`thigh_${k}`, `shin_${k}`], [{ ch: "up", set: { [`foot_${k}`]: add(foot, up) } }, ...turns,
				...AWAY.map(s => ({ ch: "away", delta: scale(away, s), set: { [`foot_${k}`]: add(foot, scale(away, s)) } }))]);
			if (m?.ch === "up" || m?.ch === "away") {
				const r = moveHint(X, `shin_${k}`, f, m.ch === "up" ? up : m.delta, why);
				return { ...r, hint: `${r.hint}: the knee ${m.ch === "up" ? "rides the foot" : "opens off the floor"}, the hips stay${left(m)}` };
			}
			if (m) { const r = poleHint(X, f, m, "knee", "hips", why); return { ...r, hint: r.hint + left(m) }; }
			tried = `foot_${k} up, knee_${k} turned up to ${turns.at(-1).turn} deg, foot_${k} up to ${AWAY.at(-1)} m away from the hip`;
		}
	} else if (/^uarm_[lr]$/.test(part)) {
		// an IK hand on its own target is solved with it raised; one on an anchor or a fit moves as moveHint says
		const hand = c0[`hand_${k}`];
		if (X.hand(k, f).ch !== `hand_${k}` || !Array.isArray(hand)) { const r = moveHint(X, part, f, up, why); return { ...r, hint: `${r.hint}: the elbow rides the hand, the shoulders stay` }; }
		const turns = poleTurns(c0, `elbow_${k}`, ELBOW_REST), m = bestMove(X, g, [part], [{ ch: "up", set: { [`hand_${k}`]: add(hand, up) } }, ...turns]);
		if (m?.ch === "up") { const r = moveHint(X, part, f, up, why); return { ...r, hint: `${r.hint}: the elbow rides the hand, the shoulders stay${left(m)}` }; }
		if (m) { const r = poleHint(X, f, m, "elbow", "shoulders", why); return { ...r, hint: r.hint + left(m) }; }
		ch = `elbow_${k}`;
		tried = `hand_${k} up, elbow_${k} turned up to ${turns.at(-1).turn} deg`;
	} else {
		// the neck or the head on the floor: turned off it at the neck (head_pitch, + looks down), the turn that clears it
		const now = c0.head_pitch ?? 0, turns = [];
		for (let t = PITCH_STEP; t <= PITCH_MAX; t += PITCH_STEP) turns.push(now + t, now - t);
		const m = bestMove(X, g, ["head", "neck"], turns.filter(v => Math.abs(v) <= 120).map(v => ({ set: { head_pitch: v }, value: v })));
		if (m) return { cause: X.cause("head_pitch", f), hint: `head_pitch: key ${m3(m.value)} deg at f${f} (now ${m3(now)})${why}: the head turns off the floor, the body stays${left(m)}`, fix: { channel: "head_pitch", f, value: m.value } };
		ch = "head_pitch";
		tried = `head_pitch within ${PITCH_MAX} deg`;
	}
	// nothing of the limb's own takes it out: the trunk is out of the floor, so the root stays and there is no fix
	const over = trunk[0] ? `, ${trunk[0]} ${m3(-trunk[1])} m over it` : "";
	return { cause: X.cause(ch, f), hint: `${part}: ${m3(g.worst)} m under the floor at f${f} and no move of its own takes it out (${tried}); the trunk is out of the floor${over}, so the root stays: re-pose that limb at f${f}; ${FLOOR_WORDS}` };
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
