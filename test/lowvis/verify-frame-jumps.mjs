#!/usr/bin/env node
// The writer is told one-frame jumps it can act on (src/lowvis/jumps.js, measure.mjs jumpRows) and can look closer (render.mjs).
//  1. The rows. A prop whose keys leave it one frame of rest between two moves (a gap of the spec's own) has a row with
//     the frame, the steps around it and how many frames have one, every number as recomputed from the clip here; the
//     same travel as one key has none. Rows are for where a body is (its Hips joint) and for moving props, within a frame
//     of a key: hands that jump with the prop they are on get no row of their own, a body whose pivot a later tilt key
//     moves at once gets one (and none once the key says the pivot again), a prop that snaps into the hand that takes it
//     gets one. A key written with over 0 or 1 asks for its step: no row. A prop's jump onto the place of its ride is the
//     ride row's alone. The same clip measured against keys on other frames has no row. A body's threshold goes with its scale.
//  2. The studio variant tells the rows with a strip of the frames around the worst; the manual names the row and the
//     look options.
//  3. look: focus { joint, of } frames that joint close; props: "outline" draws props as edges, so a body inside a box
//     shows, and leaves a sheet with no props as it was; wrong values are refused by name.
// Every scene here is made up for this test.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildClip } from "../../src/lowvis/engine-simple/engine.js";
import { serializeClip } from "../../src/lowvis/clip.js";
import { JOINT_COUNT, INDEX as J } from "../../src/lowvis/rig17.js";
import { measure } from "../../src/lowvis/pi/measure.mjs";
import { createCompileTool } from "../../src/lowvis/pi/compile-tool.mjs";
import { systemPrompt } from "../../src/lowvis/pi/prompt.mjs";
import { drawSheet } from "../../src/lowvis/pi/render.mjs";
import { JUMP, jumpsOf } from "../../src/lowvis/jumps.js";

const TMP = mkdtempSync(join(tmpdir(), "frame-jumps-"));
const parsed = (spec, scene) => { const b = buildClip(structuredClone({ demo: "x", ...spec }), { props: [], ...scene }); return { clip: JSON.parse(serializeClip(b.clip)), aux: b.aux }; };
const jumps = (spec, scene, keys = spec) => { const { clip, aux } = parsed(spec, scene); return { clip, rows: measure(clip, aux, { spec: keys }).filter(r => r.key.startsWith("jump:")) }; };
const tool = name => createCompileTool({ name, outDir: join(TMP, name), clipFile: join(TMP, `${name}.json`), variant: "studio" });
const body = (extra = {}) => [{ id: "a", at: [0, 0], heading: 0, ...extra }];

// a sled pulled in moves of 4 frames, `step` m each, with one frame of rest before the next (a key every 5 frames), or
// the same travel as one key; a body standing beside it with both hands on it
function sled({ step = 0.4, one = false } = {}) {
	const keys = [];
	let z = 0;
	for (let f = 12; f + 5 <= 62; f += 5) { z += step; keys.push([f, "move", { to: [0.6, 0.25, z], over: 4, ease: "linear" }]); }
	const spec = { sled: one ? [[12, "move", { to: [0.6, 0.25, z], over: keys.length * 5, ease: "linear" }]] : keys, a: [[0, "pose", { hands: { on: "sled", at: [-0.3, 0.25, 0] }, over: 8 }]] };
	return { spec, scene: { frames: 72, characters: body(), props: [{ id: "sled", size: [0.5, 0.5, 0.8], at: [0.6, 0.25, 0], moves: true }] } };
}

// --- 1. the rows ---
{
	const { spec, scene } = sled(), { clip, rows } = jumps(spec, scene), F = clip.frameCount, cm = v => (v * 100).toFixed(1);
	assert.deepEqual(rows.map(r => r.key), ["jump:props"], "one row, for the props: the hands on the sled have none of their own");
	const [row] = rows, p = clip.props.find(x => x.id === "sled"), at = f => p.pos.slice(f * 3, f * 3 + 3), dist = (x, y) => Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
	// every number of the row, from the clip: the jump into f is how far its step is from the nearer neighbour step, less half of how far those two are apart
	const size = f => { const v = k => at(k).map((x, i) => x - at(k - 1)[i]); return Math.min(dist(v(f), v(f - 1)), dist(v(f), v(f + 1))) - dist(v(f - 1), v(f + 1)) / 2; };
	const all = []; for (let f = 2; f <= F - 2; f++) if (size(f) > JUMP) all.push(f);
	const worst = all.reduce((x, y) => size(y) > size(x) ? y : x);
	assert.equal(row.frame, worst); assert.equal(row.prop, "sled"); assert.equal(row.unit, "cm");
	assert.ok(Math.abs(row.value - size(worst) * 100) < 1e-9 && row.value > 100 * JUMP, `the size: ${row.value}`);
	assert.equal(row.note, `sled; steps into f${worst - 1}, f${worst}, f${worst + 1}: ${[worst - 1, worst, worst + 1].map(f => cm(dist(at(f), at(f - 1)))).join(", ")} cm; ${all.length} frames with one, f${all[0]}-f${all.at(-1)}`);
	assert.ok(dist(at(worst), at(worst - 1)) < 1e-9 && all.length >= 8, `a stop of one frame after every move but the last: ${row.note}`);
	assert.ok(all.every(f => spec.sled.some(k => Math.abs(f - k[0]) <= 1 || Math.abs(f - k[0] - 4) <= 1)), "each within a frame of a key");
	// the hands on it do jump with it; where the body is does not
	const a = clip.characters[0], joint = j => f => a.pos.slice((f * JOINT_COUNT + j) * 3, (f * JOINT_COUNT + j) * 3 + 3);
	assert.ok(jumpsOf(joint(J.LeftHand), F, JUMP).length && !jumpsOf(joint(J.Hips), F, JUMP).length, "a wrist jumps, the Hips joint does not");
	assert.deepEqual(jumps(sled({ one: true }).spec, sled({ one: true }).scene).rows, [], "the same travel as one key has no jump");
	// the same clip against keys that lie on other frames: no key within a frame of any jump, so no row
	assert.deepEqual(jumps(spec, scene, { sled: [[2, "move", { to: [0, 0, 0], over: 2 }]] }).rows, [], "a jump with no key within a frame is not told");
	console.log(`ok rows: a prop resting one frame between its keys ${row.value.toFixed(1)} cm at f${row.frame} on ${all.length} frames, every number as recomputed; the hands on it no row; one key: none; no key near: none`);

	// a body: a later tilt key that leaves out about moves the pivot at once, and the body with it
	const tilt = about => ({ a: [[5, "pose", { tilt: [90, 0], about: "feet", over: 20 }], [40, "pose", { tilt: [0, 0], ...(about ? { about } : {}), over: 20 }]] });
	const hop = jumps(tilt(), { frames: 80, characters: body() }).rows;
	assert.deepEqual(hop.map(r => [r.key, r.who, r.frame]), [["jump:a", "a", 40]]);
	assert.ok(hop[0].value > 100 && /^Hips; steps into f39, f40, f41: 0\.0, [\d.]+, 0\.0 cm$/.test(hop[0].note), `${hop[0].value} ${hop[0].note}`);
	assert.deepEqual(jumps(tilt("feet"), { frames: 80, characters: body() }).rows, [], "the key that says the pivot again has no jump");
	assert.deepEqual(jumps({ a: [[5, "pose", { tilt: [90, 0], about: "feet", over: 20 }], [40, "pose", { tilt: [0, 0], over: 0 }]] }, { frames: 80, characters: body() }).rows, [], "a key with over 0 asks for its step");
	// its threshold goes with its size: the same 6 cm hop is told of a body at scale 1 and not of one at 1.4
	const small = (scale, deg) => jumps({ a: [[5, "pose", { tilt: [deg, 0], about: "feet", over: 20 }], [40, "pose", { tilt: [deg, 0], over: 20 }]] }, { frames: 80, characters: body(scale === 1 ? {} : { scale }) }).rows;
	const at1 = small(1, 3.3), at14 = small(1.4, 2.36);
	assert.ok(at1.length === 1 && at1[0].value > 5.5 && at1[0].value < 6.5 && at1[0].spike === 100 * JUMP, `scale 1: ${at1[0]?.value}`);
	assert.deepEqual(at14, [], "a 6 cm hop of a body at scale 1.4 is under its threshold");
	assert.ok(Math.abs(small(1.4, 3.3)[0].spike - 100 * JUMP * 1.4) < 1e-9);
	// props: a prop that snaps into the hand that takes it; a step a key of its own asks for; a jump onto the place of a ride
	const crate = (id, at) => ({ id, size: [0.3, 0.3, 0.3], at, moves: true });
	const snap = jumps({ a: [[5, "hold", { prop: "stick", hand: "R", over: 12 }]] }, { frames: 60, characters: body(), props: [{ id: "stick", size: [0.03, 0.03, 0.7], at: [0.25, 0.9, 0.3], moves: true }] }).rows;
	assert.deepEqual(snap.map(r => [r.key, r.prop, r.frame]), [["jump:props", "stick", 5]]);
	assert.match(snap[0].note, /^stick; steps into f4, f5, f6: 0\.0, [\d.]+, 0\.0 cm$/);
	for (const over of [0, 1]) assert.deepEqual(jumps({ a: [[0, "idle"]], p: [[20, "move", { to: [3, 0.15, 0], over }]] }, { frames: 40, characters: body(), props: [crate("p", [1, 0.15, 0])] }).rows, [], `over ${over} asks for the step`);
	const rideSpec = { a: [[0, "idle"]], cart: [[10, "move", { to: [1, 0.2, 2], over: 50 }]], load: [[30, "ride", { on: "cart", at: [0, 0.35, 0] }]] };
	const ride = parsed(rideSpec, { frames: 80, characters: body(), props: [{ id: "cart", size: [0.6, 0.4, 1], at: [1, 0.2, 0], moves: true }, crate("load", [2, 0.15, 1])] }), rideRows = measure(ride.clip, ride.aux, { spec: rideSpec });
	assert.ok(rideRows.some(r => r.key === "ride:load:30" && r.value > 500) && !rideRows.some(r => r.key.startsWith("jump:")), "the jump onto the ride's place is told once, by the ride row");
	console.log(`ok rows: a pivot moved at once ${hop[0].value.toFixed(1)} cm at f40, none with about said again or over 0; a 6 cm hop told at scale 1, not at 1.4; a prop snapped into a hand ${snap[0].value.toFixed(1)} cm; over 0 and 1 and a ride's place: no jump row`);
}

// --- 2. told, and the manual ---
{
	const t = tool("told"), { spec, scene } = sled(), r = t.call({ scene, spec });
	assert.equal(r.status, "ok");
	const lines = r.text.split("\n").filter(l => l.startsWith("- jump between two frames"));
	assert.equal(lines.length, 1, r.text);
	assert.match(lines[0], /^- jump between two frames: [\d.]+ cm @f\d+ \(sled; steps into /);
	assert.ok(r.text.includes("\"jump\""), "a strip of the frames around the worst jump");
	assert.ok(!tool("smooth").call(sled({ one: true })).text.includes("- jump between"), "one key: no line");
	for (const variant of ["base", "lean", "studio"]) {
		const m = systemPrompt(variant);
		assert.ok(m.includes(`\n- jump between two frames: a body's Hips joint or a moving prop, within a frame of a key`) && m.includes(`told over ${JUMP * 100} cm (times the body's scale), not for a key of its own with over 0 or 1.`), variant);
		assert.ok(m.includes(`focus: "<id>" | { joint, of: "<characterId>" }, props: "outline" }`), variant);
	}
	console.log(`ok told: one line in the studio variant, a jump strip; none for one key; the manual names the row and the look options`);
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
