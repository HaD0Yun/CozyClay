// Deterministic auto-fixes the compiler applies after the first solve (spec.fix). Each fix edits
// the baked channels or the per-frame IK offsets and re-solves only the frames it touched, so QA
// still measures the final frames; every fix reports what it changed (counts, worst amount).
//
// spec.fix = { reach: true, slide: true, penetration: 0.02, self: true, retime: true, person: true } (false = all off; retime on by default
// since deep research 4: POP -1.58 +- 0.58 frames, kept only when QA is no worse)
//   reach        wrist targets past the arm's reach go onto it through a soft knee (no snap);
//                ankle targets past the leg's reach lower the hips just enough, eased in and out; a hand
//                on a pinned target (a world or a scene object's anchor) that the straight arm misses brings
//                the body to it: lean, hip shift, lower hips, the feet kept (reach-body.js, fixed.reachBody)
//   slide        a sole under the floor lifts its ankle onto it (ground.js); a planted heel or ball
//                that drifts less than 1 cm stays put, and a foot turning on its planted ball (heel
//                up) or heel pivots about it whatever the drift; a flat planted foot (heel and ball
//                down) keeps its heading until one of them lifts (turn.js)
//   penetration  hands pushed out of scene boxes along the box normal when the depth past the
//                allowance is at most this many metres (true = 0.02), eased in and out
//   self         arms out of the rest of the body on its fitted skin: the elbow turns about the
//                shoulder-wrist line, the hand is pushed out along the skin (self.js); then an arm still in the torso,
//                hips, head or a thigh past QA's BODY or FACE limit moves out with its IK, deepest first, spread over a
//                window of frames, each span kept only where QA is no worse (self-repair.js: fixed.self spans, depth,
//                iterations, left)
//   retime       speed spikes get more frames, borrowed from the neighbouring keys; the key intervals of an air run of
//                4 frames or more that falls, or of 3 (qa/flight-checks.js fallingRuns) are left as keyed: a fall is fast because gravity makes it so (#1124);
//                one a later fix makes starts the fixes again with its key interval kept (applyFixes, fixed.retime.air); the
//                holds of 3-frame runs and of runs a later fix made stand where QA is no worse with them, and wherever the
//                take without them has fewer flights of under MIN_RUN frames that the arc moves, whatever QA reads (applyFixes)
//   ballistic    in each air run of 3 frames or more the whole body moves so the centre of mass follows the gravity
//                parabola between takeoff and landing at constant horizontal speed; past 0.5 m, where the arc enters
//                what the keyed flight did not (flight-gate.js), or a 3-frame run without a real takeoff and landing, it is
//                reported, not fixed (ballistic.js, #1124)
//   spin         in each air run the root's turn is re-timed so the angular momentum about the centre of mass stays
//                constant (faster tucked, slower open), the keyed total turn kept; left where it would enter what the
//                keyed flight did not (flight-gate.js) or read SPIN worse than keyed (spin.js); held about the turn's
//                axis alone where holding the momentum vector reads SPIN worse than that (fixed.spin.axis); its landing, like
//                the arc's push-off and impact, is a contact: QA reads a POP the fixes add there only over POP_HARD (contactPops)
//   stance       a standIdle stance whose legs, feet or hips are in a scene body slides out of it, the least
//                distance (skills/stance.js; applied when the skills expand, reported in observations.placed)
//   person       arms out of the other characters (scene.people, their installed takes; QA PERSON): the wrist
//                target moves out by the depth, back the side the hand came from, eased in and out (person.js)
//   grasp        a holding hand's fingers close on what it holds and the object rests in the hand (#816);
//                false keeps the preset grip and the grab-frame offset
import { lowerHips, armReach } from "./reach.js";
import { reachBody } from "./reach-body.js";
import { lockFeet } from "./slide.js";
import { holdTurns } from "./turn.js";
import { liftSoles } from "./ground.js";
import { clearFeet } from "./clear.js";
import { otherHandHold } from "./other-hand.js";
import { pushOut } from "./push.js";
import { retime } from "./retime.js";
import { selfClear } from "./self.js";
import { selfRepair } from "./self-repair.js";
import { personOut } from "./person.js";
import { ballisticFix } from "./ballistic.js";
import { spinFix } from "./spin.js";
import { flightGate } from "./flight-gate.js";
import { airRuns } from "../qa/style.js";
import { flights, fallingRuns, popsOf, MIN_RUN } from "../qa/flight-checks.js";
import { qaOf } from "./qa-of.js";
import { noWorse, compareQa } from "../qa/verdict.js";

/** The keyed channels a flight fix moves that QA KEY compares with the keys. */
const MOVED = ["root", "foot_l", "foot_r"];
const FIX_KEYS = ["reach", "slide", "clear", "penetration", "self", "retime", "stance", "grasp", "person", "ballistic", "spin"];
export { FIX_KEYS };

export function fixOptions(fix) {
	if (fix === false) return { reach: false, slide: false, clear: false, penetration: 0, self: false, retime: false, stance: false, grasp: false, person: false, ballistic: false, spin: false };
	const f = fix ?? {};
	const pen = f.penetration === true ? 0.02 : Math.min(0.05, Math.max(0, Number(f.penetration) || 0));
	return { reach: f.reach !== false, slide: f.slide !== false, clear: f.clear !== false, penetration: pen, self: f.self !== false, retime: f.retime !== false, stance: f.stance !== false, grasp: f.grasp !== false, person: f.person !== false, ballistic: f.ballistic !== false, spin: f.spin !== false };
}

/** The slide report with the flat feet whose turn waited (turn.js): turns { frames, max deg }. */
const withTurns = (turns, slide) => (turns ? { ...(slide ?? { frames: 0, how: "planted heel/ball held in place" }), turns, how: `${slide?.how ?? "planted heel/ball held in place"}; a flat planted foot keeps its heading until it lifts` } : slide);
/** The self fix's report: the elbow plan and skin pushes (self.js), then the repair of what they left (self-repair.js). */
const withRepair = (clear, repair) => (repair ? { ...clear, ...repair, how: clear ? `${clear.how}; then ${repair.how}` : repair.how } : clear);
const mergeReach = (a, b) => (a && b ? { frames: Math.max(a.frames, b.frames), eased: Math.max(a.eased, b.eased), max: Math.max(a.max, b.max), how: a.how } : a ?? b);

/**
 * Runs the enabled fixes in order (retime first: it moves keys; the flight last: ballistic, spin) and returns their reports.
 * Retime reads the air runs of the first solve, and a later fix can make one where the first solve had a foot or a hand
 * down (bench-handstand-r3: none on the first solve, f21-f27 at the end, all 7 frames re-timed, stretch 1.6). A falling
 * run of the final frames whose frames retime moved (retimedAir) starts the fixes again from the keys, retime keeping
 * that run's key interval as keyed too: once, so a run the second pass makes is reported (fixed.retime.air), not chased.
 * Holding an interval takes frames retime would borrow: when it leaves more frames too fast than the first pass did, the
 * first pass's timing comes back, and fixed.retime.air says so. (The handstand as sent holds: retime does not count the
 * landing frames that read a held velocity, retime.js excess.)
 * Those holds, and the 3-frame falling runs of the first solve (fallingRuns), cost retime frames elsewhere: a run with a
 * trip whose 2- and 3-frame flights were held slid its planted feet more. So the take with them is kept only when QA
 * (runMotionQa, as pipeline.js reads it) is no worse than the take that holds only the runs of MIN_RUN frames or more,
 * by pipeline.js keptRetime's rule (qa/verdict.js noWorse); else that take stands, and fixed.retime.air says which.
 * One exception: where the take without them has fewer flights of under MIN_RUN frames that the arc moves (ballistic.js:
 * between real contacts), the holds stand (fixed.retime.held says so). A standing hop's 3-frame flight re-timed is a
 * 2-frame air run the arc does not reach (12.4 m/s^2 RMS off g, 0 held); QA read the re-timed hop 7 problems, held 12.
 * Cost: the take without the holds is solved only where retime read different windows or times without them (retime.js
 * note.same), and the pass that stands is put back (restore), not solved again.
 */
export function applyFixes(out, fix, engine, opts = {}) {
	const keys = out.keys, short = fix.retime && opts.whole !== false ? fallingRuns(out, airRuns(out, out.ctx.spec?.checks?.supports ?? [])).filter(([a, b]) => b - a + 1 < MIN_RUN) : [];
	const note = {}, first = runFixes(out, fix, engine, opts, [], short, note), missed = first.retime ? retimedAir(out) : [], at = r => r.map(([a, b]) => `f${a}-f${b}`).join(", ");
	if (!missed.length && !short.length) return first;
	let held = first, air = [];
	if (missed.length) {
		const prev = [snapshot(out), note.same], again = fromKeys(out, fix, engine, opts, keys, missed, short, note), fast = r => r.retime?.stillFast ?? 0;
		if (fast(again) <= fast(first)) {
			const left = again.retime ? retimedAir(out) : [];
			if (again.retime) again.retime = { ...again.retime, air: `kept the key intervals of ${at(missed)} as keyed: a later fix made an air run there${left.length ? `; ${at(left)} still re-timed` : ""}` };
			[held, air] = [again, missed];
		} else {
			restore(out, prev[0]);
			note.same = prev[1];
			held.retime = { ...held.retime, air: `re-timed ${at(missed)}, an air run a later fix made: keeping its key interval as keyed left ${fast(again)} frames too fast against ${fast(first)}` };
		}
		if (!air.length && !short.length) return held;
	}
	const runs = at([...short, ...air].sort((p, q) => p[0] - q[0]));
	// retime read the same windows and times without those holds (retime.js note.same): the take without them is this one
	if (note.same) return held;
	const was = snapshot(out), plain = fromKeys(out, fix, engine, opts, keys, [], []);
	if (!plain.retime && !held.retime) return plain;
	const keep = why => { restore(out, was); if (held.retime) held.retime = { ...held.retime, held: `kept the key intervals of ${runs} as keyed: ${why}` }; return held; };
	// a 3-frame flight the arc moves (ballistic.js: between real contacts) that the re-time without the holds takes away
	const arcs = r => (r.ballistic?.at ?? []).filter(s => { const [a, b] = s.slice(1).split("-f").map(Number); return b - a + 1 < MIN_RUN; }).length;
	if (arcs(plain) < arcs(held)) return keep(`without them the arc moves ${arcs(plain)} flights of under ${MIN_RUN} frames against ${arcs(held)}`);
	const without = qaOf(out), mine = snapshot(out);
	restore(out, was);
	const withHold = qaOf(out);
	if (noWorse(withHold, without)) return keep("QA no worse than without (pipeline.js keptRetime's rule)");
	restore(out, mine);
	const v = compareQa(withHold, without);
	if (plain.retime) plain.retime = { ...plain.retime, air: `re-timed ${runs} as well: holding their key intervals as keyed read worse on QA (summed severity ${v.sev[1]} -> ${v.sev[0]}, problems ${v.problems[1]} -> ${v.problems[0]})` };
	return plain;
}

/** What a fix pass leaves in out and out.ctx (their fields, the frames, the entries of the maps the passes share), for restore. */
function snapshot(out) {
	const { ctx } = out, maps = [...["push", "swivel", "skinPush", "fkArm"].flatMap(m => Object.values(ctx[m] ?? {})), ...["sockets", "rims", "supports"].map(m => ctx[m]).filter(Boolean)];
	return { out: { ...out }, ctx: { ...ctx }, frames: out.frames.slice(), maps: maps.map(m => [m, [...m]]) };
}

/** Puts back what snapshot read, instead of solving that pass again: a later fromKeys bakes new channels and frames, so the saved ones stand untouched. */
function restore(out, s) {
	for (const [o, saved] of [[out, s.out], [out.ctx, s.ctx]]) {
		for (const k of Object.keys(o)) if (!(k in saved)) delete o[k];
		Object.assign(o, saved);
	}
	s.frames.forEach((fr, i) => { out.frames[i] = fr; });
	out.frames.length = s.frames.length;
	for (const [m, entries] of s.maps) { m.clear(); for (const [k, v] of entries) m.set(k, v); }
}

/** The fixes again from `keys` on a fresh solve, retime keeping the key intervals of `air` and of the 3-frame runs `short` too (applyFixes). */
function fromKeys(out, fix, engine, opts, keys, air, short, note) {
	for (const k of ["timeMap", "flightPops", "flightMoved", "flightRuns"]) delete out[k];
	for (const m of ["push", "swivel", "skinPush", "fkArm"]) for (const side of Object.values(out.ctx[m] ?? {})) side.clear();
	engine.rebake(keys);
	engine.solve(engine.all());
	return runFixes(out, fix, engine, opts, air, short, note);
}

/** The final take's falling air runs (qa/flight-checks.js fallingRuns) whose frames retime moved, as frames before the retime. */
function retimedAir(out) {
	const map = out.timeMap, n = out.frames.length, runs = fallingRuns(out, airRuns(out, out.ctx.spec?.checks?.supports ?? []));
	if (!map) return [];
	// the frame before the retime that frame g of the take shows (map is increasing)
	const from = g => { let lo = 0, hi = n - 1; for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; if (map(mid) < g) lo = mid; else hi = mid; } return lo; };
	return runs.filter(([a, b]) => Array.from({ length: b - a + 3 }, (_, i) => a - 1 + i).some(f => f >= 0 && f < n && Math.abs(map(f) - f) > 1e-9))
		.map(([a, b]) => [Math.max(0, Math.floor(from(a))), Math.min(n - 1, Math.ceil(from(b)))]);
}

function runFixes(out, fix, engine, { whole = true, repair = true } = {}, air, short, note = {}) {
	const fixed = {}, put = (name, report) => { if (report) fixed[name] = report; };
	const supports = out.ctx.spec?.checks?.supports ?? [];
	// retime leaves a fall alone, a run the take cuts or a hand holds too (qa/flight-checks.js fallingRuns: 3 frames or more; a walk's one-frame lift is none)
	if (fix.retime && whole) {
		// the holds round 5 added (the 3-frame runs `short` of the first solve, a run a later fix made: `air`) are read as held by retime's excess too
		const long = fallingRuns(out, airRuns(out, supports)).filter(([a, b]) => b - a + 1 >= MIN_RUN);
		put("retime", retime(out, engine, [...long, ...short, ...air], [...short, ...air], short.length || air.length ? long : null, note));
	}
	if (fix.slide) put("ground", liftSoles(out, engine));
	if (fix.reach) put("reachLegs", lowerHips(out, engine));
	if (fix.reach) put("reachBody", reachBody(out, engine));
	if (fix.slide) put("slide", withTurns(holdTurns(out, engine), lockFeet(out, engine)));
	if (fix.clear) put("clear", clearFeet(out, engine));
	// a pivot can hold a foot past the leg's reach: the hips go down for those frames too
	if (fix.reach && fixed.slide?.pivots) put("reachLegs", mergeReach(fixed.reachLegs, lowerHips(out, engine)));
	if (fix.grasp) put("otherHand", otherHandHold(out, engine));
	if (fix.penetration > 0) put("penetration", pushOut(out, engine, fix.penetration));
	if (fix.self) { const clear = selfClear(out, engine); put("self", repair ? withRepair(clear, selfRepair(out, engine)) : clear); }
	if (fix.person) put("person", personOut(out, engine));
	if (fix.reach) put("reachArms", armReach(out));
	// the flight last, on the frames QA reads (an air run of the first solve that the leg fixes put back on the ground
	// is no flight): the arc, the spin, and the arc again (a spin turns the body about its hips, so the centre of mass moves)
	if (fix.ballistic || fix.spin) Object.assign(fixed, flightFixes(out, engine, fix, flights(out, airRuns(out, supports))));
	return fixed;
}

/**
 * The ballistic and spin fixes over `runs` (flights). out.flightMoved[ch] = Map(frame -> [dx, dy, dz]) is how far they moved
 * root and the ankles (qa/key-reach.js reads the keys before them); out.flightRuns the runs whose root fix.ballistic moved or
 * whose turn fix.spin re-timed, and out.flightPops the POPs before them (QA's POP on their contact frames, qa/flight-checks.js contactPops).
 */
function flightFixes(out, engine, fix, runs) {
	const fixed = {}, put = (name, report) => { if (report) fixed[name] = report; };
	if (!runs.length) return fixed;
	const before = Object.fromEntries(MOVED.map(ch => [ch, out.baked[ch]?.slice()]));
	out.flightPops = popsOf(out);
	const gate = flightGate(out, runs, out.flightPops);
	if (fix.ballistic) put("ballistic", ballisticFix(out, engine, runs, gate));
	if (fix.spin) put("spin", spinFix(out, engine, runs, gate));
	// the second pass's report joins the first's (ballisticFix prev); null: nothing moved or skipped in either
	if (fix.ballistic && fixed.spin) {
		const arc = ballisticFix(out, engine, runs, gate, fixed.ballistic);
		if (arc) fixed.ballistic = arc;
		else delete fixed.ballistic;
	}
	out.flightMoved = Object.fromEntries(MOVED.filter(ch => before[ch]).map(ch => [ch, new Map(before[ch].flatMap((v, f) => {
		const w = out.baked[ch][f];
		return w !== v && Array.isArray(v) && Array.isArray(w) ? [[f, [w[0] - v[0], w[1] - v[1], w[2] - v[2]]]] : [];
	}))]));
	// a run fix.spin re-timed has the same contacts as one the arc moved: its landing is read against re-timed air frames
	const root = out.flightMoved.root, f0 = out.f0 ?? 0, spun = new Set(fixed.spin?.at ?? []);
	out.flightRuns = runs.filter(([a, b]) => spun.has(`f${a + f0}-f${b + f0}`) || (root && Array.from({ length: b - a + 1 }, (_, i) => a + f0 + i).some(f => root.has(f))));
	return fixed;
}
