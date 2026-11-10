// The levers the self repair (self-repair.js) moves an arm with, and the moves it tries on one frame. An arm on its IK
// moves its wrist target (ctx.skinPush) or turns its elbow about the shoulder-wrist line (ctx.swivel); pose.js scales
// both by the arm's IK weight, so a move asks them divided by it. An arm on FK moves by its angles (ctx.fkArm, pose.js
// hooks.fkArm): `out` raises it out from the body (its arm_rest less out, so a swing keeps its phase and its reach and
// the hand passes beside the thigh) and `bend` bends its elbow more (or less). An arm part on its IK takes those as far
// as it is on FK (the FK hand its IK target blends from), so a move asks them as they are, where that part is over
// FK_MIN; an arm in between takes both kinds.
import { bodyNormal } from "../body.js";
import { add, sub, scale, len, norm } from "../compiler/math.js";
import { turnWeight } from "../compiler/pose.js";
import { armHit, handHold, SIDES } from "./self-hits.js";

const MARGIN = 0.004;
export const GAIN = 0.002;
const PUSH_MAX = 0.2, WIDE_MAX = 0.3, TURN_MAX = 180, OUT_MAX = 45, BEND_MAX = 60, FK_MIN = 0.05;
const REACH = [0.95, 0.85, 0.75], PUSHES = [1, 1.75, 2.5], TURNS = [15, 30, 45, 60, 90], WIDE = [1, 1.75, 2.5], WIDE_TURNS = [120, 150], OUTS = [1, 1.75, 2.5, 4], BENDS = [1, 2, 3];
const DEG = 180 / Math.PI;

/** The levers of side k at absolute frame f: its wrist target offset, its elbow turn and its FK angles. */
export const leverAt = (out, k, f) => ({ push: out.ctx.skinPush[k].get(f), turn: out.ctx.swivel[k].get(f), ...out.ctx.fkArm[k].get(f) });
export function setLever(out, k, f, v) {
	const { skinPush: push, swivel: turn, fkArm: fk } = out.ctx;
	if (v.push) push[k].set(f, v.push); else push[k].delete(f);
	if (v.turn) turn[k].set(f, v.turn); else turn[k].delete(f);
	if (v.out || v.bend) fk[k].set(f, { out: v.out ?? 0, bend: v.bend ?? 0 }); else fk[k].delete(f);
}
/** Levers v with move mv added: its IK levers times ti (the push times tp), its FK angles times tf. */
const added = (v, mv, tp, ti, tf) => ({ push: mv.push ? add(v.push ?? [0, 0, 0], scale(mv.push, tp)) : v.push, turn: mv.turn ? (v.turn ?? 0) + mv.turn * ti : v.turn,
	out: mv.out ? (v.out ?? 0) + mv.out * tf : v.out, bend: mv.bend ? (v.bend ?? 0) + mv.bend * tf : v.bend });
/** How far side k's arm is on its IK on frame index j (pose.js turnWeight of armw), and on FK (1 - armw: the FK hand's share of its target). */
const weightAt = (out, k, j) => turnWeight(out.frames[j].c[`armw_${k}`] ?? 0);
const fkAt = (out, k, j) => 1 - Math.min(1, Math.max(0, out.frames[j].c[`armw_${k}`] ?? 0));
const isFk = mv => Boolean(mv.out || mv.bend);
/** Sets move mv on side k at frame indices `at` ([j, share]) and solves them; -> undo (puts back the levers and the solved frames as they were). */
export function apply(out, engine, k, mv, at) {
	const f0 = out.f0 ?? 0, was = [];
	for (const [j, t0] of at) {
		// a wrist push or an FK move fades with the weight that holds the hand; an elbow turn keeps the hand where it is
		const tw = weightAt(out, k, j), ik = tw >= 1e-3, fk = isFk(mv) && fkAt(out, k, j) >= 1e-3;
		const t = mv.push || fk ? t0 * (1 - handHold(out.ctx.spec, out.frames[j], f0 + j, k).held) : t0;
		const tp = mv.push && ik ? t / tw : 0, ti = mv.turn && ik ? t0 / tw : 0, tf = fk ? t : 0;
		if (!(tp > 0 || ti > 0 || tf > 0)) continue;
		was.push([j, leverAt(out, k, f0 + j), out.frames[j]]);
		setLever(out, k, f0 + j, added(leverAt(out, k, f0 + j), mv, tp, ti, tf));
	}
	engine.solve(was.map(([j]) => f0 + j));
	return () => { for (const [j, v, fr] of was) { setLever(out, k, f0 + j, v); out.frames[j] = fr; } };
}

/** The FK moves of side k for hit h on frame index i: the arm out by the angle that takes the hit's depth (and a margin)
 * off at its distance from the shoulder, times OUTS; the elbow bent either way by the angle that does it at its distance
 * from the elbow, times BENDS (a forearm or hand hit); and the two together. */
function fkMoves(out, k, i, h, P0, a, e, was) {
	const fkw = fkAt(out, k, i), c = out.frames[i].c, moves = [], need = h.past + MARGIN;
	const at = (p, j) => Math.max(0.05, len(sub(p, P0[j])));
	const o = (DEG * need) / at(h.p, a) / fkw, b = (DEG * need) / at(h.p, e) / fkw, part = h.b === out.ctx.sk.index[`${SIDES[k]}Arm`];
	const okOut = x => (was.out ?? 0) + x <= OUT_MAX, okBend = x => Math.abs((was.bend ?? 0) + x) <= BEND_MAX && (c[`abend_${k}`] ?? 0) + (was.bend ?? 0) + x >= 0;
	for (const m of OUTS) if (okOut(o * m)) moves.push({ out: o * m });
	if (!part) for (const m of BENDS) for (const sg of [1, -1]) if (okBend(sg * b * m)) moves.push({ bend: sg * b * m });
	if (!part && okOut(o) && okBend(b)) moves.push({ out: o, bend: b });
	return moves;
}

/** The moves of side k on frame index i for its hit h, each tried on that frame alone, best first: those that clear it
 * by the smaller move of the elbow and wrist, then those that take at least GAIN off it by how much. */
export function movesFor(out, engine, body, k, i, h, known, wider = false) {
	const { sk } = out.ctx, I = sk.index, S = SIDES[k], fr = out.frames[i], was = leverAt(out, k, (out.f0 ?? 0) + i);
	const [a, e, w] = [I[`${S}Arm`], I[`${S}ForeArm`], I[`${S}Hand`]], P0 = fr.s.P, rise0 = Math.max(0, P0[e][1] - P0[a][1]);
	const tw = weightAt(out, k, i), moves = [], wide = [];
	// a push that takes the wrist farther from the shoulder than r of the arm's length slides back onto that sphere
	const L = len(sub(P0[e], P0[a])) + len(sub(P0[w], P0[e]));
	const inReach = (v, r) => { const to = sub(add(P0[w], v), P0[a]), d = len(to); return d > r * L ? sub(add(P0[a], scale(to, (r * L) / d)), P0[w]) : v; };
	// a push past PUSH_MAX in all is not tried; one of the wider set stops at WIDE_MAX
	const push = (list, v, max = PUSH_MAX) => {
		const now = scale(was.push ?? [0, 0, 0], tw), all = len(add(now, v));
		if (max > PUSH_MAX && all > max) v = sub(scale(add(now, v), max / all), now);
		if (!moves.concat(wide).some(x => x.push && len(sub(x.push, v)) < 1e-6) && len(add(now, v)) <= max + 1e-12) list.push({ push: v });
	};
	if (tw >= 0.05 && !h.hold) {
		const nrm = bodyNormal(body, fr.s, h.p, body.skip.get(h.b));
		if (nrm) for (const m of PUSHES) for (const r of REACH) push(moves, inReach(scale(nrm, m * (h.past + MARGIN)), r));
	}
	// the wider set (`wider`: on what the moves above left, self-repair.js), tried where none of those clears the frame:
	// the wrist over the skin rather than into it (forward, up, out to the arm's side and between, as well as along the
	// normal), by the depth times the lever from the shoulder to the hit (an upper arm across the belly moves its wrist
	// that much more), up to WIDE_MAX in all, and the elbow turned farther
	if (wider && tw >= 0.05 && !h.hold) {
		const nrm = bodyNormal(body, fr.s, h.p, body.skip.get(h.b)), yaw = ((fr.c.yaw ?? 0) * Math.PI) / 180, fwd = [Math.sin(yaw), 0, Math.cos(yaw)], side = scale([Math.cos(yaw), 0, -Math.sin(yaw)], k === "l" ? 1 : -1);
		const lever = Math.min(3, L / Math.max(0.1, len(sub(h.p, P0[a])))), dirs = [nrm, fwd, [0, 1, 0], side, norm(add(fwd, [0, 1, 0])), norm(add(fwd, side))].filter(Boolean);
		for (const m of WIDE) for (const d of dirs) for (const r of REACH) push(wide, inReach(scale(d, m * lever * (h.past + MARGIN)), r), WIDE_MAX);
	}
	if (tw >= 0.05) {
		for (const d of TURNS) for (const sg of [1, -1]) if (Math.abs((was.turn ?? 0) * tw + sg * d) <= TURN_MAX) moves.push({ turn: sg * d });
		if (wider) for (const d of WIDE_TURNS) for (const sg of [1, -1]) if (Math.abs((was.turn ?? 0) * tw + sg * d) <= TURN_MAX) wide.push({ turn: sg * d });
	}
	// a hand the take holds (on the body, on an anchor, a grasp or a contact) keeps its place: no FK move
	if (fkAt(out, k, i) >= FK_MIN && (h.hold === null || h.hold === "fk")) moves.push(...fkMoves(out, k, i, h, P0, a, e, was));
	const tried = list => list.flatMap(mv => {
		const undo = apply(out, engine, k, mv, [[i, 1]]), P = out.frames[i].s.P, hit = armHit(out, body, i, k, known), past = hit ? hit.past : -Infinity;
		const size = len(sub(P[e], P0[e])) + len(sub(P[w], P0[w])), gain = h.past - past, high = P[e][1] - P[a][1] > rise0 + 1e-9;
		undo();
		return !high && (past <= 0 || gain >= GAIN) ? [{ mv, clear: past <= 0, size, gain }] : [];
	});
	let ok = tried(moves);
	if (wider && !ok.some(m => m.clear)) ok = ok.concat(tried(wide));
	ok.forEach((m, n) => { m.n = n; });
	// ties keep the order tried (deterministic)
	return ok.sort((p, q) => q.clear - p.clear || (p.clear ? p.size - q.size : q.gain - p.gain || p.size - q.size) || p.n - q.n);
}
