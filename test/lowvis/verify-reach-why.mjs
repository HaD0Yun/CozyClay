#!/usr/bin/env node
// A limb whose target is in its reach ends on it, and a reach row that is told says what holds the limb
// (src/lowvis/engine-simple/reach.js, solve.js, src/lowvis/pi/reach-why.mjs, measure.mjs):
//  1. in reach: wrists, ankles and elbows sent to points inside the limb's reach of the body as it stands (standing,
//     bowed, seated, knelt, after a walk; scale 1 and 0.8) end within 10 mm of them. An elbow is in reach on the sphere
//     of the upper arm about the shoulder; with a free wrist the whole arm turns to put it there, and a low elbow target
//     of a free wrist is bent toward by the reach assist as a wrist's is.
//  2. a blend that overshoots (ease "over") is not counted as off its target while it settles.
//  3. out of reach: each reason the writer reads, with the number it gives checked against the clip where the clip
//     has it: beyond the limb's reach, a shoulder that moved after the arrival, the assist at its limit, an elbow
//     target off the upper arm's sphere, an elbow held by its wrist's own target, a late wrist, a foot under the floor,
//     and the engine's own miss. A "why:" reason lies in the spec, an "engine limit:" one does not.
// Every scene here is made up for this test.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INDEX as J, JOINT_COUNT, OFFSET } from "../../src/lowvis/rig17.js";
import { buildClip } from "../../src/lowvis/engine-simple/engine.js";
import { createCompileTool } from "../../src/lowvis/pi/compile-tool.mjs";
import { reachWhy } from "../../src/lowvis/pi/reach-why.mjs";

const len = a => Math.hypot(...a), sub = (a, b) => a.map((v, i) => v - b[i]);
const UPPER = len(OFFSET[J.LeftForeArm]), ARM = UPPER + len(OFFSET[J.LeftHand]), LEG = len(OFFSET[J.LeftLeg]) + len(OFFSET[J.LeftFoot]);
const at = (c, f, j) => { const i = (f * JOINT_COUNT + j) * 3; return [c.pos[i], c.pos[i + 1], c.pos[i + 2]]; };
const one = (frames, extra = {}) => ({ frames, characters: [{ id: "a", at: [0, 0], heading: 0, ...extra }], props: [] });

// --- 1. in reach ---
{
	const POSTURES = { standing: [], bowed: [[0, "pose", { bow: 40, over: 0 }]], seated: [[0, "sit", { height: 0.45, over: 0 }]], knelt: [[0, "kneel", { over: 0 }]], walked: [[0, "walk", { to: [0.4, 1.2] }], [36, "idle"]] };
	const DIRS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1], [1, 1, 1], [-1, -1, 1], [1, -1, -1], [-1, 1, -1]].map(d => d.map(v => v / len(d)));
	const LIMBS = [{ key: "R", root: J.RightArm, slot: 1, reach: ARM, k: 0.85 }, { key: "footL", root: J.LeftUpLeg, slot: 2, reach: LEG, k: 0.85, down: true }, { key: "elbowL", root: J.LeftArm, slot: 4, reach: UPPER, k: 1 }];
	const worst = {};
	let n = 0;
	for (const s of [1, 0.8]) for (const [name, base] of Object.entries(POSTURES)) {
		const ref = buildClip({ demo: "x", a: base }, one(90, { scale: s })).clip.characters[0];
		for (const L of LIMBS) for (const d of DIRS) {
			if (L.down && d[1] > 0.1) continue; // a foot goes forward, back, out or down from its hip
			const P = at(ref, 60, L.root).map((v, i) => v + d[i] * L.reach * s * L.k);
			if (P[1] < 0.12) continue;
			const { aux } = buildClip({ demo: "x", a: [...base, [40, "pose", { [L.key]: { world: P }, over: 12 }]] }, one(90, { scale: s }));
			const e = aux.reach.a[70][L.slot];
			assert.ok(e, `${name} s${s} ${L.key}: the row has the limb`);
			n++;
			if (e.d > (worst[L.key]?.d ?? -1)) worst[L.key] = { d: e.d, name, s, dir: d };
		}
	}
	for (const [key, w] of Object.entries(worst)) assert.ok(w.d <= 0.01, `${key} ends within 10 mm of a target in its reach (worst ${(w.d * 1000).toFixed(1)} mm, ${w.name} at scale ${w.s}, direction ${w.dir.map(v => v.toFixed(2))})`);
	// a free wrist's elbow on a low target past the upper arm: the assist bends the body toward it (seated, the own knee)
	const knee = buildClip({ demo: "x", a: [[0, "sit", { height: 0.45, over: 0 }], [10, "pose", { bow: 50, elbowL: { joint: "LeftLeg", at: [0, 0.05, 0] }, over: 15 }]] }, one(80));
	assert.ok(knee.aux.reach.a[60][4].d <= 0.01, `a seated elbow reaches its own knee with the wrist free (${(knee.aux.reach.a[60][4].d * 1000).toFixed(1)} mm)`);
	console.log(`ok in reach: ${n} targets of wrists, ankles and elbows in 5 postures at 2 sizes, worst ${Object.entries(worst).map(([k, w]) => `${k} ${(w.d * 1000).toFixed(1)} mm`).join(", ")}; the elbow on the own knee ${(knee.aux.reach.a[60][4].d * 1000).toFixed(1)} mm`);
}

// --- 2. an overshooting blend is not a miss while it settles ---
{
	const { aux } = buildClip({ demo: "x", a: [[10, "pose", { R: { world: [-0.3, 1.1, 0.35] }, over: 30, ease: "over" }]] }, one(80));
	assert.ok(aux.reach.a.slice(0, 40).every(r => !r[1]), "no entry before the blend's last frame, though the overshoot passes 1 on the way");
	assert.ok(Math.max(...aux.reach.a.slice(40).map(r => r[1].d)) < 0.002, "after it the wrist is on the target");
	console.log("ok overshoot: a blend with ease over has no reach entry until its frames are over, then it is on the target");
}

// --- 3. reasons ---
const TMP = mkdtempSync(join(tmpdir(), "lowvis-reach-why-"));
let runs = 0;
const run = (scene, spec) => { const name = `w${++runs}`, t = createCompileTool({ name, outDir: join(TMP, name), clipFile: join(TMP, `${name}.json`), variant: "studio" }); const r = t.call({ scene, spec }); assert.equal(r.status, "ok", r.text); return { ...r, clip: JSON.parse(readFileSync(t.clipFile, "utf8")).characters[0] }; };
const told = (r, part) => { const l = r.text.split("\n").filter(x => x.startsWith(`- ${part} off its target`)); assert.equal(l.length, 1, `one ${part} row:\n${r.text}`); return l[0]; };
const near = (a, b, what) => assert.ok(Math.abs(a - b) <= 1.01, `${what}: told ${a} mm, the clip has ${b.toFixed(1)} mm`);
{
	// beyond the arm's reach: the number is the target's distance from the clip's shoulder less the arm
	const T = [-0.3, 1.7, 0.95], far = run(one(60), { a: [[10, "pose", { R: { world: T }, over: 15 }]] }), line = told(far, "hand");
	const m = /^- hand off its target: [\d.]+ mm @f(\d+) a \(R hand, the action at f10; over 10 mm off on \d+ frames; why: on that frame the target is (\d+) mm beyond the arm's reach \(0\.56 m\) from the shoulder\)$/.exec(line);
	assert.ok(m, `beyond: ${line}`);
	near(Number(m[2]), (len(sub(T, at(far.clip, Number(m[1]), J.RightArm))) - ARM) * 1000, "beyond");
	assert.ok(far.rows.some(r => r.key === "reach:a:1"), "the row key stays reach:<character>:<slot>");

	// the shoulder moved after the arrival: a later twist turns it away
	const turned = told(run(one(100), { a: [[0, "kneel", { over: 0 }], [10, "pose", { L: { world: [0.4, 0.5, 0.2] }, over: 20 }], [40, "pose", { twist: -60, over: 20 }]] }), "hand");
	assert.match(turned, /; why: on that frame the target is \d+ mm beyond the arm's reach \(0\.56 m\) from the shoulder; the shoulder is \d+ mm from where it was at f30, the first frame after the blend\)$/, `moved: ${turned}`);

	// low and far in front: the reach assist is hinged as far as it goes
	const low = told(run(one(80), { a: [[10, "pose", { R: { world: [-0.2, 0.05, 0.75] }, over: 20 }]] }), "hand");
	assert.match(low, /; why: on that frame the target is \d+ mm beyond the arm's reach \(0\.56 m\) from the shoulder; the reach assist was hinged at the hips as far as it goes\)$/, `spent: ${low}`);

	// an elbow target off the sphere of the upper arm, nearer and farther; the wrist free
	const inner = told(run(one(80), { a: [[10, "pose", { elbowR: { joint: "Spine2", at: [-0.05, 0, 0.12] }, over: 15 }]] }), "elbow");
	assert.match(inner, /\(R elbow, the action at f10; over 10 mm off on \d+ frames; why: on that frame the target is \d+ mm nearer the shoulder than the upper arm is long \(0\.28 m\); an elbow is always that far from the shoulder\)$/, `nearer: ${inner}`);
	const outer = told(run(one(80), { a: [[10, "pose", { elbowL: { world: [0.9, 1.4, 0] }, over: 15 }]] }), "elbow");
	assert.match(outer, /; why: on that frame the target is \d+ mm farther from the shoulder than the upper arm is long \(0\.28 m\)\)$/, `farther: ${outer}`);

	// the wrist's own target holds the elbow: the number is the nearest the elbow can come, the row's own value
	// (standing, the wrist in front of the chest, the elbow target straight over the shoulder at the upper arm's length)
	const wristOnly = { a: [[10, "pose", { R: [-0.2, 0.45, 0.35], over: 15 }]] }, sh = at(buildClip({ demo: "x", ...wristOnly }, one(80)).clip.characters[0], 40, J.RightArm);
	const held = run(one(80), { a: [[10, "pose", { ...wristOnly.a[0][2], elbowR: { world: [sh[0], sh[1] + UPPER, sh[2]] } }]] }), hl = told(held, "elbow");
	const hm = /^- elbow off its target: ([\d.]+) mm .*; why: the wrist's own target holds the elbow: with the wrist there the elbow comes no nearer than (\d+) mm\)$/.exec(hl);
	assert.ok(hm, `held: ${hl}`);
	near(Number(hm[2]), Number(hm[1]), "held");

	// late: a wrist sent 0.6 m in 2 frames
	const late = told(run(one(60), { a: [[10, "pose", { R: { world: [-0.3, 1.5, 0.4] }, over: 2 }]] }), "hand");
	assert.match(late, /\(R hand, the action at f10; over 10 mm off on [1-9] frames; why: late: a wrist moves at most 120 mm a frame in the body frame unless its key says fast, and on that frame it was still on its way\)$/, `late: ${late}`);
	assert.equal(run(one(60), { a: [[10, "pose", { R: { world: [-0.3, 1.5, 0.4] }, over: 2, fast: true }]] }).text.split("\n").filter(x => x.startsWith("- hand off")).length, 0, "with fast: true it arrives with its blend");

	// a seated foot sent under the floor, in the leg's reach
	const floor = run(one(80), { a: [[0, "sit", { height: 0.45, over: 0 }], [10, "pose", { footR: { at: [-0.1, -0.06, 0.45] }, over: 15 }]] }), fl = told(floor, "foot");
	const fm = /\(R foot, the action at f10; over 10 mm off on \d+ frames; why: the floor holds the foot: the target is (\d+) mm lower than the floor lets the ankle go\)$/.exec(fl);
	assert.ok(fm, `floor: ${fl}`);

	// the engine's own miss (no spec case makes one today): the entry facts say the target was in reach and nothing held it
	const engine = reachWhy([null, { key: 1, d: 0.0234, beyond: -0.2, r: [0, 1.4, 0] }], 1, 0);
	assert.equal(engine, "engine limit: the target is in the arm's reach and nothing the engine knows holds the wrist; it misses by 23 mm, and no spec removes that");
	assert.equal(reachWhy([{ key: 0, d: 0.03, beyond: -0.01 }], 0, 3), "engine limit: the target is in the leg's reach and nothing the engine knows holds the ankle; it misses by 30 mm, and no spec removes that");
	console.log(`ok reasons: beyond ${m[2]} mm, moved, assist at its limit, elbow nearer and farther, held by the wrist ${hm[2]} mm, late, floor ${fm[1]} mm, engine limit; each as the writer reads it`);
}
rmSync(TMP, { recursive: true, force: true });
console.log("PASS verify-reach-why");
