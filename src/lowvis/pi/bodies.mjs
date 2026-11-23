// The rows against the drawn bodies: how a hand, a foot, a riding prop and a body's limbs end against the parts a look
// draws of a body (its solids, src/lowvis/looks/solids.js, each the convex solid around a part, at the body's scale
// about its joints: the solids the inside rows read; the hands left out), measured on the clip as built. Nothing is
// moved by it. Per frame:
//  - tied: a hand or a foot whose target is a place on a body ({joint, at?, of?}, or {on: characterId, part} as
//    resolveParts writes it), on the frames after that action's blend (aux.reach has the limb on that key): the hand is
//    its wrist to its finger tip (5 points), the foot its sole and toe tip (gaps.mjs); against every drawn part of that
//    body (on the own body, the parts of the limb's own arm or leg left out): inside past LIMIT (the deepest point), or
//    off past GAP (the nearest point to the nearest part), and that far from every prop that rides that body too (a hand
//    on a worn prop is on what the body wears).
//  - ride: a prop that rides a joint that has a drawn part (aux.rides, while it rides: up to its next key or a hand
//    taking it off; on frames it is shown), its box (its drawn parts when it has them; a ball as a ball): sunk into the
//    parts of that joint past LIMIT (the least distance it would have to move to be clear of the part, as the inside
//    rows; not a prop the scene marks hollow: things may be inside it, and a part it is worn around is), or off the
//    body past GAP (its nearest part, when it is that far from the parts of its joint too).
//  - through: a limb (an upper arm, a forearm, a thigh, a shin, a hand, a foot) counts by its line, from its joint to
//    the next joint down the limb or to the rig's tip (finger tip, toe tip): how deep that line lies inside a part's
//    solid at its deepest point. A limb that rests on a part or is pressed into it has its line outside it; past LIMIT
//    the limb is sunk by more than half its thickness and LIMIT. Measured: a body's arms inside its own parts (the
//    arm's own parts and the part its joint hangs from left out), every limb of a body inside another body's parts,
//    and two bodies' other parts (trunk, neck, head) inside each other as solids (separating axes); a hand or a foot
//    inside the body its target is on, from that key to the limb's next and for as long after it as it has been inside
//    that body on every frame (it leaves the place its target gave it), is the tied row's, not this one. The legs inside
//    the own body are not measured: the engine's own steps and postures place them (a kneel puts the shins together),
//    not a spec's target.
// LIMIT and GAP are the inside and the gap rows' own (inside.mjs, gaps.mjs), times the body's scale (for two bodies the
// smaller). A row is told past them on a tenth of a second's worth of frames or more (prompt.mjs seenFrames): one row per
// body, limb and body, per riding prop and body, and per body and body, at its worst frame; of a body and a body, the
// pairs of parts that are each past the limit on that many frames, the deepest of them named.
import { INDEX as J, JOINTS, JOINT_COUNT, OFFSET, PARENT, REST, TIPS } from "../rig17.js";
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
const chainOf = j => CHAIN.findIndex(ch => ch.includes(j));
const ARMS = CHAIN[0].concat(CHAIN[1]), LIMBS = CHAIN.flat(), TIP = j => TIPS[JOINTS[j]]?.map((v, k) => v - REST[j][k]);
/** The length of the rig's bones from the Hips joint down to joint j (m at scale 1). */
const boneLength = j => { let l = 0; for (let k = j; PARENT[k] >= 0; k = PARENT[k]) l += Math.hypot(...OFFSET[k]); return l; };

/** A convex solid in its own frame as the measures read it: corners, triangles, face planes and edge directions. */
function shapeOf(v, t, e) {
	const tris = t.map(([i, j, k]) => ({ i, j, k })), n = [];
	for (const T of tris) { const m = unit(cross(sub(v[T.j], v[T.i]), sub(v[T.k], v[T.i]))); if (m && !n.some(x => dot(x, m) > 1 - 1e-9)) n.push(m); }
	const g = [0, 1, 2].map(k => v.reduce((s, p) => s + p[k], 0) / v.length);
	const d = []; for (const [a, b] of e) { const u = unit(sub(v[b], v[a])); if (u && !d.some(x => Math.abs(dot(x, u)) > 1 - 1e-9)) d.push(u); }
	return { v, tris, n, off: n.map(m => Math.max(...v.map(p => dot(p, m)))), d, e, r: Math.max(...v.map(p => Math.hypot(...sub(p, g)))), g };
}
const cache = {};
/** The solids of a look, each as a shape, with its joint; reach: no drawn part of that look and no tip of the rig lies
 *  further from the Hips joint, however the body is posed (m at scale 1). */
function solidsOf(look) {
	const name = bodyLook(look);
	if (cache[name]) return cache[name];
	const solids = LOOK_SOLIDS[name]().map(o => ({ joint: o.joint, ...shapeOf(o.v, o.t, o.e) }));
	return (cache[name] = { solids, reach: Math.max(...solids.map(o => boneLength(o.joint) + Math.max(...o.v.map(p => Math.hypot(...p)))), ...LIMBS.filter(TIP).map(j => boneLength(j) + Math.hypot(...TIP(j)))) });
}
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
/** How deep the line p q lies inside placed shape W at its deepest point (the least distance from that point to a face;
 *  <= 0: the whole line is outside). The depth along the line is the least of its depths under each face, each linear:
 *  one peak, found by thirds. */
function lineDepth(W, p, q) {
	const o = W.o, a = qRotate(W.iq, sub(p, W.P)), b = qRotate(W.iq, sub(q, W.P)), A = o.n.map((n, i) => o.off[i] * W.s - dot(n, a)), B = o.n.map(n => dot(n, a) - dot(n, b));
	const g = t => { let m = Infinity; for (let i = 0; i < A.length; i++) m = Math.min(m, A[i] + B[i] * t); return m; };
	let lo = 0, hi = 1;
	for (let i = 0; i < 40; i++) { const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3; if (g(m1) < g(m2)) lo = m1; else hi = m2; }
	return g((lo + hi) / 2);
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
	const F = clip.frameCount, seen = seenFrames(clip.fps), { solids, reach } = solidsOf(look), chars = clip.characters, cases = new Map();
	const at = (c, f, j) => { const i = (f * JOINT_COUNT + j) * 3; return [c.pos[i], c.pos[i + 1], c.pos[i + 2]]; };
	const rot = (c, f, j) => { const i = (f * JOINT_COUNT + j) * 4; return [c.quat[i], c.quat[i + 1], c.quat[i + 2], c.quat[i + 3]]; };
	const off = (c, f, j, v) => { const a = at(c, f, j), d = qRotate(rot(c, f, j), v), s = c.scale ?? 1; return [a[0] + d[0] * s, a[1] + d[1] * s, a[2] + d[2] * s]; };
	/** A limb's line: from its joint to the next joint down the limb, or to the rig's tip where the limb ends. */
	const lineOf = (c, f, j) => [at(c, f, j), TIP(j) ? off(c, f, j, TIP(j)) : at(c, f, PARENT.indexOf(j))];
	const handPts = (c, f, i) => { const [w, t] = lineOf(c, f, HAND[i]); return [0, 1, 2, 3, 4].map(n => w.map((v, k) => v + (t[k] - v) * n / 4)); };
	const footPts = (c, f, i) => [off(c, f, FOOT[i], SOLE), off(c, f, FOOT[i], TOE)];
	const posed = (c, f) => solids.map(o => ({ joint: o.joint, W: placed(o, at(c, f, o.joint), rot(c, f, o.joint), c.scale ?? 1) }));
	// a case's frames past the limit are kept per pair of parts (what.pair; a tied or a ride case has one): its worst and its frames
	const note = (key, base, v, f, what) => {
		const e = cases.get(key) ?? cases.set(key, { ...base, key, pairs: new Map() }).get(key), k = what.pair ?? "", p = e.pairs.get(k) ?? e.pairs.set(k, { value: 0, frames: new Set() }).get(k);
		p.frames.add(f);
		if (v > p.value) Object.assign(p, { value: v, frame: f, what });
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
	/** The props that ride a joint of a body on frame f, while they ride and are shown: [{ r: the ride, p: the prop, b: the body }]. */
	const riding = f => (aux.rides ?? []).flatMap(r => { const p = r.joint && r.began != null && f >= r.began && f < (r.next ?? F) && (r.cut ??= heldFrom(aux, r, F)) > f && clip.props.find(x => x.id === r.prop), b = bodyOf.get(r.of); return p && b && p.shown?.[f] !== 0 ? [{ r, p, b }] : []; });
	const left = new Map(); // per hand or foot and body: the last frame it was the tied row's with that body
	const bodyOf = new Map(chars.map(c => [c.id, c])), tiedTo = (c, f, i) => { const k = aux.reach?.[c.id]?.[f]?.[i]?.key; return k == null ? null : tied.get(c.id)[i].get(k) ?? null; };
	const tiedSpan = (c, f, i, id) => spans.get(c.id)[i].some(e => e.body === id && f >= e.a && f < (e.b ?? F));
	const shapes = new Map((def?.props ?? []).map(p => [p.id, p]));
	/** The nearest (or deepest) of a prop's shapes and a body's parts: { sd: signed distance, part }. */
	const nearest = (list, parts) => { let best = { sd: Infinity, part: null }; for (const x of list) for (const { joint, W } of parts) { if (!x.ball && Math.hypot(...sub(x.g, W.g)) - x.r - W.r >= best.sd) continue; const d = x.ball ? pointSd(W, x.c) - x.r : shapeSd(x, W); if (d < best.sd) best = { sd: d, part: JOINTS[joint] }; } return best; };
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
			// off: past GAP from the body and from every prop that rides it (a hand on a worn prop is on what the body wears)
			const inside = deep.v > LIMIT * s, gone = !inside && near.v > GAP * s && !riding(f).some(r => r.b === b && propShapes(r.p, f).some(x => pts.some(q => (x.ball ? Math.hypot(...sub(q, x.c)) - x.r : pointSd(x, q)) <= GAP * s)));
			if (inside || gone) note(`body:${c.id}.${LIMB[i]}>${b.id}`, { who: c.id, body: b.id, limb: LIMB[i], kind: "tied", limits: [LIMIT * s, GAP * s] }, inside ? deep.v : near.v, f, inside ? { inside: true, part: deep.part } : { part: near.part });
		}
		// rides on a joint with a drawn part
		for (const { r, p, b } of riding(f)) {
			const parts = P.get(b.id).filter(x => x.joint === J[r.joint]);
			if (!parts.length) continue;
			const s = b.scale ?? 1, list = propShapes(p, f);
			let near = nearest(list, parts);
			const inside = shapes.get(p.id)?.hollow !== true && -near.sd > LIMIT * s;
			if (near.sd > GAP * s) near = nearest(list, P.get(b.id)); // off its joint's parts: off the body when it is off every part
			const gone = near.sd > GAP * s;
			if (inside || gone) note(`body:${r.prop}.ride>${b.id}`, { prop: r.prop, body: b.id, kind: "ride", joint: r.joint, limits: [LIMIT * s, GAP * s] }, Math.abs(near.sd), f, { inside, part: near.part });
		}
		// limbs through bodies
		chars.forEach((a, ia) => chars.forEach((b, ib) => {
			if (ib < ia) return;
			const own = a === b, s = Math.min(a.scale ?? 1, b.scale ?? 1), lim = LIMIT * s;
			if (!own && apart(at(a, f, J.Hips), at(b, f, J.Hips), reach * ((a.scale ?? 1) + (b.scale ?? 1)))) return;
			const name = (c, x) => (own ? x : `${c.id}'s ${x}`);
			const pair = (c, x, d, y, v) => note(`body:${a.id}.limbs>${b.id}`, { who: a.id, body: b.id, kind: "through", limits: [lim] }, v, f, { pair: `${c.id} ${x}|${y}`, x: name(c, x), y: name(d, y) });
			const limbs = (c, d) => { // c's limbs, each as its line, inside d's parts
				for (const j of own ? ARMS : LIMBS) {
					const i = chainOf(j), hand = CHAIN[i][2] === j && `${c.id} ${i} ${d.id}`, [p, q] = lineOf(c, f, j), deep = []; // hand: a hand or a foot
					if (hand && tiedSpan(c, f, i, d.id)) { left.set(hand, f); continue; } // in the body its target is on: the tied row's
					for (const y of P.get(d.id)) if (!(own && (chainOf(y.joint) === i || PARENT[j] === y.joint)) && segPoint(y.W.g, p, q) <= y.W.r) { const v = lineDepth(y.W, p, q); if (v > lim) deep.push([JOINTS[y.joint], v]); }
					if (hand && deep.length && left.get(hand) === f - 1) { left.set(hand, f); continue; } // and as it leaves that body from inside it
					for (const [y, v] of deep) pair(c, JOINTS[j], d, y, v);
				}
			};
			limbs(a, b);
			if (own) return;
			limbs(b, a);
			for (const x of P.get(a.id)) for (const y of P.get(b.id)) if (chainOf(x.joint) < 0 && chainOf(y.joint) < 0 && !apart(x.W.g, y.W.g, x.W.r + y.W.r)) { const v = overlap(x.W, y.W, lim); if (v > lim) pair(a, JOINTS[x.joint], b, JOINTS[y.joint], v); }
		}));
	}
	// told: the pairs of parts past the limit on enough frames to be seen; a case's row is its deepest such pair
	return [...cases.values()].flatMap(e => {
		const pairs = [...e.pairs.values()].filter(p => p.frames.size >= seen), top = pairs.reduce((a, b) => (b.value > (a?.value ?? 0) ? b : a), null), frames = [...new Set(pairs.flatMap(p => [...p.frames]))].sort((x, y) => x - y);
		return top ? [{ ...e, value: top.value, frame: top.frame, what: top.what, frames: frames.length, first: frames[0], last: frames.at(-1), more: pairs.length - 1 }] : [];
	}).sort((x, y) => y.value - x.value).map(rowOf);
}
/** The first frame a hand holds the prop a ride carries, from the ride's start (the ride ends there; F when none). */
function heldFrom(aux, r, F) { for (let f = r.began; f < (r.next ?? F); f++) if (aux.holders?.[r.prop]?.[f]) return f; return F; }

/** A case as the row measure.mjs tells. */
function rowOf(e) {
	const span = `on ${e.frames} frame${e.frames === 1 ? "" : "s"}, from f${e.first} to f${e.last}`, mm = v => num1(v * 1000), of = e.who === e.body ? "its own drawn body" : `the drawn body of ${e.body}`;
	const base = { key: e.key, value: e.value * 1000, unit: "mm", frame: e.frame, worse: 1 };
	if (e.kind === "tied") return { ...base, label: `${e.who}'s ${e.limb} on ${of}`, short: "off body", who: e.who, note: `${e.what.inside ? `inside its part ${e.what.part}` : `off the body, its nearest part ${e.what.part}`}; past ${mm(e.limits[0])} mm inside or ${mm(e.limits[1])} mm off ${span}` };
	if (e.kind === "ride") return { ...base, label: `${e.prop} riding the drawn body of ${e.body}`, short: "ride body", who: e.body, prop: e.prop, note: `${e.what.inside ? `sunk into its part ${e.what.part}, on whose joint it rides` : `off the body, its nearest part ${e.what.part}`}; past ${mm(e.limits[0])} mm in or ${mm(e.limits[1])} mm off ${span}` };
	const more = e.more;
	return { ...base, label: e.who === e.body ? `${e.who}'s body through its own drawn body` : `the drawn bodies of ${e.who} and ${e.body} through each other`, short: "through", who: e.who, note: `deepest: ${e.what.x} in ${e.what.y}${more > 0 ? `, and ${more} more pair${more === 1 ? "" : "s"} of parts` : ""}; deeper than ${mm(e.limits[0])} mm ${span}` };
}

/** What the body lines measure and leave out, said once in a session (compile-tool.mjs): look, the look the bodies are drawn in. */
export const bodyText = look => `body lines (said once): measured against each body as the ${bodyLook(look)} look draws it (each part the convex solid around it, at the body's scale; hands are not parts), on every frame. A hand (wrist to finger tip) or a foot (sole and toe tip) whose target is a place on a body, after its blend: inside or off that body's nearest part past the limits its line states (on the own body the limb's own arm or leg left out; not off while on a prop that rides the body). A prop riding a joint with a drawn part, its box (its drawn parts; a ball as a ball): sunk into that part by the least move that clears it (a box around a part: no less than the part's size; a hollow prop is not told as sunk), or off every part of the body. Through: an upper arm, forearm, thigh, shin, hand or foot is the line of its joints (to the finger or toe tip), told by that line's depth inside a part, so not while it rests on one: a body's arms in its own parts (the arm's own and the part it hangs from left out; its own legs not measured), any limb in another body's parts, two bodies' other parts in each other as solids; each pair of parts by its own frames, the deepest named. Not counted: a hand or foot inside the body its target is on, up to its next key and while it leaves it (its own line says it). The engine moves nothing because of it.`;
