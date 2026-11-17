#!/usr/bin/env node
// The holds of share.js where they met what the first version did not handle: a take at once, a second hold by the
// own other hand, one hand of a carry or a hold let go, a prop taken again after a let-go, a holder that turns round,
// aim on a prop held at a place, a place on a prop that rides on another, and the reach entries the reasons read.
// Each part names what it checks; every scene here is made up for this test.
import assert from "node:assert/strict";
import { buildClip } from "../../src/lowvis/engine-simple/engine.js";
import { serializeClip } from "../../src/lowvis/clip.js";
import { INDEX as J, JOINT_COUNT, qRotate } from "../../src/lowvis/rig17.js";
import { measure } from "../../src/lowvis/pi/measure.mjs";
import { onPlaces, otherReach } from "../../src/lowvis/engine-simple/share.js";

const build = (spec, scene) => { const b = buildClip(structuredClone({ demo: "x", ...spec }), scene); return { ...b, parsed: JSON.parse(serializeClip(b.clip)) }; };
const joint = (clip, id, f, j) => { const c = clip.characters.find(ch => ch.id === id), i = (f * JOINT_COUNT + j) * 3; return [c.pos[i], c.pos[i + 1], c.pos[i + 2]]; };
const jointQ = (clip, id, f, j) => { const c = clip.characters.find(ch => ch.id === id), i = (f * JOINT_COUNT + j) * 4; return [c.quat[i], c.quat[i + 1], c.quat[i + 2], c.quat[i + 3]]; };
const prop = (clip, id, f) => { const p = clip.props.find(q => q.id === id), i = p.pos.length === 3 ? 0 : f; return { c: Array.from(p.pos.slice(i * 3, i * 3 + 3)), q: Array.from(p.quat.slice(i * 4, i * 4 + 4)) }; };
const on = (clip, id, f, at) => { const p = prop(clip, id, f), o = qRotate(p.q, at); return [p.c[0] + o[0], p.c[1] + o[1], p.c[2] + o[2]]; };
const axis = (clip, id, f, a) => qRotate(prop(clip, id, f).q, a);
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const turnDeg = (a, b) => 2 * Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]))) * 180 / Math.PI;
const mm = v => (v * 1000).toFixed(1);
const HAND = { L: J.LeftHand, R: J.RightHand };
const gap = (b, who, side, id, at, f) => dist(joint(b.parsed, who, f, HAND[side]), on(b.parsed, id, f, at));
const worstGap = (b, who, side, id, at, from, to) => { let w = 0; for (let f = from; f < to; f++) w = Math.max(w, gap(b, who, side, id, at, f)); return w; };
const maxStep = (b, id, from, to) => { let w = 0; for (let f = from; f < to; f++) w = Math.max(w, turnDeg(prop(b.parsed, id, f).q, prop(b.parsed, id, f - 1).q)); return w; };
const one = (props, frames) => ({ frames, characters: [{ id: "a", at: [0, 0], heading: 0 }], props });
const rows = b => measure(b.parsed, b.aux);
const failed = [];
const part = (n, run) => { try { run(); } catch (e) { failed.push(n); console.log(`FAIL part ${n}: ${e.message.split("\n")[0]}`); } };

// 1. hold with `at` and over: 0 takes hold at once: the hands are on their places on the hold's own frame (from frame 0,
//    or later with fast: true; without it a hand moves at most 0.12 m a frame, and how far it was short is told)
part(1, () => {
	const crate = [{ id: "crate", size: [0.5, 0.3, 0.4], at: [0, 1.0, 0.42], moves: true }], AT = { L: [0.28, 0, 0], R: [-0.28, 0, 0] };
	for (const [f0, fast] of [[0, undefined], [30, true]]) {
		const b = build({ a: [[f0, "hold", { prop: "crate", hand: "both", at: AT, over: 0, fast }], [f0 + 20, "pose", { hands: [0.2, 0.15, 0.35], over: 16 }]] }, one(crate, 80));
		const w = Math.max(worstGap(b, "a", "L", "crate", AT.L, f0, 80), worstGap(b, "a", "R", "crate", AT.R, f0, 80));
		assert.ok(w < 0.01, `over 0 at f${f0}: both hands on their places from that frame (worst ${mm(w)} mm)`);
		assert.ok(dist(prop(b.parsed, "crate", f0).c, [0, 1.0, 0.42]) < 0.005, `the crate is not pulled at the take (${prop(b.parsed, "crate", f0).c})`);
	}
	const slow = build({ a: [[30, "hold", { prop: "crate", hand: "both", at: AT, over: 0 }]] }, one(crate, 60)), pulled = rows(slow).filter(r => /^reach:a:\d:took$/.test(r.key));
	assert.ok(pulled.length === 2 && pulled.every(r => r.frame === 30 && r.value > 100), `without fast the hands arrive short and that is told: ${pulled.map(r => `${r.key} ${r.value.toFixed(0)} mm @f${r.frame}`).join(", ")}`);
	const r = build({ a: [[30, "hold", { prop: "crate", hand: "R", at: [-0.28, 0, 0], over: 0, fast: true }]] }, one(crate, 60));
	assert.ok(worstGap(r, "a", "R", "crate", [-0.28, 0, 0], 30, 60) < 0.01, "over 0, one hand: on its place at once");
	// a pose of the holding hands on the very frame they take hold, then another: the hands stay on their places
	const hid = build({ a: [[10, "hold", { prop: "crate", hand: "both", at: AT, over: 10 }], [20, "pose", { hands: [0.25, 0.2, 0.4], over: 6 }], [40, "pose", { hands: [0.25, 0.05, 0.45], over: 10 }]] }, one(crate, 70));
	const hw = Math.max(worstGap(hid, "a", "L", "crate", AT.L, 20, 70), worstGap(hid, "a", "R", "crate", AT.R, 20, 70));
	assert.ok(hw < 0.01, `a pose on the take frame: the hands stay on their places (worst ${mm(hw)} mm)`);
	console.log(`ok hold {at, over: 0}: the hands take hold at once on their places; short without fast, told (${pulled.map(r => r.value.toFixed(0)).join(" / ")} mm); a pose on the take frame compiles`);
});

// 2. a second hold by the other hand of the same character: both hands hold until they let go
part(2, () => {
	const pole = [{ id: "pole", size: [0.04, 0.04, 1.4], at: [0, 1.0, 0.4], turn: 90, moves: true }];
	const spec = { a: [[10, "hold", { prop: "pole", hand: "R", at: [0, 0, -0.3], over: 12 }], [50, "hold", { prop: "pole", hand: "L", at: [0, 0, 0.3], over: 12 }], [90, "pose", { R: [-0.35, 0.45, 0.3], over: 16 }]] };
	const b = build(spec, one(pole, 140)), held = b.aux.holders.pole;
	assert.ok(held.slice(62).every(h => /a:R/.test(h) && /a:L/.test(h)), `both hands hold from the second take on (f62 ${held[62]}, f139 ${held[139]})`);
	const told = side => rows(b).find(x => x.key === `reach:a:${side === "L" ? 0 : 1}`)?.value ?? 0;
	for (const [side, at] of [["R", [0, 0, -0.3]], ["L", [0, 0, 0.3]]]) {
		const w = worstGap(b, "a", side, "pole", at, 62, 140);
		assert.ok(w < 0.01 || Math.abs(told(side) - w * 1000) < 1, `${side}: on its place (${mm(w)} mm) or told (${told(side).toFixed(1)} mm)`);
	}
	const z = axis(b.parsed, "pole", 120, [0, 0, 1]);
	assert.ok(Math.abs(z[1]) > 0.2, `the raised right hand tilts the pole held in both (z ${z.map(v => v.toFixed(2))})`);
	// the same with the old one-hand hold (no at): the other hand joins it
	const plain = build({ a: [[0, "hold", { prop: "pole", hand: "R" }], [30, "pose", { L: [0.2, 0.1, 0.4], over: 12 }], [44, "hold", { prop: "pole", hand: "L" }]] }, one(pole, 70));
	assert.ok(plain.aux.holders.pole.slice(44).every(h => /a:R/.test(h) && /a:L/.test(h)), `a plain hold by the other hand joins (${plain.aux.holders.pole[60]})`);
	console.log("ok a second hold by the other hand: both hands hold the pole");
});

// 3. release {hand}: one hand of a carry or of a hold lets go, the other keeps the prop
part(3, () => {
	const box = [{ id: "box", size: [0.4, 0.3, 0.3], at: [0, 1.0, 0.4], moves: true }];
	const spec = { a: [[5, "carry", { prop: "box", at: [0, 0.1, 0.4], over: 12 }], [40, "release", { prop: "box", hand: "L" }], [42, "pose", { L: "rest", over: 12 }], [60, "pose", { R: [-0.3, 0.3, 0.3], over: 16 }]] };
	const b = build(spec, one(box, 100)), held = b.aux.holders.box;
	assert.ok(held.slice(40).every(h => h === "a:R"), `the right hand keeps the box (f40 ${held[40]}, f99 ${held[99]})`);
	const rel = f => { const c = prop(b.parsed, "box", f).c, h = joint(b.parsed, "a", f, J.RightHand), q = jointQ(b.parsed, "a", f, J.RightHand); return qRotate([-q[0], -q[1], -q[2], q[3]], [c[0] - h[0], c[1] - h[1], c[2] - h[2]]); };
	let slip = 0;
	for (let f = 41; f < 100; f++) slip = Math.max(slip, dist(rel(f), rel(40)));
	assert.ok(slip < 0.001 && dist(prop(b.parsed, "box", 99).c, prop(b.parsed, "box", 40).c) > 0.1, `the box goes with the right hand (slip ${mm(slip)} mm, moved ${mm(dist(prop(b.parsed, "box", 99).c, prop(b.parsed, "box", 40).c))} mm)`);
	let jump = 0;
	for (let f = 39; f < 43; f++) jump = Math.max(jump, dist(prop(b.parsed, "box", f).c, prop(b.parsed, "box", f - 1).c));
	assert.ok(jump < 0.01, `no jump when the left hand lets go (${mm(jump)} mm)`);
	// a hand that does not hold the prop lets go of nothing
	const r = build({ a: [[0, "hold", { prop: "box", hand: "R" }], [20, "release", { prop: "box", hand: "L" }], [30, "pose", { R: [-0.3, 0.3, 0.3], over: 12 }]] }, one(box, 60));
	assert.ok(r.aux.holders.box.slice(20).every(h => h === "a"), `release of the free hand: the right hand still holds (${r.aux.holders.box[50]})`);
	console.log(`ok release {hand}: the other hand keeps the prop (slip ${mm(slip)} mm, no jump at the let-go)`);
});

// 4. a prop taken again by the same hands after a let-go: nothing of the last hold is left over
part(4, () => {
	// a. a cup held at a place, let go onto a tray it rides, taken again
	const tray = { id: "tray", size: [0.5, 0.03, 0.35], at: [-0.1, 1.0, 0.45], moves: true }, cup = { id: "cup", size: [0.08, 0.1, 0.08], at: [-0.25, 1.065, 0.45], moves: true };
	const A = [0, 0.02, -0.07], spec = {
		a: [[5, "hold", { prop: "cup", hand: "R", at: A, over: 12 }], [25, "pose", { R: [-0.15, 0.45, 0.25], over: 14 }], [50, "pose", { R: [-0.25, 0.06, 0.38], over: 14 }], [66, "release", { prop: "cup" }], [68, "pose", { R: "rest", over: 12 }], [120, "hold", { prop: "cup", hand: "R", at: A, over: 12 }], [140, "pose", { R: [-0.15, 0.45, 0.25], over: 14 }]],
		cup: [[0, "ride", { on: "tray" }], [60, "ride", { on: "tray" }]], tray: [[80, "move", { to: [0.1, 1.0, 0.45], over: 20 }]] };
	const b = build(spec, one([tray, cup], 200)), c = b.clip.props.find(p => p.id === "cup");
	assert.ok(Array.from(c.pos).every(Number.isFinite) && Array.from(c.quat).every(Number.isFinite), "the cup's track is finite on every frame");
	assert.ok(worstGap(b, "a", "R", "cup", A, 132, 200) < 0.01, "taken again: the hand is on its place");
	// b. a tray in both hands, let go, turned by its own key, taken again: it does not snap back to the old turn
	const T = [{ id: "tray", size: [0.6, 0.04, 0.4], at: [0, 1.0, 0.42], moves: true }], AT = { L: [0.3, 0, 0], R: [-0.3, 0, 0] };
	const t = build({ a: [[5, "hold", { prop: "tray", hand: "both", at: AT, over: 12 }], [40, "release", { prop: "tray" }], [42, "pose", { hands: "rest", over: 12 }], [110, "hold", { prop: "tray", hand: "both", at: AT, over: 14 }]], tray: [[60, "move", { to: [0, 1.0, 0.42], axis: [1, 0, 0], deg: 40, over: 30 }]] }, one(T, 200));
	assert.ok(maxStep(t, "tray", 120, 200) < 2, `taken again after its own turn: largest turn in one frame ${maxStep(t, "tray", 120, 200).toFixed(1)} deg`);
	// c. a stick in one hand at a place, twisted, let go, taken again at the same place
	const S = [{ id: "stick", size: [0.04, 0.04, 0.7], at: [-0.22, 1.0, 0.38], moves: true }], P = [0, 0, -0.2];
	const s = build({ a: [[5, "hold", { prop: "stick", hand: "R", at: P, over: 12 }], [30, "pose", { twist: 30, over: 14 }], [60, "release", { prop: "stick" }], [62, "pose", { twist: 0, R: "rest", over: 14 }], [100, "hold", { prop: "stick", hand: "R", at: P, over: 14 }]] }, one(S, 160));
	assert.ok(maxStep(s, "stick", 112, 160) < 2, `a one-hand hold taken again after a twist: largest turn in one frame ${maxStep(s, "stick", 112, 160).toFixed(1)} deg`);
	console.log("ok taken again: a finite track, no snap to the turn of the last hold");
});

// 5. a prop held at places on one line by a holder who turns round: it does not roll over when one hand is raised
part(5, () => {
	const T = [{ id: "tray", size: [0.6, 0.03, 0.4], at: [0, 1.05, 0.4], moves: true }], AT = { L: [0.3, 0, 0], R: [-0.3, 0, 0] };
	for (const heading of [0, 120, 180, -150]) {
		const turn = heading ? [[30, "turn", { heading }]] : [];
		const b = build({ a: [[0, "hold", { prop: "tray", hand: "both", at: AT, over: 12 }], ...turn, [110, "pose", { L: [0.3, 0.17, 0.4], over: 20 }]] }, one(T, 180));
		let low = 1;
		for (let f = 12; f < 180; f++) low = Math.min(low, axis(b.parsed, "tray", f, [0, 1, 0])[1]);
		const step = maxStep(b, "tray", 100, 180);
		assert.ok(low > 0.85 && step < 6, `heading ${heading}: the tray's top stays up (lowest y of its up axis ${low.toFixed(2)}), largest turn in one frame ${step.toFixed(1)} deg`);
	}
	console.log("ok a tray in both hands keeps its top up after the holder turns round");
});

// 6. aim turns a prop held in one hand at a place, either hand
part(6, () => {
	const rod = [{ id: "rod", size: [0.04, 0.04, 0.9], at: [0, 1.0, 0.4], moves: true }];
	for (const [hand, at] of [["L", [0, 0, -0.3]], ["R", [0, 0, -0.3]]]) {
		const b = build({ a: [[5, "hold", { prop: "rod", hand, at, over: 12 }], [30, "pose", { aim: [0, 1, 0], over: 14 }]] }, one(rod, 80)), z = axis(b.parsed, "rod", 70, [0, 0, 1]);
		assert.ok(z[1] > 0.95, `${hand}: aim [0, 1, 0] points the rod's z up (${z.map(v => v.toFixed(2))})`);
		assert.ok(worstGap(b, "a", hand, "rod", at, 17, 80) < 0.01, `${hand}: the hand stays on its place while it aims`);
	}
	console.log("ok aim turns a prop held in one hand at a place");
});

// 7. a place on a prop that rides on a keyed prop: the hand is on it in the same frame, and the row says what the clip has
part(7, () => {
	const props = [{ id: "tray", size: [0.5, 0.03, 0.35], at: [-0.25, 1.0, 0.45], moves: true }, { id: "cup", size: [0.08, 0.1, 0.08], at: [-0.25, 1.065, 0.45], moves: true }];
	const A = [0, 0.08, 0], b = build({ a: [[0, "pose", { R: { on: "cup", at: A }, over: 12 }]], tray: [[20, "move", { to: [0.25, 1.0, 0.45], over: 24 }]], cup: [[0, "ride", { on: "tray" }]] }, one(props, 90));
	let worst = 0, off = 0;
	for (let f = 12; f < 90; f++) { const g = gap(b, "a", "R", "cup", A, f); worst = Math.max(worst, g); off = Math.max(off, Math.abs(g - b.aux.reach.a[f][1].d)); }
	assert.ok(worst < 0.01, `the hand on the riding cup (worst ${mm(worst)} mm)`);
	assert.ok(off < 0.001, `its reach entry is the clip's gap on every frame (largest difference ${mm(off)} mm)`);
	console.log(`ok a place on a riding prop: worst ${mm(worst)} mm, entries = the clip`);
});

// 8. the reach entry of a holding hand is finished on every frame of the hold (the target is not blended)
part(8, () => {
	const p = { id: "box", c: [0, 1, 0], q: [0, 0, 0, 1], grips: [] }, c = { id: "a" }, U = { hands: [{ self: { joint: "Hips" } }, {}] };
	p.grips.push({ c, i: 0, g: [0.2, 0, 0], key: 7, took: { f: 9, d: 0.1 } });
	onPlaces({ box: p }, c, U, 9, x => x);
	const h = U.hands[0];
	assert.ok(h.done === true && h.w === 1 && h.key === 7 && h.self === undefined, `a holding hand's target is finished, its own and no other (${JSON.stringify(h)})`);
	assert.ok(h.took === 0.1 && h.prop === "box", "the take frame's pull and the prop are the hand's facts");
	console.log("ok a holding hand: its target finished (done) on every frame of the hold");
});

// 9. the pull at the take is a fact of the entry's own and a row of its own; d stays the clip's gap on that frame
part(9, () => {
	const BOARD = { frames: 60, characters: [{ id: "p", at: [-0.6, 0.55], heading: 180 }], props: [{ id: "board", size: [1.6, 0.06, 0.4], at: [0, 0.03, 0], moves: true }] };
	const b = build({ p: [[20, "hold", { prop: "board", hand: "both", at: { L: [-0.75, 0, 0.18], R: [-0.45, 0, 0.18] }, over: 14 }]] }, BOARD);
	const e = b.aux.reach.p[34][0], clip34 = gap(b, "p", "L", "board", [-0.75, 0, 0.18], 34);
	assert.ok(Math.abs(e.d - clip34) < 0.001 && e.took > 0.05, `take frame: d is the clip's gap (${mm(e.d)} / ${mm(clip34)} mm), the pull its own fact (${mm(e.took)} mm)`);
	const pull = rows(b).filter(r => /^reach:p:\d:took$/.test(r.key));
	assert.ok(pull.length === 2 && pull.every(r => r.frame === 34 && r.prop === "board" && r.value > 50), `the pull is told as its own row:\n${pull.map(r => `${r.key} ${r.value.toFixed(0)} ${r.label} ${r.note}`).join("\n")}`);
	assert.ok(!rows(b).some(r => /^reach:p:\d$/.test(r.key) && r.value > 10), "and not as a hand off its target");
	console.log(`ok the pull: d ${mm(e.d)} mm = the clip, took ${mm(e.took)} mm, told as ${pull.map(r => `${r.key} ${r.value.toFixed(1)} mm @f${r.frame}`).join(", ")}`);
});

// 10. a target on another body: the whole entry is made again from that body as it ended, not only its d
part(10, () => {
	const pos = Array.from({ length: JOINT_COUNT }, () => [0, 0, 0]), quat = Array.from({ length: JOINT_COUNT }, () => [0, 0, 0, 1]);
	pos[J.RightHand] = [0.3, 1, 0];
	const me = { U: { hands: [{}, { self: { joint: "RightHand", of: "b" }, to: [9, 9, 9] }], feet: [null, null] }, solved: { pos } }, other = { poseNow: { pos: pos.map((v, j) => (j === J.RightHand ? [0.3, 1, 0.1] : v)), quat } };
	const row = [null, { key: 10, d: 5, t: [9, 9, 9], stale: true }, null, null];
	otherReach(me, row, { b: other }, {}, 40, x => x, (ch, k, key, t) => ({ key, d: dist(ch.solved.pos[J.RightHand], t), t, k }));
	assert.deepEqual(row[1], { key: 10, d: dist([0.3, 1, 0], [0.3, 1, 0.1]), t: [0.3, 1, 0.1], k: 1 }, `the entry is made again from the target as it ended (${JSON.stringify(row[1])})`);
	console.log("ok a target on another body: the entry made again as a whole");
});
assert.deepEqual(failed, [], `parts failed: ${failed.join(", ")}`);
console.log("PASS verify-share-repairs");
