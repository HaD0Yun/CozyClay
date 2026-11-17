// Places that follow something other than the own body, and one prop held by any number of hands.
//  - {on: propId, at}: a place on a prop, `at` from its centre in its own frame.
//  - {joint, at, of: characterId}: a place on another character's body that follows that joint.
//  - hold that shares (hand "both", an `at`, or a prop another character holds): every holding hand keeps its place on
//    the prop; the prop takes the place and turn that best puts each place on its hand.
// The frame loop of engine.js runs every character twice. What one character reads of another body or of a prop is
// fixed for each pass, so the order of the characters in the scene does not change the clip: on the first pass the
// state at the start of the frame (another body: its last pose carried with its body), on the second the state after
// the first pass of every character and the fit of every shared prop.
import { INDEX as J, qAxisAngle } from "../rig17.js";
import { add, cross, dot, len, mul, qConj, qMul, qRotate, qY, sub } from "./math.js";
import { solveSized } from "./size.js";

const HAND = [J.LeftHand, J.RightHand], SIDE = ["L", "R"];
const pointOf = (P, j, at) => add(P.pos[j], qRotate(P.quat[j], at ?? [0, 0, 0]));
const jointOf = name => { const j = J[name]; if (j == null) throw new Error(`engine-simple: unknown joint "${name}"; want one of ${Object.keys(J).join(", ")}`); return j; };

/** Each prop's place and turn at the start of the frame, after its keys: what the first pass reads of it. */
export function startFrame(props) {
	for (const p of Object.values(props)) { p.at0 = { c: p.c.slice(), q: p.q.slice() }; p.at1 = null; }
}

/** A world point on prop `id` ({on, at}), as the current pass reads the prop. */
export function onPoint(props, to) {
	const p = props[to.on];
	if (!p) throw new Error(`engine-simple: {on: ${JSON.stringify(to.on)}} wants a prop id; props: ${Object.keys(props).join(", ")}`);
	const s = p.at1 ?? p.at0 ?? p;
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
	if (e.holder == null) { // release / place: this character lets go (e.lets: only that hand)
		if (!p.grips) return false;
		p.grips = p.grips.filter(g => g.c !== c || (e.lets != null && g.i !== e.lets));
		if (p.grips.length) return true;
		p.grips = null;
		return false;
	}
	if (e.hand === undefined && !e.share) { p.grips = null; return false; } // carry takes the prop from every other hand
	if (!e.share && !p.grips && !(p.holder && p.holder !== c.id)) return false;
	if (!p.grips) { // the hands that held it alone go on holding it, each where it is
		const o = byId[p.holder];
		p.grips = o ? (p.hand != null ? [p.hand] : [0, 1]).map(i => ({ c: o, i, key: p.takenAt ?? f, ask: null, g: null })) : [];
	}
	p.grips = p.grips.filter(g => g.c !== c);
	for (const i of e.hands ?? [e.hand]) p.grips.push({ c, i, key: e.key ?? f, ask: e.at?.[i] ?? null, g: null });
	p.holder = label(p); p.hand = null; p.slide = false; p.takenAt = f;
	return true;
}
const label = p => p.grips.map(g => `${g.c.id}:${SIDE[g.i]}`).join("+");

/** Between the two passes: every body's pose of this frame is kept for the second pass, a hand that took hold this
 *  frame gets its place (where it is on the prop now), and every shared prop is fitted to its holding hands. */
export function afterFirstPass(props, chars, f) {
	for (const c of chars) { c.snap = c.poseNow; c.snapF = f; }
	for (const p of Object.values(props)) {
		if (p.grips) {
			const hand = g => g.c.poseNow.pos[HAND[g.i]];
			for (const g of p.grips) if (!g.g) { g.g = qRotate(qConj(p.q), sub(hand(g), p.c)); g.ask ??= g.g; }
			const set = label(p);
			if (p.grips.length === 1) { // one hand: the prop is fixed in it as it was when this hand came to hold it alone
				const g = p.grips[0], hq = g.c.poseNow.quat[HAND[g.i]];
				if (p.set !== set) p.rel = qMul(qConj(hq), p.q);
				p.q = qMul(hq, p.rel);
			} else p.q = fitTurn(p.q, p.grips.map(g => g.g), p.grips.map(hand));
			const gc = mean(p.grips.map(g => g.g)), hc = mean(p.grips.map(hand));
			p.c = sub(hc, qRotate(p.q, gc));
			const z = qRotate(p.q, [0, 0, 1]);
			p.yaw = Math.atan2(z[0], z[2]); p.set = set; p.holder = set;
		}
		p.at1 = { c: p.c.slice(), q: p.q.slice() };
	}
}

/** Second pass: each hand of c that holds a shared prop goes to its place on it (toBody: a world point into the space
 *  the pose is solved in). h.ask is the place the spec asked for, which the reach row measures it against. */
export function onPlaces(props, c, U, toBody) {
	for (const p of Object.values(props)) for (const g of p.grips ?? []) {
		if (g.c !== c) continue;
		const h = U.hands[g.i], to = toBody(add(p.c, qRotate(p.q, g.g)));
		Object.assign(h, { from: to, to, w: 1, line: true, key: g.key, offset: undefined, ask: toBody(add(p.c, qRotate(p.q, g.ask))) });
	}
}

/** The reach row of c, measured again where a limb's target is on another body: against that body as it ended. */
export function otherReach(c, row, byId, f, toBody, solved) {
	const at = (k, to, j) => { if (row[k] && to?.of) row[k].d = len(sub(solved.pos[j], toBody(otherPoint(byId, to, f, true)))); };
	c.U.hands.forEach((h, i) => { at(i, h.self, HAND[i]); at(4 + i, h.elbow?.self, [J.LeftForeArm, J.RightForeArm][i]); });
	c.U.feet.forEach((ft, i) => at(2 + i, ft?.self, [J.LeftFoot, J.RightFoot][i]));
}

const mean = list => mul(list.reduce(add, [0, 0, 0]), 1 / list.length);
/** The turn nearest q0 that best lays the places g (prop frame) on the points P (world), in the least-squares sense:
 *  Gauss-Newton steps from q0. A turn the points do not fix (about the line through two places) stays as in q0. */
function fitTurn(q0, g, P) {
	const gc = mean(g), Pc = mean(P);
	let q = q0;
	for (let it = 0; it < 12; it++) {
		const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], b = [0, 0, 0];
		g.forEach((gi, n) => {
			const r = qRotate(q, sub(gi, gc)), t = sub(P[n], Pc), rr = dot(r, r), rt = cross(r, t);
			for (let x = 0; x < 3; x++) { b[x] += rt[x]; for (let y = 0; y < 3; y++) A[x][y] += (x === y ? rr : 0) - r[x] * r[y]; }
		});
		const eps = 1e-9 + 1e-3 * (A[0][0] + A[1][1] + A[2][2]);
		for (let x = 0; x < 3; x++) A[x][x] += eps;
		const w = solve3(A, b), a = len(w);
		if (a < 1e-10) break;
		q = qMul(qAxisAngle(mul(w, 1 / a), Math.min(a, 1)), q);
	}
	return q;
}
function solve3(A, b) {
	const det = m => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
	const d = det(A);
	if (Math.abs(d) < 1e-18) return [0, 0, 0];
	return [0, 1, 2].map(k => det(A.map((row, x) => row.map((v, y) => (y === k ? b[x] : v)))) / d);
}
