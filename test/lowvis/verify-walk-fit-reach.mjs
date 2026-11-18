#!/usr/bin/env node
// The counted move's fit, second repairs (gait.js, pace.js fitCount, measure.mjs travel lines), each over the case a
// review measured and variations of other sizes, ways, frames, gaits, paces and scales: a turn on the spot that would
// leave a move under 4 frames is made while walking, so every joint is a number; `end` spots are told with the step onto
// them and how far that foot lands from the hips; a run stepped as a walk names a walk's longest step; a pace that stops
// or starts at full speed is fitted to how far its feet land from the hips, so the body does not drop. Scenes and specs
// are written here.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildClip } from "../../src/lowvis/engine-simple/engine.js";
import { STAND_Y } from "../../src/lowvis/engine-simple/gait.js";
import { travel } from "../../src/lowvis/pi/measure.mjs";
import { INDEX as J, JOINT_COUNT } from "../../src/lowvis/rig17.js";

const I = [0, "idle", {}];
/** One character's clip: hips depth and fall while moving, foot plants, the longest step along the hips' line, told text. */
function run(acts, { frames = 260, scale = 1, heading = 0 } = {}) {
	const spec = { demo: "x", a: acts }, { clip, aux } = buildClip(spec, { frames, characters: [{ id: "a", at: [0, 0], heading, ...(scale === 1 ? {} : { scale }) }], props: [] });
	const c = clip.characters[0], at = (f, j) => { const i = (f * JOINT_COUNT + j) * 3; return [c.pos[i], c.pos[i + 1], c.pos[i + 2]]; };
	const on = []; for (let f = 1; f < frames; f++) { const a = at(f - 1, J.Hips), b = at(f, J.Hips); if (Math.hypot(b[0] - a[0], b[2] - a[2]) * 24 > 0.05) on.push(f); }
	const first = on[0] ?? 0, last = on.at(-1) ?? 0;
	let low = 0, fall = 0; for (let f = first; f <= last; f++) { low = Math.max(low, STAND_Y * scale - at(f, J.Hips)[1]); if (f > first) fall = Math.max(fall, at(f - 1, J.Hips)[1] - at(f, J.Hips)[1]); }
	const plants = []; for (let f = 1; f < frames; f++) for (const s of [0, 1]) if (aux.contacts.a[f][s] && !aux.contacts.a[f - 1][s]) { const p = at(f, s ? J.RightFoot : J.LeftFoot); plants.push({ f, s, p: [p[0], p[2]] }); }
	const h0 = at(first, J.Hips), h1 = at(last, J.Hips), dl = Math.hypot(h1[0] - h0[0], h1[2] - h0[2]) || 1, dir = [(h1[0] - h0[0]) / dl, (h1[2] - h0[2]) / dl];
	const spot = [J.LeftFoot, J.RightFoot].map(j => { const p = at(0, j); return [p[0], p[2]]; });
	const longest = plants.reduce((m, pl) => { const o = spot[1 - pl.s], d = Math.abs((pl.p[0] - o[0]) * dir[0] + (pl.p[1] - o[1]) * dir[1]); spot[pl.s] = pl.p; return Math.max(m, d); }, 0);
	const nan = Array.from(c.pos).some(x => !Number.isFinite(x)) || Array.from(c.quat).some(x => !Number.isFinite(x));
	const end = at(frames - 1, J.Hips), was = [J.LeftFoot, J.RightFoot].map(j => { const p = at(0, j); return [p[0], p[2]]; });
	// on the floor: each plant against the spot the other foot stood on then, and against the Hips joint as it lands
	const floor = plants.map(pl => { const o = was[1 - pl.s], h = at(pl.f, J.Hips); was[pl.s] = pl.p; return { step: Math.hypot(pl.p[0] - o[0], pl.p[1] - o[1]), far: Math.hypot(pl.p[0] - h[0], pl.p[1] - h[2]) }; });
	return { low: low * 1000, fall: fall * 1000, plants, floor, longest, nan, end: [end[0], end[2]], text: travel(clip, aux, spec).flatMap(t => t.told).join("; ") };
}

// --- V1: a turn on the spot never leaves a move without frames: every joint is a number, the body arrives ---
for (const [name, verb, o, gap, scale] of [
	["review: 2 m behind, steps 4", "walk", { to: [0, -2], steps: 4 }, 6, 1],
	["review: 0.6 m back facing front again, steps 2", "walk", { to: [0, -0.6], heading: 0, steps: 2 }, 12, 1],
	["a run to the back right that arrives facing right, steps 3, scale 0.8", "run", { to: [1.5, -2], heading: 90, steps: 3 }, 7, 0.8],
	["a push to a place behind, steps 3", "push", { to: [0.3, -1.2], steps: 3 }, 9, 1],
	["a walk ahead that arrives facing back, stepFrames 6, scale 1.3", "walk", { to: [0.4, 1.8], heading: 180, steps: 2, stepFrames: 6 }, 5, 1.3],
]) for (let n = 4; n <= gap + 2; n++) {
	const to = o.to.map(v => v * scale), r = run([I, [10, verb, { ...o, to }], [10 + n, "idle", {}]], { frames: 60, scale });
	assert.ok(!r.nan, `${name} in ${n} frames: every joint is a number`);
	assert.ok(Math.hypot(r.end[0] - to[0], r.end[1] - to[1]) < 0.3 * scale, `${name} in ${n} frames: the body ends at its place (${r.end.map(v => v.toFixed(2))})`);
}
{
	const r = run([I, [10, "walk", { to: [0, 2] }], [70, "walk", { to: [0.3, 0.9], heading: 0 }], [76, "idle", {}]], { frames: 120 });
	assert.ok(!r.nan, "a chain whose last walk turns back in 6 frames: every joint is a number");
}
console.log("ok V1 counted and chained moves of 4 to 14 frames with turns on the spot: every joint is a number, each ends at its place");

// --- V2: end spots: the line gives the step onto them and how far that foot lands from the hips ---
for (const [name, o, scale, first] of [
	["review: 3.2 m, steps 4, L 0.2 ahead", { to: [0, 3.2], steps: 4, end: { L: [0, 0.2], R: [0, -0.15] } }, 1, null],
	["2.6 m, steps 3, R 0.3 ahead, scale 1.2", { to: [0, 2.6], steps: 3, end: { L: [0, -0.2], R: [0, 0.3] } }, 1.2, "L"],
	["2 m back facing front, steps 4, R 0.3 behind", { to: [0, -2], facing: 0, steps: 4, end: { L: [0, 0.1], R: [0, -0.3] } }, 1, "R"],
	["a count that fits, 2 m, steps 4, L 0.25 ahead", { to: [0, 2], steps: 4, end: { L: [0, 0.25], R: [0, -0.2] } }, 1, null],
]) {
	const s = scale, end = Object.fromEntries(Object.entries(o.end).map(([k, v]) => [k, v.map(x => x * s)]));
	const r = run([I, [10, "walk", { ...o, to: o.to.map(v => v * s), end, ...(first ? { first } : {}) }]], { scale: s });
	const m = /its end spots, which the count is not fitted to, make a step of up to ([\d.]+) m onto them and put a foot ([\d.]+) m from the hips as it lands: /.exec(r.text);
	const said = [...r.text.matchAll(/steps of up to ([\d.]+) m|make a step of up to ([\d.]+) m onto them/g)].map(x => +(x[1] ?? x[2]));
	assert.ok(m, `${name}: the line tells the end spots: ${r.text}`);
	assert.ok(said.some(v => Math.abs(v - r.longest) <= 0.1 * s), `${name}: a length the line gives is the longest step walked (${r.longest.toFixed(2)}): ${r.text}`);
	console.log(`ok V2 ${name}: longest step ${r.longest.toFixed(2)} m, told ${m[1]} m onto the end spots, the foot ${m[2]} m from the hips`);
}
{
	const r = run([I, [10, "walk", { to: [0, 2.4], steps: 5, end: { L: [0, 0.1], R: [0, -0.1] } }]]);
	assert.ok(!/end spots/.test(r.text), `end spots a walk steps onto are not told: ${r.text}`);
	console.log("ok V2 end spots within a walk's step: nothing told");
}

// --- V3: a run stepped as a walk names a walk's longest step, and says why ---
for (const [name, o, scale, longest] of [
	["review: 4 m back, facing 0, steps 4", { to: [0, -4], facing: 0, steps: 4 }, 1, 0.75],
	["2 m to the left, facing 0, steps 3, scale 0.8", { to: [-2, 0], facing: 0, steps: 3 }, 0.8, 0.44],
	["0.414 m to the left (under 0.5 m at scale 0.9: a short run), steps 2", { to: [0.46, 0], steps: 2 }, 0.9, null],
]) {
	const r = run([I, [10, "run", { ...o, to: o.to.map(v => v * scale) }]], { frames: 220, scale });
	assert.ok(/of a walk that way \(this run steps as a walk: (it has facing|it goes [\d.]+ m, under 0\.5 m times its body's scale, [\d.]+ m)\), [\d.]+ m/.test(r.text) && !/of a run that way/.test(r.text), `${name}: ${r.text}`);
	if (longest) assert.ok(r.text.includes(`, ${(longest * scale).toFixed(2)} m, so it took`), `${name}: names the walk's longest that way times the scale: ${r.text}`);
	console.log(`ok V3 ${name}: ${r.plants.length} plants, the line names a walk's longest step`);
}

// --- V4: a pace that stops or starts at full speed is fitted to how far its feet land from the hips ---
for (const [name, verb, o, scale] of [
	["review: a run 4 m, steps 5, ease in", "run", { to: [0, 4], steps: 5, ease: "in" }, 1],
	["a run 3 m, steps 3, burst, scale 0.8", "run", { to: [0, 3], steps: 3, burst: true }, 0.8],
	["a run 3.2 m to the front right, steps 4, ease out", "run", { to: [2, 2.5], steps: 4, ease: "out" }, 1],
	["a run 2.5 m, steps 4, ease in, stepFrames 6, scale 1.3", "run", { to: [0, 2.5], steps: 4, ease: "in", stepFrames: 6 }, 1.3],
	["a walk 2.4 m, steps 4, ease linear (at speed from start to stop)", "walk", { to: [0, 2.4], steps: 4, ease: "linear" }, 1],
]) {
	const r = run([I, [10, verb, { ...o, to: o.to.map(v => v * scale) }]], { frames: 300, scale });
	assert.ok(r.low < 150 * scale && r.fall < 80 * scale && !r.nan, `${name}: pelvis ${r.low.toFixed(0)} mm under standing, falls ${r.fall.toFixed(0)} mm in a frame`);
	assert.ok(/so it took \d+ plants/.test(r.text), `${name}: the line tells the plants taken: ${r.text}`);
	console.log(`ok V4 ${name}: ${r.plants.length} plants, pelvis ${r.low.toFixed(0)} mm, fall ${r.fall.toFixed(0)} mm`);
}
{
	const r = run([I, [10, "run", { to: [0, 2], steps: 3 }]], { frames: 200 });
	assert.ok(/make 2 steps of up to 1\.00 m \(the last plant brings the feet together\), and put a foot up to [\d.]+ m from the hips as it lands or lifts, further than a run at a steady pace of its longest steps that way puts one, 0\.45 m, so it took \d+ plants/.test(r.text), `a run whose steps fit but whose feet land far from the hips is told why: ${r.text}`);
	console.log("ok V4 a run 2 m, steps 3 (steps of 1 m): told the foot's distance from the hips");
}
// --- X1: end spots to the side, or ahead and to the side, are measured on the floor: the step onto them and the foot ---
// [name, verb, options, scale, the gait's longest step and reach that way at scale 1]; the last case is within them
for (const [name, verb, o, scale, [lim, reach]] of [
	["review: 2 m, steps 4, L 0.4 left, R 0.4 right", "walk", { to: [0, 2], steps: 4, end: { L: [0.4, 0], R: [-0.4, 0] } }, 1, [0.75, 0.45]],
	["1.8 m back facing front, steps 4, L 0.35 left 0.1 behind, scale 0.85", "walk", { to: [0, -1.8], facing: 0, steps: 4, end: { L: [0.35, -0.1], R: [0, 0] } }, 0.85, [0.75, 0.45]],
	["a run 3.4 m to the front left, steps 4, R 0.5 right 0.1 ahead, scale 1.25", "run", { to: [1.5, 3], steps: 4, end: { L: [0, 0], R: [-0.5, 0.1] } }, 1.25, [1.2, 0.45]],
	["1.5 m to the right facing front, steps 5, L 0.3 ahead, R 0.3 behind", "walk", { to: [-1.5, 0], facing: 0, steps: 5, end: { L: [0, 0.3], R: [0, -0.3] } }, 1, [0.44, 0.26]],
	["within: 2.4 m, steps 5, L 0.08 left, R 0.08 right", "walk", { to: [0, 2.4], steps: 5, end: { L: [0.08, 0], R: [-0.08, 0] } }, 1, [0.75, 0.45]],
]) {
	const s = scale, end = Object.fromEntries(Object.entries(o.end).map(([k, v]) => [k, v.map(x => x * s)]));
	const r = run([I, [10, verb, { ...o, to: o.to.map(v => v * s), end }]], { frames: 220, scale: s }), last = r.floor.slice(-2);
	const onto = Math.max(...last.map(x => x.step)), lands = Math.max(...last.map(x => x.far)), over = onto > (lim + 0.1) * s || lands > (reach + 0.05) * s;
	const m = /its end spots, which the count is not fitted to, make a step of up to ([\d.]+) m onto them and put a foot ([\d.]+) m from the hips/.exec(r.text);
	assert.equal(over, !name.startsWith("within"), `${name}: the case is ${over ? "over" : "within"} the gait's bounds (onto ${onto.toFixed(2)} m, lands ${lands.toFixed(2)} m)`);
	if (over) assert.ok(m, `${name}: end spots over the bounds are told: ${r.text}`);
	// the line's step and foot are those of one of the last two plants (the one the end spots made, not the move's own)
	if (m) assert.ok(last.some(x => Math.abs(+m[1] - x.step) <= 0.1 * s) && last.some(x => Math.abs(+m[2] - x.far) <= 0.1 * s), `${name}: the line gives the step ${m[1]} m and the foot ${m[2]} m, the floor ${last.map(x => `${x.step.toFixed(2)} / ${x.far.toFixed(2)}`).join(", ")} m`);
	console.log(`ok X1 ${name}: onto the end spots ${onto.toFixed(2)} m, the foot ${lands.toFixed(2)} m from the hips; ${m ? `told ${m[1]} / ${m[2]} m` : "nothing told"}`);
}

// --- X2: why a run steps as a walk, by the body's scale: its facing, or a distance under 0.5 m times the scale ---
{
	const header = readFileSync(new URL("../../src/lowvis/engine-simple/engine.js", import.meta.url), "utf8").split("\n").filter(l => l.startsWith("//")).join(" ").replace(/\s*\/\/\s*/g, " ");
	assert.ok(header.includes("A run with `facing` or of under 0.5 m times the body's scale steps as a walk."), "SPEC FORMAT names the scale of the short run");
}
for (const [name, o, scale, reason] of [
	["review: a run 0.65 m to the left, steps 2, scale 1.4", { to: [0.65, 0], steps: 2 }, 1.4, "it goes 0.65 m, under 0.5 m times its body's scale, 0.70 m"],
	["a run 0.58 m to the left facing front, steps 2, scale 1.2", { to: [0.58, 0], facing: 0, steps: 2 }, 1.2, "it has facing and it goes 0.58 m, under 0.5 m times its body's scale, 0.60 m"],
	["a run 0.9 m to the right facing front, steps 2, scale 0.7", { to: [-0.9, 0], facing: 0, steps: 2 }, 0.7, "it has facing)"],
	["a run 0.45 m ahead, steps 2, scale 0.8 (not short for its size)", { to: [0, 0.45], steps: 2 }, 0.8, null],
	["a run 0.4 m to the left, steps 2, scale 0.7 (not short for its size)", { to: [0.4, 0], steps: 2 }, 0.7, null],
]) {
	const r = run([I, [10, "run", o]], { frames: 160, scale }), gaps = r.plants.slice(1).map((p, i) => p.f - r.plants[i].f);
	if (reason) assert.ok(r.text.includes(`(this run steps as a walk: ${reason}`), `${name}: the reason is what the engine tests: ${r.text}`);
	else assert.ok(!/steps as a walk/.test(r.text) && gaps.length && Math.max(...gaps) < 11, `${name}: it steps as a run (${gaps.join(", ")} frames apart): ${r.text}`);
	console.log(`ok X2 ${name}: ${reason ? `told "${reason}"` : `run steps ${gaps.join(", ")} frames apart`}`);
}
// --- Y1-Y3: end spots are told as the feet land on the floor, wherever they are stepped onto: in place (a move of no
// length), in the turn on the spot of an arrival heading, at the end of a path that curves into its heading, and by a
// push, whose feet trail its hips. The line's step and foot are the floor's; "longer" / "further" are so; a stance past
// the bounds is told. [name, verb, options, scale, the gait that steps onto them, the start
// heading]; bounds: that gait's longest and reach ahead (in place and in a turn on the spot a walk's), as told for a push.
const endLine = text => /its end spots, which the count is not fitted to, make a step of up to ([\d.]+) m onto them and put a foot ([\d.]+) m from the hips as it lands: ([^;]*)/.exec(text);
const BOUND = { walk: [0.75, 0.45], run: [1.2, 0.45], push: [0.4, 0.37] };
for (const [name, verb, o, scale, gait, heading = 0] of [
	["review Y1: in place, steps 2, L 0.4 left, R 0.4 right", "walk", { to: [0, 0], steps: 2, end: { L: [0.4, 0], R: [-0.4, 0] } }, 1, "walk"],
	["Y1: a run in place turning to facing 45, steps 3, L 0.5 ahead, R 0.45 behind, scale 0.9", "run", { to: [0, 0], facing: 45, steps: 3, end: { L: [0.1, 0.5], R: [-0.1, -0.45] } }, 0.9, "walk"],
	["Y1: in place facing 200, steps 4, stepFrames 9, R 0.55 right, scale 1.15", "walk", { to: [0, 0], steps: 4, stepFrames: 9, end: { R: [-0.55, 0.1] } }, 1.15, "walk", 200],
	["review Y1: 2 m ahead, heading 180, steps 4, L 0.4 left, R 0.4 right", "walk", { to: [0, 2], heading: 180, steps: 4, end: { L: [0.4, 0], R: [-0.4, 0] } }, 1, "walk"],
	["Y1: a run to the back left that turns to heading 90 at the end, steps 3, L 0.45 left, scale 0.8", "run", { to: [-2.5, 1], heading: 90, steps: 3, end: { L: [0.45, 0.2] } }, 0.8, "walk"],
	["Y1: a walk to the back left that turns to heading -20 at the end, steps 5, R 0.35 behind", "walk", { to: [1, -1.5], heading: -20, steps: 5, end: { R: [-0.3, -0.35] } }, 1, "walk"],
	["review Y2: 2.6 m ahead, arrives heading -90, steps 4, R 0.3 right", "walk", { to: [0, 2.6], heading: -90, steps: 4, end: { R: [-0.3, 0] } }, 1, "walk"],
	["review Y2: a run 3 m ahead, arrives heading 90, steps 3, L 0.5 left", "run", { to: [0, 3], heading: 90, steps: 3, end: { L: [0.5, 0] } }, 1, "run"],
	["Y2: to the front left, arrives heading 120, steps 4, R 0.5 right, scale 1.1", "walk", { to: [1.2, 2], heading: 120, steps: 4, end: { R: [-0.5, 0] } }, 1.1, "walk"],
	["Y2: a run to the back right, arrives heading -30, steps 4, 0.55 apart, scale 0.85", "run", { to: [-3, -1], heading: -30, steps: 4, end: { L: [0.55, 0], R: [-0.55, 0] } }, 0.85, "run"],
	["review Y3: push 1.2 m, steps 4, L 0.3 ahead, R 0.2 behind", "push", { to: [0, 1.2], steps: 4, end: { L: [0, 0.3], R: [0, -0.2] } }, 1, "push"],
	["Y3: push to the front left, steps 5, L 0.25 behind, scale 1.25", "push", { to: [0.5, 1.5], steps: 5, end: { L: [0, -0.25] } }, 1.25, "push"],
	["Y3: push to the front right, steps 4, stepFrames 14, R 0.25 behind, scale 0.85", "push", { to: [-1, 0.6], steps: 4, stepFrames: 14, end: { R: [-0.05, -0.25] } }, 0.85, "push"],
	["within: push 1.2 m, steps 5, L 0.02 ahead", "push", { to: [0, 1.2], steps: 5, end: { L: [0, 0.02] } }, 1, "push"],
	["within: in place, steps 2, L 0.08 left, R 0.08 right", "walk", { to: [0, 0], steps: 2, end: { L: [0.08, 0], R: [-0.08, 0] } }, 1, "walk"],
]) {
	const s = scale, end = Object.fromEntries(Object.entries(o.end).map(([k, v]) => [k, v.map(x => x * s)])), act = { ...o, to: o.to.map(v => v * s), end };
	const r = run([I, [10, verb, act]], { scale: s, heading }), last = r.floor.slice(-2), m = endLine(r.text);
	const onto = Math.max(...last.map(x => x.step)), lands = Math.max(...last.map(x => x.far)), [lim, reach] = BOUND[gait];
	const own = verb === "push" ? Math.max(...run([I, [10, verb, { ...act, end: undefined }]], { scale: s, heading }).floor.map(x => x.far)) : 0;
	const over = onto > (lim + 0.1) * s || lands > Math.max(reach + 0.05, own / s + 0.05) * s;
	if (name.startsWith("within")) assert.ok(!over, `${name}: the case is within the bounds (onto ${onto.toFixed(2)} m, lands ${lands.toFixed(2)} m)`);
	if (over) assert.ok(m, `${name}: end spots past the bounds are told: ${r.text}`);
	if (m) {
		const step = last.find(x => Math.abs(+m[1] - x.step) <= 0.05 * s), foot = last.find(x => Math.abs(+m[2] - x.far) <= 0.05 * s);
		assert.ok(step && foot, `${name}: the line gives ${m[1]} / ${m[2]} m, the floor ${last.map(x => `${x.step.toFixed(2)} / ${x.far.toFixed(2)}`).join(", ")} m`);
		const lg = /longer than the longest step of a \w+ that way(?: \([^)]*\))?, ([\d.]+) m/.exec(m[3]), fu = /further than a \w+ at a steady pace of its longest steps that way puts one, ([\d.]+) m/.exec(m[3]);
		assert.ok((!lg || step.step > +lg[1]) && (!fu || foot.far > +fu[1]) && (lg || fu), `${name}: what the line calls longer or further is so (onto ${onto.toFixed(2)}, lands ${lands.toFixed(2)}): ${m[3]}`);
	}
	console.log(`ok Y ${name}: onto ${onto.toFixed(2)} m, the foot ${lands.toFixed(2)} m from the hips; ${m ? `told ${m[1]} / ${m[2]} m` : "nothing told"}`);
}
console.log("PASS verify-walk-fit-reach");
