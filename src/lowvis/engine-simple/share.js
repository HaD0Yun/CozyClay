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
import { add, cross, dot, len, mul, norm, qConj, qMul, qRotate, qY, sub, wrap } from "./math.js";
import { PAD } from "./prop-frame.js";
import { jointFrame, moveRiders } from "./ride.js";
import { ARM_LEN } from "./solve.js";

const HAND = [J.LeftHand, J.RightHand], ARM = [J.LeftArm, J.RightArm], SIDE = ["L", "R"];
const END = [J.LeftHand, J.RightHand, J.LeftFoot, J.RightFoot, J.LeftForeArm, J.RightForeArm]; // the joint of each reach slot
const jointOf = name => { const j = J[name]; if (j == null) throw new Error(`engine-simple: unknown joint "${name}"; want one of ${Object.keys(J).join(", ")}`); return j; };

/** Each prop's place and turn at the start of the frame, after its keys and with its riders on their carriers: what
 *  the first pass reads of it. */
export function startFrame(props, f, byId) {
	moveRiders(props, f, byId);
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
	const { c, q } = jointFrame(o, j, f, final);
	return add(c, qRotate(q, to.at ?? [0, 0, 0]));
}

/** The shared side of a prop event (buildUpper's events) of character c at frame f. Returns true when it is handled
 *  here; false lets engine.js run the event as a single holder's (carry, a hold in one hand, a let-go of it). */
export function shareEvent(p, c, e, f, byId) {
	// the hands that held it alone, as grips, each where it held it at the end of the last frame (so the prop goes on
	// moving with them on this one), a carry of c's own only when c lets go of one hand of it
	const alone = own => {
		const o = byId[p.holder];
		if (!o || (o === c && p.hand == null && !own)) return [];
		const at = i => o.world && qRotate(qConj(p.q), sub(o.world.pos[HAND[i]], p.c)), hq = i => o.world?.quat[HAND[i]];
		return (p.hand != null ? [p.hand] : [0, 1]).map(i => ({ c: o, i, key: p.takenAt ?? f, ask: null, here: true, g: at(i), hq: hq(i), took: { f: -1, d: 0 } }));
	};
	if (e.holder == null) { // release / place: this character lets go (e.lets: only that hand)
		if (!p.grips && e.lets != null && p.holder === c.id) {
			if (p.hand != null && p.hand !== e.lets) return true; // that hand does not hold it: nothing to let go
			if (p.hand == null) p.grips = alone(true);
		}
		if (!p.grips) return false;
		const push = p.slide; // a push goes on with the hand that is left: the prop slides on the floor with it
		p.grips = p.grips.filter(g => g.c !== c || (e.lets != null && g.i !== e.lets));
		if (p.grips.length) { held(p); p.slide = push; return true; }
		free(p);
		return false;
	}
	if (e.hand === undefined && !e.share) { free(p); return false; } // carry takes the prop from every other hand
	const hands = e.hands ?? [e.hand];
	if (!e.share && !p.grips && !(p.holder && (p.holder !== c.id || (p.hand != null && p.hand !== e.hand)))) { free(p); return false; }
	p.grips = (p.grips ?? alone(false)).filter(g => g.c !== c || !hands.includes(g.i)); // these hands take hold again, the others hold on
	for (const i of hands) p.grips.push({ c, i, key: e.key ?? f, since: f, ask: e.at?.[i] ?? null, g: null });
	p.takenAt = f;
	return held(p);
}
/** A place's entry of aux.placed, one per prop and frame its hands let go on: how far the prop is from the place's
 *  target (the worst of the places that end on that frame), who placed it and whether any of them held it. */
export function placed(list, p, c, e, f) {
	const holds = p.holder === c.id || !!p.grips?.some(g => g.c === c);
	let row = list.find(r => r.prop === e.prop && r.f === f);
	if (!row) list.push(row = { prop: e.prop, f, miss: 0, who: [], held: false });
	Object.assign(row, { miss: Math.max(row.miss, len(sub(p.c, e.at))), who: [...row.who, c.id], held: row.held || holds });
}
const label = p => p.grips.map(g => `${g.c.id}:${SIDE[g.i]}`).join("+");
const held = p => { p.holder = label(p); p.hand = null; p.slide = false; return true; };
/** No hand holds the prop through here any more: nothing of the last set of hands is kept for the next. */
const free = p => { p.grips = null; p.set = null; };

/** Between the two passes: every body's pose of this frame is kept for the second pass, a hand that took hold this
 *  frame gets its place (the one asked; a hand that held it alone: where it is; else the point of the prop nearest to
 *  it, a wrist's pad off its surface;
 *  g.took: how far it was from it), and every shared prop is fitted to its holding hands. A hand that took hold short
 *  of its place pulls the prop to it. A prop in one hand alone keeps the turn it had in that hand when it came to hold
 *  it alone (c.gripTurn: that turn, for aim; g.hq: a hand that held it on the last frame, as it was then). In more
 *  hands, about an axis the places hardly fix it keeps the turn it had on the last frame, turned about the vertical as
 *  far as its holders' headings turned since then (spin) and otherwise only as the places turn it. */
export function afterFirstPass(props, chars, f) {
	for (const c of chars) {
		const facing = c.body[f].yaw; // the heading: the frame a holding hand's place in the body frame turns with
		Object.assign(c, { snap: c.poseNow, snapF: f, gripTurn: [null, null], spun: c.facing == null ? 0 : wrap(facing - c.facing), facing });
	}
	for (const p of Object.values(props)) {
		if (p.hand != null && p.gq) chars.find(c => c.id === p.holder).gripTurn[p.hand] = p.gq; // in one hand alone (engine.js follow)
		if (!p.grips) continue;
		const hand = g => g.c.poseNow.pos[HAND[g.i]];
		for (const g of p.grips) if (!g.g) {
			const now = qRotate(qConj(p.q), sub(hand(g), p.c)), pad = PAD * g.c.s;
			g.g = g.ask ?? (g.here ? now : now.map((v, k) => Math.max(-p.size[k] / 2 - pad, Math.min(p.size[k] / 2 + pad, v))));
			// why: slow: how far the top speed held this hand back; beyond: how far the place lay past the arm's reach;
			// near: no place was asked, so it is the prop's nearest point to the hand
			const why = { slow: g.c.solved.slow[g.i], beyond: len(sub(add(p.c, qRotate(p.q, g.g)), g.c.poseNow.pos[ARM[g.i]])) - ARM_LEN * g.c.s, near: !g.ask && !g.here };
			g.took = { f, d: len(sub(g.g, now)), why };
		}
		const set = label(p), fresh = p.set !== set, y = p.c[1];
		if (p.slide) ; // pushed by the hand left of a push: it keeps its turn and height and slides with the hand
		else if (p.grips.length === 1) { // one hand: the prop is fixed in it as it was when this hand came to hold it alone
			const g = p.grips[0], hq = g.c.poseNow.quat[HAND[g.i]];
			if (fresh) { p.gripTurn = qMul(qConj(g.hq ?? hq), p.q); g.c.gripHand = g.i; }
			p.q = qMul(hq, p.gripTurn); g.c.gripTurn[g.i] = p.gripTurn;
		} else p.q = heldTurn(p.q, p.grips.map(g => g.g), p.grips.map(hand), spin(p.grips));
		for (const g of p.grips) g.hq = null;
		const gc = mean(p.grips.map(g => g.g)), hc = mean(p.grips.map(hand));
		p.c = sub(hc, qRotate(p.q, gc));
		if (p.slide) p.c[1] = y;
		for (const g of p.grips) g.kept = len(sub(add(p.c, qRotate(p.q, g.g)), hand(g))); // how far the fit keeps the place from where this pass put the hand
		const z = qRotate(p.q, [0, 0, 1]);
		p.yaw = Math.atan2(z[0], z[2]); p.set = set; p.holder = set;
	}
	moveRiders(props, f, Object.fromEntries(chars.map(c => [c.id, c]))); // a prop that rides on one the first pass moved, or on a body, goes with it
	for (const p of Object.values(props)) p.at1 = { c: p.c.slice(), q: p.q.slice() };
}

/** Second pass: each hand of c that holds a shared prop goes to its place on it (toBody: a world point into the space
 *  the pose is solved in), which its reach entry measures it against, finished on every frame of the hold; on the frame
 *  it took hold, h.took is how far it was from that place (the prop then moved to it): a fact of the entry's own.
 *  h.own: on a frame the fit kept the place more than a wrist's pad off where the first pass put the hand (more hands
 *  pull on the prop; not the frame it took hold), where the hand's own action of the hold or after it puts it once its
 *  blend has ended ("rest" for the rest pose), which the place on the prop has taken over (own-body.js measures how far
 *  the hand ends from it). */
export function onPlaces(props, c, U, f, toBody) {
	for (const p of Object.values(props)) for (const g of p.grips ?? []) {
		if (g.c !== c) continue;
		const h = U.hands[g.i], to = toBody(add(p.c, qRotate(p.q, g.g)));
		const own = g.kept > PAD * c.s && g.took.f !== f && h.done && h.key >= (g.since ?? g.key) ? h.to ?? "rest" : null;
		Object.assign(h, { from: to, to, w: 1, done: true, line: true, key: g.key, offset: undefined, flow: undefined, lead: h.flow && c.solvedF === f ? c.solved.lead[g.i] : undefined, self: undefined, took: g.took.f === f ? g.took.d : 0, tookWhy: g.took.f === f ? g.took.why : null, prop: p.id, own, ownKey: h.by ?? h.key });
	}
}

/** The reach row of c, made again where a limb's target is on another body or on a prop: against that body or prop as
 *  it ended this frame. entry(c, slot, key, target, facts) makes one entry (engine.js passes its own); the facts kept
 *  are those that do not depend on the target, plus drift: how far the target moved after the pose was solved toward
 *  it (that body or prop moved on in the second pass), on: what it is on, and back: that body has a target on c's. */
export function otherReach(c, row, byId, props, f, toBody, entry = plainEntry) {
	const aims = o => !!o?.U && [...o.U.hands.flatMap(h => [h.self, h.elbow?.self]), ...o.U.feet.map(ft => ft?.self)].some(t => t?.of === c.id);
	const at = (k, to, offset) => {
		if (!row[k] || !(to?.of || to?.on)) return;
		const end = to.of ? otherPoint(byId, to, f, true) : onPoint(props, to, true), { key, slow, floor } = row[k], t = toBody(offset ? add(end, offset) : end);
		row[k] = entry(c, k, key, t, { slow, floor, wrist: k >= 4 && !!c.U.hands[k - 4].to, drift: row[k].t && len(sub(row[k].t, t)), on: to.of ?? to.on, back: !!to.of && aims(byId[to.of]) });
	};
	c.U.hands.forEach((h, i) => { at(i, h.self, h.offset); at(4 + i, h.elbow?.self); });
	c.U.feet.forEach((ft, i) => at(2 + i, ft?.self));
}
const plainEntry = (c, k, key, t) => ({ key, d: len(sub(c.solved.pos[END[k]], t)) });

const mean = list => mul(list.reduce(add, [0, 0, 0]), 1 / list.length);
/** How far the bodies of the hands that hold a prop turned their heading since the last frame (c.spun; rad, the mean
 *  over the hands). */
const spin = grips => grips.reduce((sum, g) => sum + g.c.spun, 0) / grips.length;
/** The turn of a prop held at places g (prop frame) by hands at P (world), from its turn q0 on the last frame: the fit
 *  from q0 turned by the holders' heading (spun); then fitted again from that turn rolled about the line through the
 *  two places farthest apart (when it is not near vertical) back to the roll about it, against the vertical, that the
 *  prop had on the last frame. As far as the places fix that roll the fit keeps theirs; as far as they hardly do (all
 *  on or near one line) the prop keeps its roll against the vertical, whichever way the line got where it is. */
function heldTurn(q0, g, P, spun) {
	const q1 = fitTurn(qMul(qY(spun), q0), g, P);
	let a = g[0], b = g[0];
	for (const x of g) for (const y of g) if (len(sub(x, y)) > len(sub(a, b))) { a = x; b = y; }
	if (len(sub(a, b)) < 1e-6) return q1;
	const l = norm(sub(b, a));
	// the roll against the vertical is not defined for a vertical line: none of it near one, on this frame or the last
	const level = q => Math.min(1, Math.max(0, (0.97 - Math.abs(qRotate(q, l)[1])) / 0.07)), k = level(q0) * level(q1);
	return k > 0 ? fitTurn(qMul(qAxisAngle(qRotate(q1, l), k * wrap(rollOf(q0, l) - rollOf(q1, l))), q1), g, P) : q1;
}
/** The roll of a prop at turn q about its own line l: the angle about that line, seen in the world, from the vertical
 *  to a prop axis square to l. */
function rollOf(q, l) {
	const L = qRotate(q, l), u = qRotate(q, cross(l, Math.abs(l[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]));
	const up = [-L[0] * L[1], 1 - L[1] * L[1], -L[2] * L[1]], w = sub(u, mul(L, dot(L, u)));
	return Math.atan2(dot(cross(up, w), L), dot(up, w));
}
/** The turn that best lays the places g (prop frame) on the points P (world), in the least-squares sense, plus a small
 *  pull (STIFF of the places' spread) toward q0, the turn the prop had on the last frame turned as its holders turned:
 *  about an axis the places hardly fix (all of them on or near one line) the prop keeps that turn, turned only as the
 *  places turn it, instead of rolling on small differences between the hands. Gauss-Newton steps from q0. */
const STIFF = 0.005;
function fitTurn(q0, g, P) {
	const ref = q0;
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
