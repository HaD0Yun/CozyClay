#!/usr/bin/env node
// A body's drawn parts: the parts a look draws, read from its solids (src/lowvis/engine-simple/body-parts.js), the word
// that aims a hand, an elbow, a foot or a ride at a place on one ({on: characterId, part, at?}, parts.js resolveParts),
// what the manual tells of them (prompt.mjs), and the rows against the drawn bodies (src/lowvis/pi/bodies.mjs), each
// number worked out again here from the solids. Every scene here is made up for this test, and every place and every
// expected number is worked out from the look's solids and its body (lookBody), so another head or body size passes too.
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
	const cube = systemPrompt("studio", [], B, "cube"), block = systemPrompt("studio", [], 1, null), line = text => /A body's drawn parts, named for their joints,[^\n]*/.exec(text)?.[0];
	const r3 = v => Number((Math.abs(v) < 5e-4 ? 0 : v).toFixed(3));
	assert.ok(line(cube).includes(`Head [${HEAD.c.map(v => r3(v * B)).join(", ")}] [${HEAD.h.map(v => r3(2 * v * B)).join(", ")}]`), "the cube head as its solids give it, times the look's body");
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
	assert.throws(() => resolveParts({ a: [[3, "sit", { on: "b", part: "Hips" }]] }, def), /a sit at frame 3: a sit on a part wants a part of a prop; b is a character, whose drawn parts take a hand, an elbow, a foot or a ride/);
	assert.throws(() => resolveParts({ a: [[3, "hold", { prop: "hat", hand: "R", at: { on: "b", part: "Head" } }]] }, def), /a hold at frame 3: a hold's at wants a part of a prop; b is a character/);
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
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2], mm1 = v => String(Math.round(v * 10) / 10);
/** how deep world point p lies inside solid S of body c at frame f (under each of its faces, from its corners) */
const depthIn = (S, c, f, p) => { const l = qRotate(qConj(rot(c, f, S.joint)), p.map((v, k) => v - at(c, f, S.joint)[k])).map(v => v / c.scale); return Math.min(...S.n.map(n => Math.max(...S.v.map(v => dot(v, n))) - dot(l, n))) * c.scale; };
/** the deepest point of the line from joint j to joint k inside the solids of joint `name`, 2,000 steps (mm) */
const lineIn = (c, f, j, k, name) => Math.max(...LOOK_SOLIDS.cube().filter(S => S.joint === J[name]).flatMap(S => Array.from({ length: 2001 }, (_, i) => depthIn(S, c, f, at(c, f, j).map((v, n) => v + (at(c, f, k)[n] - v) * i / 2000))))) * 1000;
// the head's own solid (the largest on the Head joint) at the look's body: its centre and half sizes from the joint
const HS = LOOK_SOLIDS.cube().filter(x => x.joint === J.Head).sort((x, y) => y.h[0] - x.h[0])[0], HC = HS.c.map(v => v * B), HH = HS.h.map(v => v * B);
const SCENE = { frames: 120, characters: [{ id: "figure1", at: [0, 0], heading: 0 }], props: [{ id: "prop1", size: [0.13, 0.035, 0.03], at: [0, 1.4, 0.1], moves: true }] };
{
	// the hands put on the own head by its joint 20 mm inside the drawn sides, and a box by the joint 40 mm into the face
	const side = HC[0] + HH[0] - 0.02, t = tool("old"), r = t.call({ scene: structuredClone(SCENE), spec: { prop1: [[0, "ride", { joint: "Head", of: "figure1", at: [0, HC[1], HC[2] + HH[2] - 0.04 + 0.015] }]], figure1: [[0, "idle", {}], [20, "pose", { L: { joint: "Head", at: [side, HC[1], HC[2]] }, R: { joint: "Head", at: [-side, HC[1], HC[2]] }, over: 20 }], [80, "pose", { L: "rest", R: "rest", over: 20 }]] } });
	assert.equal(r.status, "ok", r.error);
	const row = k => r.rows.find(x => x.key === k), C = t.state.last, clip = JSON.parse(readFileSync(t.clipFile, "utf8")), c = clip.characters[0];
	const L = row("body:figure1.L hand>figure1"), deep = Math.max(...handPts(c, L.frame, "Left").map(p => -headSd(c, L.frame, p))) * 1000;
	near(L.value, deep, 0.2, "the L hand's depth in the head, again from the head solid");
	assert.ok(new RegExp(`- figure1's L hand on its own drawn body: [\\d.]+ mm @f\\d+ figure1 \\(inside its part Head; past ${mm1(25 * B)} mm inside or ${mm1(30 * B)} mm off on 40 frames, from f40 to f79\\)`.replaceAll(".", "\\.").replaceAll("[\\d\\.]", "[\\d.]")).test(r.text), "the hand's line, with the limits of the look's body");
	const ride = row("body:prop1.ride>figure1");
	assert.ok(ride && /sunk into its part Head, on whose joint it rides/.test(ride.note), "the face box sunk into the head");
	near(ride.value, 40, 0.5, "sunk: the least move that clears it (40 mm out of the face)");
	const thru = row("body:figure1.limbs>figure1");
	assert.ok(!thru || !/Hand in/.test(thru.note), `a hand that leaves the body its target was on from inside it is the tied row's: ${thru?.note}`);
	assert.ok(r.text.includes("body lines (said once):"), "the first answer with a body line says what they measure");
	assert.ok(C.scene.figure === undefined, "the kept scene of a spec with no part has no figure");
	// the same intent with the word, aimed from the drawn head: hands 0 to 30 mm off its sides, the box's back on the face
	const hw = HEAD.h.map(v => v * B), t2 = tool("word"), r2 = t2.call({ scene: structuredClone(SCENE), spec: { prop1: [[0, "ride", { on: "figure1", part: "Head", at: [0, 0.02, hw[2] + 0.015 + 0.002] }]], figure1: [[0, "idle", {}], [20, "pose", { L: { on: "figure1", part: "Head", at: [hw[0] + 0.09, 0.025, -0.013] }, R: { on: "figure1", part: "Head", at: [-hw[0] - 0.09, 0.025, -0.013] }, over: 20 }], [80, "pose", { L: "rest", R: "rest", over: 20 }]] } });
	assert.equal(r2.status, "ok", r2.error);
	assert.ok(!r2.rows.some(x => x.key.startsWith("body:")), `no body row: ${r2.rows.filter(x => x.key.startsWith("body:")).map(x => x.key)}`);
	const clip2 = JSON.parse(readFileSync(t2.clipFile, "utf8")), c2 = clip2.characters[0], g = Math.min(...handPts(c2, 60, "Left").map(p => headSd(c2, 60, p))) * 1000;
	assert.ok(g >= 0 && g < 30 * B, `the drawn L hand ${g.toFixed(1)} mm off the drawn head`);
	assert.equal(t2.state.last.scene.figure, "cube", "the kept scene names the look its parts are read from");
	console.log(`ok rows: hands in the head ${L.value.toFixed(1)} mm (again ${deep.toFixed(1)}), the face box ${ride.value.toFixed(1)} mm in; with the word ${g.toFixed(1)} mm off and no row`);
}
{
	// a limb through the own head (the left wrist 20 mm past the head's far side) and an arm through another body; a
	// limb counts by its line: the forearm's depth again from its joints and the head's solid
	const t = tool("through"), r = t.call({ scene: { frames: 60, characters: [{ id: "a", at: [0, 0], heading: 0 }, { id: "b", at: [0.45, 0], heading: 0 }], props: [] }, spec: { a: [[0, "idle"], [5, "pose", { L: { joint: "Head", at: [-(HC[0] + HH[0]) - 0.02, HC[1], HC[2]] }, R: { on: "b", part: "Spine2", at: [0, 0, 0] }, over: 8 }]], b: [[0, "idle"]] } });
	assert.equal(r.status, "ok", r.error);
	const own = r.rows.find(x => x.key === "body:a.limbs>a"), other = r.rows.find(x => x.key === "body:a.limbs>b"), ca = JSON.parse(readFileSync(t.clipFile, "utf8")).characters[0];
	assert.ok(own && /deepest: LeftForeArm in Head/.test(own.note), `the left forearm across the own head: ${own?.note}`);
	near(own.value, lineIn(ca, own.frame, J.LeftForeArm, J.LeftHand, "Head"), 0.2, "the forearm's line (elbow to wrist) in the head, again");
	assert.equal(own.label, "a's body through its own drawn body");
	assert.ok(!other || (other.label === "the drawn bodies of a and b through each other" && /deepest: (a|b)'s \w+ in (a|b)'s \w+/.test(other.note) && !/RightHand/.test(other.note)), `two bodies: each part with its body; a hand in the body its target is on is not a through row: ${other?.note}`);
	assert.ok(r.rows.some(x => x.key === "body:a.R hand>b" && /inside its part Spine2/.test(x.note)), "it is the tied row's");
	const idle = tool("idle").call({ scene: { frames: 40, characters: [{ id: "a", at: [0, 0], heading: 0 }], props: [] }, spec: { a: [[0, "idle"], [10, "walk", { to: [0, 1] }]] } });
	assert.ok(!idle.rows.some(x => x.key.startsWith("body:")), "idle and walking: no body row");
	const off = createCompileTool({ name: "off", outDir: join(TMP, "off"), clipFile: join(TMP, "off.json"), variant: "studio", off: ["tops"], figure: "cube" }).call({ scene: structuredClone(SCENE), spec: { figure1: [[0, "pose", { L: { joint: "Head", at: [0.08, 0.12, 0] } }]] } });
	assert.ok(!off.rows.some(x => x.key.startsWith("body:")), "with the tops step off nothing is measured against the bodies");
	console.log(`ok through: ${own.label}: ${own.value.toFixed(1)} mm (${own.note})${other ? `; ${other.label}: ${other.note.split(";")[0]}` : ""}`);
}
{
	// a limb that rests on a part is not through it: a hand put 5 mm off the hips' side with the word (the forearm's
	// solid lies against the hips, its line outside them); the same hand aimed through the chest is
	const part = n => { const p = bodyParts("cube").find(x => x.name === n); return { c: p.c.map(v => v * B), h: p.h.map(v => v * B) }; }, hips = part("Hips");
	const run = (name, L) => { const t = tool(name), r = t.call({ scene: { frames: 60, characters: [{ id: "a", at: [0, 0], heading: 0 }], props: [] }, spec: { a: [[0, "idle"], [5, "pose", { L, over: 10 }]] } }); assert.equal(r.status, "ok", r.error); return { r, c: JSON.parse(readFileSync(t.clipFile, "utf8")).characters[0] }; };
	const rest = run("rest", { on: "a", part: "Hips", at: [hips.h[0] + 0.005, 0, 0] });
	assert.ok(!rest.r.rows.some(x => x.key.startsWith("body:")), `a hand resting on the hip: no body row: ${rest.r.rows.filter(x => x.key.startsWith("body:")).map(x => `${x.key} ${x.note}`)}`);
	assert.ok(lineIn(rest.c, 59, J.LeftForeArm, J.LeftHand, "Hips") <= 25 * B, "its forearm's line is not past the limit in the hips");
	const far = run("far", { on: "a", part: "Spine2", at: [-part("Spine2").h[0], 0, 0] }), row = far.r.rows.find(x => x.key === "body:a.limbs>a");
	assert.ok(row && /deepest: LeftForeArm in Spine2/.test(row.note), `a forearm through the chest to its far side: ${row?.note}`);
	near(row.value, lineIn(far.c, row.frame, J.LeftForeArm, J.LeftHand, "Spine2"), 0.2, "the forearm's line in the chest, again");
	// two bodies: a hand of one through the other's chest (a world point, so no target on that body): each part with its body
	const chest = part("Spine2"), two = tool("two"), r2 = two.call({ scene: { frames: 60, characters: [{ id: "a", at: [0, 0], heading: 0 }, { id: "b", at: [0.35, 0.1], heading: 0 }], props: [] }, spec: { a: [[0, "idle"], [5, "pose", { L: { world: [0.35, REST[J.Spine2][1] * B + chest.c[1], 0.1 + chest.c[2]] }, over: 10 }]], b: [[0, "idle"]] } });
	assert.equal(r2.status, "ok", r2.error);
	const both = r2.rows.find(x => x.key === "body:a.limbs>b"), c2 = JSON.parse(readFileSync(two.clipFile, "utf8")).characters;
	assert.ok(both && both.label === "the drawn bodies of a and b through each other" && /deepest: a's Left(Hand|ForeArm) in b's Spine2/.test(both.note), `a's arm through b's chest: ${both?.label}: ${both?.note}`);
	assert.match(r2.text, /- the drawn bodies of a and b through each other: [\d.]+ mm @f\d+ a \(deepest: a's Left/);
	if (/a's LeftForeArm in/.test(both.note)) near(both.value, Math.max(...LOOK_SOLIDS.cube().filter(S => S.joint === J.Spine2).flatMap(S => Array.from({ length: 2001 }, (_, i) => depthIn(S, c2[1], both.frame, at(c2[0], both.frame, J.LeftForeArm).map((v, n) => v + (at(c2[0], both.frame, J.LeftHand)[n] - v) * i / 2000))))) * 1000, 0.2, "a's forearm line in b's chest, again");
	console.log(`ok resting: a hand on the hip has no row; through the chest ${row.value.toFixed(1)} mm (${row.note.split(";")[0]}); two bodies: ${both.note.split(";")[0]}`);
}
{
	// a worn box: sunk by the least move that clears it; a hollow one is not told as sunk; off only when off the whole body
	const hh = HC[1] + HH[1], hat = (size, more = {}) => [{ id: "hat", size, at: [0, 2, 0], moves: true, ...more }], thigh = bodyParts("cube").find(x => x.name === "LeftUpLeg"), hip = k => (REST[J.LeftUpLeg][k] - REST[J.Hips][k] + thigh.c[k]) * B;
	const ride = (name, props, to) => { const r = tool(name).call({ scene: { frames: 40, characters: [{ id: "a", at: [0, 0], heading: 0 }], props }, spec: { a: [[0, "idle"]], hat: [[0, "ride", to]] } }); assert.equal(r.status, "ok", r.error); return r.rows.find(x => x.key === "body:hat.ride>a"); };
	const onHead = y => ({ joint: "Head", of: "a", at: [0, hh + 0.05 + y, HC[2]] });
	const sunk = ride("sunk", hat([0.3, 0.1, 0.3]), onHead(-0.04));
	assert.ok(sunk && /sunk into its part Head, on whose joint it rides/.test(sunk.note)); near(sunk.value, 40, 0.5, "a hat 40 mm into the head's top");
	assert.equal(ride("hollow", hat([0.3, 0.1, 0.3], { hollow: true }), onHead(-0.04)), undefined, "a hollow prop is not told as sunk");
	const around = ride("around", hat([0.3, 0.3, 0.3]), { joint: "Head", of: "a", at: HC });
	assert.ok(around && around.value >= 2000 * Math.min(...HH) - 0.5, `a box around the head: no less than the head's size (${around?.value.toFixed(1)} mm)`);
	assert.equal(ride("on", hat([0.3, 0.1, 0.3]), onHead(0.01)), undefined, "a hat 10 mm over the head: no row");
	const off = ride("off", hat([0.3, 0.1, 0.3]), onHead(0.1));
	assert.ok(off && /off the body, its nearest part Head/.test(off.note)); near(off.value, 100, 0.5, "a hat 100 mm over the head");
	// a pouch riding the Hips joint 10 mm beside the thigh: off the hips' own part, on the body
	assert.equal(ride("pouch", hat([0.04, 0.04, 0.04]), { joint: "Hips", of: "a", at: [hip(0) + thigh.h[0] * B + 0.03, hip(1), hip(2)] }), undefined, "a prop off its joint's part but at another part: no row");
	const out = ride("out", hat([0.04, 0.04, 0.04]), { joint: "Hips", of: "a", at: [hip(0) + thigh.h[0] * B + 0.3, hip(1), hip(2)] });
	assert.ok(out && /off the body, its nearest part /.test(out.note), `far from every part: ${out?.note}`);
	// hands on a cap the head wears (10 mm over its top): on what the body wears, not off the body; with no cap they are
	const capped = (name, props, extra) => { const r = tool(name).call({ scene: { frames: 60, characters: [{ id: "a", at: [0, 0], heading: 0 }], props }, spec: { a: [[0, "idle"], [5, "pose", { L: { joint: "Head", at: [0.1, hh + 0.07, HC[2]] }, R: { joint: "Head", at: [-0.1, hh + 0.07, HC[2]] }, over: 10 }]], ...extra } }); assert.equal(r.status, "ok", r.error); return r.rows.filter(x => /^body:a\.[LR] hand>a$/.test(x.key)); };
	const bare = capped("bare", []), worn = capped("worn", hat([0.3, 0.06, 0.3]), { hat: [[0, "ride", { joint: "Head", of: "a", at: [0, hh + 0.03, HC[2]] }]] });
	assert.ok(bare.length === 2 && bare.every(x => /off the body, its nearest part Head/.test(x.note)), `hands 70 mm over a bare head are off it: ${bare.map(x => x.note)}`);
	assert.equal(worn.length, 0, `hands on the cap the head wears are not off the body: ${worn.map(x => `${x.value.toFixed(1)} ${x.note}`)}`);
	console.log(`ok rides: sunk ${sunk.value.toFixed(1)} mm, hollow none, around ${around.value.toFixed(1)} mm, off ${off.value.toFixed(1)} mm (${off.note.split(";")[0]}), beside the thigh none; hands on a worn cap none (bare head ${bare[0].value.toFixed(1)} mm off)`);
}
console.log("PASS verify-body-parts");
