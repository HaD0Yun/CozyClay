// Task checks the agent declares in spec.checks (balance is style: style.js).
//   contacts:  [{ name, point, target, tol, when }]       point on target (e.g. filter on lips)
//   orient:    [{ name, from, to, along, minCos, when }]  direction from->to against "face" | "up" | [x,y,z]
//   below:     [{ name, joint, ref, min, when }]          joint at least `min` m below ref (no chicken wing)
//   clearance: [{ name, part, object, min, frames }]      body part keeps `min` m from an object
//   appear:    [{ name, channel, joint, anchor, tol }]    a visibility switch happens with joint at anchor
//   supports:  [{ object, part, tol }]                     frames where `part` rests on `object` skip balance (style.js)
// point/from/to: "joint:Name" | "prop:name.point" | "anchor:name"; when: weight channel (> 0.99) or [f0, f1].
// f below indexes out.frames (frame out.f0 + f when the compile was windowed).
import { sub, dot, norm, len } from "../compiler/math.js";
import { carried } from "../compiler/limbs.js";
import { resolveAnchor } from "../compiler/anchors.js";
import { capsulesFor, segPoints, sdBox } from "./geometry.js";
import { refDistance } from "../refs.js";
import { seatsInHand } from "../seat.js";
import { handOf } from "../object-pose.js";

export function pointOf(out, f, ref) {
	const { s, diag, c } = out.frames[f], [kind, rest] = ref.split(/:(.*)/s);
	if (kind === "joint") return s.P[out.ctx.sk.index[rest]];
	if (kind === "prop") { const [p, pt] = rest.split("."); return diag.props?.[p]?.[pt] ?? null; }
	if (kind === "anchor") return resolveAnchor(out.ctx, rest, s, diag, c);
	throw new Error(`MOTION_SPEC_INVALID: check point "${ref}"`);
}

/** The part a contact target "anchor:<name>" holds by when that anchor takes a grasp (its socket's owner, else its object), else null. */
/** The carry on the grasp path (seat.js) the hand of prop point `ref` holds at absolute frame f, or null (#816). */
function seatedIn(out, ref, f) {
	const prop = /^prop:([^.]+)\./.exec(ref)?.[1], k = out.ctx.spec.props?.[prop]?.hand, { spec, scene } = out.ctx;
	return k ? Object.keys(spec.objects ?? {}).find(id => seatsInHand(spec, spec.objects[id], scene, id) && handOf(out, id, f) === k) ?? null : null;
}

function graspPart(out, ref) {
	const [kind, name] = ref.split(/:(.*)/s), a = kind === "anchor" ? out.ctx.spec.anchors?.[name] : null;
	if (a?.kind !== "object" || !a.grasp) return null;
	return out.ctx.sockets?.get(name)?.owner ?? a.object;
}

export const active = (out, f, when) => (Array.isArray(when) ? f + (out.f0 ?? 0) >= when[0] && f + (out.f0 ?? 0) <= when[1] : when ? (out.frames[f].c[when] ?? 0) > 0.99 : true);

function alongDir(out, f, along) {
	if (along === "up") return [0, 1, 0];
	if (along === "face") return carried(out.ctx.sk, out.frames[f].s, out.ctx.sk.index.Head, [0, 0, 1]);
	return norm(along);
}

/** How far a checks.contacts entry k's point is from its target at frame f (indexes out.frames), m; null when a point is unknown there. */
export function contactGap(out, f, k) {
	const a = pointOf(out, f, k.point), b = pointOf(out, f, k.target);
	if (!a || !b) return null;
	// on a grasp's anchor the fingers close on the held part wherever the grasp turned them round it: they are on it
	// when they are on its surface (as goals' near on an object), not on one point of it (session 7f15b4ae: 0.4 cm
	// on the cup, read as 5.3 cm from the anchor)
	// and a hand that holds a thing resting in its palm (seat.js) has its fingers on that thing's surface
	const held = graspPart(out, k.target) ?? seatedIn(out, k.point, f + (out.f0 ?? 0));
	return held ? refDistance(out, f, k.point, `object:${held}`) ?? len(sub(a, b)) : len(sub(a, b));
}

export function specChecks(out, checks = {}) {
	const issues = [], n = out.frames.length, sk = out.ctx.sk, I = sk.index;
	const push = (kind, msg, f, value, limit) => issues.push({ kind, msg, frame: f, value: +value.toFixed(4), limit });
	for (let f = 0; f < n; f++) {
		for (const k of checks.contacts ?? []) if (active(out, f, k.when)) {
			const e = contactGap(out, f, k);
			if (e !== null && e > (k.tol ?? 0.01)) push("CONTACT", `${k.name}: ${(e * 100).toFixed(1)} cm apart`, f, e, k.tol ?? 0.01);
		}
		for (const k of checks.orient ?? []) if (active(out, f, k.when)) {
			const a = pointOf(out, f, k.from), b = pointOf(out, f, k.to);
			if (!a || !b) continue;
			const cosv = dot(norm(sub(b, a)), alongDir(out, f, k.along));
			if (cosv < (k.minCos ?? 0.64)) push("ORIENT", `${k.name}: cos ${cosv.toFixed(2)}`, f, cosv, k.minCos ?? 0.64);
		}
		for (const k of checks.below ?? []) if (active(out, f, k.when)) {
			const { P } = out.frames[f].s, drop = P[I[k.ref]][1] - P[I[k.joint]][1];
			if (drop < (k.min ?? 0.08)) push("BELOW", `${k.name}: ${k.joint} only ${(drop * 100).toFixed(1)} cm below ${k.ref}`, f, drop, k.min ?? 0.08);
		}
		for (const k of checks.clearance ?? []) if (active(out, f, k.frames)) {
			const box = out.objectsAt(f)[k.object], cap = capsulesFor(out.ctx.sk).find(c => c[0] === k.part);
			if (!box || !cap) continue;
			const { P } = out.frames[f].s, d = Math.min(...segPoints(P[I[cap[1]]], P[I[cap[2]]]).map(p => sdBox(p, box))) - cap[3];
			if (d < k.min) push("CLEARANCE", `${k.name}: ${(d * 100).toFixed(1)} cm`, f, d, k.min);
		}
	}
	for (const k of checks.appear ?? []) for (let f = 1; f < n; f++) {
		const was = (out.frames[f - 1].c[k.channel] ?? 0) > 0.5, is = (out.frames[f].c[k.channel] ?? 0) > 0.5;
		if (was === is) continue;
		const e = len(sub(pointOf(out, f, `joint:${k.joint}`), pointOf(out, f, `anchor:${k.anchor}`)));
		if (e > (k.tol ?? 0.035)) push("APPEAR", `${k.name}: switches with the hand ${(e * 100).toFixed(1)} cm from ${k.anchor}`, f, e, k.tol ?? 0.035);
	}
	return issues;
}
