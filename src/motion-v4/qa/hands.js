// Hand checks that need no spec (v4 qa). Old QA judges a hand only where the spec says it holds
// something (wrist-checks.js holding, grasp-checks.js); a raw take has no spec, so these read the pose
// alone. A hand is in contact when its palm centre or a finger tip is within 2 cm of the floor or a
// box for 2+ frames (a contact run, one surface).
//   HAND_PEN     on any frame: the palm centre, a finger tip or the hand capsule more than 1 cm inside a box or the floor
//   PALM_TILT    in a contact run: the palm faces more than 35 deg away from the surface
//   WRIST_LIMIT  on any frame: wrist flex, deviation or twist more than 5 deg past WRIST_LIMITS (arm-orient.js)
//   HAND_SLIDE   in a contact run on a still surface: the palm travels more than 3 cm along it
// The palm centre is the midpoint of Hand and HandMiddle1 (bench take.mjs:39); its outward normal is
// palmAxes n on the left hand and -n on the right (both face down in the T-pose).
import { add, angle, apply, dot, len, mul, scale, sub, T } from "../../motion3/compiler/math.js";
import { CAPSULES, segPoints, sdBox, boxNormal } from "../../motion3/qa/geometry.js";
import { WRIST_LIMITS, wristNeed } from "../../motion3/compiler/arm-orient.js";
import { palmAxes } from "../../motion3/compiler/limbs.js";
import { groupIssues } from "./impact.js";

const TOUCH = 0.02, PEN = 0.01, TILT = 35, PAST = 5, SLIDE = 0.03, TIP_R = 0.008, STILL = 1e-6;
const FINGERS = ["Thumb", "Index", "Middle", "Ring", "Pinky"];
const SIDES = [["l", "Left"], ["r", "Right"]];
const WORDS = { flex: v => (v >= 0 ? "flex" : "extension"), dev: v => (v >= 0 ? "radial deviation" : "ulnar deviation"), twist: () => "twist" };
const cm = m => (m * 100).toFixed(1);

/** The floor and the boxes of frame index i (the filter of ground.js boxesOf). */
const surfacesAt = (out, i) => [{ id: "floor", box: null },
	...Object.entries(out.objectsAt(i)).filter(([, b]) => b?.half && !b.ignore).map(([id, box]) => ({ id, box }))];
const sd = (p, srf) => (srf.box ? sdBox(p, srf.box) : p[1]);
const normalAt = (p, srf) => (srf.box ? boxNormal(p, srf.box) : [0, 1, 0]);

/** The wrist's turn from neutral on frame state s, degrees { twist, flex, dev } (the neutral of wrist-checks.js needAt). */
function wristAt(sk, s, S) {
	const I = sk.index, hb = I[`${S}Hand`], fa = I[`${S}ForeArm`], rw = sk.restWorldRot;
	const ax = sub(s.P[hb], s.P[fa]), axT = scale(ax, 1 / Math.max(1e-9, len(ax))), neutral = mul(s.R[fa], mul(T(rw[fa]), rw[hb]));
	return wristNeed(neutral, s.R[hb], axT, apply(mul(neutral, T(s.R[hb])), palmAxes(sk, s, S).l));
}

/** The axis of a wrist need furthest past WRIST_LIMITS: { axis, value, edge, past } (degrees). */
function worstAxis(need) {
	let best = null;
	for (const axis of ["flex", "dev", "twist"]) {
		const [lo, hi] = WRIST_LIMITS[axis], v = need[axis], edge = v >= 0 ? hi : lo, past = v >= 0 ? v - hi : lo - v;
		if (!best || past > best.past) best = { axis, value: v, edge, past };
	}
	return best;
}

/** One frame of one hand: palm centre and normal, the deepest point per surface, and the nearest surface in touch (or null). */
function handFrame(out, i, S, capR) {
	const sk = out.ctx.sk, s = out.frames[i].s, P = n => s.P[sk.index[`${S}${n}`]], ax = palmAxes(sk, s, S);
	const palm = scale(add(P("Hand"), P("HandMiddle1")), 0.5), tips = FINGERS.map(f => P(`Hand${f}4`)), capsule = segPoints(P("Hand"), P("HandMiddle3"), 5);
	const pens = [];
	let touch = null;
	for (const srf of surfacesAt(out, i)) {
		const depth = Math.max(-sd(palm, srf), ...tips.map(p => TIP_R - sd(p, srf)), ...capsule.map(p => capR - sd(p, srf)));
		const gap = Math.min(sd(palm, srf), ...tips.map(p => sd(p, srf) - TIP_R));
		if (depth > PEN) pens.push({ id: srf.id, depth });
		if (gap <= TOUCH && (!touch || gap < touch.gap)) touch = { srf, gap };
	}
	return { s, palm, normal: S === "Left" ? ax.n : scale(ax.n, -1), pens, touch };
}

/** Runs [a, b] of frame indexes in which the hand touches one surface for 2+ frames. */
function contactRuns(frames) {
	const runs = [];
	for (let a = 0; a < frames.length; a++) {
		const id = frames[a].touch?.srf.id;
		if (!id) continue;
		let b = a;
		while (b + 1 < frames.length && frames[b + 1].touch?.srf.id === id) b++;
		if (b > a) runs.push([a, b]);
		a = b;
	}
	return runs;
}

/** True when box surface srf keeps its pose on frames a..b (the floor always does). */
function stillOn(out, srf, a, b) {
	if (!srf.box) return true;
	const at = f => out.objectsAt(f)[srf.id];
	for (let f = a + 1; f <= b; f++) {
		const box = at(f);
		if (!box || len(sub(box.pos, srf.box.pos)) > STILL || box.R.some((row, r) => row.some((v, c) => Math.abs(v - srf.box.R[r][c]) > STILL))) return false;
	}
	return true;
}

/** HAND_PEN, PALM_TILT, WRIST_LIMIT and HAND_SLIDE groups (runMotionQa group fields, frames absolute). */
export function handChecks(out) {
	const sk = out.ctx.sk, f0 = out.f0 ?? 0, n = out.frames.length, issues = [];
	const push = (kind, msg, i, value, limit) => issues.push({ kind, msg, frame: i + f0, value: +value.toFixed(4), limit });
	for (const [k, S] of SIDES) {
		const capR = CAPSULES.find(c => c[0] === `hand_${k}`)[3], frames = [];
		for (let i = 0; i < n; i++) {
			const h = handFrame(out, i, S, capR);
			frames.push(h);
			for (const { id, depth } of h.pens) push("HAND_PEN", `hand_${k} ${cm(depth)} cm inside ${id}`, i, depth, PEN);
			const w = worstAxis(wristAt(sk, h.s, S));
			if (w.past > PAST) push("WRIST_LIMIT", `hand_${k} ${WORDS[w.axis](w.value)} ${Math.round(Math.abs(w.value))}deg (limit ${Math.abs(w.edge)})`, i, Math.abs(w.value), Math.abs(w.edge));
		}
		for (const [a, b] of contactRuns(frames)) {
			const srf = frames[a].touch.srf, still = stillOn(out, srf, a, b), n0 = normalAt(frames[a].palm, srf);
			for (let i = a; i <= b; i++) {
				const h = frames[i], tilt = angle(h.normal, scale(normalAt(h.palm, frames[i].touch.srf), -1));
				if (tilt > TILT) push("PALM_TILT", `hand_${k} palm ${Math.round(tilt)}deg off the ${srf.id} surface (limit ${TILT})`, i, tilt, TILT);
				if (!still) continue;
				const d = sub(h.palm, frames[a].palm), travel = len(sub(d, scale(n0, dot(d, n0))));
				if (travel > SLIDE) push("HAND_SLIDE", `hand_${k} palm slides ${cm(travel)} cm on ${srf.id}`, i, travel, SLIDE);
			}
		}
	}
	return groupIssues(issues);
}
