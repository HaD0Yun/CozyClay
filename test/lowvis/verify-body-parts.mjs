#!/usr/bin/env node
// A body's drawn parts: the parts a look draws, read from its solids (src/lowvis/engine-simple/body-parts.js), the word
// that aims a hand, an elbow, a foot or a ride at a place on one ({on: characterId, part, at?}, parts.js resolveParts),
// what the manual tells of them (prompt.mjs), and the rows against the drawn bodies (src/lowvis/pi/bodies.mjs), each
// number worked out again here from the solids. Every scene here is made up for this test.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildClip } from "../../src/lowvis/engine-simple/engine.js";
import { resolveParts, withFigure } from "../../src/lowvis/engine-simple/parts.js";
import { bodyParts } from "../../src/lowvis/engine-simple/body-parts.js";
import { LOOK_SOLIDS } from "../../src/lowvis/looks/solids.js";
import { lookBody } from "../../src/lowvis/studio/figure.js";
import { createCompileTool } from "../../src/lowvis/pi/compile-tool.mjs";
import { systemPrompt } from "../../src/lowvis/pi/prompt.mjs";
import { INDEX as J, JOINTS, REST, TIPS } from "../../src/lowvis/rig17.js";
import { qConj, qRotate } from "../../src/lowvis/engine-simple/math.js";

const TMP = mkdtempSync(join(tmpdir(), "body-parts-"));
const near = (a, b, tol, what) => [].concat(a).forEach((v, i) => assert.ok(Math.abs(v - [].concat(b)[i]) <= tol, `${what}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`));
const at = (c, f, j) => { const i = (f * 17 + j) * 3; return [c.pos[i], c.pos[i + 1], c.pos[i + 2]]; };
const rot = (c, f, j) => { const i = (f * 17 + j) * 4; return [c.quat[i], c.quat[i + 1], c.quat[i + 2], c.quat[i + 3]]; };
const B = lookBody("cube");

// --- 1. the parts: one per joint the look draws on, the box around its solids, named for the joint ---
for (const look of ["cube", "block"]) {
	const parts = bodyParts(look), solids = LOOK_SOLIDS[look]();
	assert.deepEqual(parts.map(p => p.name), JOINTS.filter(n => solids.some(s => JOINTS[s.joint] === n)), `${look}: a part for each joint the look draws on, in the rig's order`);
	assert.ok(!parts.some(p => /Hand$/.test(p.name)), `${look}: the hands are no parts (the solids leave them out)`);
	for (const p of parts) {
		const mine = solids.filter(s => s.joint === p.joint);
		for (let k = 0; k < 3; k++) {
			near(p.c[k] - p.h[k], Math.min(...mine.map(s => s.c[k] - s.h[k])), 1e-12, `${look} ${p.name} low ${k}`);
			near(p.c[k] + p.h[k], Math.max(...mine.map(s => s.c[k] + s.h[k])), 1e-12, `${look} ${p.name} high ${k}`);
		}
	}
}
const HEAD = bodyParts("cube").find(p => p.name === "Head");
console.log("ok parts: one box per drawn joint, around its solids, named for the joint; no hands");

// --- 2. the manual: the parts of the look the Studio draws at scale 1, with the tops step only ---
{
	const cube = systemPrompt("studio", [], B, "cube"), block = systemPrompt("studio", [], 1, null), line = text => /A body's drawn parts, each named for its joint:[^\n]*/.exec(text)?.[0];
	const r3 = v => Number((Math.abs(v) < 5e-4 ? 0 : v).toFixed(3));
	assert.ok(line(cube).includes(`Head at [${HEAD.c.map(v => r3(v * B)).join(", ")}] size [${HEAD.h.map(v => r3(2 * v * B)).join(", ")}]`), "the cube head as its solids give it, times the look's body");
	assert.notEqual(line(cube), line(block), "another look, other parts");
	assert.ok(!line(cube).includes("RightArm"), "a Right part that mirrors its Left one is said once");
	assert.ok(cube.includes("| {on:characterId, part, at?}") && cube.includes("- on a drawn body:"), "the word and the row in the studio manual");
	for (const [v, off] of [["studio", ["tops"]], ["base", []], ["tilt", []]]) {
		const t = systemPrompt(v, off, B, "cube");
		assert.ok(!line(t) && !t.includes("characterId, part") && !t.includes("on a drawn body") && !t.includes("prop or a body"), `${v} -${off}: no word of a body's parts`);
	}
	console.log(`ok manual: the cube parts line ${line(cube).length} characters; none without the tops step`);
}

// --- 3. the word: a place on a body's part, written as that joint's place ---
{
	const def = { frames: 40, figure: "cube", characters: [{ id: "a", at: [0, 0], heading: 0, scale: 0.5 }, { id: "b", at: [1, 0], heading: 180, scale: 3 }], props: [{ id: "hat", size: [0.2, 0.1, 0.2], at: [0, 2, 0], moves: true }] };
	const spec = { a: [[0, "pose", { L: { on: "a", part: "Head", at: [0, 0.1, 0] }, R: { on: "b", part: "Spine2" }, elbowL: { on: "b", part: "LeftArm", at: [0, 0, 0.1] }, footR: { on: "b", part: "LeftLeg", pitch: 10 } }]], hat: [[0, "ride", { on: "b", part: "Head", at: [0, 0.2, 0], axis: [1, 0, 0], deg: 10 }]] };
	const out = resolveParts(spec, def), cubeAt = (name, s, plus = [0, 0, 0]) => bodyParts("cube").find(p => p.name === name).c.map((v, k) => v * s + plus[k]);
	assert.deepEqual(Object.keys(out.a[0][2].L).sort(), ["at", "joint"], "on the own body: no of");
	near(out.a[0][2].L.at, cubeAt("Head", 0.5, [0, 0.1, 0]), 1e-12, "own head at scale 0.5: the part's centre times the scale, plus at");
	assert.equal(out.a[0][2].R.of, "b"); near(out.a[0][2].R.at, cubeAt("Spine2", 3), 1e-12, "another's chest at scale 3, no at: its centre");
	assert.equal(out.a[0][2].elbowL.joint, "LeftArm"); assert.equal(out.a[0][2].footR.pitch, 10, "the other fields stay");
	assert.deepEqual(out.hat[0][2], { joint: "Head", of: "b", at: cubeAt("Head", 3, [0, 0.2, 0]), axis: [1, 0, 0], deg: 10 }, "a ride on a body's part rides its joint");
	near(resolveParts(spec, { ...def, figure: undefined }).a[0][2].L.at, bodyParts("block").find(p => p.name === "Head").c.map((v, k) => v * 0.5 + [0, 0.1, 0][k]), 1e-12, "no figure: the block look's parts");
	assert.throws(() => resolveParts({ a: [[3, "pose", { L: { on: "a", part: "LeftHand" } }]] }, def), /a pose at frame 3: a has no drawn part "LeftHand"; its parts \(named for their joints\): Hips, Spine/);
	assert.throws(() => resolveParts({ a: [[3, "pose", { L: { on: "a", part: "Head", at: [1, 2] } }]] }, def), /at wants \[x, y, z\]/);
	assert.equal(resolveParts({ a: [[0, "pose", { L: { joint: "Head", at: [0, 0.1, 0] } }]] }, def).a[0][2].L.joint, "Head", "the joint form as it was");
	// the scene carries the figure only for a spec that names a part
	assert.equal(withFigure({ frames: 2 }, { a: [[0, "idle"]] }, "cube").figure, undefined);
	assert.equal(withFigure({ frames: 2 }, spec, "cube").figure, "cube");
	assert.equal(withFigure({ frames: 2 }, spec, null).figure, undefined);
	// the same place by the joint and by the part: the same clip
	const one = { frames: 30, characters: [{ id: "a", at: [0, 0], heading: 0, scale: 0.81 }], props: [] };
	const byJoint = buildClip({ demo: "x", a: [[0, "idle"], [5, "pose", { L: { joint: "Head", at: cubeAt("Head", 0.81, [0.15, 0, 0]) }, over: 10 }]] }, one).clip;
	const byPart = buildClip({ demo: "x", a: [[0, "idle"], [5, "pose", { L: { on: "a", part: "Head", at: [0.15, 0, 0] }, over: 10 }]] }, { ...one, figure: "cube" }).clip;
	assert.deepEqual(Array.from(byPart.characters[0].pos), Array.from(byJoint.characters[0].pos), "the part word is the joint's place");
	console.log("ok word: {on, part, at?} on the own and another body, a hand, an elbow, a foot and a ride, at scales 0.5 and 3");
}

// --- 4. the rows, each number worked out again from the solids ---
const tool = (name, figure = "cube") => createCompileTool({ name, outDir: join(TMP, name), clipFile: join(TMP, `${name}.json`), variant: "studio", figure });
const toBox = (l, c, h) => { const d = l.map((v, k) => Math.abs(v - c[k]) - h[k]); return Math.hypot(...d.map(v => Math.max(v, 0))) + Math.min(0, Math.max(...d)); };
/** signed distance of world point p to the cube head of body c at frame f (the head solid is a box) */
const headSd = (c, f, p) => { const s = c.scale, HS = LOOK_SOLIDS.cube().filter(x => x.joint === J.Head).sort((x, y) => y.h[0] - x.h[0])[0], l = qRotate(qConj(rot(c, f, J.Head)), p.map((v, k) => v - at(c, f, J.Head)[k])).map(v => v / s); return toBox(l, HS.c, HS.h) * s; };
const handPts = (c, f, side) => { const H = J[`${side}Hand`], w = at(c, f, H), t = qRotate(rot(c, f, H), TIPS[`${side}Hand`].map((v, k) => (v - REST[H][k]) * c.scale)); return [0, 1, 2, 3, 4].map(i => w.map((v, k) => v + t[k] * i / 4)); };
const SCENE = { frames: 120, characters: [{ id: "figure1", at: [0, 0], heading: 0 }], props: [{ id: "prop1", size: [0.13, 0.035, 0.03], at: [0, 1.4, 0.1], moves: true }] };
{
	// the hands put on the own head by its joint 20 mm inside the drawn sides, and a box on the face by the joint
	const t = tool("old"), r = t.call({ scene: structuredClone(SCENE), spec: { prop1: [[0, "ride", { joint: "Head", of: "figure1", at: [0, 0.065, 0.085] }]], figure1: [[0, "idle", {}], [20, "pose", { L: { joint: "Head", at: [0.08, 0.12, 0] }, R: { joint: "Head", at: [-0.08, 0.12, 0] }, over: 20 }], [80, "pose", { L: "rest", R: "rest", over: 20 }]] } });
	assert.equal(r.status, "ok", r.error);
	const row = k => r.rows.find(x => x.key === k), C = t.state.last, clip = JSON.parse(readFileSync(t.clipFile, "utf8")), c = clip.characters[0];
	const L = row("body:figure1.L hand>figure1"), deep = Math.max(...handPts(c, L.frame, "Left").map(p => -headSd(c, L.frame, p))) * 1000;
	near(L.value, deep, 0.2, "the L hand's depth in the head, again from the head solid");
	assert.match(r.text, /- figure1's L hand on its own drawn body: [\d.]+ mm @f\d+ figure1 \(inside its part Head; past 20\.3 mm inside or 24\.3 mm off on 40 frames, from f40 to f79\)/);
	const ride = row("body:prop1.ride>figure1");
	assert.ok(ride && /sunk into its part Head/.test(ride.note) && ride.value > 30, `the face box sunk into the head: ${ride?.value}`);
	assert.ok(r.text.includes("body lines (said once):"), "the first answer with a body line says what they measure");
	assert.ok(C.scene.figure === undefined, "the kept scene of a spec with no part has no figure");
	// the same intent with the word, aimed from the drawn head: hands 0 to 30 mm off its sides, the box's back on the face
	const hw = HEAD.h.map(v => v * B), t2 = tool("word"), r2 = t2.call({ scene: structuredClone(SCENE), spec: { prop1: [[0, "ride", { on: "figure1", part: "Head", at: [0, 0.02, hw[2] + 0.015 + 0.002] }]], figure1: [[0, "idle", {}], [20, "pose", { L: { on: "figure1", part: "Head", at: [0.18, 0.025, -0.013] }, R: { on: "figure1", part: "Head", at: [-0.18, 0.025, -0.013] }, over: 20 }], [80, "pose", { L: "rest", R: "rest", over: 20 }]] } });
	assert.equal(r2.status, "ok", r2.error);
	assert.ok(!r2.rows.some(x => x.key.startsWith("body:")), `no body row: ${r2.rows.filter(x => x.key.startsWith("body:")).map(x => x.key)}`);
	const clip2 = JSON.parse(readFileSync(t2.clipFile, "utf8")), c2 = clip2.characters[0], g = Math.min(...handPts(c2, 60, "Left").map(p => headSd(c2, 60, p))) * 1000;
	assert.ok(g >= 0 && g < 24.3, `the drawn L hand ${g.toFixed(1)} mm off the drawn head`);
	assert.equal(t2.state.last.scene.figure, "cube", "the kept scene names the look its parts are read from");
	console.log(`ok rows: hands in the head ${L.value.toFixed(1)} mm (again ${deep.toFixed(1)}), the face box ${ride.value.toFixed(1)} mm in; with the word ${g.toFixed(1)} mm off and no row`);
}
{
	// a limb through the own head and an arm through another body; a body standing idle has no row
	const t = tool("through"), r = t.call({ scene: { frames: 60, characters: [{ id: "a", at: [0, 0], heading: 0 }, { id: "b", at: [0.45, 0], heading: 0 }], props: [] }, spec: { a: [[0, "idle"], [5, "pose", { L: { joint: "Head", at: [-0.12, 0.12, 0.05] }, R: { on: "b", part: "Spine2", at: [0, 0, 0] }, over: 8 }]], b: [[0, "idle"]] } });
	assert.equal(r.status, "ok", r.error);
	const own = r.rows.find(x => x.key === "body:a.limbs>a"), other = r.rows.find(x => x.key === "body:a.limbs>b");
	assert.ok(own && /LeftForeArm in Head|LeftArm in Head/.test(own.note), `the left arm across the own head: ${own?.note}`);
	assert.ok(!other || !/RightHand/.test(other.note), "a hand in the body its target is on is not a through row");
	assert.ok(r.rows.some(x => x.key === "body:a.R hand>b" && /inside its part Spine2/.test(x.note)), "it is the tied row's");
	const idle = tool("idle").call({ scene: { frames: 40, characters: [{ id: "a", at: [0, 0], heading: 0 }], props: [] }, spec: { a: [[0, "idle"], [10, "walk", { to: [0, 1] }]] } });
	assert.ok(!idle.rows.some(x => x.key.startsWith("body:")), "idle and walking: no body row");
	const off = createCompileTool({ name: "off", outDir: join(TMP, "off"), clipFile: join(TMP, "off.json"), variant: "studio", off: ["tops"], figure: "cube" }).call({ scene: structuredClone(SCENE), spec: { figure1: [[0, "pose", { L: { joint: "Head", at: [0.08, 0.12, 0] } }]] } });
	assert.ok(!off.rows.some(x => x.key.startsWith("body:")), "with the tops step off nothing is measured against the bodies");
	console.log(`ok through: ${own.label}: ${own.value.toFixed(1)} mm (${own.note})`);
}
console.log("PASS verify-body-parts");
