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
	// a free wrist's elbow on a low target past the upper arm: the body does not bend for it (verify-elbow-free.mjs); the
	// entry says how far past, and the spec's own bow brings the shoulder there (seated, the own knee)
	const knee = bow => buildClip({ demo: "x", a: [[0, "sit", { height: 0.45, over: 0 }], [10, "pose", { bow, elbowL: { joint: "LeftLeg", at: [0, 0.05, 0] }, over: 15 }]] }, one(80)).aux.reach.a[60][4];
	const shallow = knee(50), deep = knee(80);
	assert.ok(shallow.d > 0.01 && Math.abs(shallow.d - shallow.beyond) < 0.002, `bowed 50: the elbow is as far off the knee as the knee is past the upper arm (${(shallow.d * 1000).toFixed(1)} / ${(shallow.beyond * 1000).toFixed(1)} mm)`);
	assert.ok(deep.d <= 0.01, `bowed 80: a seated elbow reaches its own knee with the wrist free (${(deep.d * 1000).toFixed(1)} mm)`);
	console.log(`ok in reach: ${n} targets of wrists, ankles and elbows in 5 postures at 2 sizes, worst ${Object.entries(worst).map(([k, w]) => `${k} ${(w.d * 1000).toFixed(1)} mm`).join(", ")}; the elbow on the own knee ${(shallow.d * 1000).toFixed(1)} mm past it bowed 50, ${(deep.d * 1000).toFixed(1)} mm bowed 80`);
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
	const m = /^- hand off its target: [\d.]+ mm @f(\d+) a \(R hand, the action at f10; over 10 mm off on \d+ frames; why: on that frame the target is (\d+) mm beyond the arm's reach \(0\.56 m\) from the shoulder(?:; the shoulder is \d+ mm [^\n]*)?\)$/.exec(line);
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
	const hm = /^- elbow off its target: ([\d.]+) mm .*; why: the wrist's own target holds the elbow: with the wrist there the elbow comes no nearer than (\d+) mm(?:; also: .*)?\)$/.exec(hl);
	assert.ok(hm, `held: ${hl}`);
	near(Number(hm[2]), Number(hm[1]), "held");

	// late: a wrist sent 0.6 m in 2 frames
	const late = told(run(one(60), { a: [[10, "pose", { R: { world: [-0.3, 1.5, 0.4] }, over: 2 }]] }), "hand");
	assert.match(late, /\(R hand, the action at f10; over 10 mm off on [1-9] frames; why: late: a wrist moves at most 120 mm a frame in the body frame unless its key says fast, and on that frame it was still \d+ mm short of where its blend had it\)$/, `late: ${late}`);
	assert.equal(run(one(60), { a: [[10, "pose", { R: { world: [-0.3, 1.5, 0.4] }, over: 2, fast: true }]] }).text.split("\n").filter(x => x.startsWith("- hand off")).length, 0, "with fast: true it arrives with its blend");

	// a seated foot sent under the floor, in the leg's reach
	const floor = run(one(80), { a: [[0, "sit", { height: 0.45, over: 0 }], [10, "pose", { footR: { at: [-0.1, -0.06, 0.45] }, over: 15 }]] }), fl = told(floor, "foot");
	const fm = /\(R foot, the action at f10; over 10 mm off on \d+ frames; why: the floor holds the foot: the target is (\d+) mm lower than the floor lets the ankle go\)$/.exec(fl);
	assert.ok(fm, `floor: ${fl}`);

	// no fact of the entry accounts for the miss: the line says only that, and claims nothing about what a spec can do
	const engine = reachWhy([null, { key: 1, d: 0.0234, beyond: -0.2, r: [0, 1.4, 0] }], 1, 0);
	assert.equal(engine, "engine limit: the target is in the arm's reach and no fact the engine knows holds the wrist on that frame; it misses by 23 mm");
	assert.equal(reachWhy([{ key: 0, d: 0.03, beyond: -0.01 }], 0, 3), "engine limit: the target is in the leg's reach and no fact the engine knows holds the ankle on that frame; it misses by 30 mm");
	console.log(`ok reasons: beyond ${m[2]} mm, moved, assist at its limit, elbow nearer and farther, held by the wrist ${hm[2]} mm, late, floor ${fm[1]} mm, engine limit; each as the writer reads it`);
}

// --- 4. every fact that holds, the largest first; none the engine did not compute ---
{
	const B = f => ({ frames: f, characters: [{ id: "b", at: [-0.4, 0.3], heading: -40 }], props: [] }), ref = buildClip({ demo: "x", b: [] }, B(90)).clip.characters[0];
	const add = (a, b) => a.map((v, i) => v + b[i]), mul = (a, k) => a.map(v => v * k), shL = at(ref, 40, J.LeftArm);
	const line = (frames, spec, part) => told({ text: run(B(frames), spec).text }, part);
	const facts = l => l.replace(/^.*?; (?:why|engine limit): /, "").split("; also: ");
	const lines = [];
	// late, then 25 mm past the arm; the wrist's own target, then 21 mm off the sphere; the floor, then past the leg
	const late = line(70, { b: [[20, "pose", { L: { world: add(shL, mul([0.6, 0.3, 0.74], (ARM + 0.025) / len([0.6, 0.3, 0.74]))) }, over: 1 }]] }, "hand");
	const held = line(80, { b: [[10, "pose", { L: [0.15, 0.3, 0.4], elbowL: { world: add(shL, mul([0.8, -0.6, 0], UPPER + 0.02)) }, over: 12 }]] }, "elbow");
	const floor = line(90, { b: [[10, "pose", { footL: { at: [0.15, 0.1, 0.38], pitch: 70 }, over: 15 }]] }, "foot");
	for (const [l, first, second] of [[late, /^late: .* still (\d+) mm short/, /^on that frame the target is (\d+) mm beyond the arm's reach/], [held, /^the wrist's own target holds the elbow: .* no nearer than (\d+) mm$/, /^on that frame the target is (\d+) mm farther from the shoulder/], [floor, /^the floor holds the foot: the target is (\d+) mm lower/, /^on that frame the target is (\d+) mm beyond the leg's reach/]]) {
		const [a, b] = facts(l), d = Number(/off its target: ([\d.]+) mm/.exec(l)[1]);
		assert.ok(first.test(a) && second.test(b ?? ""), `the larger fact first, the other after "also": ${l}`);
		const va = Number(first.exec(a)?.[1]), vb = Number(second.exec(b ?? "")?.[1]);
		assert.ok(va >= vb && va + vb >= d - 10 && !/no fact/.test(l), `the facts account for the miss, the larger first (${va} and ${vb} of ${d} mm): ${l}`);
		lines.push(l);
	}
	// a target on the own body that the reaching arm carries: the gap is the target's own move, a spec fact
	const carried = line(90, { b: [[10, "pose", { L: { joint: "LeftArm", at: [0.03, -0.03, 0.02] }, over: 15 }]] }, "hand"), cm = /why: the target is on the own body and moved (\d+) mm with the pose that reached for it\)$/.exec(carried);
	assert.ok(cm && Math.abs(Number(cm[1]) - Number(/off its target: ([\d.]+) mm/.exec(carried)[1])) <= 10, `carried: ${carried}`);
	// the reach assist lowers the body for the other hand only (low behind: no hinge); the elbow's line says so
	const lowered = line(100, { b: [[10, "pose", { elbowL: { world: add(shL, mul([0.3, 0.5, 0.81], UPPER * 1.3)) }, over: 12 }], [40, "pose", { R: [-0.3, -0.75, -0.35], over: 20 }]] }, "elbow");
	assert.match(lowered, /; the shoulder is \d+ mm from where it was at f22, the first frame after the blend, and the reach assist moved the body in between \(hinge 0\.00 to 0\.00 rad, hips lowered 0 mm to \d+ mm\)\)$/, `lowered: ${lowered}`);
	// a fact of 10 mm is a fact (the elbow is exactly the upper arm from the shoulder); a part no fact accounts for is told as such
	assert.equal(reachWhy([{ key: 0, d: 0.0138, beyond: 0.01, r: [0, 1.4, 0] }], 0, 5), "why: on that frame the target is 10 mm farther from the shoulder than the upper arm is long (0.28 m)");
	assert.equal(reachWhy([{ key: 0, d: 0.2, beyond: 0.03, r: [0, 1.4, 0] }], 0, 0), "engine limit: no fact the engine knows accounts for 170 mm of the 200 mm; why: on that frame the target is 30 mm beyond the arm's reach (0.56 m) from the shoulder");
	assert.equal(reachWhy([{ key: 0, d: 0.2, slow: 0.15, beyond: 0.03, r: [0, 1.4, 0] }], 0, 0), "why: late: a wrist moves at most 120 mm a frame in the body frame unless its key says fast, and on that frame it was still 150 mm short of where its blend had it; also: on that frame the target is 30 mm beyond the arm's reach (0.56 m) from the shoulder; 20 mm of the 200 mm no fact the engine knows accounts for");
	for (const l of [...lines, carried, lowered]) assert.ok(!/no spec removes/.test(l), `no line claims what no spec can do: ${l}`);
	console.log(`ok largest first: late ${/still (\d+) mm/.exec(facts(late)[0])[1]} mm then past the arm, held then off the sphere, floor then past the leg, an own-body target carried ${cm[1]} mm, the assist's move named`);
}
rmSync(TMP, { recursive: true, force: true });
console.log("PASS verify-reach-why");
