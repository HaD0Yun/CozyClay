#!/usr/bin/env node
// Every number the travel lines tell of a counted move is the clip's own (gait.js stepper lands, pace.js endSplit,
// measure.mjs travel), and an option is named as a cause only where the same move without it does not do it.
// Over random counted moves of every kind (walk, run, push; straight, sideways, curved arrival, arrival turn, in place;
// with and without end spots, facing, ease, burst, stepFrames, first; body scales 0.7 to 1.4; any start heading) the
// told text is read as the writer reads it and each number recomputed from the clip: foot plants (aux.contacts), ankles
// and the Hips joint on the frame a foot lands; a step is a plant's ankle to the other ankle on that frame (the other
// foot's last plant when it is in the air). The end spots are weighed plant by plant: each of the last two plants
// against the same foot's last plant of the same move without `end`. Tolerance: TOL x scale for lengths (a length
// against a bound too: the line rounds it to centimetres), 1 frame for frames. The count line gives the plants taken and
// no length of them (the plan's step and the hips' travel are not one measure of a step for every way: sideways the
// ankles stand apart, on a curve the feet swing round). Not checked: the plant count of a move with plants on
// consecutive frames (a step under a frame in the air need not lift on any frame: counted apart, "crammed").
// Scenes and specs are made here.
// LOWVIS_TOLD_N=<moves per kind> runs more (default 12), LOWVIS_TOLD_SEED=<n> other moves.
import assert from "node:assert/strict";
import { buildClip } from "../../src/lowvis/engine-simple/engine.js";
import { measure, travel } from "../../src/lowvis/pi/measure.mjs";
import { INDEX as J, JOINT_COUNT } from "../../src/lowvis/rig17.js";

const TOL = 0.03, N = +(process.env.LOWVIS_TOLD_N ?? 12), FRAMES = 320, F0 = 10;
// the most a gait steps or lands a foot from the hips that way (ahead: its largest, per unit scale; a turn on the spot
// steps as a walk): an end spot past both these and the same move without it is told
const MOST = { walk: [0.75, 0.45], run: [1.2, 0.45], push: [0.4, 0.37] };
let seed = +(process.env.LOWVIS_TOLD_SEED ?? 20261118);
const rnd = () => { seed = (seed + 0x6D2B79F5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = a => a[Math.floor(rnd() * a.length)], range = (a, b) => a + (b - a) * rnd(), r2 = v => Math.round(v * 100) / 100;
const gap = (P, Q) => Math.hypot(P[0] - Q[0], P[1] - Q[1]);

/** One random counted move of a kind: { verb, o (world metres), scale, heading (start), next (frame of the next act) }. */
function move(kind) {
	const verb = pick(["walk", "run", "push"]), scale = r2(range(0.7, 1.4)), heading = Math.round(range(-180, 180)), yaw = heading * Math.PI / 180;
	const d = kind === "in place" ? 0 : range(0.6, 3.4) * scale, a = kind === "sideways" ? pick([-1, 1]) * range(Math.PI / 4, Math.PI / 2) : range(-Math.PI, Math.PI) * (kind === "straight" ? 0.25 : 1);
	const to = [r2(Math.sin(yaw + a) * d), r2(Math.cos(yaw + a) * d)], way = Math.atan2(to[0], to[1]) * 180 / Math.PI;
	const o = { to, steps: 2 + Math.floor(rnd() * 5) };
	if (kind === "sideways") return { verb: pick(["walk", "run"]), o: { ...o, facing: heading, ...(rnd() < 0.3 && { stepFrames: 8 + Math.floor(rnd() * 10) }), ...(rnd() < 0.4 && { end: { [pick(["L", "R"])]: [r2(range(-0.4, 0.4) * scale), r2(range(-0.4, 0.4) * scale)] } }) }, scale, heading, next: F0 + 40 + Math.floor(rnd() * 140) };
	if (kind === "curved arrival") o.heading = Math.round(way + pick([-1, 1]) * range(20, 95));
	if (kind === "arrival turn") o.heading = Math.round(way + pick([-1, 1]) * range(110, 180));
	if (verb !== "push" && kind === "in place" && rnd() < 0.3) o.facing = Math.round(heading + range(-120, 120));
	if (verb !== "push" && kind === "straight" && rnd() < 0.2) o.facing = heading;
	if (rnd() < 0.3) o.stepFrames = 6 + Math.floor(rnd() * 16);
	if (rnd() < 0.15) o.ease = pick(["in", "out", "linear"]); else if (rnd() < 0.1) o.burst = true;
	if (rnd() < 0.3) o.first = pick(["L", "R"]);
	const e = rnd();
	if (e < 0.15) o.end = {};
	else if (e < 0.85) { const big = rnd() < 0.5 ? 0.12 : 0.55; o.end = {}; for (const s of ["L", "R"]) if (rnd() < 0.75) o.end[s] = [r2(range(-big, big) * scale), r2(range(-big, big) * scale)]; }
	return { verb, o, scale, heading, next: F0 + 40 + Math.floor(rnd() * 140) };
}

/** The clip of one move, and its plants on the floor from frame F0 to the next act. */
function built({ verb, o, scale, heading, next }, drop = null) {
	const op = { ...o }; if (drop) delete op[drop];
	const spec = { demo: "x", a: [[0, "idle", {}], [F0, verb, op], [next, "idle", {}]] };
	const { clip, aux } = buildClip(spec, { frames: FRAMES, characters: [{ id: "a", at: [0, 0], heading, ...(scale === 1 ? {} : { scale }) }], props: [] });
	const c = clip.characters[0], at = (f, j) => { const i = (f * JOINT_COUNT + j) * 3; return [c.pos[i], c.pos[i + 2]]; }, foot = s => (s ? J.RightFoot : J.LeftFoot);
	const C = aux.contacts.a, last = [0, 1].map(s => at(F0 - 1, foot(s))), plants = [];
	for (let f = F0; f < next; f++) for (const s of [0, 1]) if (C[f][s] && !C[f - 1][s]) {
		const p = at(f, foot(s)), other = C[f][1 - s] ? at(f, foot(1 - s)) : last[1 - s];
		plants.push({ f, s, p, step: gap(p, other), far: gap(p, at(f, J.Hips)) }); last[s] = p;
	}
	const rows = Object.fromEntries(travel(clip, aux, spec).map(t => [t.a, t])), slide = measure(clip, aux).find(r => r.key === "slide");
	// a foot the leg does not reach is drawn in from where the stepper put it, and the slide row tells that (over its spike)
	return { spec, plants, text: (rows[F0]?.told ?? []).join("; "), slid: slide.value > slide.spike };
}

const n2 = re => (re ? re.slice(1).map(x => (x == null ? null : Number(x))) : null);
const checked = {}, lines = {}, unreached = {}, cram = {}, fails = [];
const ok = (kind, what, cond, msg) => { checked[kind] = (checked[kind] ?? 0) + 1; if (!cond) fails.push(`${kind}: ${what}: ${msg}`); };
// The review's cases (round 5: Z1 a push's end line pairs two feet, Z2 a push's own step told as its end spots', Z3 the
// count line of a push that arrives on a curve) and variations of other sizes, sides, headings and frames.
const push = (o, scale = 1, heading = 0, next = 300) => ({ verb: "push", o, scale, heading, next });
const CASES = [
	["Z1", push({ to: [0, 1.2], steps: 4, end: { R: [-0.05, 0] } })], ["Z1", push({ to: [0, 1.2], steps: 4, end: { R: [0, -0.08] } })],
	["Z1", push({ to: [0.76, 0.76], steps: 3, end: { L: [0, -0.04] } }, 1.2, 40)], ["Z1", push({ to: [0, 1.3], heading: 50, steps: 3, first: "R", end: { R: [0.05, 0.02] } }, 0.8, -30)],
	["Z2", push({ to: [0, 1], heading: -95, steps: 2, end: {} })], ["Z2", push({ to: [0, 0], steps: 3, end: { L: [0, 0] } }, 1.2, 70)],
	["Z2", push({ to: [0, 1.6], heading: 70, steps: 4, end: { R: [0, 0.02] } }, 0.8)], ["Z2", push({ to: [-1.2, 0.5], heading: 10, steps: 3, stepFrames: 15, end: {} }, 1.3, 180)],
	["Z3", push({ to: [0, 1], heading: -95, steps: 2 })], ["Z3", push({ to: [1.5, 0], heading: 170, steps: 3, first: "R" }, 1.2)],
	["Z3", push({ to: [-0.8, -1], heading: 120, steps: 3, stepFrames: 15 }, 0.8, 200)], ["Z3", push({ to: [0, 1.4], heading: 45, steps: 5, ease: "in" }, 1.1)],
	// round 6: A1 an end spot's long step beside a longer step of the move's own, A2 the move's own step given as the end
	// spots', A3 a sideways count line over the longest it names
	["A1", push({ to: [0, 1], heading: -95, steps: 5, end: { L: [0, 0.6] } })], ["A1", push({ to: [1.1, 0.5], heading: 75, steps: 4, end: { R: [0.06, 0.66] } }, 1.2, 10)],
	["A1", push({ to: [0, 0], steps: 3, stepFrames: 14, end: { L: [-0.05, 0.4], R: [0, 0.02] } }, 0.8, 130)],
	["A2", push({ to: [0, 1], heading: -95, steps: 5, end: { L: [0, -0.15] } })], ["A2", push({ to: [0, 0], steps: 2, end: { R: [0.03, -0.14] } }, 1.15, 40)],
	["A2", push({ to: [-0.9, 0.7], heading: -10, steps: 4, first: "R", end: { L: [0.05, -0.1] } }, 0.9, -60)],
	["A3", { verb: "walk", o: { to: [1, 0], facing: 0, steps: 2 }, scale: 1, heading: 0, next: 300 }], ["A3", { verb: "run", o: { to: [-2.1, 0.4], facing: 0, steps: 2 }, scale: 1.3, heading: 0, next: 300 }],
	["A3", { verb: "walk", o: { to: [-0.64, -0.64], facing: -90, steps: 2, stepFrames: 15 }, scale: 0.75, heading: -90, next: 200 }],
];
for (const [kind, m] of CASES) check(kind, m);
for (const kind of ["straight", "sideways", "curved arrival", "arrival turn", "in place"]) for (let i = 0; i < N; i++) check(kind, move(kind));

function check(kind, m) {
	const s = m.scale, A = built(m), t = A.text, name = `${m.verb} ${JSON.stringify(m.o)} scale ${s} from ${m.heading} next ${m.next}`;
	for (const k of [kind, m.verb]) lines[k] = (lines[k] ?? 0) + (t ? t.split("; the ").length : 0);
	ok(kind, "reached", !(A.slid && kind.startsWith("Z")), `a review case whose feet slide: ${name}`);
	if (A.slid) { unreached[kind] = (unreached[kind] ?? 0) + 1; return; } // its feet are not where the lines say, and a row says so
	const turns = [...t.matchAll(/it turned on the spot (first|at the end) \((\d+) plants in (\d+) frames\) besides its (\d+) plants/g)].map(x => ({ when: x[1], k: +x[2], frames: +x[3] }));
	const kFirst = turns.find(x => x.when === "first")?.k ?? 0, kEnd = turns.find(x => x.when === "at the end")?.k ?? 0;
	const took = n2(/so it took (\d+) plants/.exec(t)), sf =/stepFrames (\d+) asked: (\d+) plants at \d+ frames need (\d+) frames to land, the action has (\d+) \([^)]*\)(?: and turns on the spot in (\d+) of them, leaving (\d+))?, so each step took ([\d.]+)/.exec(t);
	const n = took?.[0] ?? (sf ? +sf[2] : m.o.steps), own = A.plants.slice(kFirst, kFirst + n);
	const crammed = A.plants.some((p, j) => j && p.f - A.plants[j - 1].f < 2);
	if (crammed) cram[kind] = (cram[kind] ?? 0) + 1;
	ok(kind, "plants", crammed || A.plants.length === kFirst + n + kEnd,`${A.plants.length} plants on the floor, told ${kFirst} + ${n} + ${kEnd}: ${name}: ${t}`);
	ok(kind, "count told", own.length === m.o.steps || crammed || !!took, `${own.length} plants for steps ${m.o.steps}, no count line: ${name}: ${t}`);
	if (took) {
		ok(kind, "taken has no length", /so it took \d+ plants(;|$)/.test(t), `the count line gives a length of what was taken: ${t}`);
		const asked = n2(/(\d+) plants over ([\d.]+) m make (\d+) steps? of up to ([\d.]+) m/.exec(t));
		if (asked) ok(kind, "asked steps", asked[2] === asked[0] - 1 && asked[3] >= asked[1] / asked[2] - 0.01 && asked[3] <= asked[1] + 0.01, `${asked}: ${t}`);
		const lg = n2(/(?:make \d+ steps? of up to ([\d.]+) m[^,]*\), )longer than the longest step of a \w+ that way(?: \([^)]*\))?, ([\d.]+) m/.exec(t)), fu = n2(/put a foot up to ([\d.]+) m from the hips as it lands or lifts, further than a \w+ at a steady pace of its longest steps that way puts one, ([\d.]+) m/.exec(t));
		if (lg) ok(kind, "asked longer", lg[0] >= lg[1], `${lg}: ${t}`);
		if (fu) ok(kind, "asked further", fu[0] >= fu[1], `${fu}: ${t}`);
	}
	if (sf) {
		const room = m.next - F0 - 3, steps = own.length > 1 ? (own.at(-1).f - own[0].f) / (own.length - 1) : +sf[7];
		ok(kind, "stepFrames room", +sf[4] === room && +sf[3] > (sf[6] ? +sf[6] : room), `room ${room}: ${sf[0]}`);
		ok(kind, "stepFrames took", Math.abs(steps - +sf[7]) <= 1, `plants ${steps.toFixed(2)} frames apart, told ${sf[7]}: ${name}`);
	}
	const el = /its end spots, which the count is not fitted to, make a step of up to ([\d.]+) m onto them and put a foot ([\d.]+) m from the hips as it lands: ([^;]*)/.exec(t);
	if (m.o.end) {
		// each of the last two plants against the same foot's last plant without `end`: moved (its ankle), lengthened (its step)
		const B = built(m, "end"), tail = [0, 1].map(k => A.plants.findLast(p => p.s === k)).filter(Boolean);
		const by = p => B.plants.findLast(q => q.s === p.s) ?? { p: [NaN, NaN], step: NaN, far: NaN };
		const made = p => gap(p.p, by(p).p) > TOL * s || p.step - by(p).step > TOL * s, show = tail.map(p => `${p.s ? "R" : "L"} step ${p.step.toFixed(3)}/${by(p).step.toFixed(3)} far ${p.far.toFixed(3)}/${by(p).far.toFixed(3)} moved ${gap(p.p, by(p).p).toFixed(3)}`).join(", ");
		if (el) {
			const lgE = n2(/longer than the longest step of a \w+ that way(?: \([^)]*\))?, ([\d.]+) m(?:, and than a step there without its end spots, ([\d.]+) m)?/.exec(el[3])), fuE = n2(/further than a \w+ at a steady pace of its longest steps that way puts one, ([\d.]+) m(?:, and than that foot lands without its end spot, ([\d.]+) m)?/.exec(el[3]));
			// the plants whose step / foot the numbers can be (two plants may be within the tolerance): one of them must be so
			const plants = tail.filter(p => Math.abs(p.step - +el[1]) <= TOL * s && made(p)), feet = tail.filter(p => Math.abs(p.far - +el[2]) <= TOL * s && made(p));
			ok(kind, "end step", plants.length > 0, `told ${el[1]}, a step the end spots made: ${show}: ${name}: ${t}`);
			ok(kind, "end foot", feet.length > 0, `told ${el[2]}, a foot of a plant the end spots made: ${show}: ${name}: ${t}`);
			if (lgE && plants.length) ok(kind, "end longer", plants.some(p => p.step > lgE[0] - TOL * s && p.step - by(p).step > TOL * s && (lgE[1] == null || Math.abs(lgE[1] - by(p).step) <= TOL * s)), `${show}: ${name}: ${t}`);
			if (fuE && feet.length) ok(kind, "end further", feet.some(p => p.far > fuE[0] - TOL * s && p.far - by(p).far > 0.02 * s && (fuE[1] == null || Math.abs(fuE[1] - by(p).far) <= TOL * s)), `${show}: ${name}: ${t}`);
			ok(kind, "end cause", !!(lgE || fuE), el[0]);
		} else {
			const [lim, reach] = MOST[kEnd ? "walk" : m.verb].map(v => v * s);
			const long = tail.some(p => p.step > lim + 0.1 * s && p.step - by(p).step > 0.1 * s), wide = tail.some(p => p.far > Math.max(reach, by(p).far) + 0.05 * s);
			ok(kind, "end untold", !(long || wide), `no end line: ${show}: ${name}: ${t}`);
		}
	} else ok(kind, "no end", !el, t);
}
console.log(`told lines / numbers and causes checked / moves whose leg does not reach a foot (slide row): ${Object.keys(checked).map(k => `${k} ${lines[k] ?? 0} / ${checked[k]} / ${unreached[k] ?? 0}`).join(", ")}; crammed: ${JSON.stringify(cram)}; told lines by gait: ${["walk", "run", "push"].map(k => `${k} ${lines[k] ?? 0}`).join(", ")}`);
if (fails.length) console.log(fails.slice(0, 12).join("\n"));
assert.equal(fails.length, 0, `${fails.length} told numbers or causes are not the clip's`);
console.log("PASS verify-told-floor");
