// Which QA groups block a take and which are warnings (#1114). A motion is done at the first take with 0 blocking
// problems, every visible criterion met and one look at its contact sheet; warnings go in the report, in one line.
// Blocking is what a viewer sees at 960x540 (a wide shot draws about 1-2 cm a pixel) or what breaks the request:
//   always     GOAL KEY CONTACT LOAD TELEPORT FLIP, and GRAB CATCH (a hand off what it picks up or catches: a contact)
//   REACH      an arm or leg short of a contact or an anchor by more than REACH_GAP: the cause names an anchor, or the
//              limb end ends within the miss + NEAR of a surface (its target may lie on it); a target in the air is a
//              warning (the arm points there at full reach), and so is an object off its keys (the hand still holds it)
//   FLOAT      only when no body part is within NEAR of the floor or a scene body on half the frames of one of its runs:
//              a crawl, a roll, a hang or a body lying on a roof rests on something; a jump that hangs in the air does not
//   GROUND     the trunk, legs or head under the floor deeper than DEEP (palms, fingers and arms are warnings)
//   COLLIDE BODY SELF FACE PERSON OBJECT   deeper than DEEP; fingers, thumbs and palms (hand_<k>) in a body are warnings
//   POP        above POP_HARD m/frame^2
// Every other kind (SLIDE, PALM_GAP, PALM_OFF, WRIST, KNEE, ELBOW, FINGER_*, THUMB_OFF, TIPS_OFF, unknown ones) warns.
// A size that cannot be read (no worst, no take to measure FLOAT or REACH on) blocks: unseen is not clean.
// Stricter than #1114's list, on purpose: GRAB and CATCH block as CONTACT does (QA raises them only past 3 cm, REACH_GAP: the
// object jumps into the hand), FACE (a hand into the head), PERSON (a limb through another character) and OBJECT (a carried
// object through a scene body) past DEEP as BODY and COLLIDE do. Of these only FACE occurs on v2 (7 sizes, med 0.8 cm, one
// past 5 cm), so none of them moves a replay stop.
// Thresholds, from the 2026-11-07 physics bench (30 v2 runs, every compile answer that gave a size, deduped per take):
//   DEEP 5 cm   COLLIDE thigh med 1.9 cm, p90 18.7; shin med 3.5, p75 16.7: grazes under 4 cm, a gap, then limbs through
//               a box. GROUND shin and thigh med 5.3 cm (p25 1.5-2.3). BODY upper arm into the torso med 2.9 cm, p90 5.1:
//               an arm at the side. 5 cm is 3-5 px, the least a sinking shin or an arm in the body shows.
//   POP 0.25    limits are 0.05 (limbs) and 0.015 (core); forearm, hand and foot pops med 8.7-11.1 cm/f^2 with 9-16 % past
//               25, the legs' med 27.8 (knee snaps, 55 % past): a one-frame change of 6 m/s reads as a snap, 2-3 m/s does not.
//   REACH 3 cm  arm misses med 13.4 cm (96 % past 3), leg misses med 6.1 (83 %): under 3 cm (2-3 px) is the IK at full
//               extension; goals call 4 cm "on" (needs <= 0.04).
//   NEAR 5 cm   DEEP's 3-5 px the other way: a part this close to a surface reads as on it (FLOAT itself reads only the soles,
//               the wrists and the trunk). All 1,147 v2 session compiles replayed, 582 float runs in 264 takes (21 bench runs),
//               each run's median nearest skin gap: <= 0 in 70 % (a crawl, a hang, a lying body), <= 5 cm in 89 %. Past 5 cm
//               55 runs hover 5-8 cm (forward rolls r1 r3 mid-roll 26, one wall climb r1 hang over 21 drafts, trip run r1 3)
//               and 10 more 8-24 cm (muscle-up r1, handstand r1, push crate): 3-15 px of air under a body that does not fall.
//               The distribution's trough, 8-12 cm, would excuse the 3-8 px hovers too. No delivered take hovers past 5 cm.
//   REST_SHARE  .5: a float run's share of frames within NEAR (24 sampled) is >= .8 in 85 % of the runs and < .4 in 7 %; .5
//               splits the band between (42 runs: the wall climb r1 hang at .44-.47, 8 runs at .50); .4 / .6 rest 539 / 509
//               of the 582 runs against 517.
import { capsulesFor, sdBox, segDist, segPoints, solePoints, legGap } from "./geometry.js";
import { groundY } from "./ground.js";
import { floatChecks } from "./style.js";
import { MOTION_OUTPUT_BUDGET, fitOutput } from "../report.js";

export const DEEP = 0.05, POP_HARD = 0.25, REACH_GAP = 0.03, NEAR = 0.05;
/** A FLOAT run rests on something when this share of its frames has a body part within NEAR of a surface. */
const REST_SHARE = 0.5;
const ALWAYS = new Set(["GOAL", "KEY", "CONTACT", "LOAD", "TELEPORT", "FLIP", "GRAB", "CATCH"]);
const DEPTH = new Set(["COLLIDE", "BODY", "SELF", "FACE", "PERSON", "OBJECT"]);
/** Finger-level parts: the fingers, the thumb and the palm (the hand_<k> capsule runs from the wrist to the knuckles). */
const HANDS = /^(fingers|thumb|palm|hand|tips)(_[lr])?$/;
/** Parts under the floor a viewer sees: the trunk, the legs (a sole is the foot's) and the head. */
const FLOOR_PARTS = /^(hips|torso_lo|torso_hi|neck|shoulder(_[lr])?|head|thigh_[lr]|shin_[lr]|foot_[lr]|(Left|Right) sole)$/;
const MISS = /^(arm|leg)_miss_([lr])$/;
const TIPS = ["Thumb4", "Index4", "Middle4", "Ring4", "Pinky4"], HEAD_R = 0.09, TIP_R = 0.008;
const LEGS = { "thighs overlap": ["UpLeg", "Leg"], "shins touch": ["Leg", "Foot"] };

/** The worst value of g, from the subject when the group carries none (a POP subject names its acceleration). */
function worstOf(g) {
	if (Number.isFinite(g.worst)) return g.worst;
	const pop = g.kind === "POP" && /accel ([\d.]+) cm\/f\^2/.exec(g.subject ?? "");
	return pop ? Number(pop[1]) / 100 : null;
}

/**
 * isBlocking(group, seen?) -> true when the group blocks the take. seen is what the take measured for it (measureGroup):
 * { rests } for FLOAT, { onSurface } for REACH, { depth } for SELF's legs; without it those block.
 */
export function isBlocking(g, seen = {}) {
	const kind = g?.kind, subject = g?.subject ?? "", worst = worstOf(g ?? {});
	if (ALWAYS.has(kind)) return true;
	if (kind === "POP") return worst === null || worst > POP_HARD;
	if (kind === "FLOAT") return !seen.rests;
	if (kind === "REACH") {
		if (!MISS.test(subject)) return false;
		if (worst !== null && worst <= REACH_GAP) return false;
		return /\banchor\b/.test(g.cause ?? "") || seen.onSurface !== false;
	}
	if (kind === "GROUND") return FLOOR_PARTS.test(/^(.+?) below floor/.exec(subject)?.[1] ?? "") && (worst === null || worst > DEEP);
	if (!DEPTH.has(kind)) return false;
	if (kind === "COLLIDE" && HANDS.test(/^(\S+) x /.exec(subject)?.[1] ?? "")) return false;
	const depth = LEGS[subject] ? seen.depth ?? null : worst;
	return depth === null || depth > DEEP;
}

/** Body points and their skin radius for a surface test: the capsules, the head, the soles and the fingertips. */
function bodyPoints(sk, s) {
	const P = s.P, I = sk.index, pts = [];
	for (const [, a, b, r] of capsulesFor(sk)) for (const p of segPoints(P[I[a]], P[I[b]], 3)) pts.push([p, r]);
	if (I.HeadTop_End !== undefined) for (const p of segPoints(P[I.Head], P[I.HeadTop_End], 3)) pts.push([p, HEAD_R]);
	for (const S of ["Left", "Right"]) pts.push(...limbPoints(sk, s, "arm", S), ...limbPoints(sk, s, "leg", S));
	return pts;
}

/** The end of a limb: a hand's wrist, knuckles and fingertips, or a foot's sole. */
function limbPoints(sk, s, limb, S) {
	if (limb === "leg") return Object.values(solePoints(sk, s, S)).map(p => [p, 0]);
	return [`${S}Hand`, `${S}HandMiddle1`, ...TIPS.map(t => `${S}Hand${t}`)].map(j => sk.index[j]).filter(j => j !== undefined).map(j => [s.P[j], TIP_R]);
}

/** How far (m) the nearest skin of these points is from the floor, a top under it or a scene body at frame index i (< 0: in it). */
function gapAt(out, i, pts) {
	const boxes = Object.values(out.objectsAt(i) ?? {}).filter(b => b?.half && !b.ignore);
	let gap = Infinity;
	for (const [p, r] of pts) {
		gap = Math.min(gap, p[1] - groundY(out, i, p) - r);
		for (const b of boxes) gap = Math.min(gap, sdBox(p, b) - r);
	}
	return gap;
}

/** At most n frame indexes spread over the list. */
const spread = (list, n = 48) => (list.length <= n ? list : Array.from({ length: n }, (_, k) => list[Math.round((k * (list.length - 1)) / (n - 1))]));

/**
 * What the take shows for group g, or undefined when its kind needs nothing: out is the compile's frames (out.frames[i].s,
 * out.ctx.sk, out.objectsAt; physics-frames.js takeOut rebuilds them from a take), group frames are absolute.
 */
export function measureGroup(out, g) {
	const n = out?.frames?.length ?? 0, f0 = out?.f0 ?? 0, sk = out?.ctx?.sk;
	if (!n || !sk) return undefined;
	const at = f => Math.max(0, Math.min(n - 1, Math.round(f - f0)));
	const range = () => Array.from({ length: Math.max(1, at(g.last ?? g.first ?? 0) - at(g.first ?? 0) + 1) }, (_, k) => at(g.first ?? 0) + k);
	if (g.kind === "FLOAT") {
		// one group holds every float run of the take: each run must rest on something (a crawl's lying run does not excuse a jump's)
		const air = [...new Set(floatChecks(out, out.ctx.spec?.checks ?? {}).map(i => i.frame))].filter(i => i >= 0 && i < n).sort((a, b) => a - b);
		const runs = [];
		for (const i of air.length ? air : range()) { const last = runs.at(-1); if (last && i === last.at(-1) + 1) last.push(i); else runs.push([i]); }
		return { rests: runs.every(run => { const frames = spread(run, 24); return frames.filter(i => gapAt(out, i, bodyPoints(sk, out.frames[i].s)) <= NEAR).length >= REST_SHARE * frames.length; }) };
	}
	const miss = g.kind === "REACH" && MISS.exec(g.subject ?? "");
	if (miss) {
		const i = at(g.worstFrame ?? g.first ?? 0), side = miss[2] === "l" ? "Left" : "Right";
		return { onSurface: gapAt(out, i, limbPoints(sk, out.frames[i].s, miss[1], side)) <= (worstOf(g) ?? 0) + NEAR };
	}
	const legs = g.kind === "SELF" && LEGS[g.subject];
	if (legs) {
		const [a, b] = legs, touch = Number.isFinite(g.limit) ? g.limit : legGap(sk, g.subject);
		const depth = Math.max(...spread(range()).map(i => { const P = out.frames[i].s.P, I = sk.index;
			return touch - segDist(P[I[`Left${a}`]], P[I[`Left${b}`]], P[I[`Right${a}`]], P[I[`Right${b}`]]); }));
		return { depth };
	}
	return undefined;
}

const MEASURED = g => g.kind === "FLOAT" || (g.kind === "REACH" && MISS.test(g.subject ?? "") && !/\banchor\b/.test(g.cause ?? "")) || (g.kind === "SELF" && LEGS[g.subject]);

/**
 * markBlocking(groups, out?) -> flagged copies { ...group, blocking }, the blocking ones first (each part keeps its rank).
 * out: the compile's frames, or a function that makes them (called once, only when a group needs the take).
 */
export function markBlocking(groups = [], out = null) {
	let frames = typeof out === "function" ? undefined : out;
	const take = () => (frames === undefined ? (frames = out() ?? null) : frames);
	const flagged = groups.map(g => ({ ...g, blocking: isBlocking(g, out && MEASURED(g) ? measureGroup(take(), g) ?? {} : {}) }));
	return [...flagged.filter(g => g.blocking), ...flagged.filter(g => !g.blocking)];
}

/** The blocking groups: by their flag (markBlocking), else as isBlocking reads them without a take. */
export const blockingOf = (groups = []) => groups.filter(g => (typeof g.blocking === "boolean" ? g.blocking : isBlocking(g)));

/** Blocking problems in a QA result: 0 for a clean one; a failed one without groups counts its problems (never clean). */
export function blockingCount(qa) {
	if (qa?.ok) return 0;
	const groups = Array.isArray(qa?.groups) ? qa.groups : [];
	return groups.length ? blockingOf(groups).length : Math.max(1, qa?.problems ?? qa?.total ?? 1);
}

/** "1 blocking, 2 warnings" for a flagged QA result. */
export function blockingSay(qa) {
	const b = blockingCount(qa), w = Math.max(0, (qa?.groups?.length ?? 0) - b);
	return `${b} blocking, ${w} warning${w === 1 ? "" : "s"}`;
}

const bytes = v => new TextEncoder().encode(JSON.stringify(v)).length;

/**
 * fitOutput (report.js) for an answer whose qa is flagged: a group cut to a one-liner keeps its blocking flag (v2: 34 compile
 * answers carried 89 one-liners), the brief's head says "<b> blocking, <w> warnings" where it said "<n> problems", and a
 * warning's group line ends "(warning)": a script returns the brief as is (v2: 475 of 826 script answers carried only it).
 * While the flags push the answer past the budget it is fitted again with the room they took (fitOutput cuts whole items, so
 * less room by the excess alone often cuts nothing: v2 handstand r2 stayed 2 bytes over).
 */
export function fitFlagged(answer, budget = MOTION_OUTPUT_BUDGET) {
	const groups = answer.qa?.groups ?? [], lines = groups.filter(g => g.kind !== "GOAL"), say = blockingSay(answer.qa);
	const flagOf = (g, i) => (typeof g.blocking === "boolean" || groups[i]?.kind !== g.kind ? g : { kind: g.kind, blocking: Boolean(groups[i].blocking), ...g });
	const mark = out => {
		const at = out.brief?.[1]?.startsWith("goals ") ? 2 : 1;
		const brief = out.brief?.map((l, k) => (k === 0 ? l.replace(/ qa \d+ problems \(/, ` qa ${say} (`) : k >= at && lines[k - at]?.blocking === false ? `${l} (warning)` : l));
		return { ...out, ...(brief ? { brief } : {}), ...(out.qa?.groups ? { qa: { ...out.qa, groups: out.qa.groups.map(flagOf) } } : {}) };
	};
	let room = budget, plain = fitOutput(answer, room), out = mark(plain);
	for (let k = 0; k < 4 && bytes(out) > budget; k++) { room -= bytes(out) - Math.min(budget, bytes(plain)); plain = fitOutput(answer, room); out = mark(plain); }
	// a head fitOutput cannot fit (v2 wall climb r2 r3: 8 of 1147 answers, all groups one-liners): one-liners go from the end,
	// warnings first, so a flag never adds bytes to a receipt that is already over (motion.report pages them, more counts them)
	while (bytes(out) > budget && out.qa?.groups?.length && !("worst" in out.qa.groups.at(-1))) out = { ...out, qa: { ...out.qa, groups: out.qa.groups.slice(0, -1) } };
	return out;
}
