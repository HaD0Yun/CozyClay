#!/usr/bin/env node
// What the engine does on its own is done right or told with its cause (src/lowvis/engine-simple/solve.js, share.js,
// src/lowvis/pi/reach-why.mjs, measure.mjs):
//  1. an elbow key that turns a free wrist: the elbow comes to its target without swinging back, the reason of a late
//     elbow is the wrist's top speed, and fast on that key lifts it;
//  2. an elbow that goes from one target to another moves no more in a frame than a wrist may;
//  3. one hand of a carry let go while the body walks, runs or turns: the prop goes on moving on that frame;
//  4. hands that hold one prop and are posed apart: each is told as a `held` row with the hold that keeps it;
//  5. two holders that turn round under a prop whose places lie on one line: it does not flip;
//  6. two limbs that aim at each other: the reason names the other body, that each aims at where the other was, and
//     how far the reach assist lowered the body;
//  7. a place by one of two holders is a place row; a hand that takes hold late is told why.
// Each part has the scene of the review that found it and at least two of this test's own. Every scene is made up.
import assert from "node:assert/strict";
import { buildClip } from "../../src/lowvis/engine-simple/engine.js";
import { serializeClip } from "../../src/lowvis/clip.js";
import { INDEX as J, JOINT_COUNT, OFFSET, qRotate } from "../../src/lowvis/rig17.js";
import { measure } from "../../src/lowvis/pi/measure.mjs";

const build = (spec, scene) => { const b = buildClip(structuredClone({ demo: "x", ...spec }), structuredClone(scene)); const parsed = JSON.parse(serializeClip(b.clip)); return { ...b, parsed, rows: measure(parsed, b.aux) }; };
const joint = (b, id, f, j) => { const c = b.parsed.characters.find(ch => ch.id === id), i = (f * JOINT_COUNT + j) * 3; return [c.pos[i], c.pos[i + 1], c.pos[i + 2]]; };
const prop = (b, id, f) => { const p = b.parsed.props.find(q => q.id === id), i = p.pos.length === 3 ? 0 : f; return { c: Array.from(p.pos.slice(i * 3, i * 3 + 3)), q: Array.from(p.quat.slice(i * 4, i * 4 + 4)) }; };
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]), mm = v => (v * 1000).toFixed(1);
const turnDeg = (a, b) => 2 * Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]))) * 180 / Math.PI;
const UPPER = Math.hypot(...OFFSET[J.LeftForeArm]), unit = d => { const l = Math.hypot(...d); return d.map(v => v / l); };
const ARM = { elbowL: [J.LeftArm, J.LeftForeArm, J.LeftHand, 4], elbowR: [J.RightArm, J.RightForeArm, J.RightHand, 5] };
const one = (frames, c = {}, props = []) => ({ frames, characters: [{ id: "a", at: [0, 0], heading: 0, ...c }], props });
const row = (b, key) => b.rows.find(r => r.key === key);
const failed = [];
const part = (n, run) => { try { run(); } catch (e) { failed.push(n); console.log(`FAIL part ${n}: ${e.message.split("\n")[0]}`); } };
// a point on the upper arm's sphere about the shoulder of a scene without the key, at frame f
const onSphere = (scene, base, key, f, d) => { const sh = joint(build({ a: base }, scene), "a", f, ARM[key][0]), s = scene.characters[0].scale ?? 1; return sh.map((v, k) => v + unit(d)[k] * UPPER * s); };

// 1. a short elbow key with a free wrist
part(1, () => {
	const cases = [ // [name, scene, base, key, target, over]
		["review forward-up", one(60), [], "elbowR", [-0.152, 1.567, 0.183], 3], ["review straight up", one(60), [], "elbowR", [-0.152, 1.706, -0.058], 6],
		["left, 0.85, heading 70", one(60, { at: [0.4, -0.3], heading: 70, scale: 0.85 }), [], "elbowL", null, 4, [0.3, 0.8, 0.5]],
		["seated 1.2, up and back", one(60, { scale: 1.2 }), [[0, "sit", { height: 0.5, over: 0 }]], "elbowR", null, 5, [-0.2, 0.6, -0.77]],
	];
	for (const [name, scene, base, key, given, over, dir] of cases) {
		const T = given ?? onSphere(scene, base, key, 30, dir), [, fore, , slot] = ARM[key], end = 10 + over;
		const slow = build({ a: [...base, [10, "pose", { [key]: { world: T }, over }]] }, scene), fast = build({ a: [...base, [10, "pose", { [key]: { world: T }, over, fast: true }]] }, scene);
		const gaps = Array.from({ length: 40 }, (_, k) => dist(joint(slow, "a", end + k, fore), T)), back = gaps.findIndex((g, k) => k && g > gaps[k - 1] + 0.001 && gaps[k - 1] > 0.01);
		assert.ok(back < 0, `${name}: after the blend the elbow only comes nearer its target (${gaps.slice(0, 8).map(mm).join(" ")} mm)`);
		const r = row(slow, `reach:a:${slot}`);
		assert.ok(r && /why: late: this elbow turns its free wrist with it/.test(r.note) && !/engine limit/.test(r.note), `${name}: the late elbow is told by the wrist's top speed: ${r?.note}`);
		assert.ok(dist(joint(fast, "a", end, fore), T) < 0.01, `${name}: with fast the elbow is on its target when the blend ends (${mm(dist(joint(fast, "a", end, fore), T))} mm)`);
		console.log(`ok ${name}: ${mm(gaps[0])} mm late at f${end}, then nearer every frame; fast: ${mm(dist(joint(fast, "a", end, fore), T))} mm`);
	}
});

// 2. an elbow from one target to another moves no farther in a frame than a wrist may (0.12 m at scale 1)
part(2, () => {
	const cases = [
		["review up to down-back", one(100), [], "elbowR", [[10, [-0.152, 1.706, -0.058]], [50, [-0.152, 1.205, -0.225]]]],
		["seated 1.2, three targets", one(140, { scale: 1.2 }), [[0, "sit", { height: 0.5, over: 0 }]], "elbowR", [[10, [0, 1, 0]], [50, [0, -0.6, -0.8]], [90, [0.3, -0.3, 0.9]]]],
		["left, 0.9, heading 120", one(140, { at: [-0.5, 0.2], heading: 120, scale: 0.9 }), [], "elbowL", [[10, [0.7, 0.7, 0]], [50, [0, -0.5, 0.86]], [90, [-0.5, -0.2, 0.84]]]],
	];
	for (const [name, scene, base, key, list] of cases) {
		const keys = list.map(([f, t]) => [f, "pose", { [key]: { world: name.startsWith("review") ? t : onSphere(scene, base, key, 5, t) }, over: 15 }]);
		const b = build({ a: [...base, ...keys] }, scene), [, fore] = ARM[key], s = scene.characters[0].scale ?? 1;
		let worst = 0, wf = 0;
		for (let f = 1; f < scene.frames; f++) { const v = dist(joint(b, "a", f, fore), joint(b, "a", f - 1, fore)); if (v > worst) { worst = v; wf = f; } }
		assert.ok(worst <= 0.12 * s + 1e-6, `${name}: the elbow moves at most ${mm(0.12 * s)} mm a frame (${mm(worst)} mm @f${wf})`);
		console.log(`ok ${name}: the elbow's largest move in one frame ${mm(worst)} mm @f${wf}`);
	}
});

// 3. one hand of a carry let go while the body moves: the prop goes on moving on that frame
part(3, () => {
	const props = [{ id: "crate", size: [0.5, 0.25, 0.3], at: [0, 0.95, 0.42], moves: true }, { id: "stand", size: [0.3, 0.8, 0.3], at: [0, 0.4, 0.42] }];
	const pre = [[0, "pose", { hands: { prop: "crate" }, over: 10 }], [12, "carry", { prop: "crate", at: [0, 0, 0.38], over: 10 }]];
	const cases = [["review walk", {}, [[30, "walk", { to: [0.9, 2.2] }]], 70, "R"], ["review run", {}, [[30, "run", { to: [0, 4.5] }]], 50, "R"], ["review turn", {}, [[30, "turn", { heading: 150 }]], 50, "L"],
		["0.9, heading 60, walk, left", { scale: 0.9, heading: 60 }, [[30, "walk", { to: [1.6, 1.4] }]], 64, "L"], ["1.1, turn to -120", { scale: 1.1 }, [[30, "turn", { heading: -120 }]], 46, "R"]];
	for (const [name, c, move, rf, hand] of cases) {
		const scale = c.scale ?? 1, sc = { ...one(160, c), props: props.map(p => ({ ...p, at: p.at.map(v => v * scale) })) };
		const b = build({ a: [...pre, ...move, [rf, "release", { prop: "crate", hand }]] }, sc), step = f => dist(prop(b, "crate", f).c, prop(b, "crate", f - 1).c);
		const turn = f => turnDeg(prop(b, "crate", f).q, prop(b, "crate", f - 1).q), was = Math.min(step(rf - 1), step(rf + 1));
		assert.ok(was > 0.005 && step(rf) > 0.5 * was, `${name}: the crate moves on the let-go frame (${mm(step(rf - 1))} / ${mm(step(rf))} / ${mm(step(rf + 1))} mm)`);
		if (turn(rf - 1) > 1 && turn(rf + 1) > 1) assert.ok(turn(rf) > 0.5 * Math.min(turn(rf - 1), turn(rf + 1)), `${name}: and turns (${turn(rf - 1).toFixed(1)} / ${turn(rf).toFixed(1)} / ${turn(rf + 1).toFixed(1)} deg)`);
		console.log(`ok ${name}: ${mm(step(rf - 1))} / ${mm(step(rf))} / ${mm(step(rf + 1))} mm a frame around the let-go of the ${hand} hand`);
	}
});

// 4. two hands on one prop posed apart, with no release: each is a held row naming the hold; with the release, none
part(4, () => {
	const cup = (x, s = 1) => [{ id: "cup", size: [0.09, 0.12, 0.09].map(v => v * s), at: [x, 0.95 * s, 0.35 * s], moves: true }, { id: "shelf", size: [0.3, 0.89, 0.3].map(v => v * s), at: [x, 0.445 * s, 0.35 * s] }];
	const swap = (A, B, sa) => [[0, "pose", { [A]: { prop: "cup" }, over: 12 }], [14, "hold", { prop: "cup", hand: A }], [16, "pose", { [A]: [sa * 0.08, 0.25, 0.35], over: 14 }], [34, "pose", { [B]: [-sa * 0.08, 0.25, 0.35], over: 12 }], [48, "hold", { prop: "cup", hand: B }], [50, "pose", { [A]: "rest", over: 14 }], [70, "pose", { [B]: [-sa * 0.3, 0.45, 0.25], over: 16 }]];
	const cases = [["review right to left", one(140, {}, cup(-0.3)), swap("R", "L", -1)], ["left to right", one(140, {}, cup(0.3)), swap("L", "R", 1)], ["1.1, heading -45, right to left", one(140, { scale: 1.1, heading: -45 }, cup(-0.3, 1.1).map(p => ({ ...p, at: [p.at[0] * Math.cos(-Math.PI / 4) + p.at[2] * Math.sin(-Math.PI / 4), p.at[1], -p.at[0] * Math.sin(-Math.PI / 4) + p.at[2] * Math.cos(-Math.PI / 4)] }))), swap("R", "L", -1)]];
	for (const [name, scene, spec] of cases) {
		const b = build({ a: spec }, scene), held = b.rows.filter(r => /^reach:a:\d:held$/.test(r.key));
		assert.ok(held.length === 2 && held.every(r => r.value > 100 && /the action at f(14|48) has it hold cup/.test(r.note)), `${name}: both hands are told as held by the cup:\n${held.map(r => `${r.key} ${r.value.toFixed(0)} ${r.note}`).join("\n")}`);
		const A = spec[1][2].hand, freed = build({ a: [...spec, [48, "release", { prop: "cup", hand: A }]] }, scene);
		assert.ok(!freed.rows.some(r => /:held$/.test(r.key)), `${name}: with release {hand} there is none`);
		console.log(`ok ${name}: held rows ${held.map(r => `${r.value.toFixed(0)} mm`).join(" / ")}; none with the release`);
	}
});

// 5. two holders turn round under a prop whose places lie on one line: it does not flip
part(5, () => {
	const at = (z, s = 1) => ({ L: [0, 0, z * s], R: [0, 0, z * s] });
	const cases = [["review +180 / +180", 0.4, 2.4, 1.55, 180, 360, 1], ["+180 / -180", 0.4, 2.4, 1.55, 180, 0, 1], ["0.9, plank 2.0, -170 / -170", 0.3, 2.0, 1.3, -170, 10, 0.9]];
	for (const [name, w, l, z, hp, hq, s] of cases) {
		const scene = { frames: 300, characters: [{ id: "p", at: [0, -z * s], heading: 0, scale: s }, { id: "q", at: [0, z * s], heading: 180, scale: s }], props: [{ id: "lad", size: [w * s, 0.05 * s, l * s], at: [0, 0.95 * s, 0], moves: true }] };
		const b = build({ p: [[0, "hold", { prop: "lad", hand: "both", at: at(-(l / 2 - 0.05), s), over: 12 }], [30, "turn", { heading: hp }]], q: [[0, "hold", { prop: "lad", hand: "both", at: at(l / 2 - 0.05, s), over: 12 }], [30, "turn", { heading: hq }], [150, "pose", { hands: [0, 0.3, -0.3], over: 20 }]] }, scene);
		let low = 1, turn = 0;
		for (let f = 13; f < 300; f++) { low = Math.min(low, qRotate(prop(b, "lad", f).q, [0, 1, 0])[1]); turn = Math.max(turn, turnDeg(prop(b, "lad", f).q, prop(b, "lad", f - 1).q)); }
		assert.ok(low > 0.9 && turn < 10, `${name}: the top stays up (lowest ${low.toFixed(2)}), no flip (largest turn in a frame ${turn.toFixed(1)} deg)`);
		console.log(`ok ${name}: top normal at least ${low.toFixed(2)} up, at most ${turn.toFixed(1)} deg a frame`);
	}
});

// 6. two limbs that aim at each other
part(6, () => {
	const cases = [["review right wrists", [{ id: "a", at: [0, 0], heading: 0 }, { id: "b", at: [0.25, 0.85], heading: 180 }], "R", "RightHand", "R", "RightHand"],
		["review left wrists, 0.9 / 1.15", [{ id: "a", at: [1, 1], heading: 45, scale: 0.9 }, { id: "b", at: [1.62, 1.62], heading: 225, scale: 1.15 }], "L", "LeftHand", "L", "LeftHand"],
		["a's right on b's left elbow, b's left on a's right wrist", [{ id: "a", at: [-0.2, 0], heading: 20, scale: 1.05 }, { id: "b", at: [0.3, 0.75], heading: 200 }], "R", "LeftForeArm", "L", "RightHand"]];
	for (const [name, characters, ha, ja, hb, jb] of cases) {
		const b = build({ a: [[10, "pose", { [ha]: { joint: ja, of: "b" }, over: 14 }]], b: [[10, "pose", { [hb]: { joint: jb, of: "a" }, over: 14 }]] }, { frames: 100, characters, props: [] });
		const told = b.rows.filter(r => /^reach:[ab]:[01]$/.test(r.key) && r.value > 10);
		assert.ok(told.length >= 1, `${name}: the gap is a row`);
		for (const r of told) {
			assert.ok(!/engine limit/.test(r.note) && /the target is on [ab], which moved it \d+ mm on that frame after this pose was aimed at it; [ab] has a target on this body too, so each aims at where the other was/.test(r.note), `${name}: ${r.key} names the chase: ${r.note}`);
			const hips = joint(b, r.who, r.frame, J.Hips)[1], stand = joint(build({}, { frames: 100, characters, props: [] }), r.who, r.frame, J.Hips)[1], low = /its hips (\d+) mm lower/.exec(r.note);
			if (stand - hips > 0.05) assert.ok(low && Math.abs(Number(low[1]) / 1000 - (stand - hips)) < 0.03, `${name}: ${r.who}'s hips are ${mm(stand - hips)} mm low and the row says so: ${r.note}`);
		}
		console.log(`ok ${name}: ${told.map(r => `${r.key} ${r.value.toFixed(0)} mm`).join(", ")}, the chase and the lowered hips told`);
	}
	const oneSide = build({ a: [[10, "pose", { R: [-0.05, 0.1, 0.42], over: 14 }]], b: [[10, "pose", { R: { joint: "RightHand", of: "a" }, over: 14 }]] }, { frames: 100, characters: [{ id: "a", at: [0, 0], heading: 0 }, { id: "b", at: [0.25, 0.85], heading: 180 }], props: [] });
	assert.ok(!oneSide.rows.some(r => /^reach:/.test(r.key) && r.value > 10), "one side only: the hands meet, no row");
});

// 7. a place by one of two holders; a hand that takes hold late
part(7, () => {
	for (const [name, s, x] of [["box, two holders", 1, 0.6], ["0.9, the other side", 0.9, -0.6], ["1.1, far", 1.1, 1.2]]) {
		const scene = { frames: 120, characters: [{ id: "p", at: [-0.55 * s, 0], heading: 90, scale: s }, { id: "q", at: [0.55 * s, 0], heading: -90, scale: s }], props: [{ id: "box", size: [0.5, 0.3, 0.3].map(v => v * s), at: [0, 0.95 * s, 0], moves: true }] };
		const b = build({ p: [[0, "hold", { prop: "box", hand: "both", at: { L: [-0.28 * s, 0, 0.08 * s], R: [-0.28 * s, 0, -0.08 * s] }, over: 12 }], [40, "place", { prop: "box", at: [x, 0.5, 0.5], over: 20 }]], q: [[0, "hold", { prop: "box", hand: "both", at: { L: [0.28 * s, 0, -0.08 * s], R: [0.28 * s, 0, 0.08 * s] }, over: 12 }]] }, scene);
		const r = row(b, "place:box");
		assert.ok(r && r.value > 50, `${name}: the place is a row (${r ? `${r.value.toFixed(0)} mm` : "none"})`);
		console.log(`ok ${name}: place row ${r?.value.toFixed(0)} mm`);
	}
	const crate = [{ id: "crate", size: [0.5, 0.3, 0.4], at: [0, 1.0, 0.42], moves: true }];
	for (const [name, f0, over] of [["review over 0 at f30", 30, 0], ["over 0 at f12", 12, 0], ["over 2 at f20", 20, 2]]) {
		const b = build({ a: [[f0, "hold", { prop: "crate", hand: "both", at: { L: [0.28, 0, 0], R: [-0.28, 0, 0] }, over }]] }, one(80, {}, crate)), took = b.rows.filter(r => /:took$/.test(r.key));
		assert.ok(took.length === 2 && took.every(r => /late: a wrist moves at most 120 mm a frame in the body frame unless its key says fast/.test(r.note)), `${name}: the pull says why: ${took.map(r => r.note).join(" | ")}`);
		console.log(`ok ${name}: ${took.map(r => `${r.key} ${r.value.toFixed(0)} mm`).join(", ")}, told as late`);
	}
});

assert.deepEqual(failed, [], `parts failed: ${failed.join(", ")}`);
console.log("PASS verify-told-causes");
