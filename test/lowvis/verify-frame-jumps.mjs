#!/usr/bin/env node
// The writer is told one-frame jumps (src/lowvis/jumps.js, measure.mjs jumpRows) and can look closer (render.mjs).
//  1. A prop keyed in short linear moves whose keys each stop it for one frame, with a body whose hands are on it: the
//     prop row and the body row name the frame, the part, the steps around it and how many frames have one; the same
//     travel as one key gives no row. A body at scale 1.4 has its threshold 1.4 times as large.
//  2. The studio variant tells the rows (they are asked by no spec) with a strip of the frames around the worst; the
//     manual names the row and the look options.
//  3. look: focus { joint, of } frames that joint close; props: "outline" draws props as edges, so a body inside a box
//     shows, and leaves a sheet with no props as it was; wrong values are refused by name.
// Every scene here is made up for this test.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildClip } from "../../src/lowvis/engine-simple/engine.js";
import { serializeClip } from "../../src/lowvis/clip.js";
import { measure } from "../../src/lowvis/pi/measure.mjs";
import { createCompileTool } from "../../src/lowvis/pi/compile-tool.mjs";
import { systemPrompt } from "../../src/lowvis/pi/prompt.mjs";
import { drawSheet } from "../../src/lowvis/pi/render.mjs";
import { JUMP } from "../../src/lowvis/jumps.js";

const TMP = mkdtempSync(join(tmpdir(), "frame-jumps-"));
const parsed = (spec, scene) => { const b = buildClip(structuredClone({ demo: "x", ...spec }), scene); return { clip: JSON.parse(serializeClip(b.clip)), aux: b.aux }; };
const tool = name => createCompileTool({ name, outDir: join(TMP, name), clipFile: join(TMP, `${name}.json`), variant: "studio" });

// a sled pulled in keys of `every` frames, `step` m each; a body standing beside it with both hands on it
function sled({ step = 0.3, every = 4, scale = 1, one = false } = {}) {
	const keys = [];
	let z = 0;
	for (let f = 12; f + every <= 60; f += every) { z += step; keys.push([f, "move", { to: [0.6, 0.25, z], over: every, ease: "linear" }]); }
	const spec = { sled: one ? [[12, "move", { to: [0.6, 0.25, z], over: keys.length * every, ease: "linear" }]] : keys, a: [[0, "pose", { hands: { on: "sled", at: [-0.3, 0.25, 0] }, over: 8 }]] };
	return { spec, scene: { frames: 72, characters: [{ id: "a", at: [0, 0], heading: 0, ...(scale === 1 ? {} : { scale }) }], props: [{ id: "sled", size: [0.5, 0.5, 0.8], at: [0.6, 0.25, 0], moves: true }] } };
}

// --- 1. the rows ---
{
	const { spec, scene } = sled(), { clip, aux } = parsed(spec, scene), rows = measure(clip, aux);
	const prop = rows.find(r => r.key === "jump:props"), body = rows.find(r => r.key === "jump:a");
	assert.ok(prop, "the stalled sled has a jump row");
	assert.equal(prop.prop, "sled"); assert.equal(prop.unit, "cm");
	// each key's first frame repeats the frame before (the engine as it is), so the step into that frame is 0
	const steps = prop.note.match(/steps into f(\d+), f(\d+), f(\d+): ([\d.]+), ([\d.]+), ([\d.]+) cm/);
	assert.ok(steps, prop.note);
	assert.equal(+steps[2], prop.frame);
	assert.ok(+steps[5] < 0.5 && +steps[4] > 5 && +steps[6] > 5, `a stop of one frame inside the move: ${prop.note}`);
	assert.ok(prop.value > 5 && Math.abs(prop.value - +steps[4]) < 1, `the size is the step it stopped from: ${prop.value}`);
	const frames = +/(\d+) frames with a jump/.exec(prop.note)[1];
	assert.ok(frames >= 10, `every key stops it: ${frames} frames`);
	assert.ok(body, "the hands on it jump with it"); assert.equal(body.who, "a");
	assert.match(body.note, /^(Left|Right)(Hand|ForeArm)/, body.note);
	const one = parsed(sled({ one: true }).spec, sled({ one: true }).scene);
	// (the hands' reach to the sled before it moves may jump where the hand speed limit stops a wrist: not the sled's keys)
	assert.deepEqual(measure(one.clip, one.aux).filter(r => r.key === "jump:props" || (r.key.startsWith("jump:") && r.frame >= 12)), [], "the same travel as one key has no jump");
	// the threshold goes with the body's size: a body at 1.4 is told only over 1.4 times JUMP
	const big = sled({ step: 0.18, scale: 1.4 }), b = parsed(big.spec, big.scene), bRows = measure(b.clip, b.aux);
	const bp = bRows.find(r => r.key === "jump:props"), bb = bRows.find(r => r.key === "jump:a");
	assert.ok(bp && bp.value < 100 * JUMP * 1.4 && bp.value > 100 * JUMP, `the prop's own threshold is JUMP: ${bp?.value}`);
	assert.ok(!bb || bb.value > 100 * JUMP * 1.4, "a body row is over the body's threshold");
	assert.match(bp.note, new RegExp(`over ${(100 * JUMP).toFixed(1)} cm`));
	console.log(`ok rows: a stalled keyed prop ${prop.value.toFixed(1)} cm at f${prop.frame} on ${frames} frames, the hands on it ${body.value.toFixed(1)} cm; one key: none`);
}

// --- 2. told, and the manual ---
{
	const t = tool("told"), { spec, scene } = sled(), r = t.call({ scene, spec });
	assert.equal(r.status, "ok");
	const lines = r.text.split("\n").filter(l => l.startsWith("- jump between two frames"));
	assert.equal(lines.length, 2, r.text);
	assert.ok(lines.every(l => / cm @f\d+/.test(l)), lines.join("\n"));
	assert.ok(r.text.includes("\"jump\""), "a strip of the frames around the worst jump");
	assert.ok(r.shown.length >= 1);
	const smooth = tool("smooth").call(sled({ one: true }));
	assert.ok(!smooth.text.split("\n").some(l => l.startsWith("- jump between") && !/@f[0-9] /.test(l)), smooth.text);
	for (const variant of ["base", "lean", "studio"]) {
		const m = systemPrompt(variant);
		assert.ok(m.includes(`- jump between two frames: `) && m.includes(`told over ${JUMP * 100} cm`), variant);
		assert.ok(m.includes(`focus: "<id>" | { joint, of: "<characterId>" }, props: "outline" }`), variant);
	}
	console.log(`ok told: ${lines.length} lines in the studio variant, a jump strip; none for one key; the manual names the row and the look options`);
}

// --- 3. look ---
{
	const scene = { frames: 30, characters: [{ id: "r", at: [0, 0], heading: 0 }], props: [{ id: "shell", size: [1, 1.2, 1.6], at: [0, 0.6, 0.2], hollow: true }] };
	const spec = { r: [[0, "sit", { height: 0.5, over: 0 }], [5, "pose", { R: [-0.25, 0.4, 0.45], over: 10 }]] }, { clip } = parsed(spec, scene);
	const px = s => { let n = 0; for (let i = 0; i < s.rgba.length; i += 4) if (s.rgba[i] !== 255 || s.rgba[i + 1] !== 255) n++; return n; };
	const diff = (a, b) => { let n = 0; for (let i = 0; i < a.rgba.length; i += 4) if (a.rgba[i] !== b.rgba[i] || a.rgba[i + 1] !== b.rgba[i + 1] || a.rgba[i + 2] !== b.rgba[i + 2]) n++; return n; };
	const solid = drawSheet(clip, { frames: [20] }), outline = drawSheet(clip, { frames: [20], props: "outline" });
	assert.ok(px(solid) > 0 && diff(solid, outline) > 2000, `the box's faces are gone: ${diff(solid, outline)} pixels differ`);
	// a figure colour pixel count: the body inside the box shows in outline, not in solid (the box's grey is darker than the figure's)
	const grey = s => { let n = 0; for (let i = 0; i < s.rgba.length; i += 4) if (s.rgba[i] > 186 && s.rgba[i + 2] > 192 && s.rgba[i + 2] - s.rgba[i] < 12 && s.rgba[i + 2] > s.rgba[i]) n++; return n; };
	assert.ok(grey(outline) > grey(solid) + 500, `the figure shows through: ${grey(solid)} -> ${grey(outline)}`);
	const bare = parsed(spec, { ...scene, props: [] }).clip;
	assert.equal(diff(drawSheet(bare, { frames: [20] }), drawSheet(bare, { frames: [20], props: "outline" })), 0, "no props: the sheet is the same");
	// a joint framed close: the hand fills more of the cell than with the character as focus
	const span = s => { let x0 = Infinity, x1 = -1; for (let y = 0; y < s.height; y++) for (let x = 0; x < s.width; x++) { const i = (y * s.width + x) * 4; if (s.rgba[i] < 120) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); } } return x1 - x0; };
	const hand = drawSheet(clip, { frames: [20], focus: [{ joint: "RightHand", of: "r" }] }), whole = drawSheet(clip, { frames: [20], focus: ["r"] });
	assert.ok(hand.figurePx > 2 * whole.figurePx, `close: ${whole.figurePx} -> ${hand.figurePx} px figure`);
	assert.ok(span(hand) > 0);
	const t = tool("look");
	assert.equal(t.call({ scene, spec }).status, "ok");
	const ok = t.call({ look: { frames: [20], focus: { joint: "RightHand", of: "r" }, props: "outline" } });
	assert.equal(ok.status, "ok"); assert.match(ok.text, /framed on r's RightHand, props as outlines/);
	assert.match(t.call({ look: { focus: { joint: "Tail", of: "r" } } }).text, /look\.focus: want ids or \{ joint, of \}/);
	assert.match(t.call({ look: { focus: { joint: "Head", of: "shell" } } }).text, /look\.focus: want ids/);
	assert.match(t.call({ look: { props: "glass" } }).text, /look\.props: want "solid" or "outline", got "glass"/);
	console.log(`ok look: outline shows the body in the box (${diff(solid, outline)} pixels differ), no props no change; a joint framed close (${whole.figurePx} -> ${hand.figurePx} px); wrong values refused`);
}
console.log("PASS verify-frame-jumps");
