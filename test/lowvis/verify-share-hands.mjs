#!/usr/bin/env node
// One prop held by any number of hands, and places that follow a prop or another body (src/lowvis/engine-simple/share.js):
//  1. hold {hand: "both", at: {L, R}} by two characters: one long board, four hands; every hand stays within 10 mm of its
//     place on the board on every frame of the hold while the two walk and lift it together.
//  2. hold {hand: "both", at}: one character, one pole in both hands; the pole follows both and turns with them.
//  3. holders that ask for places the board cannot be in at once (they walk apart): the reach rows tell the gap.
//  4. {joint, at, of}: a hand on another character's forearm follows it as that body walks; a foot on another
//     character's knee; the clip does not depend on the order of the characters in the scene.
//  5. {on, at}: a hand on a place of a keyed prop follows it.
// Every scene here is made up for this test.
import assert from "node:assert/strict";
import { buildClip } from "../../src/lowvis/engine-simple/engine.js";
import { serializeClip } from "../../src/lowvis/clip.js";
import { INDEX as J, JOINT_COUNT, qRotate } from "../../src/lowvis/rig17.js";
import { measure } from "../../src/lowvis/pi/measure.mjs";

const build = (spec, scene) => { const b = buildClip(structuredClone({ demo: "x", ...spec }), scene); return { ...b, parsed: JSON.parse(serializeClip(b.clip)) }; };
const joint = (clip, id, f, j) => { const c = clip.characters.find(ch => ch.id === id), i = (f * JOINT_COUNT + j) * 3; return [c.pos[i], c.pos[i + 1], c.pos[i + 2]]; };
const jointQ = (clip, id, f, j) => { const c = clip.characters.find(ch => ch.id === id), i = (f * JOINT_COUNT + j) * 4; return [c.quat[i], c.quat[i + 1], c.quat[i + 2], c.quat[i + 3]]; };
const prop = (clip, id, f) => { const p = clip.props.find(q => q.id === id), i = p.pos.length === 3 ? 0 : f; return { c: Array.from(p.pos.slice(i * 3, i * 3 + 3)), q: Array.from(p.quat.slice(i * 4, i * 4 + 4)) }; };
const on = (clip, id, f, at) => { const p = prop(clip, id, f), o = qRotate(p.q, at); return [p.c[0] + o[0], p.c[1] + o[1], p.c[2] + o[2]]; };
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const mm = v => (v * 1000).toFixed(1);
const HANDS = { L: J.LeftHand, R: J.RightHand };
const worstOn = (clip, list, from, to) => { let w = 0; for (let f = from; f < to; f++) for (const [who, side, id, at] of list) w = Math.max(w, dist(joint(clip, who, f, HANDS[side]), on(clip, id, f, at))); return w; };
const reachRows = b => measure(b.parsed, b.aux).filter(r => r.key.startsWith("reach:"));

// --- 1. two characters, one board, four hands ---
const BOARD = { frames: 200, characters: [{ id: "p", at: [-1.05, 0.55], heading: 180 }, { id: "q", at: [1.05, 0.55], heading: 180 }],
	props: [{ id: "board", size: [2.6, 0.06, 0.4], at: [0, 0.6, 0], moves: true }, { id: "stool", size: [0.3, 0.57, 0.3], at: [0, 0.285, 0] }] };
const PLACES = { p: { L: [-1.2, 0, 0.18], R: [-0.9, 0, 0.18] }, q: { L: [0.9, 0, 0.18], R: [1.2, 0, 0.18] } }; // heading 180: the own left is -X
const lift = (who, delay = 0) => [
	[10, "pose", { bow: 35, over: 20 }],
	[20 + delay, "hold", { prop: "board", hand: "both", at: PLACES[who], over: 14 }],
	[50, "pose", { hands: [0.16, 0.25, 0.32], bow: 0, over: 24 }],
	[80, "walk", { to: [who === "p" ? -1.05 : 1.05, -1.6] }],
	[150, "pose", { hands: [0.16, -0.05, 0.4], bow: 20, over: 20 }],
	[175, "release", { prop: "board" }],
	[178, "pose", { hands: "rest", bow: 0, over: 16 }],
];
const holdList = Object.entries(PLACES).flatMap(([who, s]) => Object.entries(s).map(([side, at]) => [who, side, "board", at]));
{
	const b = build({ p: lift("p"), q: lift("q") }, BOARD), worst = worstOn(b.parsed, holdList, 34, 175);
	const start = prop(b.parsed, "board", 30), up = prop(b.parsed, "board", 78), end = prop(b.parsed, "board", 174);
	assert.ok(worst < 0.01, `every hand within 10 mm of its place on the board from the take to the let-go (worst ${mm(worst)} mm)`);
	assert.ok(dist(start.c, [0, 0.6, 0]) < 1e-6, `the board does not move before the hands take it (${start.c})`);
	assert.ok(up.c[1] > 0.85, `lifted together (centre at ${up.c[1].toFixed(2)} m)`);
	assert.ok(end.c[2] < -1.5, `carried along by both walkers (z ${end.c[2].toFixed(2)})`);
	const rows = reachRows(b).filter(r => r.value > 10);
	assert.equal(rows.length, 0, `no reach row over 10 mm: ${rows.map(r => `${r.key} ${r.value.toFixed(1)}`).join(", ")}`);
	const after = prop(b.parsed, "board", 199), before = prop(b.parsed, "board", 176);
	assert.ok(dist(after.c, before.c) < 1e-9, "let go, the board stays where it is");
	console.log(`ok four hands on one board: worst ${mm(worst)} mm from their places over the hold; lifted to ${up.c[1].toFixed(2)} m and carried to z ${end.c[2].toFixed(2)}`);

	// the order of the characters in the scene does not change the clip
	const swapped = build({ p: lift("p"), q: lift("q") }, { ...BOARD, characters: BOARD.characters.slice().reverse() });
	let diff = 0;
	for (let f = 0; f < BOARD.frames; f++) { diff = Math.max(diff, dist(prop(b.parsed, "board", f).c, prop(swapped.parsed, "board", f).c)); for (const id of ["p", "q"]) for (const j of [J.LeftHand, J.RightHand, J.Hips]) diff = Math.max(diff, dist(joint(b.parsed, id, f, j), joint(swapped.parsed, id, f, j))); }
	assert.ok(diff < 1e-9, `the same clip with the characters listed the other way round (largest difference ${diff})`);
	console.log("ok the scene's order of the characters does not change the shared hold");

	// one holder takes hold later than the other: the board waits for no one, the early pair holds it alone meanwhile
	const late = build({ p: lift("p"), q: lift("q", 6) }, BOARD), lw = worstOn(late.parsed, holdList, 40, 175);
	assert.ok(lw < 0.01, `a late second holder: every hand still on its place (worst ${mm(lw)} mm)`);
}

// --- 2. one character, a pole in both hands ---
{
	const scene = { frames: 120, characters: [{ id: "a", at: [0, 0], heading: 0 }], props: [{ id: "pole", size: [0.04, 0.04, 1.6], at: [0, 0.95, 0.35], turn: 90, moves: true }] };
	const at = { L: [0, 0, 0.25], R: [0, 0, -0.25] }; // the pole's own z runs across the body (turn 90)
	const spec = { a: [
		[0, "hold", { prop: "pole", hand: "both", at, over: 16 }],
		[30, "pose", { L: [0.3, 0.55, 0.3], R: [-0.25, 0.05, 0.35], over: 20 }],
		[60, "pose", { L: [0.25, 0.1, 0.4], R: [-0.3, 0.5, 0.3], twist: 25, over: 20 }],
		[100, "release", { prop: "pole", hand: "L" }],
		[104, "pose", { L: "rest", over: 12 }],
	] };
	const b = build(spec, scene), list = [["a", "L", "pole", at.L], ["a", "R", "pole", at.R]], worst = worstOn(b.parsed, list, 16, 100);
	assert.ok(worst < 0.01, `both hands on their places on the pole while it is raised and tilted (worst ${mm(worst)} mm)`);
	const tilt = f => { const z = qRotate(prop(b.parsed, "pole", f).q, [0, 0, 1]); return Math.asin(Math.abs(z[1])) * 180 / Math.PI; };
	assert.ok(tilt(50) > 20 && tilt(80) > 20, `the pole tilts with the hands (${tilt(50).toFixed(0)} and ${tilt(80).toFixed(0)} deg)`);
	const r = worstOn(b.parsed, [list[1]], 100, 120);
	assert.ok(r < 0.01, `after the left hand lets go the pole stays on the right (worst ${mm(r)} mm)`);
	console.log(`ok one pole in two hands: worst ${mm(worst)} mm; tilts ${tilt(50).toFixed(0)} / ${tilt(80).toFixed(0)} deg with them; the right hand keeps it after the left lets go`);
}

// --- 3. holders who ask for what the board cannot do: the difference is told ---
{
	const apart = who => [...lift(who).filter(a => a[1] !== "walk" && a[0] < 150), [80, "walk", { to: [who === "p" ? -2.2 : 2.2, 0.55] }]];
	const b = build({ p: apart("p"), q: apart("q") }, BOARD), rows = reachRows(b).filter(r => r.value > 10);
	assert.ok(rows.length >= 2 && rows.every(r => /action at f20/.test(r.note)), `the hands pulled off the board are reach rows naming the hold:\n${rows.map(r => `${r.key} ${r.value.toFixed(0)} mm ${r.note}`).join("\n")}`);
	const worst = Math.max(...rows.map(r => r.value));
	assert.ok(worst > 300, `the gap is large (${worst.toFixed(0)} mm)`);
	console.log(`ok holders that walk apart: ${rows.length} reach rows, worst ${worst.toFixed(0)} mm, each naming the hold at f20`);
}

// --- 4. a hand and a foot on another body ---
{
	const scene = { frames: 140, characters: [{ id: "a", at: [0, 0], heading: 90 }, { id: "b", at: [0.42, 0], heading: 0 }], props: [] };
	const AT = [0, -0.05, 0], hand = elbow => ({ a: [[10, "pose", { R: { joint: elbow, of: "b", at: AT }, over: 14 }], [40, "walk", { to: [0, 1.0] }]],
		b: [[40, "walk", { to: [0.42, 1.0] }], [100, "kneel", { over: 20 }]] });
	const placeOn = (clip, f, j) => { const o = qRotate(jointQ(clip, "b", f, j), AT), e = joint(clip, "b", f, j); return [e[0] + o[0], e[1] + o[1], e[2] + o[2]]; };
	const worstTo = (clip, j) => { let w = 0; for (let f = 24; f < 140; f++) w = Math.max(w, dist(joint(clip, "a", f, J.RightHand), placeOn(clip, f, j))); return w; };
	const b = build(hand("RightForeArm"), scene), worst = worstTo(b.parsed, J.RightForeArm), walked = dist(placeOn(b.parsed, 30, J.RightForeArm), placeOn(b.parsed, 139, J.RightForeArm));
	assert.ok(worst < 0.01, `the hand on b's near elbow follows it as b walks and kneels (worst ${mm(worst)} mm)`);
	assert.ok(walked > 0.8, `b's elbow travelled ${walked.toFixed(2)} m and the hand went with it`);
	const swapped = build(hand("RightForeArm"), { ...scene, characters: scene.characters.slice().reverse() });
	let diff = 0;
	for (let f = 0; f < 140; f++) for (const id of ["a", "b"]) for (let j = 0; j < JOINT_COUNT; j++) diff = Math.max(diff, dist(joint(b.parsed, id, f, j), joint(swapped.parsed, id, f, j)));
	assert.ok(diff < 1e-9, `the same clip with the characters listed the other way round (largest difference ${diff})`);
	// b's far elbow is out of a's reach: the reach row is the gap the clip has
	const far = build(hand("LeftForeArm"), scene), fw = worstTo(far.parsed, J.LeftForeArm), row = reachRows(far).find(r => r.key === "reach:a:1");
	assert.ok(fw > 0.05 && Math.abs(row.value - fw * 1000) < 0.5 && /action at f10/.test(row.note), `out of reach: row ${row?.value.toFixed(1)} mm = the clip's ${mm(fw)} mm (${row?.note})`);
	console.log(`ok hand on another body: worst ${mm(worst)} mm over ${walked.toFixed(2)} m of b's travel; the order of the characters does not matter; out of reach the row says ${row.value.toFixed(0)} mm`);

	// a foot on another character's foot while that body turns on the spot
	const AF = [0, 0.08, 0.06], steps = { a: [[30, "pose", { footR: { joint: "LeftFoot", of: "b", at: AF, pitch: 10 }, over: 16 }]], b: [[60, "turn", { heading: -20 }]] };
	const k = build(steps, { frames: 110, characters: [{ id: "a", at: [0, 0], heading: 0 }, { id: "b", at: [-0.3, 0.2], heading: 0 }], props: [] });
	let fw2 = 0;
	for (let f = 46; f < 110; f++) { const e = joint(k.parsed, "b", f, J.LeftFoot), o = qRotate(jointQ(k.parsed, "b", f, J.LeftFoot), AF); fw2 = Math.max(fw2, dist(joint(k.parsed, "a", f, J.RightFoot), [e[0] + o[0], e[1] + o[1], e[2] + o[2]])); }
	assert.ok(fw2 < 0.01, `a foot on b's foot stays on it while b turns (worst ${mm(fw2)} mm)`);
	console.log(`ok foot on another body: worst ${mm(fw2)} mm from its place on b's foot`);
}

// --- 5. a hand on a place of a keyed prop ---
{
	const scene = { frames: 80, characters: [{ id: "a", at: [0, 0], heading: 0 }], props: [{ id: "door", size: [0.9, 2.0, 0.05], at: [0, 1.0, 0.6], moves: true }] };
	const spec = { a: [[0, "pose", { R: { on: "door", at: [-0.35, 0, -0.05] }, over: 12 }]], door: [[20, "move", { to: [0.6, 1.0, 0.75], over: 40 }]] };
	const b = build(spec, scene), worst = worstOn(b.parsed, [["a", "R", "door", [-0.35, 0, -0.05]]], 12, 80);
	assert.ok(worst < 0.01, `the hand stays on its place on the moving prop (worst ${mm(worst)} mm)`);
	assert.throws(() => build({ a: [[0, "pose", { R: { on: "nothing" } }]] }, scene), /wants a prop id/, "an unknown prop is refused by name");
	assert.throws(() => build({ a: [[0, "hold", { prop: "door", hand: "both", at: [0, 0, 0] }]] }, scene), /at wants/, "a hold at that does not name both places is refused");
	console.log(`ok hand on a keyed prop: worst ${mm(worst)} mm from its place while the prop moves`);
}

// --- 6. a prop in one hand (the old hold) that a second character takes: shared, then the first lets go ---
{
	const scene = { frames: 110, characters: [{ id: "a", at: [0, 0], heading: 0 }, { id: "b", at: [0, 1.0], heading: 180 }],
		props: [{ id: "jar", size: [0.12, 0.2, 0.12], at: [-0.25, 0.9, 0.3], moves: true }] };
	const AT = [0, 0.04, 0.07];
	const spec = { a: [[0, "hold", { prop: "jar", hand: "R" }], [0, "pose", { R: [-0.12, 0.1, 0.38], over: 0 }], [70, "release", { prop: "jar" }], [72, "pose", { R: "rest", over: 16 }]],
		b: [[30, "hold", { prop: "jar", hand: "R", at: AT, over: 16 }], [80, "pose", { R: [-0.15, 0.15, 0.2], over: 20 }]] };
	const run = sc => build(spec, sc), b = run(scene), worst = worstOn(b.parsed, [["b", "R", "jar", AT]], 46, 110);
	assert.ok(worst < 0.01, `b's hand stays on its place on the jar from its take on, through a's let-go (worst ${mm(worst)} mm)`);
	let jump = 0;
	for (const f of [45, 46, 47, 69, 70, 71]) jump = Math.max(jump, dist(prop(b.parsed, "jar", f).c, prop(b.parsed, "jar", f - 1).c)); // around b's take (46) and a's let-go (70)
	assert.ok(jump < 0.03, `the jar does not jump when b takes it or a lets go (largest move in one frame ${mm(jump)} mm)`);
	const swapped = run({ ...scene, characters: scene.characters.slice().reverse() });
	let diff = 0;
	for (let f = 0; f < 110; f++) diff = Math.max(diff, dist(prop(b.parsed, "jar", f).c, prop(swapped.parsed, "jar", f).c));
	assert.ok(diff < 1e-9, `the same jar track with the characters listed the other way round (${diff})`);
	console.log(`ok a one-hand hold taken by a second hand: worst ${mm(worst)} mm; largest move in one frame ${mm(jump)} mm; the order of the characters does not matter`);
}
console.log("PASS verify-share-hands");
