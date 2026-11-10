// What the self repair (self-repair.js) reads on a frame: an arm part (upper arm, forearm, hand) in the character's own
// torso, hips, neck, head or thigh deeper than QA allows, on QA's own body and measures:
//   BODY  body.js limbDepth on the fitted skin (qa/body-checks.js): the deepest skin the part is in, past the larger of
//         L.skin and checks.allow
//   FACE  a hand's probe points in the head ellipsoid (qa/checks.js generalChecks: headDepth plus the probe radius),
//         past L.headAllow (QA's FACE has no checks.allow: a hand meant at the face is on an anchor or a fit, below)
// A part in its own neighbours (the upper arm in the chest at the shoulder: body.js skipOf) never reads. A hand the take
// keeps on something on purpose is the take's to keep:
//   body      a hand on an anchor on the body (kind body, bone, segment or landmark: a hand on the hip, a pocket, the
//             mouth) or on a fit (the cigarette at the lips): its hand is not read, and its forearm and upper arm may
//             only turn the elbow
//   pinned    a hand on any other anchor, holding a keyed carry, or named by an active checks.contacts entry: the hand
//             stays where it is, so only the elbow may turn
// A wrist push spread onto a frame where the take holds the hand in part (an anchor weight easing in) is scaled by
// what is left free (handHold held), so a held hand never leaves its target.
//   fk        an arm with almost no IK weight (armw): the IK levers do not reach it
import { limbDepth } from "../body.js";
import { turnWeight } from "../compiler/pose.js";
import { allowance, QA_LIMITS } from "../qa/checks.js";
import { regionOf } from "../qa/body-checks.js";
import { headDepth, segPoints } from "../qa/geometry.js";
import { fitWeight } from "./self.js";

export const SIDES = { l: "Left", r: "Right" };
/** The parts the arm must stay out of (QA part names, qa/body-checks.js regionOf). */
const TARGET = /^(torso_lo|torso_hi|shoulder_[lr]|hips|neck|head|thigh_[lr])$/;
/** The anchors that put a hand on the body itself (compiler/anchors.js). */
const ON_BODY = new Set(["body", "bone", "segment", "landmark"]);
/** An anchor weight, a fit or a carry at least this much is the take's contact. */
const ON = 0.05;
/** An arm turned this little onto its IK (pose.js turnWeight of armw) has no IK lever. */
const IK_MIN = 0.05;
/** FACE's hand probes: 5 points wrist to middle finger, this radius (m) (qa/checks.js generalChecks). */
const FACE_R = 0.022;

/** QA's BODY limit (m) for arm part `part` in body part `into` under spec (its checks.limits.skin and checks.allow). */
function limitOf(spec, part, into) {
	const skin = spec.checks?.limits?.skin ?? QA_LIMITS.skin;
	return Math.max(allowance(spec.checks?.allow, part, into) ?? 0, skin);
}

/** Whether checks.contacts entry k is on at absolute frame f with channels c (qa/spec-checks.js active). */
const activeAt = (k, f, c) => (Array.isArray(k.when) ? f >= k.when[0] && f <= k.when[1] : k.when ? (c[k.when] ?? 0) > 0.5 : true);

/** How the take holds hand k on frame { c, diag } at absolute frame f: { hold: "body" | "pinned" | "fk" | null (free),
 * held: how much of the hand's place is the take's (0..1: the anchor, fit, carry or contact weight on it) }. */
export function handHold(spec, { c, diag }, f, k) {
	const fit = fitWeight(spec, c, k);
	let anchored = 0, body = fit >= ON;
	for (const [ch, w] of Object.entries(c)) {
		const m = /^w_(.+)_([lr])$/.exec(ch);
		if (!m || m[2] !== k || !(w > 0)) continue;
		anchored += w;
		if (w >= ON && ON_BODY.has(spec.anchors?.[m[1]]?.kind)) body = true;
	}
	const hand = new RegExp(`(${SIDES[k]}Hand|hand_${k}\\b)`), props = Object.entries(spec.props ?? {}).filter(([, p]) => p.hand === k).map(([n]) => n);
	const named = x => typeof x === "string" && (hand.test(x) || props.some(p => x.includes(`prop:${p}`) || x.startsWith(`${p}.`)));
	const contact = (spec.checks?.contacts ?? []).some(e => activeAt(e, f, c) && (named(e.point) || named(e.target))) ? 1 : 0;
	const held = Math.min(1, Math.max(fit, anchored, diag[`hold_${k}`]?.w ?? 0, contact));
	const hold = body ? "body" : turnWeight(c[`armw_${k}`] ?? 0) < IK_MIN ? "fk" : held >= ON ? "pinned" : null;
	return { hold, held };
}

/** FACE's reading of hand k in the head on pose s: { depth, past, p } at its deepest probe (null without a head). */
function faceHit(sk, spec, s, k) {
	const I = sk.index, end = I[`${SIDES[k]}HandMiddle3`];
	if (end === undefined || !sk.landmarks?.headRadii) return null;
	let best = null;
	for (const p of segPoints(s.P[I[`${SIDES[k]}Hand`]], s.P[end], 5)) {
		const depth = headDepth(sk, s, p) + FACE_R;
		if (!best || depth > best.depth) best = { depth, p };
	}
	return { ...best, past: best.depth - (spec.checks?.limits?.headAllow ?? QA_LIMITS.headAllow) };
}

/**
 * The deepest hit of side k's arm on frame index i: { b, part, into, depth, past, p, hold, seen } with past = depth -
 * QA's limit (> 0 is a hit QA reads), or null when no part of that arm is in a target part. hold: handHold's reading; a
 * hand on the body (hold "body") is not read. seen: every BODY and FACE subject of that arm QA reports on
 * this frame, in any part ("BODY farm_r into torso_hi"), so a move can be told it would add one. With `known` (a set of
 * those subjects), a part QA would report under a subject not in it is read in any body part too: the repair clears
 * what its own moves added.
 */
export function armHit(out, body, i, k, known = null) {
	const { sk, spec } = out.ctx, fr = out.frames[i], { hold } = handHold(spec, fr, (out.f0 ?? 0) + i, k), I = sk.index, seen = [];
	let best = null;
	for (const n of ["Arm", "ForeArm", "Hand"]) {
		const b = I[`${SIDES[k]}${n}`], h = limbDepth(body, sk, fr.s, b), part = regionOf(sk, b), into = h.into < 0 ? null : regionOf(sk, h.into);
		const past = into ? h.depth - limitOf(spec, part, into) : -Infinity, face = n === "Hand" ? faceHit(sk, spec, fr.s, k) : null;
		if (past > 0) seen.push(`BODY ${part} into ${into}`);
		if (face?.past > 0) seen.push(`FACE ${part} into head`);
		if (hold === "body" && n === "Hand") continue;
		if ((TARGET.test(into ?? "") || (known && past > 0 && !known.has(`BODY ${part} into ${into}`))) && (!best || past > best.past)) best = { b, part, into, depth: h.depth, past, p: h.p, hold };
		if (face && face.depth > 0 && (!best || face.past > best.past)) best = { b, part, into: "head", ...face, hold, face: true };
	}
	return best ? { ...best, seen } : seen.length ? { past: -Infinity, depth: 0, hold, seen } : null;
}
