// Self repair (spec.fix.self, after self.js): an arm part still in the character's own torso, hips, neck, head or thigh
// past QA's BODY or FACE limit (self-hits.js armHit, on QA's body and measures) after the elbow plan and the skin pushes.
// Over the whole take, the deepest hit first:
//  - the arm moves out on that frame (self-moves.js): on its IK the wrist target out along the skin's normal where the
//    part is deepest (ctx.skinPush, slid back toward the shoulder when it would go past the arm's reach, so the elbow
//    bends instead of the arm locking straight) or the elbow turned about the shoulder-wrist line (ctx.swivel); on FK the
//    arm raised out from the body or its elbow bent (ctx.fkArm). Each is tried on that frame alone; the TRIES best are then
//    tried spread over the frames within EASE of it (an FK move also held over the run of frames with a hit around it),
//    smootherstep down to 0 at the window's edge, so nothing pops; frames
//    the keys hold the arm still on with its hand on the body count as one, so hands keyed onto the hips take one
//    constant move, clockOf), and
//    the one that clears the frame with the smaller move of the elbow and wrist wins, provided the window's summed depth
//    past the limit does not rise; with none clearing it, the one that takes the most off the window, at least GAIN.
//    Each lever stays within its limit in all (self-moves.js), the elbow no higher over the shoulder than it was; the IK
//    keeps the elbow's fold and the wrist's limits. A move that adds a POP or a FLIP to the arm, or makes the elbow's or the wrist's POP worse as QA would group it, is not made (self-guard.js);
//  - again, until no hit is past the limit or MAX_IT moves are tried for each run of frames with a hit. A hand held on
//    its target (self-hits.js "pinned") or on the body keeps it: only the elbow turns, and a wrist push spread toward it
//    fades with the weight that holds it; such a hand takes no FK move.
// Never worse: a span that neither takes GAIN off its deepest hit nor clears a frame gets its frames back; the others
// stand together where QA (qa-of.js, as pipeline.js reads it) is no worse with them, else they are tried in halves on
// top of what stood, down to one span.
// A group stands where QA is no worse by keptRetime's rule (qa/verdict.js noWorse: problems, summed severity, goals
// held), no goal that held is lost, and no group but BODY and FACE got worse or new (a contact, a grasp, a support, a
// planted foot, a carried object, a collision with an object or a person, a reach, a pop or a flip); else its spans get
// their frames back exactly (the solved frames are kept, not solved again). Takes with no hit past the limit are not
// touched. Reported in fixed.self: spans [{ at, depth: [before, after] }], depth [before, after] (m, the deepest hit),
// iterations, and left [{ at, side, why }]: the frames still past the limit, with why.
import { bodyFor } from "../body.js";
import { round4 } from "./ease.js";
import { qaOf } from "./qa-of.js";
import { noWorse, compareQa } from "../qa/verdict.js";
import { groupKey } from "../qa/severity.js";
import { armHit, handOnBody, handsPast } from "./self-hits.js";
import { leverAt, setLever, apply, movesFor, GAIN } from "./self-moves.js";
import { armMotion, moveWorse, popsOutside } from "./self-guard.js";

const EASE = 10, MAX_IT = 48, TRIES = 6;
/** The kinds this repair is about; every other group must not get worse. */
const OWN = new Set(["BODY", "FACE"]);
const KS = ["r", "l"];
/** 1 at the moved frame, 0 at EASE + 1 frames away (smootherstep). */
const easeAt = d => { const t = Math.min(1, d / (EASE + 1)); return 1 - t * t * t * (t * (6 * t - 15) + 10); };

/** Equal channel values (numbers or vectors) to 1e-9. */
const same = (a, b) => (Array.isArray(a) && Array.isArray(b) ? a.length === b.length && a.every((x, i) => same(x, b[i])) : a === b || (typeof a === "number" && typeof b === "number" && Math.abs(a - b) <= 1e-9));
/** Side k's clock over the take's frame indices: it stops where the keys hold the arm still with its hand on the body
 * (every channel but the other arm's the same as the frame before, the hand's skin on the torso, hips or a thigh: hands
 * keyed onto the hips), so that held run is one instant to the ease and a move eased onto it is one constant move over
 * the run, not a wave across a pose keyed to hold still. `on`: handOnBody of side k per frame index, before the repair. */
function clockOf(out, k, on) {
	const F = out.frames, other = new RegExp(`_${k === "l" ? "r" : "l"}$`), t = new Float64Array(F.length);
	for (let j = 1; j < F.length; j++) {
		const a = F[j - 1].c, b = F[j].c, names = new Set([...Object.keys(a), ...Object.keys(b)].filter(nm => !other.test(nm)));
		t[j] = t[j - 1] + (on(j - 1) && on(j) && [...names].every(nm => same(a[nm], b[nm])) ? 0 : 1);
	}
	return t;
}

/** Side k's frame indices within EASE of frame indices ra..rb on its clock, each with its share ([j, share]): 1 on
 * ra..rb, easing to 0 EASE + 1 frames beyond (easeAt). */
function windowOf(out, clock, ra, rb) {
	const at = [];
	for (let j = 0; j < out.frames.length; j++) {
		const d = Math.max(0, clock[ra] - clock[j], clock[j] - clock[rb]);
		if (d <= EASE) at.push([j, easeAt(d)]);
	}
	return at;
}

/** The move for side k's hit h on frame index i, spread over its window: { mv, at } or null (movesFor's TRIES best,
 * tried in place). The window is the frames within EASE of frame i on side k's clock; an FK move is tried there and
 * also held whole over the run of frames with a hit around i, easing out beyond it (an arm hanging into the thigh all
 * through a swing or a walk takes one angle there, as if it were keyed to hang wider, instead of a wave of eased moves
 * whose small shares at a window's edge can take a part deeper: the skin is not convex). A move must take GAIN off the
 * window's deepest hit, or off its summed depth past the limit without deepening that hit; one that clears frame i that
 * way wins by the smaller move, else the larger gain. */
function bestMove(out, engine, body, k, i, h, hits, known, clock, wide) {
	const measure = (w, hit) => {
		let max = 0, sum = 0, fresh = 0;
		for (let j = w.lo; j <= w.hi; j++) { const x = hit(j), p = Math.max(0, x?.past ?? 0); max = Math.max(max, p); sum += p; fresh += (x?.seen ?? []).filter(t => !known.has(t)).length; }
		return { max, sum, fresh };
	};
	const whole = armMotion(out, k, 0, out.frames.length - 1), span = (w, f) => Array.from({ length: w.hi - w.lo + 1 }, (_, n) => f(w.lo + n));
	// a move must not take the hands into each other (QA's SELF), nor deeper where they are (crossed arms)
	const handsWorse = w => span(w, j => handsPast(out, j)).some((p, n) => p > 0 && p > w.hands[n] + 1e-9);
	// the guard reads the frames whose pops the move can change (popLevel looks 3 either side of a frame whose
	// acceleration, 2 frames back, moved), against the arm's hardest pops elsewhere in the take
	const frame = at => {
		const w = { at, lo: at[0][0], hi: at[at.length - 1][0] };
		w.prev = armMotion(out, k, w.lo - 3, w.hi + 5);
		w.rest = popsOutside(whole, w.prev.lo, w.prev.hi);
		w.base = measure(w, j => hits[k][j]);
		w.hands = span(w, j => handsPast(out, j));
		return w;
	};
	let ra = i, rb = i;
	while (ra > 0 && hits[k][ra - 1]?.past > 0) ra--;
	while (rb < out.frames.length - 1 && hits[k][rb + 1]?.past > 0) rb++;
	const here = frame(windowOf(out, clock, i, i)), run = ra < rb ? frame(windowOf(out, clock, ra, rb)) : null;
	let best = null;
	for (const c of movesFor(out, engine, body, k, i, h, known, wide).slice(0, TRIES)) {
		for (const w of c.mv.out || c.mv.bend ? [here, run].filter(Boolean) : [here]) {
			const undo = apply(out, engine, k, c.mv, w.at), worse = moveWorse(w.prev, armMotion(out, k, w.lo - 3, w.hi + 5), w.rest) || handsWorse(w);
			const now = worse ? null : measure(w, j => armHit(out, body, j, k, known)), clearI = !worse && (armHit(out, body, i, k, known)?.past ?? -1) <= 0;
			undo();
			// a move that deepens the window's deepest hit is not made; one that adds a BODY or FACE subject QA did not report
			// (a new problem to QA, which the repair then has to clear too) only when no other move will do
			if (!now || now.max > w.base.max + 1e-12) continue;
			const r = { mv: c.mv, at: w.at, clean: now.fresh <= w.base.fresh, clear: clearI, size: c.size, gain: [w.base.max - now.max, w.base.sum - now.sum] };
			if (!(r.gain[0] >= GAIN || r.gain[1] >= GAIN)) continue;
			const better = !best || (r.clean !== best.clean ? r.clean : r.clear !== best.clear ? r.clear : r.clear ? r.size < best.size : r.gain[0] - best.gain[0] || r.gain[1] - best.gain[1]) > 0;
			if (better) best = r;
			// movesFor sorts the moves that clear the frame by size: none after a clean one that clears it can win
			if (best.clean && best.clear) return best;
		}
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
	const clock = Object.fromEntries(KS.map(k => [k, clockOf(out, k, j => handOnBody(out, body, j, k))]));
	const worst0 = deepIn(0, n - 1);
	// the BODY and FACE subjects of the arms QA reports before the repair (armHit seen, every frame): a move should not add
	// another (it would count as a new problem)
	known = new Set(KS.flatMap(k => hits[k].flatMap(h => h?.seen ?? [])));
	// before: the levers and solved frame of every frame index the repair moves, as they were
	const before = new Map(), done = new Set();
	// the move cap: MAX_IT for each run of frames with a hit QA reads
	const cap = MAX_IT * KS.reduce((c, k) => c + runsOf(hits[k].flatMap((_, j) => (open(k, j) ? [[j, ""]] : []))).length, 0);
	// first the moves round the hit (self-moves.js), until nothing is left or each frame is tried; then, on what is left,
	// the wider set too, with a cap of its own
	let it = 0;
	for (const wide of [false, true]) {
		done.clear();
		for (let tries = 0; tries < cap; tries++) {
			let pick = null;
			for (const k of KS) hits[k].forEach((h, j) => { if (open(k, j) && !done.has(`${k}${j}`) && (!pick || h.past > pick.h.past)) pick = { k, j, h }; });
			if (!pick) break;
			it++;
			const { k, j, h } = pick, best = bestMove(out, engine, body, k, j, h, hits, known, clock[k], wide);
			if (!best) { done.add(`${k}${j}`); continue; }
			for (const [x] of best.at) if (!before.has(x)) before.set(x, { fr: out.frames[x], v: Object.fromEntries(KS.map(s => [s, leverAt(out, s, f0 + x)])) });
			apply(out, engine, k, best.mv, best.at);
			// the window changed: its frames may take a move again
			for (const [x] of best.at) { read(x); done.delete(`${k}${x}`); }
		}
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
	// QA of the take before the repair is read only when a span may stand
	if (rest.length) { for (const s of rest) put(s, before); settle(rest, qaOf(out)); }
	kept.sort((p, q) => p.a - q.a);
	// what is still past the limit, and why
	const left = [];
	for (const k of KS) {
		const why = j => {
			const h = hits[k][j], u = spans.find(s => s.undone && j >= s.a && j <= s.b);
			if (u) return `undone: ${u.undone}`;
			if (!done.has(`${k}${j}`)) return `the move cap (${MAX_IT} for each run of frames with a hit)`;
			return h.hold === "fk" ? "no FK move (the arm out, the elbow bent) clears it within the limits" : h.hold ? "the hand stays on its target and no elbow turn clears it" : "no move clears it within the limits";
		};
		for (const r of runsOf(hits[k].flatMap((h, j) => (open(k, j) ? [[j, why(j)]] : [])))) left.push({ at: `f${f0 + r.a}-f${f0 + r.b}`, side: k, why: r.why });
	}
	return { spans: kept.map(s => ({ at: `f${f0 + s.a}-f${f0 + s.b}`, depth: s.depth.map(round4) })), depth: [round4(worst0), round4(deepIn(0, n - 1))], iterations: it, ...(left.length ? { left } : {}),
		how: "an arm left in the torso, hips, head or thigh moved out, deepest first: on its IK the wrist target out along the skin or the elbow turned, on FK the arm raised out from the body or the elbow bent; eased over the frames around; a span QA reads worse with gets its frames back" };
}
