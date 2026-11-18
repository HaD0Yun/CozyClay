#!/usr/bin/env node
// The counted move's fit, second repairs (gait.js, pace.js fitCount, measure.mjs travel lines), each over the case a
// review measured and variations of other sizes, ways, frames, gaits, paces and scales: a turn on the spot that would
// leave a move under 4 frames is made while walking, so every joint is a number; `end` spots are told with the step onto
// them and how far that foot lands from the hips; a run stepped as a walk names a walk's longest step; a pace that stops
// or starts at full speed is fitted to how far its feet land from the hips, so the body does not drop. Scenes and specs
// are written here.
import assert from "node:assert/strict";
import { buildClip } from "../../src/lowvis/engine-simple/engine.js";
import { STAND_Y } from "../../src/lowvis/engine-simple/gait.js";
import { travel } from "../../src/lowvis/pi/measure.mjs";
import { INDEX as J, JOINT_COUNT } from "../../src/lowvis/rig17.js";

const I = [0, "idle", {}];
/** One character's clip: hips depth and fall while moving, foot plants, the longest step along the hips' line, told text. */
function run(acts, { frames = 260, scale = 1 } = {}) {
	const spec = { demo: "x", a: acts }, { clip, aux } = buildClip(spec, { frames, characters: [{ id: "a", at: [0, 0], heading: 0, ...(scale === 1 ? {} : { scale }) }], props: [] });
	const c = clip.characters[0], at = (f, j) => { const i = (f * JOINT_COUNT + j) * 3; return [c.pos[i], c.pos[i + 1], c.pos[i + 2]]; };
	const on = []; for (let f = 1; f < frames; f++) { const a = at(f - 1, J.Hips), b = at(f, J.Hips); if (Math.hypot(b[0] - a[0], b[2] - a[2]) * 24 > 0.05) on.push(f); }
	const first = on[0] ?? 0, last = on.at(-1) ?? 0;
	let low = 0, fall = 0; for (let f = first; f <= last; f++) { low = Math.max(low, STAND_Y * scale - at(f, J.Hips)[1]); if (f > first) fall = Math.max(fall, at(f - 1, J.Hips)[1] - at(f, J.Hips)[1]); }
	const plants = []; for (let f = 1; f < frames; f++) for (const s of [0, 1]) if (aux.contacts.a[f][s] && !aux.contacts.a[f - 1][s]) { const p = at(f, s ? J.RightFoot : J.LeftFoot); plants.push({ f, s, p: [p[0], p[2]] }); }
	const h0 = at(first, J.Hips), h1 = at(last, J.Hips), dl = Math.hypot(h1[0] - h0[0], h1[2] - h0[2]) || 1, dir = [(h1[0] - h0[0]) / dl, (h1[2] - h0[2]) / dl];
	const spot = [J.LeftFoot, J.RightFoot].map(j => { const p = at(0, j); return [p[0], p[2]]; });
	const longest = plants.reduce((m, pl) => { const o = spot[1 - pl.s], d = Math.abs((pl.p[0] - o[0]) * dir[0] + (pl.p[1] - o[1]) * dir[1]); spot[pl.s] = pl.p; return Math.max(m, d); }, 0);
	const nan = Array.from(c.pos).some(x => !Number.isFinite(x)) || Array.from(c.quat).some(x => !Number.isFinite(x));
	const end = at(frames - 1, J.Hips);
	return { low: low * 1000, fall: fall * 1000, plants, longest, nan, end: [end[0], end[2]], text: travel(clip, aux, spec).flatMap(t => t.told).join("; ") };
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
	["0.45 m to the right (under 0.5 m at scale 0.9: a short run), steps 2", { to: [0.45, 0], steps: 2 }, 0.9, null],
]) {
	const r = run([I, [10, "run", { ...o, to: o.to.map(v => v * scale) }]], { frames: 220, scale });
	assert.ok(/of a walk that way \(this run steps as a walk: it has facing or goes under 0\.5 m\), [\d.]+ m/.test(r.text) && !/of a run that way/.test(r.text), `${name}: ${r.text}`);
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
console.log("PASS verify-walk-fit-reach");
