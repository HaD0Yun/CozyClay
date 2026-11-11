// The second hand on a held object (C14, lane K8). While keys lead a carry the right hand holds
// (object-keys.js), a left hand anchored to that prop (w_<anchor>_l on a kind "prop" anchor of
// the same prop, with or without a fit) turns with the object too. The wrist stays where the
// anchor puts it (with a fit, the palm stays where the fit puts it). The hand takes the holding
// hand's grip mirrored across the plane of the object's axis and the holding fingers (the object's
// +Y runs through the left palm frame as through the right one, knuckles in line), turned about
// the axis to the roll its arm holds most easily (planned over the frames, object-keys.js and
// hold-plan.js). The arm follows as for the holding hand (compiler/hold.js): the elbow swivels
// about the shoulder-wrist axis (lane N1; it stayed in the plane the anchor's IK gave it, and the
// default pole, down and back, bent a left arm reaching across the chest into the torso), the
// forearm and the wrist turn. Each roll is scored by the wrist's strain at the best of POLES poles,
// plus CLEAR per squared centimetre the upper arm, the forearm or the hand goes into the torso
// capsules (the BODY check's), and DEEP per squared centimetre the hand goes past what QA allows a
// hand: into the torso past the BODY allowance, into the holding hand past the SELF one (lane Q1:
// at CLEAR alone, session 4db5d447 put the hand 0.9 cm into torso_lo at f35 to save 1 of strain,
// QA BODY). The elbow's path is planned like the holding elbow's. The hold
// eases in with the keys' weight times the anchor weight, and a grip the arm cannot hold fades out.
// Only a hand solved after the holding hand can follow it (pose.js solves the right arm first), so
// the second hand is the left.
import { palmAxes } from "./compiler/limbs.js";
import { SIDES } from "./compiler/pose.js";
import { add, sub, scale, norm, dot, cross, mul, T, apply, axisRot, len, clamp } from "./compiler/math.js";
import { landscape, ELBOW_REST } from "./compiler/arm-orient.js";
import { bendPlane } from "./compiler/hold.js";
import { capsulesFor } from "./qa/geometry.js";
import { QA_LIMITS } from "./qa/checks.js";
import { bodyFor, segmentDepth } from "./body.js";

const ROLLS = 36, TEMP = 0.05, PULL = 0.3, EASY = 3, SLACK = 10, POLES = 36, CLEAR = 1, DEEP = 100;
const cols = (a, b, c) => [[a[0], b[0], c[0]], [a[1], b[1], c[1]], [a[2], b[2], c[2]]];
const col = (R, i) => [R[0][i], R[1][i], R[2][i]];

/** The distance between segments p1-q1 and p2-q2 (closest points, clamped to both). */
function segSeg(p1, q1, p2, q2) {
	const d1 = sub(q1, p1), d2 = sub(q2, p2), r = sub(p1, p2), a = dot(d1, d1), e = dot(d2, d2), f = dot(d2, r);
	if (a < 1e-12 || e < 1e-12) return len(r);
	const c = dot(d1, r), b = dot(d1, d2), den = a * e - b * b;
	let t = den > 1e-12 ? clamp((b * f - c * e) / den, 0, 1) : 0, u = (b * t + f) / e;
	if (u < 0) { u = 0; t = clamp(-c / a, 0, 1); } else if (u > 1) { u = 1; t = clamp((b - c) / a, 0, 1); }
	return len(sub(add(p1, scale(d1, t)), add(p2, scale(d2, u))));
}

/** The palm frame of `side` on pose s: the finger middles, axes d, l, n as columns. */
function palmFrame(sk, s, side) {
	const I = sk.index, ax = palmAxes(sk, s, side);
	return { pos: scale(add(s.P[I[`${side}HandIndex2`]], s.P[I[`${side}HandMiddle2`]]), 0.5), R: cols(ax.d, ax.l, ax.n) };
}

/**
 * The left hand's grip on carry `id` at this frame, or null when the left hand is not anchored to
 * its prop: s is the pose with the holding hand done and the left arm on its plain target, c the
 * frame's channels, axis the object's +Y as drawn. The grip is the holding hand's mirrored (knuckles
 * in line), turned `roll` radians about the axis; arm(roll) is the left arm holding it: at(th) ->
 * { pv, elbow, cost } for the elbow th radians about the shoulder-wrist axis from its plane (the
 * swivel landscape plus the torso price) and best { th, pole, cost }; cost(roll) is best's cost
 * (pulled lightly toward the mirror), point(roll) the end of the hand that moves (the palm with the
 * wrist pinned, the wrist with the palm pinned), softmin() the easiest roll.
 */
export function secondGrip(sk, spec, id, s, c, axis) {
	const o = spec.objects[id];
	if (spec.props[o.prop].hand !== "r") return null;
	const weight = Object.entries(spec.anchors ?? {}).reduce((sum, [name, a]) => sum + (a.kind === "prop" && a.prop === o.prop ? Math.max(0, c[`w_${name}_l`] ?? 0) : 0), 0);
	if (!(weight > 1e-4)) return null;
	// the mirror of the holding palm frame across the plane of the axis and the holding fingers
	const R = palmFrame(sk, s, SIDES.r).R, d = col(R, 0), p = norm(cross(axis, sub(d, scale(axis, dot(d, axis))))), mirror = v => sub(v, scale(p, 2 * dot(v, p)));
	const base = cols(mirror(d), mirror(col(R, 1)), scale(mirror(col(R, 2)), -1));
	const left = palmFrame(sk, s, SIDES.l), I = sk.index, h = I.LeftHand, wrist = s.P[h], local = mul(T(s.R[h]), left.R), localP = apply(T(s.R[h]), sub(left.pos, wrist));
	// with a fit the palm (its effector) stays where the fit put it, else the wrist stays on the anchor
	const pin = (spec.fits ?? []).some(x => x.side === "l" && spec.anchors?.[x.anchor]?.kind === "prop" && spec.anchors[x.anchor].prop === o.prop && c[`w_${x.anchor}_l`] > 1e-4) ? "palm" : "wrist";
	const rolled = r => mul(axisRot(axis, r * 180 / Math.PI), base), hand = r => mul(rolled(r), T(local));
	const point = r => (pin === "wrist" ? add(wrist, apply(hand(r), localP)) : sub(left.pos, apply(hand(r), localP)));
	// the wrist for a roll, the knuckles off it, and how deep a segment goes into the torso (m)
	const wristAt = r => (pin === "wrist" ? wrist : point(r)), knuckle = apply(T(s.R[h]), sub(s.P[I.LeftHandMiddle3], wrist)), S = s.P[I.LeftArm], plane = bendPlane(sk, s, SIDES.l);
	// on the fitted skin when the rig has one and spec.fix.self is on (body.js, as QA's BODY measures it), else on the torso capsules
	const skin = spec.fix === false || spec.fix?.self === false ? null : bodyFor(sk), BONE = { uarm_l: I.LeftArm, farm_l: I.LeftForeArm, hand_l: I.LeftHand };
	const caps = capsulesFor(sk), TORSO = caps.filter(x => x[0].startsWith("torso")), RADIUS = Object.fromEntries(caps.map(x => [x[0], x[3]]));
	const into = (a, b, part) => (skin ? segmentDepth(skin, sk, s, BONE[part], a, b) : Math.max(0, ...TORSO.map(([, ta, tb, rt]) => RADIUS[part] + rt - segSeg(a, b, s.P[I[ta]], s.P[I[tb]]))));
	const arms = new Map();
	const arm = r => {
		if (arms.has(r)) return arms.get(r);
		const W = wristAt(r), land = landscape(sk, s, SIDES.l, hand(r), W, plane, ELBOW_REST);
		const at = th => { const q = land.at(th); return { pv: q.pv, elbow: q.elbow, cost: q.cost + CLEAR * ((100 * into(S, q.elbow, "uarm_l")) ** 2 + (100 * into(q.elbow, W, "farm_l")) ** 2) }; };
		let best = { th: 0, cost: Infinity };
		for (let i = 0; i < POLES; i++) { const th = (2 * Math.PI * i) / POLES - Math.PI, v = at(th).cost; if (v < best.cost) best = { th, cost: v }; }
		const K = add(W, apply(hand(r), knuckle)), deep = into(W, K, "hand_l"), past = Math.max(0, deep - QA_LIMITS.body);
		// the holding hand is done: how far this hand's capsule goes into it (QA SELF "hands overlap")
		const touch = 2 * RADIUS.hand_l - segSeg(W, K, s.P[I.RightHand], s.P[I.RightHandMiddle3]), over = Math.max(0, touch - QA_LIMITS.hands);
		const fixed = CLEAR * ((100 * deep) ** 2 + (100 * land.miss) ** 2) + (past > 0 ? DEEP * (100 * past) ** 2 : 0) + (over > 0 ? DEEP * (100 * over) ** 2 : 0);
		const a = { at, best: { th: best.th, pole: at(best.th).pv, cost: best.cost + fixed } };
		arms.set(r, a);
		return a;
	};
	const cost = r => arm(r).best.cost + PULL * (1 - Math.cos(r));
	const softmin = () => {
		const all = Array.from({ length: ROLLS }, (_, i) => { const r = (2 * Math.PI * i) / ROLLS - Math.PI; return [r, cost(r)]; }), low = Math.min(...all.map(x => x[1]));
		const m = all.reduce((acc, [r, v]) => { const e = Math.exp(-(v - low) / TEMP); return [acc[0] + e * Math.cos(r), acc[1] + e * Math.sin(r)]; }, [0, 0]);
		return Math.atan2(m[1], m[0]);
	};
	return { id, weight, pin, at: left.pos, rolled, arm, cost, point, softmin, measure: s2 => palmFrame(sk, s2, SIDES.l) };
}

/** How much of a grip at `roll` the arm can take: 1 while its cost is under EASY, fading by SLACK past it. */
export const gripGate = (grip, roll) => Math.exp(-Math.max(0, grip.cost(roll) - EASY) / SLACK);

/**
 * The hold ({ w, palm, measure, pole, pin, second } for compiler/hold.js) of a grip at `roll`
 * radians with the elbow toward `pole` (a world direction), w the keys' lead weight, gate the
 * planned gripGate: a grip the arm cannot hold fades out, so the hand stays nearer where the plain
 * arm put it instead of turning to a limit and flipping there.
 */
export const secondHold = (grip, w, roll, gate, pole) => ({ w: w * Math.min(1, grip.weight) * gate, second: grip.id, pin: grip.pin,
	pole, palm: { pos: grip.at, R: grip.rolled(roll) }, measure: grip.measure });
