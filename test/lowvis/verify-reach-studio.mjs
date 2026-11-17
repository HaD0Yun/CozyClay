#!/usr/bin/env node
// What the studio variant tells the writer about a limb or a sit that did not end where the spec asked
// (src/lowvis/pi/compile-tool.mjs, measure.mjs, prompt.mjs):
//  1. the reach rows: a wrist, an ankle or an elbow over 10 mm off the target its action gave it (any target form:
//     a body-frame point, a world point, a joint of the own body) is a row in the motion tool's text, with the gap
//     the clip has; a limb within 10 mm of it is no row. The manual describes the rows, elbows named.
//  2. the seat rows: a sit on a prop whose hips end off the prop's top, or whose feet stand inside it, is a row
//     (aux.seats); a sit that ends on the top with the feet outside is none.
// Every scene here is made up for this test.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INDEX as J, JOINT_COUNT } from "../../src/lowvis/rig17.js";
import { createCompileTool } from "../../src/lowvis/pi/compile-tool.mjs";
import { systemPrompt } from "../../src/lowvis/pi/prompt.mjs";

const TMP = mkdtempSync(join(tmpdir(), "lowvis-reach-"));
let n = 0;
const run = (scene, spec, variant = "studio") => { const name = `r${++n}`, t = createCompileTool({ name, outDir: join(TMP, name), clipFile: join(TMP, `${name}.json`), variant }); const r = t.call({ scene, spec }); assert.equal(r.status, "ok", r.text); return { ...r, clipFile: t.clipFile }; };
const lines = (r, re) => r.text.split("\n").filter(l => re.test(l));
const mmOf = line => Number(/: (-?[\d.]+) mm/.exec(line)?.[1]);
const SEAT = { frames: 150, characters: [{ id: "a", at: [0, 0], heading: 0 }], props: [{ id: "chair", size: [0.45, 0.45, 0.45], at: [0, 0.225, -0.35] }] };

// --- 1. reach rows ---
{
	const prompt = systemPrompt("studio");
	assert.match(prompt, /- hand, foot, elbow off its target: how far a wrist, an ankle or an elbow is/, "the studio manual describes the reach rows and names elbows");
	assert.match(prompt, /told when over 10 mm/, "the manual says from what gap a row is told");

	// elbows on the knees while the wrists stay at the chin: the arm cannot do both; the row tells the gap the clip has
	const knee = side => ({ joint: `${side}Leg`, at: [0, 0, 0] }), chin = s => ({ joint: "Head", at: [0.06 * s, -0.1, 0.09] });
	const spec = { a: [[0, "sit", { on: "chair", over: 0 }], [10, "pose", { bow: 20, L: chin(1), R: chin(-1), elbowL: knee("Left"), elbowR: knee("Right"), over: 20 }]] };
	const r = run(SEAT, spec), elbow = lines(r, /^- elbow off its target/);
	assert.equal(elbow.length, 2, `both elbows off the knees are rows:\n${r.text}`);
	const c = r.rows.find(x => x.key === "reach:a:4"), clip = JSON.parse(readFileSync(r.clipFile, "utf8")).characters[0];
	const at = (f, j) => { const i = (f * JOINT_COUNT + j) * 3; return [clip.pos[i], clip.pos[i + 1], clip.pos[i + 2]]; };
	const gap = Math.hypot(...at(c.frame, J.LeftForeArm).map((v, i) => v - at(c.frame, J.LeftLeg)[i])) * 1000;
	assert.ok(Math.abs(gap - c.value) < 0.1 && elbow.some(l => Math.abs(mmOf(l) - gap) < 0.1), `the row is the clip's gap from elbow to knee (${gap.toFixed(1)} mm vs ${c.value.toFixed(1)} mm)`);
	assert.ok(gap > 10, "the case is one the arm cannot reach");

	// a wrist on the own knee arrives (within 10 mm): no row; a wrist and an ankle sent out of reach: a row each
	const near = run(SEAT, { a: [[0, "sit", { on: "chair", over: 0 }], [0, "pose", { L: { joint: "LeftLeg", at: [0, 0.07, 0.02] }, over: 10 }]] });
	assert.equal(lines(near, /off its target/).length, 0, `a wrist that rests on its target is no row:\n${near.text}`);
	const far = run({ ...SEAT, props: [] }, { a: [[0, "pose", { R: { world: [-2, 1, 0] }, footL: { at: [1.5, 0.2, 0] }, over: 0 }]] });
	assert.equal(lines(far, /^- hand off its target/).length, 1, `a world target out of reach is a hand row:\n${far.text}`);
	assert.equal(lines(far, /^- foot off its target/).length, 1, "a foot target out of reach is a foot row");
	// the variants that did not tell reach rows still do not
	assert.equal(lines(run(SEAT, spec, "tilt"), /off its target/).length, 0, "tilt tells no reach row");
	console.log(`ok reach: studio tells the elbow gap ${gap.toFixed(1)} mm as the clip has it, a wrist off its world target and a foot off its target; a wrist on its target is no row`);
}

// --- 2. seat rows ---
{
	const good = run(SEAT, { a: [[0, "sit", { on: "chair", over: 0 }]] });
	assert.equal(lines(good, /^- sit:/).length, 0, `a sit that ends on the top is no row:\n${good.text}`);
	// the figure stands far behind the seat and faces away from it: the sit cannot bring the hips onto it
	const off = run({ ...SEAT, characters: [{ id: "a", at: [0, 0.9], heading: 0 }] }, { a: [[0, "sit", { on: "chair", over: 0 }]] });
	const row = lines(off, /^- sit: hips end this far off the top of chair/), seat = off.rows.find(x => x.key.startsWith("seat:"));
	assert.ok(row.length === 1 && seat.value > 10 && Math.abs(mmOf(row[0]) - seat.value) < 0.1, `hips off the seat are a row (${seat?.value.toFixed(1)} mm):\n${off.text}`);
	// standing on the seat's footprint: the feet are inside it
	const inside = run({ ...SEAT, characters: [{ id: "a", at: [0, -0.35], heading: 0 }] }, { a: [[0, "sit", { on: "chair", over: 0 }]] });
	assert.ok(lines(inside, /^- sit: .*feet? stands? inside chair/).length === 1, `feet inside the seat are said:\n${inside.text}`);
	console.log(`ok seat: a sit on the top is no row; hips ${seat.value.toFixed(0)} mm off the top and feet inside the seat are rows`);
}

rmSync(TMP, { recursive: true, force: true });
console.log("PASS verify-reach-studio");
