#!/usr/bin/env node
// The repairs of the counted walk (gait.js), each over the case a review measured and variations of other sizes, ways,
// frames, orders and scales: a chain of walks plays forward wherever it ends; a backward move stops without a snap; a
// counted walk that fits goes no lower than before the counted walk took the path; slow steps do not stretch at the
// stop; an ease or a burst is fitted to the steps it makes; the travel line says what was computed (frames, a run's or
// a push's own longest step, the turns on the spot); a push with a count under 2 stays up; a walk of under 4 frames
// stands. Scenes and specs are written here.
import assert from "node:assert/strict";
import { buildClip } from "../../src/lowvis/engine-simple/engine.js";
import { STAND_Y } from "../../src/lowvis/engine-simple/gait.js";
import { measure, travel } from "../../src/lowvis/pi/measure.mjs";
import { INDEX as J, JOINT_COUNT } from "../../src/lowvis/rig17.js";

const I = [0, "idle", {}];
/** One character's clip: joint at frame, hips floor speed, foot plants, the moving stretch, check rows, told lines. */
function run(acts, { frames = 260, scale = 1, heading = 0 } = {}) {
	const spec = { demo: "x", a: acts }, { clip, aux } = buildClip(spec, { frames, characters: [{ id: "a", at: [0, 0], heading, ...(scale === 1 ? {} : { scale }) }], props: [] });
	const c = clip.characters[0], at = (f, j) => { const i = (f * JOINT_COUNT + j) * 3; return [c.pos[i], c.pos[i + 1], c.pos[i + 2]]; };
	const v = [0]; for (let f = 1; f < frames; f++) { const a = at(f - 1, J.Hips), b = at(f, J.Hips); v.push(Math.hypot(b[0] - a[0], b[2] - a[2]) * 24); }
	const on = v.map((s, f) => (s > 0.05 ? f : -1)).filter(f => f >= 0), first = on[0] ?? 0, last = on.at(-1) ?? 0;
	const plants = []; for (let f = 1; f < frames; f++) for (const s of [0, 1]) if (aux.contacts.a[f][s] && !aux.contacts.a[f - 1][s]) { const p = at(f, s ? J.RightFoot : J.LeftFoot); plants.push({ f, s, p: [p[0], p[2]] }); }
	let low = Infinity, fall = 0; for (let f = first; f <= last; f++) { low = Math.min(low, at(f, J.Hips)[1]); if (f > first) fall = Math.max(fall, at(f - 1, J.Hips)[1] - at(f, J.Hips)[1]); }
	const h0 = at(first, J.Hips), h1 = at(last, J.Hips), dl = Math.hypot(h1[0] - h0[0], h1[2] - h0[2]) || 1, dir = [(h1[0] - h0[0]) / dl, (h1[2] - h0[2]) / dl];
	const spot = [J.LeftFoot, J.RightFoot].map(j => { const p = at(0, j); return [p[0], p[2]]; });
	const longest = plants.reduce((m, pl) => { const o = spot[1 - pl.s], d = Math.abs((pl.p[0] - o[0]) * dir[0] + (pl.p[1] - o[1]) * dir[1]); spot[pl.s] = pl.p; return Math.max(m, d); }, 0);
	const rows = measure(clip, aux), row = k => rows.find(r => r.key === k)?.value;
	const nan = Array.from(c.pos).some(x => !Number.isFinite(x));
	return { at, v, first, last, plants, low: (STAND_Y * scale - low) * 1000, fall: fall * 1000, longest, slide: row("slide"), jointLow: row("jointLow"), nan, frames, walks: aux.walks, text: travel(clip, aux, spec).flatMap(t => t.told).join("; ") };
}
const corr = (xs, ys) => { const m = v => v.reduce((s, x) => s + x, 0) / v.length, mx = m(xs), my = m(ys); let a = 0, b = 0, c = 0; xs.forEach((x, i) => { a += (x - mx) * (ys[i] - my); b += (x - mx) ** 2; c += (ys[i] - my) ** 2; }); return a / Math.sqrt(b * c); };

// --- W1: a chain of walks without a count plays the walk forward, wherever it ends ---
for (const [name, acts, way, a, b, heading] of [
	["3 m out, back to 0.05 m behind the start", [[0, "walk", { to: [0, 3] }], [140, "walk", { to: [0, -0.05] }]], [0, 1], 20, 120, 0],
	["2 m to the right, back past the start", [[0, "walk", { to: [2, 0] }], [110, "walk", { to: [-0.4, 0.1] }]], [1, 0], 20, 95, 90],
	["a loop of three legs that ends behind its start", [[0, "walk", { to: [-2.2, 0] }], [120, "walk", { to: [-2.2, 1.2] }], [170, "walk", { to: [0.3, 0.2] }]], [-1, 0], 20, 105, 270],
]) {
	const r = run(acts, { heading }), xs = [], ys = [];
	const along = p => p[0] * way[0] + p[2] * way[1];
	for (let f = a; f <= b; f++) { xs.push(along(r.at(f, J.LeftHand)) - along(r.at(f, J.Hips))); ys.push(along(r.at(f, J.LeftFoot)) - along(r.at(f, J.RightFoot))); }
	const k = corr(xs, ys);
	assert.ok(k < -0.3, `${name}: the left wrist swings against the left foot (r ${k.toFixed(2)})`);
	console.log(`ok W1 ${name}: r ${k.toFixed(2)}`);
}

// --- W2: a backward move ends without a snap after the hips stop and its last foot lands ---
// (from the later of the two: since autorl 010 the hips no longer jump as the last foot lands, so they come to rest a
// frame or two before it, while that foot still swings in at up to 31 mm a frame as it did before)
for (const [name, o, opts] of [
	["1.6 m back, facing, steps 4", { to: [0, -1.6], facing: 0, steps: 4 }, {}],
	["2.4 m back, steps 3, stepFrames 16", { to: [0, -2.4], facing: 0, steps: 3, stepFrames: 16 }, {}],
	["back and to the left, facing 90, steps 5, scale 1.3", { to: [-1.5, 0.6], facing: 90, steps: 5 }, { scale: 1.3, heading: 90 }],
	["0.35 m back, no count", { to: [0, -0.35] }, {}],
]) {
	const r = run([I, [10, "walk", o]], { frames: 200, ...opts });
	let worst = 0; for (let f = Math.max(r.last, r.plants.at(-1)?.f ?? 0) + 1; f < r.frames; f++) for (let j = 0; j < JOINT_COUNT; j++) { const p = r.at(f - 1, j), q = r.at(f, j); worst = Math.max(worst, Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2])); }
	assert.ok(worst < 0.03 * (opts.scale ?? 1), `${name}: after the hips stop and the last foot lands no joint moves 30 mm in a frame (${(worst * 1000).toFixed(0)} mm)`);
	console.log(`ok W2 ${name}: ${(worst * 1000).toFixed(0)} mm`);
}

// --- W3: a counted walk that fits goes no lower and falls no harder than before the counted walk took the path ---
// (lowest mm under standing, largest fall in one frame mm, measured with this analysis at d52363da)
for (const [to, o, scale, low, fall] of [
	[[0, 2], { steps: 4 }, 1, 40.8, 15.5], [[0, 1.4], { steps: 3 }, 1, 44.3, 18.2], [[0, 1.8], { steps: 4, stepFrames: 11 }, 1, 32.0, 7.9],
	[[1.2, 1.9], { steps: 5, stepFrames: 12 }, 1, 28.1, 7.8], [[0.5, 2.9], { steps: 6, first: "L" }, 0.85, 37.0, 15.6],
]) {
	const r = run([I, [10, "walk", { to, ...o }]], { frames: 220, scale });
	assert.ok(r.low <= low + 1 && r.fall <= fall + 1 && r.walks.length === 0, `${JSON.stringify({ to, ...o, scale })}: lowest ${r.low.toFixed(1)} mm (was ${low}), fall ${r.fall.toFixed(1)} mm (was ${fall}), told ${r.walks.length}`);
	console.log(`ok W3 ${JSON.stringify({ to, ...o, scale })}: lowest ${r.low.toFixed(1)} mm (was ${low}), fall ${r.fall.toFixed(1)} mm (was ${fall})`);
}

// --- W4: slow steps keep their length to the stop: the same steps as at the walk's own 13 frames, no long last step ---
for (const [to, steps, sf, facing] of [[[0, 2], 4, 24, null], [[0, 3.3], 6, 26, null], [[0, -2.2], 4, 22, 0], [[1.6, 1.6], 4, 30, null]]) {
	const o = { to, steps, ...(facing == null ? {} : { facing }) }, slow = run([I, [10, "walk", { ...o, stepFrames: sf }]], { frames: 420 }), fast = run([I, [10, "walk", { ...o, stepFrames: 13 }]]);
	const name = `${JSON.stringify(o)} at stepFrames ${sf}`;
	assert.ok(slow.longest <= 0.8 && slow.fall < 30, `${name}: longest step ${slow.longest.toFixed(2)} m, fall in one frame ${slow.fall.toFixed(0)} mm`);
	assert.ok(slow.low <= fast.low + 15, `${name}: pelvis ${slow.low.toFixed(0)} mm under standing, ${fast.low.toFixed(0)} at 13 frames a step`);
	console.log(`ok W4 ${name}: longest ${slow.longest.toFixed(2)} m, fall ${slow.fall.toFixed(0)} mm, lowest ${slow.low.toFixed(0)} mm (${fast.low.toFixed(0)} at 13 frames)`);
}

// --- W5: an ease or a burst is fitted to the steps it makes; the line names the plants walked ---
for (const [o, opts] of [
	[{ to: [0, 3.4], steps: 4, ease: "in" }, {}], [{ to: [0, 2.6], steps: 3, ease: "out" }, {}],
	[{ to: [1.5, 1.5], steps: 5, burst: true }, {}], [{ to: [0, -2], facing: 0, steps: 4, ease: "in" }, {}], [{ to: [0, 2.4], steps: 4, ease: "in" }, { scale: 0.8 }],
]) {
	const r = run([I, [10, "walk", o]], { frames: 300, ...opts }), s = opts.scale ?? 1, said = [...r.text.matchAll(/so it took (\d+) plants/g)].map(m => +m[1]);
	assert.ok(r.low < 150 * s && r.longest <= 0.8 * s && r.slide < 1, `${JSON.stringify(o)}: pelvis ${r.low.toFixed(0)} mm, longest step ${r.longest.toFixed(2)} m, slide ${r.slide.toFixed(1)} mm`);
	assert.ok(said.length === 1 && said[0] === r.plants.length, `${JSON.stringify(o)}: the line names the plants walked (${r.plants.length}): ${r.text}`);
	console.log(`ok W5 ${JSON.stringify(o)}: ${r.plants.length} plants, longest ${r.longest.toFixed(2)} m, pelvis ${r.low.toFixed(0)} mm`);
}

// --- W6: the line says the frames the action has, the gait's own longest step and the turns on the spot ---
for (const [name, frames, o, has] of [
	["2.2 m behind, steps 4, stepFrames 13", 70, { to: [0, -2.2], steps: 4, stepFrames: 13 }, 57],
	["2.2 m ahead, heading 180", 80, { to: [0, 2.2], heading: 180, steps: 4, stepFrames: 13 }, 67],
	["1.8 m behind and to the left, steps 3, stepFrames 14", 60, { to: [-0.8, -1.6], steps: 3, stepFrames: 14 }, 47],
]) {
	const r = run([I, [10, "walk", o]], { frames }), m = /the action has (\d+) \(up to the next body action, less 3 to stand still\) and turns on the spot in (\d+) of them, leaving (\d+)/.exec(r.text);
	assert.ok(m && +m[1] === has && +m[1] - +m[2] === +m[3], `${name}: the action has ${has} frames: ${r.text}`);
	const turned = [...r.text.matchAll(/turned on the spot [a-z ]+ \((\d+) plants in \d+ frames\) besides its (\d+) plants/g)];
	assert.ok(turned.length === 1 && +turned[0][1] + +turned[0][2] === r.plants.length, `${name}: the plants of the turn and of the walk are the plants walked (${r.plants.length}): ${r.text}`);
	console.log(`ok W6 ${name}: ${m[0]}`);
}
for (const [verb, o, longest] of [["run", { to: [0, 4], steps: 4 }, "1.20"], ["run", { to: [2, 3.5], steps: 3 }, "1.20"], ["push", { to: [0, 2], steps: 3 }, "0.40"], ["push", { to: [-1.2, 0], steps: 2 }, "0.40"]]) {
	const r = run([I, [10, verb, o]], { frames: 200 });
	assert.ok(r.text.includes(`longer than the longest step of a ${verb} that way, ${longest} m`) && !r.text.includes("of a walk"), `${verb} ${JSON.stringify(o)}: ${r.text}`);
	console.log(`ok W6 ${verb} ${JSON.stringify(o)}: names a ${verb}'s longest step, ${longest} m`);
}
{
	const r = run([I, [10, "walk", { to: [0.5, -2], steps: 3 }]]), m = /turned on the spot first \((\d+) plants in \d+ frames\) besides its (\d+) plants/.exec(r.text);
	assert.ok(m && +m[1] + +m[2] === r.plants.length, `a place behind, steps 3: the line tells the turn: ${r.text}`);
	console.log(`ok W6 a place behind, steps 3: ${r.plants.length} plants, told`);
}

// --- W7: a push with a count under 2 stays up and is told ---
for (const [o, scale] of [[{ to: [0, 1], steps: 1 }, 1], [{ to: [0, 1], steps: 0 }, 1], [{ to: [1.5, 0], steps: 1 }, 0.8], [{ to: [0, -0.8], steps: 0 }, 1.2]]) {
	const r = run([I, [10, "push", o]], { frames: 200, scale }), end = r.at(199, J.Hips)[1];
	assert.ok(end > 0.6 * scale && r.jointLow > -10 && r.slide < 1 && /steps [01] asked: a push of [\d.]+ m takes 2 plants at least/.test(r.text), `push ${JSON.stringify(o)} scale ${scale}: hips end ${end.toFixed(2)} m, lowest joint ${r.jointLow.toFixed(0)} mm: ${r.text}`);
	console.log(`ok W7 push ${JSON.stringify(o)} scale ${scale}: hips end ${end.toFixed(2)} m, ${r.plants.length} plants, told`);
}

// --- W8: a walk of under 4 frames stands and every joint is a number ---
for (const [verb, o] of [["walk", { to: [0, 2], steps: 4 }], ["walk", { to: [1, 1], steps: 2, stepFrames: 12 }], ["push", { to: [0, 1], steps: 3 }], ["walk", { to: [0, 2] }], ["run", { to: [2, 0] }]]) for (const n of [1, 2, 3]) {
	const r = run([I, [10, verb, o], [10 + n, "idle", {}]], { frames: 60 });
	assert.ok(!r.nan, `${verb} ${JSON.stringify(o)} of ${n} frames: every joint is a number`);
}
console.log("ok W8 walks, runs and pushes of 1 to 3 frames: every joint is a number");
console.log("PASS verify-walk-repairs");
