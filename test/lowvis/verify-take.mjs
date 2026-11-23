#!/usr/bin/env node
// The frame a hand takes a prop (src/lowvis/engine-simple/take.js): the prop is not moved to the hand.
//  1. hold with no `at` and an `over`: the hand goes to the prop first, the prop stays as it lies until the hand has it,
//     and the wrist then keeps the engine's pad off its surface, at any body size.
//  2. over 0 (the default with no `at`) and a hand away from the prop: the prop is pulled to the hand on that frame, and
//     the tool's rows say so with the distance the clip shows.
//  3. the default `over`, a fractional `over`, a hand that is already in the prop.
//  4. a prop that is let go stays where the hand left it, also when a key of its own moved it before the hand took it
//     (a handover whose giver lets go first; a let-go into a roll).
// Every scene here is made up for this test.
import assert from "node:assert/strict";
import { buildClip } from "../../src/lowvis/engine-simple/engine.js";
import { checkClip } from "../../src/lowvis/engine-simple/checks.js";
import { PAD } from "../../src/lowvis/engine-simple/prop-frame.js";
import { serializeClip } from "../../src/lowvis/clip.js";
import { INDEX as J, JOINT_COUNT, qRotate } from "../../src/lowvis/rig17.js";
import { measure } from "../../src/lowvis/pi/measure.mjs";

const build = (spec, scene) => { const b = buildClip(structuredClone({ demo: "x", ...spec }), scene); return { ...b, parsed: JSON.parse(serializeClip(b.clip)) }; };
const joint = (clip, id, f, j) => { const c = clip.characters.find(ch => ch.id === id), i = (f * JOINT_COUNT + j) * 3; return [c.pos[i], c.pos[i + 1], c.pos[i + 2]]; };
const prop = (clip, id, f) => { const p = clip.props.find(q => q.id === id); return { c: Array.from(p.pos.slice(f * 3, f * 3 + 3)), q: Array.from(p.quat.slice(f * 4, f * 4 + 4)), size: p.size }; };
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const step = (clip, id, f) => dist(prop(clip, id, f).c, prop(clip, id, f - 1).c);
const turned = (clip, id, f) => { const a = prop(clip, id, f).q, b = prop(clip, id, f - 1).q; return 2 * Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]))) * 180 / Math.PI; };
/** How far a point is from a prop's box: over 0 outside it, under 0 inside. */
const off = (pt, { c, q, size }) => { const l = qRotate([-q[0], -q[1], -q[2], q[3]], [pt[0] - c[0], pt[1] - c[1], pt[2] - c[2]]).map((v, k) => Math.abs(v) - size[k] / 2); return Math.hypot(...l.map(v => Math.max(v, 0))) + Math.min(0, Math.max(...l)); };
const taken = (aux, id) => aux.holders[id].findIndex(Boolean);
const mm = v => (v * 1000).toFixed(1);
const body = (s = 1, more = {}) => ({ id: "a", at: [0, 0], heading: 0, ...(s === 1 ? {} : { scale: s }), ...more });
const box = (s = 1, more = {}) => ({ id: "box", size: [0.4 * s, 0.3 * s, 0.2 * s], at: [0.05 * s, 0.95 * s, 0.45 * s], moves: true, ...more });
const rows = (b, spec) => measure(b.parsed, b.aux, { spec });

// --- 1. the hand goes to the prop; the prop stays as it lies; the wrist keeps the pad ---
for (const s of [0.2, 1, 3]) for (const hand of ["R", "L"]) {
	const spec = { a: [[10, "hold", { prop: "box", hand, over: 12 }], [40, "walk", { to: [0.6 * s, 1.2 * s] }]] };
	const b = build(spec, { frames: 90, characters: [body(s)], props: [box(s)] }), j = hand === "L" ? J.LeftHand : J.RightHand;
	assert.equal(taken(b.aux, "box"), 22, `scale ${s} ${hand}: the hand takes hold when its over ends`);
	for (let f = 1; f <= 22; f++) assert.ok(step(b.parsed, "box", f) < 1e-3 * s && turned(b.parsed, "box", f) < 0.05, `scale ${s} ${hand}: the box does not move or turn up to the take (f${f}: ${mm(step(b.parsed, "box", f))} mm)`);
	for (const f of [22, 40, 60, 89]) assert.ok(Math.abs(off(joint(b.parsed, "a", f, j), prop(b.parsed, "box", f)) - PAD * s) < 1e-3 * s, `scale ${s} ${hand}: the wrist is a pad (${mm(PAD * s)} mm) off the box at f${f}: ${mm(off(joint(b.parsed, "a", f, j), prop(b.parsed, "box", f)))} mm`);
	const check = checkClip(b.parsed, b.aux);
	assert.ok(check.gripDrift < 1e-4 * s && check.gripTurn < 1e-4, `scale ${s} ${hand}: the box is fixed in the hand (${check.gripDrift}, ${check.gripTurn})`);
	assert.deepEqual(rows(b, spec).filter(r => /took$|^jump:props/.test(r.key)), [], `scale ${s} ${hand}: no pulled row, no jump row`);
}
console.log("ok hold over 12 with no at: the box stays as it lies until the hand has it, the wrist a pad off it (scales 0.2, 1, 3)");

// --- 2. over 0 and a hand away: the prop is pulled on that frame, and the rows say how far ---
{
	const scene = { frames: 60, characters: [body()], props: [box()] }, spec = { a: [[10, "hold", { prop: "box", hand: "R", over: 0 }]] };
	const b = build(spec, scene), r = rows(b, spec), took = r.find(x => x.key === "reach:a:1:took"), jump = r.find(x => x.key === "jump:props");
	const moved = step(b.parsed, "box", 10);
	assert.equal(taken(b.aux, "box"), 10);
	assert.ok(moved > 0.1 && turned(b.parsed, "box", 10) < 0.05, `the box is pulled ${mm(moved)} mm to the hand and keeps its turn`);
	assert.ok(took && took.frame === 10 && Math.abs(took.value - moved * 1000) < 0.5, `the pulled row says the distance the clip shows (${took?.value} mm, clip ${mm(moved)} mm)`);
	assert.match(took.note, /^R hand, the action at f10; the hold gives no at, so its place is the point nearest the hand 30 mm off the surface of box/);
	assert.ok(jump && jump.frame === 10 && Math.abs(jump.value - moved * 100) < 0.05, `the jump row says it too (${jump?.value} cm)`);
	for (let f = 11; f < 60; f++) assert.ok(Math.abs(off(joint(b.parsed, "a", f, J.RightHand), prop(b.parsed, "box", f)) - PAD) < 1e-3, "then the wrist is a pad off it");
	// no over is over 0 with no at; with at the hand takes 12 frames, as every other blend
	const none = build({ a: [[10, "hold", { prop: "box", hand: "R" }]] }, scene), withAt = build({ a: [[10, "hold", { prop: "box", hand: "R", at: [0, 0.15, 0] }]] }, scene);
	assert.deepEqual(Array.from(none.parsed.props[0].pos), Array.from(b.parsed.props[0].pos), "a hold with no at and no over is the hold with over 0");
	assert.equal(taken(withAt.aux, "box"), 22, "a hold with at and no over takes hold after 12 frames");
	assert.ok(Math.max(...Array.from({ length: 22 }, (_, f) => step(withAt.parsed, "box", f + 1))) < 0.02, "and its box is not pulled");
	// both hands with no at wait as one hand does
	const both = build({ a: [[10, "hold", { prop: "box", hand: "both", over: 14 }]] }, scene);
	assert.equal(taken(both.aux, "box"), 24);
	assert.ok(Math.max(...Array.from({ length: 30 }, (_, f) => step(both.parsed, "box", f + 1))) < 0.03, "both hands go to the box first");
	console.log(`ok hold over 0 away from the box: pulled ${mm(moved)} mm on f10, told as "pulled" and as a jump; no over = over 0 with no at, 12 with at`);
}

// --- 3. a fractional over; a hand that is in the prop already; a hand near it ---
{
	const scene = { frames: 60, characters: [body()], props: [box()] };
	for (const [over, f] of [[2.5, 13], [0.4, 11], ["4", 14], [-3, 10]]) assert.equal(taken(build({ a: [[10, "hold", { prop: "box", hand: "R", over }]] }, scene).aux, "box"), f, `over ${JSON.stringify(over)}: the take is on a whole frame`);
	assert.throws(() => build({ a: [[10, "hold", { prop: "bag", hand: "R" }]] }, scene), /a hold at frame 10: no prop "bag" in the scene/);
	const inIt = build({ a: [[0, "pose", { R: { on: "box" }, over: 14 }], [20, "hold", { prop: "box", hand: "R", over: 8 }], [30, "walk", { to: [0, 1] }]] }, scene);
	assert.equal(taken(inIt.aux, "box"), 20, "a hand in the prop takes hold on the hold's frame, whatever its over");
	assert.ok(step(inIt.parsed, "box", 20) < 1e-6 && off(joint(inIt.parsed, "a", 21, J.RightHand), prop(inIt.parsed, "box", 21)) < -0.05, "the box is not moved off the hand: the wrist stays where the pose put it, in the box");
	console.log("ok over 2.5, 0.4, \"4\", -3 take on frames 13, 11, 14, 10; a hand in the box takes it there and does not move it");
}

// --- 4. let go, the prop stays where the hand left it, also after a key of its own that ended before the take ---
{
	const two = [body(), { id: "b", at: [0, 1.1], heading: 180 }], keyed = { box: [[2, "move", { to: [0, 1.0, 0.75], over: 16 }]] };
	const scene = { frames: 90, characters: two, props: [box(1, { at: [1, 1.0, 0.75] })] };
	const give = rel => ({ ...keyed, b: [[22, "hold", { prop: "box", hand: "R" }], [24, "pose", { R: [-0.1, 0.2, 0.4], over: 12 }], [40 + rel, "release", { prop: "box" }]],
		a: [[26, "pose", { R: [-0.1, 0.2, 0.42], over: 12 }], [40, "hold", { prop: "box", hand: "R", over: 3 }], [60, "walk", { to: [1, -1] }]] });
	for (const rel of [1, 2, 3, 12]) {
		const b = build(give(rel), scene), worst = Math.max(...Array.from({ length: 24 }, (_, k) => step(b.parsed, "box", 36 + k))); // up to the walk
		assert.ok(worst < 0.01, `the giver lets go ${rel} frames after the taker's hold begins: the box moves at most ${mm(worst)} mm in a frame`);
		assert.ok(b.aux.holders.box[58]?.startsWith("a"), "the taker has it");
	}
	const drop = build({ ...keyed, b: [[22, "hold", { prop: "box", hand: "R" }], [24, "pose", { R: [-0.1, 0.2, 0.4], over: 12 }], [50, "release", { prop: "box" }]] }, scene);
	assert.ok(step(drop.parsed, "box", 50) < 1e-6 && dist(prop(drop.parsed, "box", 89).c, prop(drop.parsed, "box", 49).c) < 1e-6, "a let-go leaves the box where the hand had it, not back where its key ended");
	assert.equal(checkClip(drop.parsed, drop.aux).freeTravel, 0);
	const later = build({ ...keyed, box: [...keyed.box, [70, "move", { to: [1, 0.1, 1], over: 10 }]], b: [[22, "hold", { prop: "box", hand: "R" }], [50, "release", { prop: "box" }]] }, scene);
	assert.ok(step(later.parsed, "box", 60) < 1e-6 && dist(prop(later.parsed, "box", 85).c, [1, 0.1, 1]) < 1e-5, "a later key of its own moves it again, from where it was let go");
	const ball = { frames: 90, characters: [body()], props: [{ id: "ball", size: [0.1, 0.1, 0.1], shape: "sphere", at: [-1, 0.95, 0.45], moves: true }] };
	const roll = build({ ball: [[2, "move", { to: [0, 0.95, 0.45], over: 16 }]], a: [[30, "hold", { prop: "ball", hand: "R", over: 6 }], [40, "pose", { R: [-0.2, 0.3, 0.5], over: 6, fast: true }], [46, "release", { prop: "ball", roll: true }]] }, ball);
	assert.ok(roll.aux.rolling.ball[50] && prop(roll.parsed, "ball", 89).c[1] < 0.06 && dist(prop(roll.parsed, "ball", 89).c, [0, 0.95, 0.45]) > 0.5, "let go into a roll it drops and rolls on, not back to where its key ended");
	console.log("ok a let-go leaves the prop where the hand had it (a key that ended before the take does not take it back): handover, drop, roll");
}
