// Self repair (spec.fix.self, after self.js): an arm part still in the character's own torso, hips, neck, head or thigh
// past QA's BODY or FACE limit (self-hits.js armHit, on QA's body and measures) after the elbow plan and the skin pushes.
// Over the whole take, the deepest hit first:
//  - the arm moves out on that frame with its IK: the wrist target out along the skin's normal where the part is deepest
//    (ctx.skinPush, PUSHES times the depth past the limit, slid back toward the shoulder onto REACH of the arm's length
//    when it would go farther, so the elbow bends instead of the arm locking straight), or the elbow turned about the
//    shoulder-wrist line (ctx.swivel, TURNS deg either way). Each is tried on that frame alone; the TRIES best are then
//    tried spread over the frames within EASE of it (smootherstep down to 0 at the window's edge, so nothing pops), and
//    the one that clears the frame with the smaller move of the elbow and wrist wins, provided the window's summed depth
//    past the limit does not rise; with none clearing it, the one that takes the most off the window, at least GAIN.
//    A turn stays within TURN_MAX deg in all, a push within PUSH_MAX m, the elbow no higher over the shoulder than it
//    was; the IK keeps the elbow's fold and the wrist's limits. A move that adds a POP or a FLIP to the arm is not made
//    (self-guard.js);
//  - again, until no hit is past the limit or MAX_IT moves are tried for each run of frames with a hit. A hand held on
//    its target (self-hits.js "pinned") or on the body keeps it: only the elbow turns, and a wrist push spread toward it
//    fades with the weight that holds it. An FK arm is not moved.
// Never worse: a span that neither takes GAIN off its deepest hit nor clears a frame gets its frames back; the others
// stand together where QA (qa-of.js, as pipeline.js reads it) is no worse with them, else they are tried in halves on
// top of what stood, down to one span.
// A group stands where QA is no worse by keptRetime's rule (qa/verdict.js noWorse: problems, summed severity, goals
// held), no goal that held is lost, and no group but BODY and FACE got worse or new (a contact, a grasp, a support, a
// planted foot, a carried object, a collision with an object or a person, a reach, a pop or a flip); else its spans get
// their frames back exactly (the solved frames are kept, not solved again). Takes with no hit past the limit are not
// touched. Reported in fixed.self: spans [{ at, depth: [before, after] }], depth [before, after] (m, the deepest hit),
// iterations, and left [{ at, side, why }]: the frames still past the limit, with why.
import { bodyFor, bodyNormal } from "../body.js";
import { add, sub, scale, len } from "../compiler/math.js";
import { turnWeight } from "../compiler/pose.js";
import { round4 } from "./ease.js";
import { qaOf } from "./qa-of.js";
import { noWorse, compareQa } from "../qa/verdict.js";
import { groupKey } from "../qa/severity.js";
import { armHit, handHold, SIDES } from "./self-hits.js";
import { armMotion, moveWorse } from "./self-guard.js";

const EASE = 10, MAX_IT = 48, MARGIN = 0.004, GAIN = 0.002, PUSH_MAX = 0.2, TURN_MAX = 180, TRIES = 6;
const REACH = [0.95, 0.85, 0.75], PUSHES = [1, 1.75, 2.5], TURNS = [15, 30, 45, 60, 90];
/** The kinds this repair is about; every other group must not get worse. */
const OWN = new Set(["BODY", "FACE"]);
const KS = ["r", "l"];
/** 1 at the moved frame, 0 at EASE + 1 frames away (smootherstep). */
const easeAt = d => { const t = Math.min(1, d / (EASE + 1)); return 1 - t * t * t * (t * (6 * t - 15) + 10); };

/** The IK levers of side k at absolute frame f: its wrist target offset and its elbow turn. */
const leverAt = (out, k, f) => ({ push: out.ctx.skinPush[k].get(f), turn: out.ctx.swivel[k].get(f) });
function setLever(out, k, f, v) {
	const push = out.ctx.skinPush[k], turn = out.ctx.swivel[k];
	if (v.push) push.set(f, v.push); else push.delete(f);
	if (v.turn) turn.set(f, v.turn); else turn.delete(f);
}
/** Levers v with move mv added, times t. */
const added = (v, mv, t) => ({ push: mv.push ? add(v.push ?? [0, 0, 0], scale(mv.push, t)) : v.push, turn: mv.turn ? (v.turn ?? 0) + mv.turn * t : v.turn });
/** pose.js scales both levers by the arm's IK weight: a move of mv on frame index j is mv / that weight. */
const weightAt = (out, k, j) => turnWeight(out.frames[j].c[`armw_${k}`] ?? 0);

/** Sets move mv on side k at frame indices `at` ([j, share]) and solves them; -> undo (puts back the levers and the solved frames as they were). */
function apply(out, engine, k, mv, at) {
	const f0 = out.f0 ?? 0, was = [];
	for (const [j, t0] of at) {
		const tw = weightAt(out, k, j), t = mv.push ? t0 * (1 - handHold(out.ctx.spec, out.frames[j], f0 + j, k).held) : t0;
		if (tw < 1e-3 || !(t > 0)) continue;
		was.push([j, leverAt(out, k, f0 + j), out.frames[j]]);
		setLever(out, k, f0 + j, added(leverAt(out, k, f0 + j), mv, t / tw));
	}
	engine.solve(was.map(([j]) => f0 + j));
	return () => { for (const [j, v, fr] of was) { setLever(out, k, f0 + j, v); out.frames[j] = fr; } };
}

/** The moves of side k on frame index i for its hit h, each tried on that frame alone, best first: those that clear it
 * by the smaller move of the elbow and wrist, then those that take at least GAIN off it by how much. */
function movesFor(out, engine, body, k, i, h, known) {
	const { sk } = out.ctx, I = sk.index, S = SIDES[k], fr = out.frames[i], was = leverAt(out, k, (out.f0 ?? 0) + i);
	const [a, e, w] = [I[`${S}Arm`], I[`${S}ForeArm`], I[`${S}Hand`]], P0 = fr.s.P, rise0 = Math.max(0, P0[e][1] - P0[a][1]);
	const tw = weightAt(out, k, i), moves = [], ok = [];
	const nrm = h.hold ? null : bodyNormal(body, fr.s, h.p, body.skip.get(h.b));
	// a push that takes the wrist farther from the shoulder than r of the arm's length slides back onto that sphere
	const L = len(sub(P0[e], P0[a])) + len(sub(P0[w], P0[e]));
	const inReach = (v, r) => { const to = sub(add(P0[w], v), P0[a]), d = len(to); return d > r * L ? sub(add(P0[a], scale(to, (r * L) / d)), P0[w]) : v; };
	if (nrm) for (const m of PUSHES) for (const r of REACH) {
		const v = inReach(scale(nrm, m * (h.past + MARGIN)), r);
		if (!moves.some(x => x.push && len(sub(x.push, v)) < 1e-6) && len(add(scale(was.push ?? [0, 0, 0], tw), v)) <= PUSH_MAX) moves.push({ push: v });
	}
	for (const d of TURNS) for (const sg of [1, -1]) if (Math.abs((was.turn ?? 0) * tw + sg * d) <= TURN_MAX) moves.push({ turn: sg * d });
	for (const mv of moves) {
		const undo = apply(out, engine, k, mv, [[i, 1]]), P = out.frames[i].s.P, hit = armHit(out, body, i, k, known), past = hit ? hit.past : -Infinity;
		const size = len(sub(P[e], P0[e])) + len(sub(P[w], P0[w])), gain = h.past - past, high = P[e][1] - P[a][1] > rise0 + 1e-9;
		undo();
		if (!high && (past <= 0 || gain >= GAIN)) ok.push({ mv, clear: past <= 0, size, gain, n: ok.length });
	}
	// ties keep the order tried (deterministic)
	return ok.sort((p, q) => q.clear - p.clear || (p.clear ? p.size - q.size : q.gain - p.gain || p.size - q.size) || p.n - q.n);
}

/** The move for side k's hit h on frame index i, spread over its window: { mv, at } or null (movesFor's TRIES best, tried
 * in place). A move must take GAIN off the window's deepest hit, or off its summed depth past the limit without
 * deepening that hit; one that clears frame i that way wins by the smaller move, else the larger gain. */
function bestMove(out, engine, body, k, i, h, hits, known) {
	const n = out.frames.length, lo = Math.max(0, i - EASE), hi = Math.min(n - 1, i + EASE), at = [];
	for (let j = lo; j <= hi; j++) at.push([j, easeAt(Math.abs(j - i))]);
	const measure = hit => {
		let max = 0, sum = 0, fresh = 0;
		for (let j = lo; j <= hi; j++) { const x = hit(j), p = Math.max(0, x?.past ?? 0); max = Math.max(max, p); sum += p; fresh += (x?.seen ?? []).filter(t => !known.has(t)).length; }
		return { max, sum, fresh };
	};
	const base = measure(j => hits[k][j]), prev = armMotion(out, k, lo - 3, hi + 3);
	let best = null;
	for (const c of movesFor(out, engine, body, k, i, h, known).slice(0, TRIES)) {
		const undo = apply(out, engine, k, c.mv, at), worse = moveWorse(prev, armMotion(out, k, lo - 3, hi + 3));
		const now = worse ? null : measure(j => armHit(out, body, j, k, known)), clearI = !worse && (armHit(out, body, i, k, known)?.past ?? -1) <= 0;
		undo();
		// a move that deepens the window's deepest hit is not made; one that adds a BODY or FACE subject QA did not report
		// (a new problem to QA, which the repair then has to clear too) only when no other move will do
		if (!now || now.max > base.max + 1e-12) continue;
		const r = { mv: c.mv, at, clean: now.fresh <= base.fresh, clear: clearI, size: c.size, gain: [base.max - now.max, base.sum - now.sum] };
		if (!(r.gain[0] >= GAIN || r.gain[1] >= GAIN)) continue;
		const better = !best || (r.clean !== best.clean ? r.clean : r.clear !== best.clear ? r.clear : r.clear ? r.size < best.size : r.gain[0] - best.gain[0] || r.gain[1] - best.gain[1]) > 0;
		if (better) best = r;
		// movesFor sorts the moves that clear the frame by size: none after a clean one that clears it can win
		if (best.clean && best.clear) break;
	}
	return best;
}

/** Why QA `next` is worse than `base` for a span ("" when it is not): the pipeline's rule, then any group but OWN that rose. */
function worseWhy(next, base) {
	const held = q => (q.goals ?? []).filter(g => g.ok).map(g => g.name), lost = held(base).filter(nm => !held(next).includes(nm));
	if (lost.length) return `goal "${lost[0]}" no longer holds`;
	if (!noWorse(next, base)) { const v = compareQa(next, base); return `QA worse (problems ${v.problems[0]} -> ${v.problems[1]}, summed severity ${v.sev[0]} -> ${v.sev[1]})`; }
	const was = new Map(base.groups.map(g => [groupKey(g), g.severity ?? 0]));
	const rose = next.groups.find(g => !OWN.has(g.kind) && (g.severity ?? 0) > (was.get(groupKey(g)) ?? 0) + 0.01);
	return rose ? `${rose.kind} ${rose.subject} ${was.has(groupKey(rose)) ? "worse" : "new"}` : "";
}

/** Runs of consecutive numbers of `list` ([x, why]) with the same why: [{ a, b, why }]. */
function runsOf(list) {
	const runs = [];
	for (const [x, why] of list) {
		const r = runs[runs.length - 1];
		if (r && r.b === x - 1 && r.why === why) r.b = x; else runs.push({ a: x, b: x, why });
	}
	return runs;
}

export function selfRepair(out, engine) {
	const body = bodyFor(out.ctx.sk);
	if (!body) return null;
	const n = out.frames.length, f0 = out.f0 ?? 0, hits = { l: new Array(n), r: new Array(n) };
	let known = null;
	const read = j => { for (const k of KS) hits[k][j] = armHit(out, body, j, k, known); };
	for (let j = 0; j < n; j++) read(j);
	const open = (k, j) => hits[k][j] !== null && hits[k][j].past > 0;
	const deepIn = (a, b) => Math.max(0, ...KS.flatMap(k => hits[k].slice(a, b + 1).map((h, j) => (open(k, a + j) ? h.depth : 0))));
	if (!KS.some(k => hits[k].some((_, j) => open(k, j)))) return null;
	const worst0 = deepIn(0, n - 1), movable = (k, j) => open(k, j) && hits[k][j].hold !== "fk";
	const qa0 = KS.some(k => hits[k].some((_, j) => movable(k, j))) ? qaOf(out) : null;
	// the BODY and FACE subjects QA reports before the repair: a move must not add another (it would count as a new problem)
	known = new Set((qa0?.groups ?? []).filter(g => OWN.has(g.kind)).map(g => `${g.kind} ${g.subject}`));
	// before: the levers and solved frame of every frame index the repair moves, as they were
	const before = new Map(), done = new Set();
	// the move cap: MAX_IT for each run of frames with a hit QA reads
	const cap = MAX_IT * KS.reduce((c, k) => c + runsOf(hits[k].flatMap((_, j) => (movable(k, j) ? [[j, ""]] : []))).length, 0);
	let it = 0;
	while (qa0 && it < cap) {
		let pick = null;
		for (const k of KS) hits[k].forEach((h, j) => { if (movable(k, j) && !done.has(`${k}${j}`) && (!pick || h.past > pick.h.past)) pick = { k, j, h }; });
		if (!pick) break;
		it++;
		const { k, j, h } = pick, best = bestMove(out, engine, body, k, j, h, hits, known);
		if (!best) { done.add(`${k}${j}`); continue; }
		for (const [x] of best.at) if (!before.has(x)) before.set(x, { fr: out.frames[x], v: Object.fromEntries(KS.map(s => [s, leverAt(out, s, f0 + x)])) });
		apply(out, engine, k, best.mv, best.at);
		// the window changed: its frames may take a move again
		for (const [x] of best.at) { read(x); done.delete(`${k}${x}`); }
	}
	// the spans of frames the repair moved (both arms), each kept only where QA is no worse with it
	const after = new Map([...before.keys()].map(x => [x, { fr: out.frames[x], v: Object.fromEntries(KS.map(s => [s, leverAt(out, s, f0 + x)])) }]));
	const put = (s, from) => {
		for (let x = s.a; x <= s.b; x++) { const m = from.get(x); out.frames[x] = m.fr; for (const k of KS) setLever(out, k, f0 + x, m.v[k]); read(x); }
	};
	const openIn = (a, b) => KS.reduce((c, k) => c + hits[k].slice(a, b + 1).filter((_, j) => open(k, a + j)).length, 0);
	const spans = runsOf([...before.keys()].sort((p, q) => p - q).map(x => [x, ""])).map(s => ({ a: s.a, b: s.b, depth: [0, deepIn(s.a, s.b)], open: [0, openIn(s.a, s.b)] }));
	for (const s of spans) { put(s, before); s.depth[0] = deepIn(s.a, s.b); s.open[0] = openIn(s.a, s.b); put(s, after); }
	// a span that neither takes GAIN off its deepest hit nor clears a frame of a hit goes back without asking QA (a take
	// changed for nothing); the rest stand together where QA is no worse with them, else they are tried in halves on top
	// of what stood, down to one span (deepest first)
	const gains = s => s.depth[0] - s.depth[1] >= GAIN || s.open[1] < s.open[0];
	const kept = [], rest = spans.filter(gains).sort((p, q) => q.depth[0] - p.depth[0] || p.a - q.a);
	for (const s of spans.filter(s => !gains(s))) { put(s, before); s.undone = `the span's deepest hit did not drop ${GAIN * 1000} mm and no frame cleared`; }
	const settle = (group, base) => {
		for (const s of group) put(s, after);
		const q = qaOf(out), no = worseWhy(q, base);
		if (!no) { kept.push(...group); return q; }
		for (const s of group) put(s, before);
		if (group.length === 1) { group[0].undone = no; return base; }
		return settle(group.slice(group.length >> 1), settle(group.slice(0, group.length >> 1), base));
	};
	if (rest.length) { for (const s of rest) put(s, before); settle(rest, qa0); }
	kept.sort((p, q) => p.a - q.a);
	// what is still past the limit, and why
	const left = [];
	for (const k of KS) {
		const why = j => {
			const h = hits[k][j], u = spans.find(s => s.undone && j >= s.a && j <= s.b);
			if (u) return `undone: ${u.undone}`;
			if (h.hold === "fk") return "FK arm (armw near 0): no IK to move";
			if (!done.has(`${k}${j}`)) return `the move cap (${MAX_IT} for each run of frames with a hit)`;
			return h.hold ? "the hand stays on its target and no elbow turn clears it" : "no IK move clears it within the limits";
		};
		for (const r of runsOf(hits[k].flatMap((h, j) => (open(k, j) ? [[j, why(j)]] : [])))) left.push({ at: `f${f0 + r.a}-f${f0 + r.b}`, side: k, why: r.why });
	}
	return { spans: kept.map(s => ({ at: `f${f0 + s.a}-f${f0 + s.b}`, depth: s.depth.map(round4) })), depth: [round4(worst0), round4(deepIn(0, n - 1))], iterations: it, ...(left.length ? { left } : {}),
		how: "an arm left in the torso, hips, head or thigh moved out with its IK (wrist target out along the skin, or the elbow turned), deepest first, eased over the frames around; a span QA reads worse with gets its frames back" };
}
