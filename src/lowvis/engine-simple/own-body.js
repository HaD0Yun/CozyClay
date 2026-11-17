// Upper-layer words that name the own body or the held prop's own axes: a hand or elbow target on one of the
// character's joints ({joint, at}), the elbow targets (pose elbowL / elbowR), and aim, the way the hand that holds a
// prop turns it. engine.js calls these inside its frame loop; `t` is its { active, prog, ended, target } helpers.
import { INDEX as J } from "../rig17.js";
import { EASE, X, Y, Z, add, len, mix, mixV, norm, qMul, qRotate, qY, sub } from "./math.js";
import { solveSized } from "./size.js";

const HAND = [J.LeftHand, J.RightHand], ELBOW = [J.LeftForeArm, J.RightForeArm], AXES = { x: X, y: Y, z: Z };

/** A place on the own body in the space the pose is solved in: joint `to.joint`, offset by `to.at` in that joint's own
 *  frame (the body frame at rest). On the first pass of a frame the joint is where the last solved pose had it, carried
 *  with the body; on the second it is where the first pass of this frame put it. */
export function ownPoint(c, to, f) {
	const j = J[to.joint], at = to.at ?? [0, 0, 0];
	if (j == null) throw new Error(`engine-simple: unknown joint "${to.joint}"; want one of ${Object.keys(J).join(", ")}`);
	const B = c.body[f], P = c.solved ?? solveSized(B, {}, c.s);
	if (c.solvedF === f || !c.prevB) return add(P.pos[j], qRotate(P.quat[j], at));
	const turn = qY(B.yaw - c.prevB.yaw);
	return add(add(B.p, qRotate(turn, sub(P.pos[j], c.prevB.p))), qRotate(qMul(turn, P.quat[j]), at));
}

/** An aim as [axis of the hand (= of the prop held in it), solve-space direction] pairs: an array is the prop's long z
 *  axis in the body frame; an object names any of its own x, y, z, in the body frame or, with world: true, the world. */
function aimAxes(aim, B, tilt) {
	if (Array.isArray(aim)) return [[Z, qRotate(qY(B.yaw), norm(aim))]];
	const turn = aim?.world ? tilt?.inv ?? [0, 0, 0, 1] : qY(B.yaw), list = Object.keys(AXES).filter(a => Array.isArray(aim?.[a])).map(a => [AXES[a], qRotate(turn, norm(aim[a]))]);
	if (!list.length) throw new Error(`engine-simple: aim wants [x,y,z], "off" or {x?, y?, z?: [x,y,z], world?: true} with at least one axis, got ${JSON.stringify(aim)}`);
	return list;
}

/** The aim of frame f on the hand that last took a prop in one hand (U.hands[c.gripHand ?? 1]). Two plain directions
 *  blend as directions (h.aim); any other pair blends as two hand turns (h.axes). */
export function aimOf(c, f, U, t) {
	const B = c.body[f], ka = t.active(c.keys.aim, f);
	if (!ka) return;
	const off = ka.to === "off";
	if (ka.from === undefined) {
		const prev = t.ended(c.keys.aim, ka, f), on = prev && prev.to !== "off";
		ka.from = (on ? prev.to : c.last.aim) ?? (off ? [0, 0, 1] : ka.to); ka.fromW = prev ? (on ? 1 : 0) : c.last.aimW ?? 0;
	}
	const w = EASE[ka.ease](t.prog(ka, f)), h = U.hands[c.gripHand ?? 1];
	c.cur.aimW = mix(ka.fromW, off ? 0 : 1, w);
	if (Array.isArray(ka.from) && (off || Array.isArray(ka.to))) { c.cur.aim = off ? ka.from : mixV(ka.from, ka.to, w); h.aim = qRotate(qY(B.yaw), norm(c.cur.aim)); }
	else { c.cur.aim = off || w < 0.5 ? ka.from : ka.to; h.axes = { a: aimAxes(ka.from, B, c.tilt), b: aimAxes(off ? ka.from : ka.to, B, c.tilt), w: off ? 1 : w }; }
	h.aimW = c.cur.aimW;
}

/** The elbow targets of frame f (pose elbowL / elbowR) on U's hands: { from, to, w, key } of solve-space points, where
 *  null is the solver's own elbow direction. A target is any hand target form. */
export function elbowsOf(c, f, U, t) {
	["elbowL", "elbowR"].forEach((name, i) => {
		const list = c.keys[name], k = t.active(list, f);
		if (!k) return;
		const at = to => (to && to !== "rest" ? t.target(c, i, to, f) : null), prev = list[list.indexOf(k) - 1];
		U.hands[i].elbow = { from: at(prev?.to), to: at(k.to), w: EASE[k.ease](t.prog(k, f)), key: k.f, self: k.to?.joint ? k.to : null };
	});
}

/** A frame's reach row ([L hand, R hand, L foot, R foot]) with the own words measured: a hand on the own body against
 *  where that joint ended up (the pass solved toward where the pass before had it), and, for a character with elbow
 *  keys, [L elbow, R elbow] after the feet. */
export function ownReach(c, f, U, row, t) {
	const self = (i, to) => t.target(c, i, to, f);
	U.hands.forEach((h, i) => { if (row[i] && h.self) row[i].d = len(sub(c.solved.pos[HAND[i]], h.offset ? add(self(i, h.self), h.offset) : self(i, h.self))); });
	if (!c.keys.elbowL.length && !c.keys.elbowR.length) return row;
	return [...row, ...U.hands.map(({ elbow: e }, i) => (e?.to && e.w >= 1 ? { key: e.key, d: len(sub(c.solved.pos[ELBOW[i]], e.self ? self(i, e.self) : e.to)) } : null))];
}
