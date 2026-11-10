// Hints for object issues (C3, C6, 7.1). A hint function takes the explain context X
// (qa/explain.js) and the group g and returns { cause, hint, fix? } (fix: see qa/patch.js).
//   GRAB     looks within +-24 frames for the frame nearest the grab where the hand is within the
//            limit and proposes fix { path: "/objects/<id>/grab", value: f }; failing that it
//            moves the hand to the object (moveHint) with a fix on what drives the hand
//   COLLIDE  for a carried object ("<part> x <id>", "<id> x <other>") moves the holding hand,
//            so the object comes out; the other hand's arm in it while that hand is on an object
//            anchor on it moves the anchor's local point out instead; any other COLLIDE is the body hint (hints-contact.js)
//   REACH    for a keyed object ("<id>: 6.2 cm off its keys", key-checks.js); else the arm and leg hint (hints-motion.js)
import { contactHints, moveHint } from "./hints-contact.js";
import { motionHints } from "./hints-motion.js";
import { keyHint } from "./key-checks.js";
import { capsulesFor, segPoints, sdBox, boxNormal } from "./geometry.js";
import { grabGap, boxOverlap } from "./object-checks.js";
import { isCarried, propOrigin } from "../carried.js";
import { objectBoxesAt, partsOf, spanOf } from "../object-pose.js";
import { groupsOf } from "../scene.js";
import { sub, scale, len, apply, T, add, clamp } from "../compiler/math.js";

const MARGIN = 0.003, SEARCH = 24;

/** A fix that moves hand k by delta at f, on whatever drives it there (hand channel, fit or world anchor). */
function handFix(X, k, f, delta) {
	const d = X.hand(k, f);
	if (d.ch === `hand_${k}`) return { channel: d.ch, f, delta };
	if (d.fit !== null && d.fit !== undefined) return X.spec.fits[d.fit].offset ? { path: `/fits/${d.fit}/offset`, delta } : { path: `/fits/${d.fit}/offset`, value: delta };
	if (d.anchor && X.spec.anchors?.[d.anchor]?.kind === "world") return { path: `/anchors/${d.anchor}/p`, delta };
	return undefined;
}

function moveHand(X, k, f, delta, why) {
	const r = moveHint(X, `hand_${k}`, f, delta, why), fix = handFix(X, k, f, delta);
	return fix ? { ...r, fix } : r;
}

/** True when hand k is on an object anchor (weight > 0.5) on record `id` or a body or group under it at f. */
function anchoredOn(X, k, f, id) {
	const a = X.spec.anchors?.[X.hand(k, f).anchor], scene = X.out.ctx.scene;
	return a?.kind === "object" && [scene.objects?.[a.object]?.ancestors, groupsOf(scene)[a.object]?.ancestors, [a.object]].some(ids => ids?.includes(id));
}

/** Closest point of a box (base pivot) to p. */
function closest(box, p) {
	const q = apply(T(box.R), sub(p, box.pos)), c = [0, box.half[1], 0];
	return add(box.pos, apply(box.R, q.map((v, i) => clamp(v, c[i] - box.half[i], c[i] + box.half[i]))));
}

export const objectHints = {
	REACH: (X, g) => keyHint(X, g) ?? motionHints.REACH(X, g),
	/** GRAB(X, g) -> { cause, hint, fix? } */
	GRAB(X, g) {
		const id = g.subject.split(":")[0], grab = g.worstFrame, o = X.spec?.objects?.[id];
		const plain = { cause: `objects.${id}.grab`, hint: `${id}: move the hand to it by f${grab}, or set objects.${id}.grab to the frame the hand arrives` };
		if (!X.out || !isCarried(o)) return plain;
		let best = null;
		for (let f = grab - SEARCH; f <= grab + SEARCH; f++) {
			const gap = grabGap(X.out, id, f);
			if (gap !== null && gap <= g.limit && (!best || Math.abs(f - grab) < Math.abs(best[0] - grab))) best = [f, gap];
		}
		if (best) return { cause: plain.cause, hint: `${id}: set objects.${id}.grab to ${best[0]} (the hand is ${(best[1] * 100).toFixed(1)} cm from it there, ${(g.worst * 100).toFixed(1)} cm at f${grab})`, fix: { path: `/objects/${id}/grab`, value: best[0] } };
		const { sk, spec, scene } = X.out.ctx, p = propOrigin(sk, spec, X.fr(grab).s, o);
		const target = partsOf(scene, id).map(part => closest(scene.objects[part], p)).reduce((a, b) => (len(sub(b, p)) < len(sub(a, p)) ? b : a));
		const gap = len(sub(target, p)), delta = scale(sub(target, p), gap > 1e-9 ? (gap - g.limit / 2) / gap : 0);
		const r = moveHand(X, spec.props[o.prop].hand, grab, delta, ` (to ${id} at grab)`);
		return { ...r, hint: `${r.hint}; or set objects.${id}.grab to the frame the hand arrives` };
	},
	/** COLLIDE(X, g) for a carried object, else the body hint. */
	COLLIDE(X, g) {
		const [, a, b] = /^(\S+) x (.+)$/.exec(g.subject) ?? [], objects = X.spec?.objects ?? {};
		const id = isCarried(objects[b]) ? b : isCarried(objects[a]) ? a : null;
		if (!id || !X.out) return contactHints.COLLIDE(X, g);
		const o = objects[id], k = X.spec.props[o.prop].hand, [grab, release] = spanOf(X.out, o), need = g.worst - g.limit + MARGIN;
		const f = g.worstFrame, held = f >= grab && f <= release, at = Math.min(f, release), boxes = objectBoxesAt(X.out, id, f) ?? [];
		if (id === b) {
			const cap = capsulesFor(X.sk).find(c => c[0] === a), { s } = X.fr(f);
			if (!cap || !boxes.length) return null;
			const pts = segPoints(s.P[X.I[cap[1]]], s.P[X.I[cap[2]]]);
			const [box, p] = boxes.flatMap(bx => pts.map(q => [bx, q])).reduce((m, x) => (sdBox(x[1], x[0]) < sdBox(m[1], m[0]) ? x : m));
			const n = boxNormal(p, box), j = /^(hand|farm|uarm)_([lr])$/.exec(a)?.[2];
			// the other hand on an object anchor on what hand k carries rides with it: moving the carry cannot part them, its point moves out
			if (held && j && j !== k && anchoredOn(X, j, f, id)) return moveHint(X, `hand_${j}`, f, scale(n, need), ` (out of ${id})`);
			return held ? moveHand(X, k, f, scale(n, -need), ` (${id} off ${a})`) : moveHint(X, a, f, scale(n, need), ` (out of ${id})`);
		}
		const ob = X.out.objectsAt(X.rel(f))[b];
		if (!ob || !boxes.length) return null;
		// out on the side it came from: where it was the frame before the hit (or at grab)
		const was = objectBoxesAt(X.out, id, Math.max(grab, g.first - 1)) ?? boxes;
		const hit = boxes.map((bx, i) => boxOverlap(bx, ob, sub(was[i].pos, ob.pos))).reduce((m, x) => (x.depth > m.depth ? x : m));
		return moveHand(X, k, at, scale(hit.axis, hit.depth - g.limit + MARGIN), held ? ` (${id} out of ${b})` : ` (${id} is put down in ${b}; it stays where the hand lets go at f${release})`);
	},
};
