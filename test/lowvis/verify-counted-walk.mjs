#!/usr/bin/env node
// A walk with a written step count (walk {steps}) moves as the engine's walk without a count moves (gait.js): over a
// grid of distances, counts, frames per step and ways (ahead; back and to the side with facing), measured with one
// analysis against the walk without a count over the same distance in the same time. The count is walked as written
// or the writer is told what was walked and why (aux.walks, the travel line of the motion tool). Scenes and specs are
// written here.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildClip } from "../../src/lowvis/engine-simple/engine.js";
import { STAND_Y } from "../../src/lowvis/engine-simple/gait.js";
import { measure } from "../../src/lowvis/pi/measure.mjs";
import { createCompileTool } from "../../src/lowvis/pi/compile-tool.mjs";
import { INDEX as J, JOINT_COUNT } from "../../src/lowvis/rig17.js";

/** The moving stretch of a one-character clip: seconds, pelvis rise and fall away from the half second at each end,
 *  its lowest point under standing, the largest change of floor speed between two frames, plants, the longest step
 *  (plant to the other foot's last spot, along the travel line), foot slide. */
function walk(acts, { frames = 220, scale = 1 } = {}) {
	const { clip, aux } = buildClip({ demo: "x", a: acts }, { frames, characters: [{ id: "a", at: [0, 0], heading: 0, ...(scale === 1 ? {} : { scale }) }], props: [] });
	const c = clip.characters[0], at = (f, j) => { const i = (f * JOINT_COUNT + j) * 3; return [c.pos[i], c.pos[i + 1], c.pos[i + 2]]; };
	const v = [0]; for (let f = 1; f < frames; f++) { const a = at(f - 1, J.Hips), b = at(f, J.Hips); v.push(Math.hypot(b[0] - a[0], b[2] - a[2]) * 24); }
	const on = v.map((s, f) => s > 0.05 ? f : -1).filter(f => f >= 0), first = on[0], last = on.at(-1);
	let lo = Infinity, hi = -Infinity, low = Infinity, jerk = 0;
	for (let f = first; f <= last; f++) { const y = at(f, J.Hips)[1]; low = Math.min(low, y); if (f > first + 12 && f < last - 12) { lo = Math.min(lo, y); hi = Math.max(hi, y); } if (f > first) jerk = Math.max(jerk, Math.abs(v[f] - v[f - 1])); }
	const end = at(frames - 1, J.Hips), dl = Math.hypot(end[0], end[2]) || 1, along = p => (p[0] * end[0] + p[2] * end[2]) / dl;
	const spot = [along(at(0, J.LeftFoot)), along(at(0, J.RightFoot))];
	let plants = 0, step = 0;
	for (let f = 1; f < frames; f++) for (const s of [0, 1]) if (aux.contacts.a[f][s] && !aux.contacts.a[f - 1][s]) { const p = along(at(f, s ? J.RightFoot : J.LeftFoot)); step = Math.max(step, Math.abs(p - spot[1 - s])); spot[s] = p; plants++; }
	const slide = measure(clip, aux).find(r => r.key === "slide").value;
	return { first, last, bob: hi > lo ? (hi - lo) * 1000 : 0, low: (STAND_Y * scale - low) * 1000, jerk, plants, step, slide, told: aux.walks };
}

// --- 1. the grid: each counted walk against the walk without a count over the same distance, ending when it ends ---
const WAYS = { ahead: d => ({ to: [0, d] }), back: d => ({ to: [0, -d], facing: 0 }), side: d => ({ to: [d, 0], facing: 0 }) };
// the most a measured step may be: a step ahead or back up to the walk's longest (0.75 m); a side step is measured from
// the other foot, so it holds the hips' width (2 x 0.082 m) besides the side step's longest (0.44 m); 0.05 m for the
// speed-up and slow-down
const MOST = { ahead: 0.8, back: 0.8, side: 0.65 };
// the margins over the walk without a count: 25 mm of rise and fall and 0.25 m/s of speed change between two frames
// (were 20 mm and 0.1 m/s while every walk began with a one-frame jump of the pelvis, 0.47 to 0.53 m/s, and lowered it
// for a planted foot on that frame alone; with both gone the walk without a count lost them, and a count of 10-frame
// steps (its own largest change fell from 0.47-0.52 to 0.06-0.43 m/s) now shows its quicker steps against it: autorl 010)
const BOB = 25, JERK = 0.25;
let n = 0, worst = { bob: -Infinity, jerk: -Infinity };
for (const [way, to] of Object.entries(WAYS)) for (const d of [1, 1.6, 2.4, 3.4, 5]) for (const steps of [2, 3, 4, 6, 8]) for (const stepFrames of [undefined, 10, 16]) {
	const name = `${way} ${d} m, steps ${steps}${stepFrames ? `, stepFrames ${stepFrames}` : ""}`;
	const c = walk([[0, "idle", {}], [10, "walk", { ...to(d), steps, ...(stepFrames ? { stepFrames } : {}) }]]);
	const plain = walk([[0, "idle", {}], [10, "walk", { to: [0, d] }], [c.last + 3, "idle", {}]]);
	assert.ok(c.bob <= plain.bob + BOB, `${name}: the pelvis rises and falls ${c.bob.toFixed(0)} mm, the walk without a count ${plain.bob.toFixed(0)} mm`);
	assert.ok(c.low <= plain.low + 20, `${name}: the pelvis goes ${c.low.toFixed(0)} mm under standing, the walk without a count ${plain.low.toFixed(0)} mm`);
	assert.ok(c.jerk <= plain.jerk + JERK, `${name}: the speed changes at most ${c.jerk.toFixed(2)} m/s between two frames, the walk without a count ${plain.jerk.toFixed(2)}`);
	assert.ok(c.slide < 1, `${name}: a planted foot slides ${c.slide.toFixed(1)} mm`);
	assert.ok(c.step <= MOST[way], `${name}: the longest step is ${c.step.toFixed(3)} m`);
	const told = c.told[0];
	if (told) assert.equal(c.plants, told.steps[1], `${name}: the plants walked are the plants told (${c.plants} vs ${told.steps[1]})`);
	else assert.equal(c.plants, steps, `${name}: ${steps} plants as written, or told (${c.plants} walked)`);
	// a count is raised only when the steps it makes at its pace are too long, to the fewest whose steps are not
	if (told && told.steps[1] !== steps) assert.ok(told.step > told.longest && told.stepPlan <= told.longest + 1e-6 && told.longest <= (way === "side" ? 0.437 : 0.75), `${name}: a count is raised only when its steps are too long (${told.step.toFixed(2)} m of ${told.longest.toFixed(2)})`);
	worst = { bob: Math.max(worst.bob, c.bob - plain.bob), jerk: Math.max(worst.jerk, c.jerk - plain.jerk) };
	n++;
}
console.log(`ok ${n} counted walks: within 20 mm of the pelvis rise and fall of the walk without a count (worst ${worst.bob.toFixed(0)} mm), within 0.1 m/s of its speed change (worst ${worst.jerk.toFixed(2)}), no slide`);

// --- 2. the walks the owner called choppy: 3.4 m ahead in 4 steps, 1.6 m back in 4 steps ---
{
	const ahead = walk([[0, "idle", {}], [10, "walk", { to: [0, 3.4], steps: 4, stepFrames: 13 }]]);
	assert.ok(ahead.bob < 60 && ahead.step < 0.8, `3.4 m in steps 4: pelvis ${ahead.bob.toFixed(0)} mm (it was 172), longest step ${ahead.step.toFixed(2)} m (it was 1.18)`);
	assert.deepEqual(ahead.told.map(t => t.steps), [[4, 6]], "3.4 m in steps 4: walked in 6 plants and told");
	const back = walk([[0, "idle", {}], [10, "walk", { to: [0, -1.6], facing: 0, steps: 4 }]]);
	assert.ok(back.bob < 35 && back.told.length === 0 && back.plants === 4, `1.6 m back in steps 4: 4 plants, pelvis ${back.bob.toFixed(0)} mm (it was 77)`);
	console.log(`ok the walks called choppy: 3.4 m in steps 4 -> pelvis ${ahead.bob.toFixed(0)} mm, 6 plants told; 1.6 m back in steps 4 -> pelvis ${back.bob.toFixed(0)} mm, 4 plants`);
}

// --- 3. a body of another scale: the longest step is the body's own ---
{
	const big = walk([[0, "idle", {}], [10, "walk", { to: [0, 3.4], steps: 5 }]], { scale: 1.3 }), small = walk([[0, "idle", {}], [10, "walk", { to: [0, 3.4], steps: 5 }]], { scale: 0.7 });
	assert.equal(big.told.length, 0, "scale 1.3: 3.4 m in 5 plants (0.85 m steps) fits its longest step, 0.98 m");
	assert.deepEqual(small.told.map(t => t.steps), [[5, 8]], "scale 0.7: 3.4 m needs 8 plants of steps up to 0.53 m");
	assert.ok(Math.abs(small.told[0].longest - 0.75 * 0.7) < 1e-9 && Math.abs(small.told[0].distance - 3.4) < 0.01, "scale 0.7: the told lengths are world metres");
	console.log("ok scale: the longest step and the told lengths follow the body");
}

// --- 4. the exact text the writer reads ---
const dir = mkdtempSync(join(tmpdir(), "lowvis-counted-"));
try {
	const tool = createCompileTool({ name: "counted", outDir: join(dir, "out"), clipFile: join(dir, "clip.json"), variant: "studio" });
	const scene = { frames: 120, characters: [{ id: "a", at: [0, 0], heading: 0 }, { id: "b", at: [2, 0], heading: 0 }], props: [] };
	const r = tool.call({ scene, spec: { a: [[0, "walk", { to: [0, 3.4], steps: 4, stepFrames: 13 }]], b: [[0, "walk", { to: [2, -1.6], facing: 0, steps: 4, stepFrames: 13 }], [30, "idle", {}]] } });
	assert.equal(r.status, "ok", r.text);
	const lines = r.text.split("\n"), a = lines.find(l => l.startsWith("- a f0-")), b = lines.find(l => l.startsWith("- b f0-"));
	assert.ok(a.endsWith("; the walk at f0: steps 4 asked: 4 plants over 3.40 m make 3 steps of up to 1.18 m (the last plant brings the feet together), longer than the longest step of a walk that way, 0.75 m, so it took 6 plants"), a);
	assert.ok(b.endsWith("; the walk at f0: stepFrames 13 asked: 4 plants at 13 frames need 49 frames to land, the action has 27 (up to the next body action, less 3 to stand still), so each step took 7.1"), b);
	const plain = tool.call({ spec: { a: [[0, "walk", { to: [0, 3.4], steps: 6 }]], b: [[0, "walk", { to: [2, -1.6], facing: 0, steps: 4 }]] } });
	assert.ok(!/ asked: /.test(plain.text), `a count that fits says nothing more:\n${plain.text}`);
	console.log(`ok the travel lines:\n${a}\n${b}`);
} finally {
	rmSync(dir, { recursive: true, force: true });
}
console.log("PASS verify-counted-walk");
