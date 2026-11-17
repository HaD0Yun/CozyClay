// Places that follow something other than the own body, and one prop held by any number of hands.
//  - {on: propId, at}: a place on a prop, `at` from its centre in its own frame.
//  - {joint, at, of: characterId}: a place on another character's body that follows that joint.
//  - hold that shares (hand "both", an `at`, a second hand of the same character, or a prop another character holds):
//    every holding hand keeps its place on the prop; the prop takes the place and turn that best puts each place on its
//    hand. A release of one hand leaves the others holding, of a hold or of a carry.
// The frame loop of engine.js runs every character twice. What one character reads of another body or of a prop is
// fixed for each pass, so the order of the characters in the scene does not change the clip: on the first pass the
// state at the start of the frame (another body: its last pose carried with its body), on the second the state after
// the first pass of every character and the fit of every shared prop. Props that ride on others are moved onto their
// carriers before each pass reads them.
import { INDEX as J, qAxisAngle } from "../rig17.js";
import { add, cross, dot, len, mul, qConj, qMul, qRotate, qY, sub } from "./math.js";
import { PAD } from "./prop-frame.js";
import { moveRiders } from "./ride.js";
import { solveSized } from "./size.js";

const HAND = [J.LeftHand, J.RightHand], SIDE = ["L", "R"];
const END = [J.LeftHand, J.RightHand, J.LeftFoot, J.RightFoot, J.LeftForeArm, J.RightForeArm]; // the joint of each reach slot
const pointOf = (P, j, at) => add(P.pos[j], qRotate(P.quat[j], at ?? [0, 0, 0]));
const jointOf = name => { const j = J[name]; if (j == null) throw new Error(`engine-simple: unknown joint "${name}"; want one of ${Object.keys(J).join(", ")}`); return j; };

/** Each prop's place and turn at the start of the frame, after its keys and with its riders on their carriers: what
 *  the first pass reads of it. */
export function startFrame(props, f) {
	moveRiders(props, f);
	for (const p of Object.values(props)) { p.at0 = { c: p.c.slice(), q: p.q.slice() }; p.at1 = null; }
}

/** A world point on prop `id` ({on, at}), as the current pass reads the prop; final: as it ended this frame. */
export function onPoint(props, to, final = false) {
	const p = props[to.on];
	if (!p) throw new Error(`engine-simple: {on: ${JSON.stringify(to.on)}} wants a prop id; props: ${Object.keys(props).join(", ")}`);
	const s = final ? p : p.at1 ?? p.at0 ?? p;
	return add(s.c, qRotate(s.q, to.at ?? [0, 0, 0]));
}

/** A world point on another character's joint ({joint, at, of}), as the current pass reads that body; final: as it
 *  ended this frame (for the reach rows). */
export function otherPoint(byId, to, f, final = false) {
	const o = byId[to.of], j = jointOf(to.joint);
	if (!o) throw new Error(`engine-simple: {joint, of: ${JSON.stringify(to.of)}} wants a character id; characters: ${Object.keys(byId).join(", ")}`);
	if (final) return pointOf(o.poseNow, j, to.at);
	if (o.snapF === f) return pointOf(o.snap, j, to.at);
	if (!o.world || !o.prevB) return pointOf(solveSized(o.body[f], {}, o.s), j, to.at);
	const B = o.body[f], turn = qY(B.yaw - o.prevB.yaw); // its last pose, carried with its body to this frame
	return add(add(B.p, qRotate(turn, sub(o.world.pos[j], o.prevB.p))), qRotate(qMul(turn, o.world.quat[j]), to.at ?? [0, 0, 0]));
}

/** The shared side of a prop event (buildUpper's events) of character c at frame f. Returns true when it is handled
 *  here; false lets engine.js run the event as a single holder's (carry, a hold in one hand, a let-go of it). */
export function shareEvent(p, c, e, f, byId) {
	// the hands that held it alone, as grips, each where it is (a carry of c's own only when c lets go of one hand of it)
	const alone = own => {
		const o = byId[p.holder];
		if (!o || (o === c && p.hand == null && !own)) return [];
		return (p.hand != null ? [p.hand] : [0, 1]).map(i => ({ c: o, i, key: p.takenAt ?? f, ask: null, here: true, g: null }));
	};
	if (e.holder == null) { // release / place: this character lets go (e.lets: only that hand)
		if (!p.grips && e.lets != null && p.holder === c.id) {
			if (p.hand != null && p.hand !== e.lets) return true; // that hand does not hold it: nothing to let go
			if (p.hand == null) p.grips = alone(true);
		}
		if (!p.grips) return false;
		p.grips = p.grips.filter(g => g.c !== c || (e.lets != null && g.i !== e.lets));
		if (p.grips.length) return held(p);
		free(p);
		return false;
	}
	if (e.hand === undefined && !e.share) { free(p); return false; } // carry takes the prop from every other hand
	const hands = e.hands ?? [e.hand];
	if (!e.share && !p.grips && !(p.holder && (p.holder !== c.id || (p.hand != null && p.hand !== e.hand)))) { free(p); return false; }
	p.grips = (p.grips ?? alone(false)).filter(g => g.c !== c || !hands.includes(g.i)); // these hands take hold again, the others hold on
	for (const i of hands) p.grips.push({ c, i, key: e.key ?? f, ask: e.at?.[i] ?? null, g: null });
	p.takenAt = f;
	return held(p);
}
const label = p => p.grips.map(g => `${g.c.id}:${SIDE[g.i]}`).join("+");
const held = p => { p.holder = label(p); p.hand = null; p.slide = false; return true; };
/** No hand holds the prop through here any more: nothing of the last set of hands is kept for the next. */
const free = p => { p.grips = null; p.set = null; };
const wrap = a => a - 2 * Math.PI * Math.round(a / (2 * Math.PI));

/** Between the two passes: every body's pose of this frame is kept for the second pass, a hand that took hold this
 *  frame gets its place (the one asked; a hand that held it alone: where it is; else the point of the prop nearest to
 *  it, a wrist's pad off its surface;
 *  g.took: how far it was from it), and every shared prop is fitted to its holding hands. A hand that took hold short
 *  of its place pulls the prop to it. A prop in one hand alone keeps the turn it had in that hand when it came to hold
 *  it alone (c.gripTurn: that turn, for aim). In more hands, about an axis the places hardly fix it keeps the turn it
 *  had when these hands took it, turned about the vertical as far as its holders' bodies have turned since. */
export function afterFirstPass(props, chars, f) {
	for (const c of chars) { c.snap = c.poseNow; c.snapF = f; c.gripTurn = [null, null]; }
	for (const p of Object.values(props)) {
		if (!p.grips) continue;
		const hand = g => g.c.poseNow.pos[HAND[g.i]];
		for (const g of p.grips) if (!g.g) {
			const now = qRotate(qConj(p.q), sub(hand(g), p.c)), pad = PAD * g.c.s;
			g.g = g.ask ?? (g.here ? now : now.map((v, k) => Math.max(-p.size[k] / 2 - pad, Math.min(p.size[k] / 2 + pad, v))));
			g.took = { f, d: len(sub(g.g, now)) };
		}
		const set = label(p), fresh = p.set !== set || p.grips.some(g => g.yaw == null);
		for (const g of p.grips) { const y = g.c.body[f].yaw; g.turned = fresh ? 0 : g.turned + wrap(y - g.yaw); g.yaw = y; }
		if (fresh) p.ref = p.q; // the turn the prop has when this set of hands takes it
		if (p.grips.length === 1) { // one hand: the prop is fixed in it as it was when this hand came to hold it alone
			const g = p.grips[0], hq = g.c.poseNow.quat[HAND[g.i]];
			if (fresh) { p.gripTurn = qMul(qConj(hq), p.q); g.c.gripHand = g.i; }
			p.q = qMul(hq, p.gripTurn); g.c.gripTurn[g.i] = p.gripTurn;
		} else p.q = fitTurn(p.q, qMul(qY(p.grips.reduce((s, g) => s + g.turned, 0) / p.grips.length), p.ref), p.grips.map(g => g.g), p.grips.map(hand));
		const gc = mean(p.grips.map(g => g.g)), hc = mean(p.grips.map(hand));
		p.c = sub(hc, qRotate(p.q, gc));
		const z = qRotate(p.q, [0, 0, 1]);
		p.yaw = Math.atan2(z[0], z[2]); p.set = set; p.holder = set;
	}
	moveRiders(props, f); // a prop that rides on one the first pass moved goes with it
	for (const p of Object.values(props)) p.at1 = { c: p.c.slice(), q: p.q.slice() };
}

/** Second pass: each hand of c that holds a shared prop goes to its place on it (toBody: a world point into the space
 *  the pose is solved in), which its reach entry measures it against, finished on every frame of the hold; on the frame
 *  it took hold, h.took is how far it was from that place (the prop then moved to it): a fact of the entry's own. */
export function onPlaces(props, c, U, f, toBody) {
	for (const p of Object.values(props)) for (const g of p.grips ?? []) {
		if (g.c !== c) continue;
		const h = U.hands[g.i], to = toBody(add(p.c, qRotate(p.q, g.g)));
		Object.assign(h, { from: to, to, w: 1, done: true, line: true, key: g.key, offset: undefined, self: undefined, took: g.took.f === f ? g.took.d : 0, prop: p.id });
	}
}

/** The reach row of c, made again where a limb's target is on another body or on a prop: against that body or prop as
 *  it ended this frame. entry(c, slot, key, target, facts) makes one entry (engine.js passes its own); the facts kept
 *  are those that do not depend on the target. */
export function otherReach(c, row, byId, props, f, toBody, entry = plainEntry) {
	const at = (k, to, offset) => {
		if (!row[k] || !(to?.of || to?.on)) return;
		const end = to.of ? otherPoint(byId, to, f, true) : onPoint(props, to, true), { key, slow, floor } = row[k];
		row[k] = entry(c, k, key, toBody(offset ? add(end, offset) : end), { slow, floor, wrist: k >= 4 && !!c.U.hands[k - 4].to });
	};
	c.U.hands.forEach((h, i) => { at(i, h.self, h.offset); at(4 + i, h.elbow?.self); });
	c.U.feet.forEach((ft, i) => at(2 + i, ft?.self));
}
const plainEntry = (c, k, key, t) => ({ key, d: len(sub(c.solved.pos[END[k]], t)) });

const mean = list => mul(list.reduce(add, [0, 0, 0]), 1 / list.length);
/** The turn that best lays the places g (prop frame) on the points P (world), in the least-squares sense, plus a small
 *  pull (STIFF of the places' spread) toward ref, the turn the prop had when these hands took it (turned with its
 *  holders): about an axis the places hardly fix (all of them on or near one line) the prop keeps that turn instead of
 *  rolling on small differences between the hands. Gauss-Newton steps from q0, the last frame's turn. */
const STIFF = 0.005;
function fitTurn(q0, ref, g, P) {
	const gc = mean(g), Pc = mean(P);
	let q = q0;
	for (let it = 0; it < 12; it++) {
		const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], b = [0, 0, 0];
		g.forEach((gi, n) => {
			const r = qRotate(q, sub(gi, gc)), t = sub(P[n], Pc), rr = dot(r, r), rt = cross(r, t);
			for (let x = 0; x < 3; x++) { b[x] += rt[x]; for (let y = 0; y < 3; y++) A[x][y] += (x === y ? rr : 0) - r[x] * r[y]; }
		});
		const lambda = 1e-9 + STIFF * (A[0][0] + A[1][1] + A[2][2]), off = turnOf(qMul(q, qConj(ref)));
		for (let x = 0; x < 3; x++) { A[x][x] += lambda; b[x] -= lambda * off[x]; }
		const w = solve3(A, b), a = len(w);
		if (a < 1e-10) break;
		q = qMul(qAxisAngle(mul(w, 1 / a), Math.min(a, 1)), q);
	}
	return q;
}
/** A turn as a rotation vector (axis times angle, radians). */
function turnOf(q) {
	const s = q[3] < 0 ? -1 : 1, v = [q[0] * s, q[1] * s, q[2] * s], l = len(v);
	return l < 1e-12 ? [0, 0, 0] : mul(v, 2 * Math.atan2(l, q[3] * s) / l);
}
function solve3(A, b) {
	const det = m => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
	const d = det(A);
	if (Math.abs(d) < 1e-18) return [0, 0, 0];
	return [0, 1, 2].map(k => det(A.map((row, x) => row.map((v, y) => (y === k ? b[x] : v)))) / d);
}
