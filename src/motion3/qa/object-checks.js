// QA of scene objects the spec carries (C3 and 7.1), as plain issues { kind, msg, frame, value,
// limit } (frame indexes out.frames):
//   GRAB     "<id>: hand 12.0 cm from it at grab", frame = grab, limit = checks.limits.grab
//   CATCH    "<id> missed by 4.2 cm": a carry that takes it out of the air (a fall with v before the grab) is more than
//            CATCH_GAP m from it at the grab (#816, catchObject)
//            (default 0.03 m); the distance runs from the prop origin to the part boxes' surface
//            at their scene pose (where the hand finds them). An object its visible channel shows
//            only from grab on appears in the hand (a cigarette out of a pocket), and one grabbed
//            at frame 0 is in hand from the take's first frame (C3, as with no grab): nothing to
//            pick up (session d5c110a7: a bat kit left on the floor, grab 0, "63.6 cm").
//   COLLIDE  "<part> x <id>": a body capsule in a carried object (every part box of a group) at
//            any frame it is shown, the holding hand and forearm excused (the fingers ride on the
//            hand), and a second hand on the frames it grips the object (../second-hand.js): at
//            weight 0.5 or more, or with its palm inside the object (a grip the arm turns only
//            partly still holds the handle: session 6262a69c, f37-40, the agent allowed it);
//            "<id> x <other>": a carried object in another scene box from grab on, the
//            support it stood on at grab excused for +-3 frames around grab and release. The
//            depths and checks.allow work as for the body (checks.js); <id> is the spec.objects
//            key, so a group reads as one object.
//   REACH    "<id>: 6.2 cm off its keys": a keyed object the hand could not hold where its keys ask (key-checks.js)
import { QA_LIMITS, allowance } from "./checks.js";
import { keyIssues } from "./key-checks.js";
import { capsulesFor, segPoints, sdBox } from "./geometry.js";
import { isCarried, propOrigin } from "../carried.js";
import { objectBoxesAt, partsOf, spanOf, restingAt } from "../object-pose.js";
import { add, sub, apply, dot, cross, len, dist, scale, norm } from "../compiler/math.js";

const NEAR_SUPPORT = 3, CATCH_GAP = 0.03;

const centre = b => add(b.pos, apply(b.R, [0, b.half[1], 0]));
const col = (R, i) => [R[0][i], R[1][i], R[2][i]];

/**
 * Overlap of two boxes (separating axes): { depth, axis } with depth > 0 when they overlap and
 * axis the unit direction that moves `a` out of `b` by depth; depth <= 0 when apart. With
 * `side` (a direction from b toward where a came from) the exit is taken on that side.
 */
export function boxOverlap(a, b, side = null) {
	const ca = centre(a), cb = centre(b), d = sub(ca, cb), A = [0, 1, 2].map(i => col(a.R, i)), B = [0, 1, 2].map(i => col(b.R, i));
	const axes = [...A, ...B, ...A.flatMap(u => B.map(v => cross(u, v)))];
	let best = { depth: Infinity, axis: [0, 1, 0] };
	for (const raw of axes) {
		if (len(raw) < 1e-6) continue;
		const L = norm(raw), r = (box, U) => U.reduce((s, u, i) => s + Math.abs(dot(u, L)) * box.half[i], 0), reach = r(a, A) + r(b, B);
		if (reach - Math.abs(dot(d, L)) <= 0) return { depth: reach - Math.abs(dot(d, L)), axis: L };
		const out = dot(side ?? d, L) < 0 ? scale(L, -1) : L, depth = reach - dot(d, out);
		if (depth < best.depth) best = { depth, axis: out };
	}
	return best;
}

/** True when the palm of hand k (between its index and middle finger, where a grip holds) is inside one of `boxes`: the hand holds the object there. */
const palmIn = (sk, s, k, boxes) => {
	const S = k === "l" ? "Left" : "Right", p = scale(add(s.P[sk.index[`${S}HandIndex2`]], s.P[sk.index[`${S}HandMiddle2`]]), 0.5);
	return boxes.some(b => sdBox(p, b) <= 0);
};

/** True while entry o's record is shown (its `visible` channel above 0.5, or no channel) at absolute f. */
const shownAt = (out, o, f) => !o.visible || (out.baked?.[o.visible]?.[f] ?? 0) > 0.5;

/** The part boxes of `id` where the hand finds it (any frame f, the hint asks later ones too): its scene pose, or where a fall before its grab left it (C17). */
const restingBoxes = (out, id, f) => partsOf(out.ctx.scene, id).map(part => ({ ...out.ctx.scene.objects[part], ...restingAt(out, part, f) }));

/** Prop origin to the nearest part box surface of `id` where it rests before grab, at absolute frame f (0 inside). */
export function grabGap(out, id, f) {
	const { sk, spec } = out.ctx, fr = out.frames[f - (out.f0 ?? 0)];
	if (!fr) return null;
	const p = propOrigin(sk, spec, fr.s, spec.objects[id]);
	return Math.max(0, Math.min(...restingBoxes(out, id, f).map(box => sdBox(p, box))));
}

/** The scene box right below `id` at grab (absolute frame), the support it may touch near grab and release. */
function supportOf(out, id, grab) {
	const parts = restingBoxes(out, id, grab);
	if (!parts.length) return null;
	const low = Math.min(...parts.map(b => b.pos[1] - Math.abs(b.R[1][0]) * b.half[0] - Math.abs(b.R[1][2]) * b.half[2]));
	const c = scale(parts.map(centre).reduce((s, p) => add(s, p), [0, 0, 0]), 1 / parts.length), probe = [c[0], low - 0.01, c[2]];
	let best = null;
	for (const [oid, box] of Object.entries(out.ctx.objectsAt(grab))) {
		if (box.carried || !box.half) continue;
		const d = sdBox(probe, box);
		if (d <= 0.02 && (!best || d < best[1])) best = [oid, d];
	}
	return best?.[0] ?? null;
}

/**
 * objectChecks(sk, out, spec) -> issues
 * @param {object} sk  the rig
 * @param {object} out  compileMotion result (out.ctx.spec, out.ctx.scene; object-pose.js)
 * @param {object} spec  the expanded spec QA measures (checks, objects)
 * @returns {{ kind: string, msg: string, frame: number, value: number, limit: number }[]}
 */
export function objectChecks(sk, out, spec) {
	const carried = Object.entries(out.ctx.spec.objects ?? {}).filter(([, o]) => isCarried(o));
	if (!carried.length) return [];
	const checks = spec.checks ?? {}, L = { ...QA_LIMITS, ...checks.limits }, allow = checks.allow, issues = [], f0 = out.f0 ?? 0, I = sk.index;
	const push = (kind, msg, f, value, limit) => issues.push({ kind, msg, frame: f, value: +value.toFixed(4), limit });
	// checks.allow names the carried id or one of its parts, on either side
	const lim = (parts, objs) => parts.reduce((v, p) => objs.reduce((w, x) => w ?? allowance(allow, p, x), v), null) ?? L.allow;
	for (const [id, o] of carried) {
		const [grab, release] = spanOf(out, o), k = spec.props?.[o.prop]?.hand, excused = new Set([`hand_${k}`, `farm_${k}`]);
		if (o.grab !== undefined && grab > 0 && out.frames[grab - f0] && shownAt(out, o, grab - 1)) {
			const gap = grabGap(out, id, grab);
			// a carry that takes a thing out of the air (a fall with v before its grab: catchObject) misses it: CATCH
			const flying = [o.fall ?? []].flat().some(fl => Array.isArray(fl.v) && fl.at < grab);
			if (flying && gap > CATCH_GAP) push("CATCH", `${id} missed by ${(gap * 100).toFixed(1)} cm`, grab - f0, gap, CATCH_GAP);
			else if (!flying && gap > L.grab) push("GRAB", `${id}: hand ${(gap * 100).toFixed(1)} cm from it at grab`, grab - f0, gap, L.grab);
		}
		const support = o.grab !== undefined ? supportOf(out, id, grab) : null;
		const nearSupport = f => Math.abs(f - grab) <= NEAR_SUPPORT || (o.release !== undefined && Math.abs(f - release) <= NEAR_SUPPORT);
		for (let i = 0; i < out.frames.length; i++) {
			const f = i + f0, boxes = objectBoxesAt(out, id, f);
			if (!boxes || !shownAt(out, o, f)) continue;
			const ids = boxes.map(b => b.id), spheres = boxes.map(b => [b, centre(b), len(b.half)]), { s } = out.frames[i];
			const grips = Object.entries(out.frames[i].diag).filter(([k, v]) => /^hold_[lr]$/.test(k) && v?.second === id && (v.w >= 0.5 || palmIn(sk, s, k.slice(-1), boxes))).map(([k]) => `hand_${k.slice(-1)}`);
			for (const [part, a, b, r] of capsulesFor(sk)) {
				if (excused.has(part) || grips.includes(part)) continue;
				const A = s.P[I[a]], B = s.P[I[b]], mid = scale(add(A, B), 0.5), reach = r + dist(A, B) / 2, l = lim([part], [id, ...ids]);
				let pts = null, pen = -Infinity;
				for (const [box, c, rb] of spheres) {
					if (reach - (dist(mid, c) - rb) <= l) continue;
					pts ??= segPoints(A, B);
					pen = Math.max(pen, r - Math.min(...pts.map(p => sdBox(p, box))));
				}
				if (pen > l) push("COLLIDE", `${part} x ${id}`, i, pen, l);
			}
			if (f < grab) continue;
			for (const [oid, ob] of Object.entries(out.objectsAt(i))) {
				if (!ob.half || ob.ignore || (oid === support && nearSupport(f))) continue;
				const l = lim([id, ...ids], [oid]), oc = centre(ob), orad = len(ob.half);
				let depth = -Infinity;
				for (const [box, c, rb] of spheres) if (dist(c, oc) < rb + orad + l) depth = Math.max(depth, boxOverlap(box, ob).depth);
				if (depth > l) push("COLLIDE", `${id} x ${oid}`, i, depth, l);
			}
		}
	}
	keyIssues(out, L, push);
	return issues;
}
