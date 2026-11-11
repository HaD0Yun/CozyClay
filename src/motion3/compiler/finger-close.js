// Fingers close on what the hand holds (#816). A preset curls each phalanx a fixed angle, which fits one size: on a
// ball the index and middle sank 3 cm into it while the little finger stayed in the air (session 7f15b4ae). After the
// arm, the hold and the elbow's swivel have placed the hand (pose.js), each finger closes phalanx by phalanx, from the
// knuckle out: the joint turns further about the axis it curls on until the rest of the finger first touches a held
// shape (shapes.js; its skin within TOUCH m of the surface), never past the fist's curl; a finger that cannot reach it
// keeps the preset's curl (closing on air would curl it into whatever lies under the palm). The thumb keeps the preset's
// turn at its base and flexes its outer joints the same way. Found by bisection (STEPS evaluations a joint) on the joints' positions,
// then turned once; weighted by how far the hand holds (a fit's weight), so the fingers close over the reach and open
// on the release. A joint the preset curled into the body straightens when that leaves the finger shallower; a
// joint whose sub-chain already touches stays, and the next joint out closes on: the finger wraps the body.
import { add, sub, scale, norm, cross, dot, apply, axisRot } from "./math.js";
import { rotateSubtree, rigScale } from "./skeleton.js";
import { palmAxes, fingerCurl, fistCurl } from "./limbs.js";
import { capsuleDepth, shapeOf } from "../shapes.js";
import { GRASP_FINGERS } from "./vocab.js";
import { partsOf } from "../object-pose.js";
import { seatsInHand } from "../seat.js";

const PHALANX = 0.009, TOUCH = 0.002, STEPS = 8, THUMB_FLEX = 70, SPREAD_STEP = 5, SPREAD_MAX = 15, SELF_GAP = 0.014;
const FINGERS = ["Index", "Middle", "Ring", "Pinky"];
/** A phalanx's radius on rig sk (m): PHALANX scaled by its hand (rigScale "hand"), as qa/finger-checks.js judges it. */
const phalanx = sk => PHALANX * rigScale(sk, "hand");
// the hand stays open for most of a reach and closes as it arrives: from OPEN_UNTIL of the fit's weight to CLOSED_AT
const OPEN_UNTIL = 0.6, CLOSED_AT = 0.9;
const closing = w => { const t = Math.min(1, Math.max(0, (w - OPEN_UNTIL) / (CLOSED_AT - OPEN_UNTIL))); return t * t * (3 - 2 * t); };

function chainDepth(points, entries, r) {
	let depth = -Infinity;
	for (let i = 0; i + 1 < points.length; i++) for (const e of entries) depth = Math.max(depth, capsuleDepth(e, points[i], points[i + 1], r));
	return depth;
}

/** The turn (deg, 0..limit) about unit `axis` at `pivot` at which the chain first touches: 0 when it already does, null when it never does. */
function touchTurn(points, pivot, axis, limit, entries, r) {
	if (limit <= 0 || chainDepth(points, entries, r) >= -TOUCH) return 0;
	const at = deg => { const R = axisRot(axis, deg); return points.map(p => add(pivot, apply(R, sub(p, pivot)))); };
	if (chainDepth(at(limit), entries, r) < -TOUCH) return null;
	let lo = 0, hi = limit;
	for (let i = 0; i < STEPS; i++) { const mid = (lo + hi) / 2; if (chainDepth(at(mid), entries, r) >= -TOUCH) hi = mid; else lo = mid; }
	return hi;
}

/** The turn (deg, 0..limit) back about `axis` that takes a chain inside the body just out of it (0 when it is out, or when
 * no opening leaves it shallower). */
function clearTurn(points, pivot, axis, limit, entries, r) {
	if (chainDepth(points, entries, r) < -TOUCH) return 0;
	const at = deg => { const R = axisRot(axis, -deg); return points.map(p => add(pivot, apply(R, sub(p, pivot)))); };
	// a chain that stays in the body however far it opens opens only if that leaves it shallower
	if (chainDepth(at(limit), entries, r) >= -TOUCH) return chainDepth(at(limit), entries, r) < chainDepth(points, entries, r) ? limit : 0;
	let lo = 0, hi = limit;
	for (let i = 0; i < STEPS; i++) { const mid = (lo + hi) / 2; if (chainDepth(at(mid), entries, r) < -TOUCH) hi = mid; else lo = mid; }
	return hi;
}

const saveChain = (sk, s, j) => new Map(sk.subtree[j].map(i => [i, [s.P[i].slice(), s.R[i].map(r => r.slice())]]));
const restoreChain = (s, saved) => { for (const [i, [p, r]] of saved) { s.P[i] = p.slice(); s.R[i] = r.map(row => row.slice()); } };

/** Degrees each of joints 1..3 of finger f is flexed: each phalanx against the one before about the knuckle line. */
function flexion(sk, s, side, f) {
	const P = i => s.P[sk.index[`${side}Hand${f}${i}`]], { d, l } = palmAxes(sk, s, side), axis = scale(l, side === "Left" ? -1 : 1);
	const flat = v => norm(sub(v, scale(axis, dot(v, axis)))), bone = [1, 2, 3].map(i => flat(norm(sub(P(i + 1), P(i)))));
	return [flat(d), bone[0], bone[1]].map((a, i) => (Math.atan2(dot(cross(a, bone[i]), axis), dot(a, bone[i])) * 180) / Math.PI);
}

/** Closest distance between segments p1-q1 and p2-q2. */
function segmentGap(p1, q1, p2, q2) {
	const d1 = sub(q1, p1), d2 = sub(q2, p2), r = sub(p1, p2), a = dot(d1, d1), e = dot(d2, d2), f = dot(d2, r), c = dot(d1, r), b = dot(d1, d2);
	const den = a * e - b * b, clamp = x => Math.min(1, Math.max(0, x));
	let t1 = den > 1e-12 ? clamp((b * f - c * e) / den) : 0, t2 = e > 1e-12 ? (b * t1 + f) / e : 0;
	if (t2 < 0) { t2 = 0; t1 = clamp(-c / a); } else if (t2 > 1) { t2 = 1; t1 = clamp((b - c) / a); }
	return Math.hypot(...sub(add(p1, scale(d1, t1)), add(p2, scale(d2, t2))));
}

/** True when no phalanx of finger f lies within SELF_GAP (scaled by the rig's hand) of a phalanx of another (non-thumb) finger. */
function clearOfNeighbours(sk, s, side, f) {
	const P = name => s.P[sk.index[`${side}Hand${name}`]], gap = SELF_GAP * rigScale(sk, "hand");
	for (const g of FINGERS) if (g !== f) for (let a = 1; a <= 3; a++) for (let b = 1; b <= 3; b++) {
		if (segmentGap(P(`${f}${a}`), P(`${f}${a + 1}`), P(`${g}${b}`), P(`${g}${b + 1}`)) < gap) return false;
	}
	return true;
}

/** Turns joint j by the touching turn about `axis` (or `limit` when it never touches, unless `air` is false), weighted; true when it touched. */
function closeJoint(sk, s, j, chain, axis, limit, entries, weight, air = true) {
	const turn = touchTurn(chain.map(i => s.P[i]), s.P[j], axis, limit, entries, phalanx(sk)), deg = turn ?? (air ? limit : 0);
	if (deg > 0) rotateSubtree(sk, s, j, s.P[j].slice(), axisRot(axis, deg * weight));
	return turn !== null;
}

/**
 * closeOnShape(sk, s, side, { entries, weight, preset }): the hand on pose s ("Left" | "Right") closes on the shape
 * entries (motion-scene entries at this frame) by `weight` 0..1; `preset` is the hand's finger weights (its fingers_<k>
 * channel), from which each joint may close as far as the fist's curl. Answers { touched: the fingers that reached it }.
 */
export function closeOnShape(sk, s, side, { entries: held, stops = [], weight, preset }) {
	if (!held?.length || !(weight > 0)) return { touched: [] };
	// a finger stops on what it holds or on what that rests against (a table under a ball)
	const entries = [...held, ...stops];
	const sign = side === "Left" ? -1 : 1, J = name => sk.index[`${side}Hand${name}`], touched = [];
	const close = (f, joints) => {
		let tip = false;
		// a finger the preset curled into the body straightens, joint by joint, when the straight finger is shallower (a
		// finger lying across a box would go deeper); each joint then closes until the finger touches
		const pts = joints.map(i => s.P[i]), l0 = scale(palmAxes(sk, s, side).l, sign);
		const straight = [0, 1, 2].reduce((p, k) => { const R = axisRot(l0, -fingerCurl(preset, f, k)); return p.map((q, i) => (i > k ? add(p[k], apply(R, sub(q, p[k]))) : q)); }, pts);
		const r = phalanx(sk), opens = chainDepth(pts, held, r) >= -TOUCH && chainDepth(straight, held, r) < chainDepth(pts, held, r);
		for (let k = 0; k < 3; k++) {
			const axis = scale(palmAxes(sk, s, side).l, sign), curl = fingerCurl(preset, f, k), open = opens ? curl : 0;
			if (open > 0) rotateSubtree(sk, s, joints[k], s.P[joints[k]].slice(), axisRot(axis, -open * weight));
			tip = closeJoint(sk, s, joints[k], joints.slice(k), axis, Math.max(0, fistCurl(f, k) - curl + open), entries, weight, false);
		}
		return tip;
	};
	for (const f of FINGERS) {
		const joints = [1, 2, 3, 4].map(i => J(`${f}${i}`));
		if (joints.some(j => j === undefined)) continue;
		const before = saveChain(sk, s, joints[0]);
		let tip = close(f, joints);
		// a finger whose curl passes beside what it holds (a ring or little finger off a ball's side) turns toward it at the
		// knuckle, SPREAD_STEP at a time up to SPREAD_MAX, and closes again; kept when it touches without lying in a neighbour
		if (!tip && f !== "Middle") {
			const after = saveChain(sk, s, joints[0]), { l, n } = palmAxes(sk, s, side);
			const toward = Math.sign(dot(sub(held[0].pos, before.get(joints[0])[0]), l)) * sign;
			for (let deg = SPREAD_STEP; deg <= SPREAD_MAX && !tip; deg += SPREAD_STEP) {
				restoreChain(s, before);
				rotateSubtree(sk, s, joints[0], s.P[joints[0]].slice(), axisRot(n, toward * sign * deg * weight));
				tip = close(f, joints) && clearOfNeighbours(sk, s, side, f);
			}
			if (!tip) restoreChain(s, after);
		}
		// a finger that still cannot reach it curls with the finger next in toward the middle (the ring and little fingers
		// move together), joint by joint as far as that finger's flexion, stopping where it touches
		const inner = { Ring: "Middle", Pinky: "Ring" }[f];
		if (!tip && inner) {
			const axis = scale(palmAxes(sk, s, side).l, sign);
			for (let k = 0; k < 3; k++) {
				const more = flexion(sk, s, side, inner)[k] - flexion(sk, s, side, f)[k];
				if (more > 1) tip = closeJoint(sk, s, joints[k], joints.slice(k), axis, more, entries, weight, true);
			}
		}
		if (tip) touched.push(f);
	}
	const thumb = [1, 2, 3, 4].map(i => J(`Thumb${i}`));
	if (thumb.every(j => j !== undefined)) {
		// the thumb keeps the preset's turn at its base (wrapThumb); its two outer joints back out of the body when the
		// preset wrapped them into it, then flex until the thumb touches (one that cannot reach it keeps the preset's flex)
		const { n } = palmAxes(sk, s, side);
		let reached = false;
		for (const k of [1, 2]) {
			const axis = scale(norm(cross(norm(sub(s.P[thumb[k + 1]], s.P[thumb[k]])), n)), sign);
			const out = clearTurn(thumb.slice(k).map(i => s.P[i]), s.P[thumb[k]], axis, THUMB_FLEX, entries, phalanx(sk));
			if (out > 0) rotateSubtree(sk, s, thumb[k], s.P[thumb[k]].slice(), axisRot(axis, -out * weight));
			reached = closeJoint(sk, s, thumb[k], thumb.slice(k), axis, THUMB_FLEX, entries, weight, false);
		}
		if (reached) touched.push("Thumb");
	}
	return { touched };
}

/**
 * What hand k closes on at frame f with channels c: the object of its heaviest fit on an object anchor with grasp, while
 * that object is not in its hand yet (a carry's hand holds it by its seat, seat.js), as { entries, weight, preset }; null
 * when it reaches for nothing.
 */
export function heldFor(ctx, c, f, k, s) {
	let best = null;
	for (const fit of ctx.spec.fits ?? []) {
		const a = ctx.spec.anchors?.[fit.anchor], w = c[`w_${fit.anchor}_${k}`] ?? 0;
		if (fit.side !== k || a?.kind !== "object" || !a.grasp || !(w > 1e-4) || (best && best.weight >= w) || ctx.objectHand(a.object, f) === k) continue;
		// a disc's rim socket (a steering wheel) is a ring the scene draws as a solid disc: the hand keeps its rim grip
		if (ctx.sockets?.get(fit.anchor)?.rim) continue;
		const at = ctx.objectsAt(f), entries = partsOf(ctx.scene, a.object).map(p => at[p]).filter(Boolean);
		// as far as the skill has the hand closing (reachGrip keys its grip late in the reach: skills/reach-human.js)
		const grip = Math.min(1, Object.entries(c[`fingers_${k}`] ?? {}).reduce((acc, [p, v]) => acc + (p === "relaxed" ? 0 : v || 0), 0));
		if (entries.length) best = { entries, weight: closing(w) * grip, preset: c[`fingers_${k}`] };
	}
	return best ?? carriedFor(ctx, c, f, k, s);
}

// A carry outlives the reach that took it: reachGrip lets its grip go after `hold` while the object stays in the hand, and
// the thumb, wrapped by the grip preset (limbs.js THUMB_WRAP), swung back out 2.3 cm off the ball it held. While hand k
// holds a seated carry, its grasp's preset is on at full weight, eased in over SETTLE frames from the grab and out over
// SETTLE before a release (a carry that runs to the end of the take stays held).
const SETTLE = 4;
const graspOf = (o, scene, id) => o.grasp ?? ({ sphere: "spherical", cylinder: "power" }[partsOf(scene, id).length === 1 ? shapeOf(scene.objects[partsOf(scene, id)[0]]).kind : "box"] ?? "palm");

/** The finger preset weights of hand k at frame f with channels c: the channel's, with a seated carry's grasp preset held on. */
export function carryFingers(ctx, c, f, k) {
	const { spec, scene } = ctx, own = c[`fingers_${k}`];
	for (const [id, o] of Object.entries(spec.objects ?? {})) {
		if (!seatsInHand(spec, o, scene, id) || spec.props?.[o.prop]?.hand !== k) continue;
		const [grab, release] = ctx.carrySpan(o), on = Math.min(1, (f - grab) / SETTLE, o.release === undefined ? 1 : (release - f) / SETTLE);
		if (!(on > 0)) continue;
		const preset = GRASP_FINGERS[graspOf(o, scene, id)];
		if (preset === "relaxed") return own;
		return { ...own, [preset]: Math.max(own?.[preset] ?? 0, on) };
	}
	return own;
}

/** A carry on the grasp path hand k holds at frame f, at its seat on pose s (seat.js), as { entries, weight, preset }. */
function carriedFor(ctx, c, f, k, s) {
	const { spec, scene } = ctx;
	for (const [id, o] of Object.entries(spec.objects ?? {})) {
		if (!seatsInHand(spec, o, scene, id) || spec.props?.[o.prop]?.hand !== k || !s) continue;
		// the hand holds it from the grab on (the object eases into its seat meanwhile, settleAt)
		const [grab, release] = ctx.carrySpan(o), weight = 1;
		// while the keyed offset is being taken (its grab frame solved without the keys) the hand has nothing seated yet
		if (f < grab || f > release || ctx.hold?.attaching(id)) continue;
		// where it is on this pose (object-pose.js: easing into its seat over the settle, as it is drawn), not the full seat
		const entries = partsOf(scene, id).map(p => ({ ...scene.objects[p], ...ctx.objectPose(p, f, { s }) }));
		const near = Object.entries(ctx.objectsAt(f)).filter(([key, e]) => !partsOf(scene, id).includes(key) && e.half && !e.carried && entries.some(h => Math.hypot(...h.pos.map((v, i) => v - e.pos[i])) < 0.25 + Math.hypot(...e.half))).map(([, e]) => e);
		if (entries.length) return { entries, stops: near, weight, preset: carryFingers(ctx, c, f, k) };
	}
	return null;
}
