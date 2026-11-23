// The rows against the drawn bodies: how a hand, a foot, a riding prop and a body's limbs end against the parts a look
// draws of a body (its solids, src/lowvis/looks/solids.js, each the convex solid around a part, at the body's scale
// about its joints: the solids the inside rows read; the hands left out), measured on the clip as built. Nothing is
// moved by it. Per frame:
//  - tied: a hand or a foot whose target is a place on a body ({joint, at?, of?}, or {on: characterId, part} as
//    resolveParts writes it), on the frames after that action's blend (aux.reach has the limb on that key): the hand is
//    its wrist to its finger tip (5 points), the foot its sole and toe tip (gaps.mjs); against every drawn part of that
//    body (on the own body, the parts of the limb's own arm or leg left out): inside past LIMIT (the deepest point), or
//    off past GAP (the nearest point to the nearest part).
//  - ride: a prop that rides a joint that has a drawn part (aux.rides, while it rides: up to its next key or a hand
//    taking it off; on frames it is shown), its box (its drawn parts when it has them; a ball as a ball) against the
//    parts of that joint: sunk past LIMIT or off past GAP.
//  - through: a body's arms (with their hands) inside its own drawn parts (the arm's own parts left out, and a part and
//    the part its joint hangs from), and any two bodies' parts inside each other (each hand as its 5 points), past LIMIT;
//    a hand inside the body its target is on, from that key to the hand's next, is the tied row's, not this one. The
//    legs inside the own body are not measured: the engine's own steps and postures place them (a kneel puts the shins
//    together), not a spec's target.
// LIMIT and GAP are the inside and the gap rows' own (inside.mjs, gaps.mjs), times the body's scale (for two bodies the
// smaller). A row is told past them on a tenth of a second's worth of frames or more (prompt.mjs seenFrames): one row per
// body, limb and body, per riding prop and body, and per body and body, at its worst frame.
import { INDEX as J, JOINTS, JOINT_COUNT, PARENT, REST, TIPS } from "../rig17.js";
import { qMul, qRotate } from "../engine-simple/math.js";
import { SOLE, TOE } from "../engine-simple/solve.js";
import { partBoxes } from "../engine-simple/parts.js";
import { LOOK_SOLIDS } from "../looks/solids.js";
import { bodyLook } from "../engine-simple/body-parts.js";
import { LIMIT } from "./inside.mjs";
import { GAP } from "./gaps.mjs";
import { seenFrames } from "./prompt.mjs";

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const apart = (a, b, r) => { const x = a[0] - b[0], y = a[1] - b[1], z = a[2] - b[2]; return x * x + y * y + z * z > r * r; };
const unit = v => { const l = Math.hypot(...v); return l > 1e-12 ? [v[0] / l, v[1] / l, v[2] / l] : null; };
const num1 = v => String(Math.round(v * 10) / 10);
const SIDE = ["Left", "Right"], LIMB = ["L hand", "R hand", "L foot", "R foot"];
const HAND = [J.LeftHand, J.RightHand], FOOT = [J.LeftFoot, J.RightFoot];
const CHAIN = [0, 1].map(i => ["Arm", "ForeArm", "Hand"].map(n => J[SIDE[i] + n])).concat([0, 1].map(i => ["UpLeg", "Leg", "Foot"].map(n => J[SIDE[i] + n]))); // L arm, R arm, L leg, R leg
const HANDS_MOVE = new Set(["carry", "hold", "place"]);
/** No drawn part of the rig's body lies further than this from its Hips joint at scale 1 (m; the arms out, 0.9 m). */
const REACH = 1.1;
const chainOf = j => CHAIN.findIndex(ch => ch.includes(j));

/** A convex solid in its own frame as the measures read it: corners, triangles, face planes and edge directions. */
function shapeOf(v, t, e) {
	const tris = t.map(([i, j, k]) => ({ i, j, k })), n = [];
	for (const T of tris) { const m = unit(cross(sub(v[T.j], v[T.i]), sub(v[T.k], v[T.i]))); if (m && !n.some(x => dot(x, m) > 1 - 1e-9)) n.push(m); }
	const g = [0, 1, 2].map(k => v.reduce((s, p) => s + p[k], 0) / v.length);
	const d = []; for (const [a, b] of e) { const u = unit(sub(v[b], v[a])); if (u && !d.some(x => Math.abs(dot(x, u)) > 1 - 1e-9)) d.push(u); }
	return { v, tris, n, off: n.map(m => Math.max(...v.map(p => dot(p, m)))), d, e, r: Math.max(...v.map(p => Math.hypot(...sub(p, g)))), g };
}
const cache = {};
/** The solids of a look, each as a shape, with its joint. */
const solidsOf = look => (cache[bodyLook(look)] ??= LOOK_SOLIDS[bodyLook(look)]().map(o => ({ joint: o.joint, ...shapeOf(o.v, o.t, o.e) })));
const BOX_T = [[0, 1, 3], [0, 3, 2], [4, 6, 7], [4, 7, 5], [0, 4, 5], [0, 5, 1], [2, 3, 7], [2, 7, 6], [0, 2, 6], [0, 6, 4], [1, 5, 7], [1, 7, 3]];
const BOX_E = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
/** A box of half sizes h about c, turned q, as a shape in that frame. */
const boxShape = (c, q, h) => shapeOf([0, 1, 2, 3, 4, 5, 6, 7].map(i => { const l = qRotate(q, [(i & 4 ? 1 : -1) * h[0], (i & 2 ? 1 : -1) * h[1], (i & 1 ? 1 : -1) * h[2]]); return [c[0] + l[0], c[1] + l[1], c[2] + l[2]]; }), BOX_T, BOX_E);
/** A shape placed in the world: about P, turned q, scaled s; its corners, normals and edge directions in the world are
 *  worked out when first read. */
function placed(o, P, q, s) {
	const w = x => { const r = qRotate(q, x); return [P[0] + r[0] * s, P[1] + r[1] * s, P[2] + r[2] * s]; };
	let v, n, d;
	return { o, P, q, iq: [-q[0], -q[1], -q[2], q[3]], s, tris: o.tris, e: o.e, g: w(o.g), r: o.r * s,
		get v() { return (v ??= o.v.map(w)); }, get n() { return (n ??= o.n.map(x => qRotate(q, x))); }, get d() { return (d ??= o.d.map(x => qRotate(q, x))); } };
}

/** Distance of point p to the triangle a b c. */
function triDist(p, a, b, c) {
	const n = cross(sub(b, a), sub(c, a)), side = (x, y) => dot(cross(sub(y, x), sub(p, x)), n) >= 0;
	if (dot(n, n) > 1e-24 && side(a, b) && side(b, c) && side(c, a)) return Math.abs(dot(sub(p, a), n)) / Math.hypot(...n);
	return Math.min(segPoint(p, a, b), segPoint(p, b, c), segPoint(p, c, a));
}
function segPoint(p, a, b) { const ab = sub(b, a), l = dot(ab, ab), t = l > 0 ? Math.max(0, Math.min(1, dot(sub(p, a), ab) / l)) : 0; return Math.hypot(...sub(p, [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t])); }
/** Least distance between segments a b and c d. */
function segSeg(a, b, c, d) {
	const u = sub(b, a), v = sub(d, c), w = sub(a, c), A = dot(u, u), B = dot(u, v), C = dot(v, v), D = dot(u, w), E = dot(v, w), den = A * C - B * B;
	let s = den > 1e-18 ? Math.max(0, Math.min(1, (B * E - C * D) / den)) : 0, t = C > 0 ? (B * s + E) / C : 0;
	if (t < 0 || t > 1) { t = Math.max(0, Math.min(1, t)); s = A > 0 ? Math.max(0, Math.min(1, (B * t - D) / A)) : 0; }
	return Math.hypot(...sub([a[0] + u[0] * s, a[1] + u[1] * s, a[2] + u[2] * s], [c[0] + v[0] * t, c[1] + v[1] * t, c[2] + v[2] * t]));
}
/** Signed distance of world point p to shape W (placed, or in the world): below 0, the depth to its nearest face; above
 *  0, the distance (only = true: the largest distance to a face plane, which is no more than the distance, is enough). */
function pointSd(W, p, only = false) {
	const o = W.o ?? W, k = W.o ? W.s : 1, l = W.o ? qRotate(W.iq, sub(p, W.P)).map(x => x / k) : p;
	let m = -Infinity;
	for (let i = 0; i < o.n.length; i++) m = Math.max(m, dot(l, o.n[i]) - o.off[i]);
	if (m <= 0 || only) return m * k;
	let best = Infinity;
	for (const T of o.tris) best = Math.min(best, triDist(l, o.v[T.i], o.v[T.j], o.v[T.k]));
	return best * k;
}
/** How deep two placed shapes overlap by separating axes (their face normals and the crosses of their edges); <= 0 when
 *  apart. Stops as soon as the overlap is at most stop. */
function overlap(A, B, stop = 0) {
	let depth = Infinity;
	const along = u => { let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity; for (const p of A.v) { const x = dot(p, u); a0 = Math.min(a0, x); a1 = Math.max(a1, x); } for (const p of B.v) { const x = dot(p, u); b0 = Math.min(b0, x); b1 = Math.max(b1, x); } depth = Math.min(depth, a1 - b0, b1 - a0); return depth <= stop; };
	for (const u of [...A.n, ...B.n]) if (along(u)) return depth;
	for (const a of A.d) for (const b of B.d) { const u = unit(cross(a, b)); if (u && along(u)) return depth; }
	return depth;
}
/** Signed distance of two placed shapes: below 0, how deep they overlap; above, the least distance between them. */
function shapeSd(A, B) {
	if (!apart(A.g, B.g, A.r + B.r)) { const d = overlap(A, B); if (d > 0) return -d; } // apart by their balls: the exact distance below
	let best = Infinity;
	for (const p of A.v) for (const T of B.tris) best = Math.min(best, triDist(p, B.v[T.i], B.v[T.j], B.v[T.k]));
	for (const p of B.v) for (const T of A.tris) best = Math.min(best, triDist(p, A.v[T.i], A.v[T.j], A.v[T.k]));
	for (const [a, b] of A.e) for (const [c, d] of B.e) best = Math.min(best, segSeg(A.v[a], A.v[b], B.v[c], B.v[d]));
	return best;
}

/** The rows against the drawn bodies (header) of a clip: finished rows for measure.mjs. def: the scene as built (props
 *  with parts); spec: as built (repeats written out, places on parts resolved); look: the look the bodies are drawn in. */
export function bodyRows(clip, aux, { def, spec, look }) {
	const F = clip.frameCount, seen = seenFrames(clip.fps), solids = solidsOf(look), chars = clip.characters, cases = new Map();
	const at = (c, f, j) => { const i = (f * JOINT_COUNT + j) * 3; return [c.pos[i], c.pos[i + 1], c.pos[i + 2]]; };
	const rot = (c, f, j) => { const i = (f * JOINT_COUNT + j) * 4; return [c.quat[i], c.quat[i + 1], c.quat[i + 2], c.quat[i + 3]]; };
	const off = (c, f, j, v) => { const a = at(c, f, j), d = qRotate(rot(c, f, j), v), s = c.scale ?? 1; return [a[0] + d[0] * s, a[1] + d[1] * s, a[2] + d[2] * s]; };
	const handPts = (c, f, i) => { const w = at(c, f, HAND[i]), t = off(c, f, HAND[i], TIPS[SIDE[i] + "Hand"].map((v, k) => v - REST[HAND[i]][k])); return [0, 1, 2, 3, 4].map(n => w.map((v, k) => v + (t[k] - v) * n / 4)); };
	const footPts = (c, f, i) => [off(c, f, FOOT[i], SOLE), off(c, f, FOOT[i], TOE)];
	// the pairs of parts measured; on the own body a limb's part with a part neither of its limb nor next to it
	const allPairs = solids.flatMap((x, m) => solids.map((y, n) => [m, n]));
	const ownPairs = allPairs.filter(([m, n]) => { const x = solids[m].joint, y = solids[n].joint; return chainOf(x) >= 0 && chainOf(x) < 2 && x !== y && chainOf(y) !== chainOf(x) && PARENT[x] !== y && PARENT[y] !== x; });
	const posed = (c, f) => solids.map(o => ({ joint: o.joint, W: placed(o, at(c, f, o.joint), rot(c, f, o.joint), c.scale ?? 1) }));
	const note = (key, base, v, f, past, what) => {
		const e = cases.get(key) ?? cases.set(key, { ...base, key, value: 0, frame: f, frames: 0, first: f, last: f, what: null, pairs: new Set() }).get(key);
		if (!past) return;
		if (!e.frames) e.first = f;
		if (e.last !== f || !e.frames) e.frames++;
		e.last = f;
		if (what.pair) e.pairs.add(what.pair);
		if (v > e.value) Object.assign(e, { value: v, frame: f, what });
	};
	// the tied targets: per character and limb slot, the action frames whose target is a place on a body, and the spans
	// from such a key to the next key of that limb (a carry, hold or place moves both hands)
	const tied = new Map(chars.map(c => [c.id, [new Map(), new Map(), new Map(), new Map()]])), spans = new Map(chars.map(c => [c.id, [[], [], [], []]]));
	for (const c of chars) {
		const acts = (Array.isArray(spec?.[c.id]) ? spec[c.id] : []).filter(a => Array.isArray(a) && Number.isInteger(a[0])).slice().sort((x, y) => x[0] - y[0]), S = spans.get(c.id);
		for (const [f0, verb, o] of acts) {
			const hands = HANDS_MOVE.has(verb), to = verb === "pose" && o ? [o.L ?? o.hands, o.R ?? o.hands, o.footL, o.footR] : [];
			for (let i = 0; i < 4; i++) {
				if (to[i] === undefined && !(hands && i < 2)) continue;
				const open = S[i].at(-1); if (open && open.b == null) open.b = f0;
				const t = to[i], body = t && typeof t === "object" && !Array.isArray(t) && typeof t.joint === "string" ? t.of ?? c.id : null;
				if (body) { tied.get(c.id)[i].set(f0, body); S[i].push({ a: f0, b: null, body }); }
			}
		}
	}
	const bodyOf = new Map(chars.map(c => [c.id, c])), tiedTo = (c, f, i) => { const k = aux.reach?.[c.id]?.[f]?.[i]?.key; return k == null ? null : tied.get(c.id)[i].get(k) ?? null; };
	const tiedSpan = (c, f, i, id) => spans.get(c.id)[i].some(e => e.body === id && f >= e.a && f < (e.b ?? F));
	const shapes = new Map((def?.props ?? []).map(p => [p.id, p]));
	const propShapes = (p, f) => {
		const k = p.pos.length === 3 ? 0 : f, c = Array.from(p.pos.slice(k * 3, k * 3 + 3)), q = Array.from(p.quat.slice(k * 4, k * 4 + 4)), boxes = p.shape === "sphere" ? null : partBoxes(shapes.get(p.id));
		if (p.shape === "sphere") return [{ ball: true, c, r: p.size[0] / 2 }];
		return (boxes ?? [{ c: [0, 0, 0], q: [0, 0, 0, 1], h: p.size.map(v => v / 2) }]).map(b => { const o = qRotate(q, b.c); return boxShape([c[0] + o[0], c[1] + o[1], c[2] + o[2]], qMul(q, b.q), b.h); });
	};
	for (let f = 0; f < F; f++) {
		const P = new Map(chars.map(c => [c.id, posed(c, f)]));
		// tied hands and feet
		for (const c of chars) for (let i = 0; i < 4; i++) {
			const to = tiedTo(c, f, i), b = to && bodyOf.get(to);
			if (!b) continue;
			const pts = i < 2 ? handPts(c, f, i) : footPts(c, f, i - 2), own = b === c, s = c.scale ?? 1;
			let deep = { v: 0, part: null }, near = { v: Infinity, part: null };
			const parts = P.get(b.id).filter(x => !(own && CHAIN[i].includes(x.joint))), bound = parts.map(({ W }) => pts.map(p => pointSd(W, p, true)));
			parts.forEach(({ joint }, n) => bound[n].forEach(d => { if (-d > deep.v) deep = { v: -d, part: JOINTS[joint] }; }));
			if (!(deep.v > LIMIT * s)) parts.forEach(({ joint, W }, n) => pts.forEach((p, k) => { // the distance where its plane bound can be the nearest
				if (bound[n][k] >= near.v) return;
				const d = Math.max(0, pointSd(W, p)); if (d < near.v) near = { v: d, part: JOINTS[joint] };
			}));
			const inside = deep.v > LIMIT * s, gone = !inside && near.v > GAP * s;
			note(`body:${c.id}.${LIMB[i]}>${b.id}`, { who: c.id, body: b.id, limb: LIMB[i], kind: "tied", limits: [LIMIT * s, GAP * s] }, inside ? deep.v : gone ? near.v : 0, f, inside || gone, inside ? { inside: true, part: deep.part } : { part: near.part });
		}
		// rides on a joint with a drawn part
		for (const r of aux.rides ?? []) {
			if (!r.joint || r.began == null || f < r.began || f >= (r.next ?? F)) continue;
			const p = clip.props.find(x => x.id === r.prop), b = bodyOf.get(r.of);
			if (!p || !b || p.shown?.[f] === 0 || (r.cut ??= heldFrom(aux, r, F)) <= f) continue;
			const parts = P.get(b.id).filter(x => x.joint === J[r.joint]);
			if (!parts.length) continue;
			const s = b.scale ?? 1;
			let sd = Infinity, part = null;
			for (const x of propShapes(p, f)) for (const { joint, W } of parts) { const d = x.ball ? pointSd(W, x.c) - x.r : shapeSd(x, W); if (d < sd) { sd = d; part = JOINTS[joint]; } }
			const inside = -sd > LIMIT * s, gone = sd > GAP * s;
			note(`body:${r.prop}.ride>${b.id}`, { prop: r.prop, body: b.id, kind: "ride", joint: r.joint, limits: [LIMIT * s, GAP * s] }, Math.abs(sd), f, inside || gone, { inside, part });
		}
		// limbs through bodies
		chars.forEach((a, ia) => chars.forEach((b, ib) => {
			if (ib < ia) return;
			const own = a === b, s = Math.min(a.scale ?? 1, b.scale ?? 1), lim = LIMIT * s, A = P.get(a.id), B = P.get(b.id);
			if (!own && apart(at(a, f, J.Hips), at(b, f, J.Hips), REACH * ((a.scale ?? 1) + (b.scale ?? 1)))) return;
			const pair = (x, y, d) => { if (d > lim) note(`body:${a.id}.limbs>${b.id}`, { who: a.id, body: b.id, kind: "through", limits: [lim] }, d, f, true, { pair: `${x}|${y}`, x, y }); };
			for (const [m, n] of own ? ownPairs : allPairs) {
				const x = A[m], y = B[n];
				if (!apart(x.W.g, y.W.g, x.W.r + y.W.r)) pair(JOINTS[x.joint], JOINTS[y.joint], overlap(x.W, y.W, lim));
			}
			const hands = (c, d, D) => [0, 1].forEach(i => { // c's hands inside d's parts, but in the body a target of that hand is on (from its key to the hand's next)
				if (tiedSpan(c, f, i, d.id)) return;
				const pts = handPts(c, f, i);
				for (const y of D) {
					if (c === d && CHAIN[i].includes(y.joint)) continue;
					if (pts.every(p => apart(p, y.W.g, y.W.r))) continue;
					pair(`${SIDE[i]}Hand`, JOINTS[y.joint], Math.max(...pts.map(p => -pointSd(y.W, p, true))));
				}
			});
			hands(a, b, B);
			if (!own) hands(b, a, A);
		}));
	}
	return [...cases.values()].filter(e => e.frames >= seen).sort((x, y) => y.value - x.value).map(rowOf);
}
/** The first frame a hand holds the prop a ride carries, from the ride's start (the ride ends there; F when none). */
function heldFrom(aux, r, F) { for (let f = r.began; f < (r.next ?? F); f++) if (aux.holders?.[r.prop]?.[f]) return f; return F; }

/** A case as the row measure.mjs tells. */
function rowOf(e) {
	const span = `on ${e.frames} frame${e.frames === 1 ? "" : "s"}, from f${e.first} to f${e.last}`, mm = v => num1(v * 1000), of = e.who === e.body ? "its own drawn body" : `the drawn body of ${e.body}`;
	const base = { key: e.key, value: e.value * 1000, unit: "mm", frame: e.frame, worse: 1 };
	if (e.kind === "tied") return { ...base, label: `${e.who}'s ${e.limb} on ${of}`, short: "off body", who: e.who, note: `${e.what.inside ? "inside" : "off"} its part ${e.what.part}; past ${mm(e.limits[0])} mm inside or ${mm(e.limits[1])} mm off ${span}` };
	if (e.kind === "ride") return { ...base, label: `${e.prop} riding the drawn body of ${e.body}`, short: "ride body", who: e.body, prop: e.prop, note: `${e.what.inside ? "sunk into" : "off"} its part ${e.what.part}, on whose joint it rides; past ${mm(e.limits[0])} mm in or ${mm(e.limits[1])} mm off ${span}` };
	const more = e.pairs.size - 1;
	return { ...base, label: `${e.who}'s body through ${e.who === e.body ? "its own drawn body" : `the drawn body of ${e.body}`}`, short: "through", who: e.who, note: `deepest: ${e.what.x} in ${e.what.y}${more > 0 ? `, and ${more} more pair${more === 1 ? "" : "s"} of parts` : ""}; deeper than ${mm(e.limits[0])} mm ${span}` };
}

/** What the body lines measure and leave out, said once in a session (compile-tool.mjs): look, the look the bodies are drawn in. */
export const bodyText = look => `body lines (said once): measured against each body as the ${bodyLook(look)} look draws it (each part the convex solid around it, at the body's scale; its hands are not parts), on every frame. A hand (its wrist to its finger tip) or a foot (its sole and toe tip) whose target is a place on a body, after its blend: inside past the inside limit or off past the gap limit its line states, against that body's nearest part (on the own body the limb's own arm or leg left out). A prop that rides a joint with a drawn part, while it rides: its box (its drawn parts, a ball as a ball) sunk into or off that part. A body's arms with its hands inside its own parts (its own arm and the part its joint hangs from left out; its legs inside it are not measured), and any two bodies' parts inside each other: the deepest pair of parts. Not counted: a hand inside the body its target is on (its own line says it). The engine moves nothing because of it.`;
