#!/usr/bin/env node
// What the engine does on its own is done right or told with its cause, second round (src/lowvis/engine-simple/solve.js,
// share.js, own-body.js, src/lowvis/pi/measure.mjs):
//  1. a hand key and an elbow key on one arm: the elbow moves no faster in a frame than its wrist (no jump where the
//     hand's blend ends or starts), and the elbow's row names the wrist's own target while the wrist blends back;
//  2. a prop held at places on one line by one body that turns (on the spot or along a path): it keeps its turn
//     against the hips, so a line that is not level does not roll it;
//  3. a pushed prop (carry slide) that one hand lets go: it slides on with the other hand, on the floor, and stays
//     when that hand lets go too;
//  4. rows: one place row for holders that place together; a place by a body that does not hold the prop says so;
//     a held row names the spec's action, not a key the engine added; a late take is told with the numbers of its cause.
// Each part has the scene of the review that found it and at least two of this test's own. Every scene is made up.
import assert from "node:assert/strict";
import { buildClip } from "../../src/lowvis/engine-simple/engine.js";
import { serializeClip } from "../../src/lowvis/clip.js";
import { INDEX as J, JOINT_COUNT, qRotate } from "../../src/lowvis/rig17.js";
import { measure } from "../../src/lowvis/pi/measure.mjs";

const build = (spec, scene) => { const b = buildClip(structuredClone({ demo: "x", ...spec }), structuredClone(scene)); const parsed = JSON.parse(serializeClip(b.clip)); return { ...b, parsed, rows: measure(parsed, b.aux) }; };
const joint = (b, id, f, j) => { const c = b.parsed.characters.find(ch => ch.id === id), i = (f * JOINT_COUNT + j) * 3; return [c.pos[i], c.pos[i + 1], c.pos[i + 2]]; };
const jointQ = (b, id, f, j) => { const c = b.parsed.characters.find(ch => ch.id === id), i = (f * JOINT_COUNT + j) * 4; return [c.quat[i], c.quat[i + 1], c.quat[i + 2], c.quat[i + 3]]; };
const prop = (b, id, f) => { const p = b.parsed.props.find(q => q.id === id), i = p.pos.length === 3 ? 0 : f; return { c: Array.from(p.pos.slice(i * 3, i * 3 + 3)), q: Array.from(p.quat.slice(i * 4, i * 4 + 4)) }; };
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]), mm = v => (v * 1000).toFixed(1);
const conj = q => [-q[0], -q[1], -q[2], q[3]];
const qmul = (a, b) => [a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1], a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0], a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
const turnDeg = (a, b) => 2 * Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]))) * 180 / Math.PI;
const one = (frames, c = {}, props = []) => ({ frames, characters: [{ id: "a", at: [0, 0], heading: 0, ...c }], props });
const fastest = (b, id, j) => { let v = 0, at = -1; for (let f = 1; f < b.parsed.frameCount; f++) { const d = dist(joint(b, id, f, j), joint(b, id, f - 1, j)); if (d > v) { v = d; at = f; } } return { v, at }; };
const failed = [];
const part = (n, run) => { try { run(); } catch (e) { failed.push(n); console.log(`FAIL part ${n}: ${e.message.split("\n")[0]}`); } };

// 1. a hand key and an elbow key on one arm
part(1, () => {
	const SIDE = { L: [J.LeftForeArm, J.LeftHand, 4], R: [J.RightForeArm, J.RightHand, 5] };
	const cases = [ // [name, scene, spec of a, arms]
		["review: hands on the hips, elbows out", one(90), [[10, "pose", { L: { joint: "LeftUpLeg", at: [0.1, 0.05, 0.02] }, R: { joint: "RightUpLeg", at: [-0.1, 0.05, 0.02] }, elbowL: [0.5, 0.25, -0.05], elbowR: [-0.5, 0.25, -0.05], over: 14 }]], "LR"],
		["review: the elbow key first, then the hand's, then the hand to rest", one(120, { at: [0.3, 0.2], heading: 60, scale: 1.15 }), [[10, "pose", { elbowR: [-0.45, 0.47, -0.05], over: 15 }], [40, "pose", { R: [-0.2, 0.35, 0.3], over: 20 }], [70, "pose", { R: "rest", over: 20 }]], "R"],
		["knelt 0.85, heading 120: hand to the head, elbow out, both back to rest", one(90, { at: [-0.4, 0.6], heading: 120, scale: 0.85 }), [[0, "kneel", { over: 0 }], [20, "pose", { R: { joint: "Head", at: [-0.08, 0.05, 0.1] }, elbowR: [-0.45, 0.45, 0.05], over: 9 }], [50, "pose", { R: "rest", elbowR: "rest", over: 12 }]], "R"],
		["1.2, heading -40: left hand forward, elbow out and back, the hand alone back to rest", one(100, { at: [0.5, -0.2], heading: -40, scale: 1.2 }), [[10, "pose", { L: [0.25, 0.3, 0.35], elbowL: [0.5, 0.35, -0.1], over: 20 }], [60, "pose", { L: "rest", over: 10 }]], "L"],
		["walking with both fists up, elbows down and in", one(140), [[0, "walk", { to: [0, 3] }], [20, "pose", { L: [0.12, 0.45, 0.3], R: [-0.12, 0.45, 0.3], elbowL: [0.15, 0.15, 0.1], elbowR: [-0.15, 0.15, 0.1], over: 8 }]], "LR"],
	];
	for (const [name, scene, spec, arms] of cases) {
		const b = build({ a: spec }, scene);
		for (const side of arms) {
			const [elbow, wrist, slot] = SIDE[side], e = fastest(b, "a", elbow), w = fastest(b, "a", wrist), r = b.rows.find(x => x.key === `reach:a:${slot}`);
			console.log(`  ${name}, ${side}: elbow fastest ${mm(e.v)} mm @f${e.at}, wrist fastest ${mm(w.v)} mm @f${w.at}; elbow row ${r ? `${r.value.toFixed(1)} mm: ${r.note.split("; ").slice(2).join("; ")}` : "none"}`);
			assert.ok(e.v <= w.v + 0.03, `${name}, ${side}: the elbow moves ${mm(e.v)} mm in a frame, its wrist at most ${mm(w.v)} mm`);
			assert.ok(!r || !/engine limit/.test(r.note), `${name}, ${side}: the elbow row has a cause: ${r?.note}`);
		}
	}
});

// 2. a prop held at places on one line by one body that turns
part(2, () => {
	const hips = (b, f) => jointQ(b, "a", f, J.Hips), against = (b, id, f) => qmul(conj(hips(b, f)), prop(b, id, f).q);
	const tray = { id: "tray", size: [0.6, 0.03, 0.4], at: [0, 1.05, 0.4], moves: true }, take = [0, "hold", { prop: "tray", hand: "both", at: { L: [0.3, 0, 0], R: [-0.3, 0, 0] }, over: 12 }];
	const box = [{ id: "box", size: [0.4, 0.3, 0.3], at: [0, 1.0, 0.4], moves: true }, { id: "shelf", size: [0.5, 0.85, 0.35], at: [0, 0.425, 0.4] }];
	const cases = [ // [name, scene, spec of a, prop, frame before the turn, frames after it]
		["review: a tray, the left hand 0.22 higher, a turn on the spot to 180", one(320, {}, [tray]), [take, [30, "pose", { L: [0.3, 0.22, 0.4], over: 20 }], [60, "turn", { heading: 180 }], [240, "pose", { L: [0.3, 0.02, 0.4], over: 20 }]], "tray", 59, [235]],
		["review: a box taken with hold both (no at), the right hand 0.2 higher, turns and a walk", one(320, {}, box), [[0, "pose", { hands: { prop: "box" }, over: 12 }], [14, "hold", { prop: "box", hand: "both" }], [20, "pose", { L: [0.23, 0.0, 0.4], R: [-0.23, 0.2, 0.4], over: 20 }], [60, "turn", { heading: 180 }], [150, "walk", { to: [0, -1.5] }], [230, "turn", { heading: 0 }]], "box", 59, [145, 319]],
		["1.1: an oar across, the left hand 0.3 higher, a walk that turns to 90", one(200, { scale: 1.1, at: [0.3, -0.5], heading: 20 }, [{ id: "oar", size: [1.4, 0.03, 0.22], at: [0.3 + 0.48 * Math.sin(0.35), 1.12, -0.5 + 0.48 * Math.cos(0.35)], turn: 20, moves: true }]),
			[[0, "hold", { prop: "oar", hand: "both", at: { L: [0.35, 0, 0], R: [-0.35, 0, 0] }, over: 12 }], [20, "pose", { L: [0.35, 0.35, 0.45], over: 20 }], [50, "walk", { to: [2.3, 1.2], heading: 110 }]], "oar", 49, [199]],
		["0.8, heading 45: a pole, the right hand 0.35 higher, a turn on the spot to -75", one(160, { scale: 0.8, heading: 45 }, [{ id: "pole", size: [1.2, 0.04, 0.04], at: [0.28 * Math.SQRT1_2, 0.8, 0.28 * Math.SQRT1_2], turn: 45, moves: true }]),
			[[0, "hold", { prop: "pole", hand: "both", at: { L: [0.25, 0, 0], R: [-0.25, 0, 0] }, over: 12 }], [20, "pose", { L: [0.25, 0.05, 0.35], R: [-0.25, 0.4, 0.35], over: 15 }], [50, "turn", { heading: -75 }]], "pole", 49, [150]],
	];
	for (const [name, scene, spec, id, before, after] of cases) {
		const b = build({ a: spec }, scene), rows = b.rows.filter(r => r.key.startsWith("reach:") && r.value > 10).length;
		const turns = after.map(f => turnDeg(against(b, id, before), against(b, id, f)));
		const up = after.map(f => qRotate(prop(b, id, f).q, [0, 1, 0])[1]), up0 = qRotate(prop(b, id, before).q, [0, 1, 0])[1];
		console.log(`  ${name}: turn against the hips from f${before}: ${after.map((f, k) => `f${f} ${turns[k].toFixed(1)} deg`).join(", ")}; top normal y ${up0.toFixed(2)} -> ${up.map(v => v.toFixed(2)).join(" / ")}; reach rows over 10 mm: ${rows}`);
		for (const t of turns) assert.ok(t < 4, `${name}: the prop turned ${t.toFixed(1)} deg against the body that holds it`);
	}
	// two bodies of other sizes carry a long prop at its ends, one end higher, round a corner: its roll about its own
	// length, against the vertical, stays as it was (a roll the hands do not ask for)
	const rollOf = (b, id, f) => { const q = prop(b, id, f).q, l = qRotate(q, [0, 0, 1]), n = qRotate(q, [0, 1, 0]), u = [-l[0] * l[1], 1 - l[1] * l[1], -l[2] * l[1]], k = Math.hypot(...u); return Math.acos(Math.max(-1, Math.min(1, (n[0] * u[0] + n[1] * u[1] + n[2] * u[2]) / (k * Math.hypot(...n))))) * 180 / Math.PI; };
	const pairs = [ // [name, scene, spec, frames to look at]
		["0.9 and 1.15, a beam in one hand each, the front end 0.3 higher, a corner to the left", { frames: 300, characters: [{ id: "p", at: [0.2, -1.1], heading: 0, scale: 0.9 }, { id: "q", at: [-0.2, 1.1], heading: 0, scale: 1.15 }], props: [{ id: "beam", size: [0.12, 0.08, 2.0], at: [0, 0.95, 0], moves: true }] },
			{ p: [[0, "hold", { prop: "beam", hand: "R", at: [0, 0, -0.95], over: 12 }], [70, "walk", { to: [-1.6, 0.6], heading: -90 }]], q: [[0, "hold", { prop: "beam", hand: "L", at: [0, 0, 0.95], over: 12 }], [25, "pose", { L: [0.2, 0.35, -0.2], over: 20 }], [70, "walk", { to: [-3.6, 1.2], heading: -90 }]] }, [60, 200, 299]],
		["1.0 and 1.0, a ladder, the back end 0.25 higher, a corner to the right and on", { frames: 300, characters: [{ id: "p", at: [0, -1.25], heading: 0 }, { id: "q", at: [0, 1.25], heading: 0 }], props: [{ id: "lad", size: [0.4, 0.05, 2.4], at: [0, 0.95, 0], moves: true }] },
			{ p: [[0, "hold", { prop: "lad", hand: "both", at: { L: [0, 0, -1.1], R: [0, 0, -1.1] }, over: 12 }], [25, "pose", { hands: [0, 0.3, 0.25], over: 20 }], [70, "walk", { to: [1.6, 0.4], heading: 90 }]], q: [[0, "hold", { prop: "lad", hand: "both", at: { L: [0, 0, 1.1], R: [0, 0, 1.1] }, over: 12 }], [70, "walk", { to: [3.9, 0.4], heading: 90 }]] }, [60, 200, 299]],
	];
	for (const [name, scene, spec, frames] of pairs) {
		const b = build(spec, scene), id = scene.props[0].id, r = frames.map(f => rollOf(b, id, f));
		console.log(`  ${name}: roll about its length against the vertical ${frames.map((f, k) => `f${f} ${r[k].toFixed(1)}`).join(", ")} deg`);
		for (const v of r.slice(1)) assert.ok(Math.abs(v - r[0]) < 3, `${name}: the prop rolled ${(v - r[0]).toFixed(1)} deg about its length`);
	}
});

// 3. a pushed prop that one hand lets go
part(3, () => {
	const cases = [ // [name, scene, spec of w, floor height of the centre, frame one hand lets go, frame the other does or null]
		["review: a crate, the right hand lets go", { frames: 160, characters: [{ id: "w", at: [0, 0], heading: 0 }], props: [{ id: "crate", size: [0.6, 0.7, 0.5], at: [0, 0.35, 0.62], moves: true }] },
			[[0, "pose", { hands: { prop: "crate", face: true, y: 0.6 }, over: 12 }], [14, "carry", { prop: "crate", slide: true }], [16, "push", { to: [0, 2.2] }], [70, "release", { prop: "crate", hand: "R" }]], 0.35, 70, null],
		["review: 0.9, heading 90, a trolley, the left hand lets go", { frames: 220, characters: [{ id: "w", at: [-1, 0.5], heading: 90, scale: 0.9 }], props: [{ id: "crate", size: [0.5, 0.9, 0.7], at: [-0.32, 0.45, 0.5], turn: 90, moves: true }] },
			[[0, "pose", { hands: { prop: "crate", face: true, y: 0.75 }, over: 12 }], [14, "carry", { prop: "crate", slide: true }], [16, "push", { to: [2, 0.5] }], [60, "release", { prop: "crate", hand: "L" }], [150, "idle", {}]], 0.45, 60, null],
		["1.2, heading -30: a low box, the right hand lets go, then the left", { frames: 200, characters: [{ id: "w", at: [0.5, 0.5], heading: -30, scale: 1.2 }], props: [{ id: "crate", size: [0.8, 0.5, 0.6], at: [0.5 - 0.75 * 0.5, 0.25, 0.5 + 0.75 * Math.cos(Math.PI / 6)], turn: -30, moves: true }] },
			[[0, "pose", { hands: { prop: "crate", face: true, y: 0.45 }, over: 12 }], [14, "carry", { prop: "crate", slide: true }], [16, "push", { to: [-0.7, 2.6] }], [50, "release", { prop: "crate", hand: "R" }], [90, "release", { prop: "crate", hand: "L" }]], 0.25, 50, 90],
	];
	for (const [name, scene, spec, floorY, one1, two] of cases) {
		const b = build({ w: spec }, scene), F = scene.frames;
		let hi = 0, lo = 0;
		for (let f = 0; f < F; f++) { const y = prop(b, "crate", f).c[1] - floorY; hi = Math.max(hi, y); lo = Math.min(lo, y); }
		const turn = turnDeg(prop(b, "crate", one1 - 1).q, prop(b, "crate", one1 + 20).q), on = dist(prop(b, "crate", one1).c, prop(b, "crate", one1 + 20).c);
		const after = two == null ? 0 : dist(prop(b, "crate", two).c, prop(b, "crate", F - 1).c);
		console.log(`  ${name}: over the floor ${mm(lo)} .. ${mm(hi)} mm; ${mm(on)} mm slid in the 20 frames after f${one1}, turned ${turn.toFixed(1)} deg; holders f${one1} ${b.aux.holders.crate[one1]}${two == null ? "" : `, f${two} ${b.aux.holders.crate[two]}, moved ${mm(after)} mm after it`}`);
		assert.ok(hi < 0.002 && lo > -0.002, `${name}: the pushed prop leaves the floor (${mm(lo)} .. ${mm(hi)} mm)`);
		assert.ok(on > 0.2 && turn < 1, `${name}: the push goes on with the other hand (${mm(on)} mm, ${turn.toFixed(1)} deg)`);
		if (two != null) assert.ok(b.aux.holders.crate[two] == null && after < 0.001, `${name}: let go by both hands it stays (${mm(after)} mm)`);
	}
});

// 4. rows
part(4, () => {
	const places = b => b.rows.filter(r => r.key.startsWith("place:"));
	const pair = (s1 = 1, s2 = 1) => ({ frames: 120, characters: [{ id: "p", at: [-0.55, 0], heading: 90, scale: s1 }, { id: "q", at: [0.55, 0], heading: -90, scale: s2 }], props: [{ id: "box", size: [0.5, 0.3, 0.3], at: [0, 0.95, 0], moves: true }] });
	const hp = [0, "hold", { prop: "box", hand: "both", at: { L: [-0.28, 0, 0.08], R: [-0.28, 0, -0.08] }, over: 12 }], hq = [0, "hold", { prop: "box", hand: "both", at: { L: [0.28, 0, -0.08], R: [0.28, 0, 0.08] }, over: 12 }];
	// a. holders that place on the same frame: one row
	for (const [name, scene, at, f] of [["review", pair(), [0, 0.6, 0.3], 40], ["0.9 and 1.1, another target", pair(0.9, 1.1), [0.2, 0.5, -0.2], 50]]) {
		const pl = [f, "place", { prop: "box", at, over: 20 }], b = build({ p: [hp, pl], q: [hq, pl] }, scene), rows = places(b);
		console.log(`  a. ${name}: ${rows.map(r => `${r.label} ${r.value.toFixed(1)} mm @f${r.frame}${r.note ? ` (${r.note})` : ""}`).join(" | ")}`);
		assert.equal(rows.length, 1, `${name}: one place row for one prop let go on one frame`);
	}
	// b. a place by a body that does not hold the prop
	const trio = (extra = {}) => ({ ...pair(), characters: [...pair().characters, { id: "r", at: [0, -0.9], heading: 0, ...extra }] });
	for (const [name, spec, scene] of [["review: r places what p and q hold", { p: [hp], q: [hq], r: [[40, "place", { prop: "box", at: [0, 0.6, 0.3], over: 20 }]] }, trio()],
		["1.2: r places what p alone holds", { p: [hp], r: [[30, "place", { prop: "box", at: [0.3, 0.4, -0.4], over: 15 }]] }, trio({ scale: 1.2 })],
		["q lets go, r places what p holds", { p: [hp], q: [hq, [20, "release", { prop: "box" }]], r: [[50, "place", { prop: "box", at: [0, 0.9, 0.6], over: 10 }]] }, trio()]]) {
		const b = build(spec, scene), rows = places(b);
		console.log(`  b. ${name}: ${rows.map(r => `"${r.label}" ${r.value.toFixed(1)} mm @f${r.frame} (${r.note})`).join(" | ")}`);
		assert.ok(rows.length === 1 && !/let go/.test(rows[0].label) && /r did not hold box/.test(rows[0].note), `${name}: the row says that r did not hold it`);
	}
	// c. a held row names the spec's action
	const rod = (s = 1, heading = 0) => one(120, { scale: s, heading }, [{ id: "rod", size: [0.04, 0.04, 1.2], at: [0.4 * Math.sin(heading * Math.PI / 180) * s, 1.0 * s, 0.4 * Math.cos(heading * Math.PI / 180) * s], turn: 90 + heading, moves: true }]);
	for (const [name, scene, f, over, side, pose] of [["review", rod(), 20, 9, "R", [-0.45, 0.5, 0.3]], ["1.1, heading 50, left", rod(1.1, 50), 35, 6, "L", [0.5, 0.45, 0.25]], ["0.8, right, over 15", rod(0.8, -20), 10, 15, "R", [-0.35, 0.2, 0.45]]]) {
		const b = build({ a: [[f, "hold", { prop: "rod", hand: "both", at: { L: [0, 0, -0.25], R: [0, 0, 0.25] }, over }], [70, "pose", { [side]: pose, over: 10 }]] }, scene);
		const held = b.rows.filter(r => /:held$/.test(r.key));
		console.log(`  c. ${name}: ${held.map(r => `${r.key} ${r.value.toFixed(1)} mm (${r.note})`).join(" | ") || "no held row"}`);
		assert.ok(held.length > 0 && held.every(r => !r.note.includes(`f${f + over} `) && new RegExp(`puts it$`).test(r.note) && (r.note.includes(`action at f${f} puts`) || r.note.includes("action at f70 puts"))), `${name}: each held row names f${f} or f70, never f${f + over}`);
	}
	// d. a late take: the reason's numbers are the pull's
	const crate = (s = 1, heading = 0) => one(80, { scale: s, heading }, [{ id: "crate", size: [0.5, 0.3, 0.4], at: [0.42 * Math.sin(heading * Math.PI / 180), 1.0 * s, 0.42 * Math.cos(heading * Math.PI / 180)], turn: heading, moves: true }]);
	for (const [name, scene, o] of [["review: one hand, over 0", crate(), { prop: "crate", hand: "R", at: [-0.28, 0, 0], over: 0 }], ["review: both hands, over 0", crate(), { prop: "crate", hand: "both", at: { L: [0.28, 0, 0], R: [-0.28, 0, 0] }, over: 0 }],
		["1.15, heading 70, left hand, over 1", crate(1.15, 70), { prop: "crate", hand: "L", at: [0.28, 0.1, 0.1], over: 1 }], ["0.85, heading -110, both, over 2", crate(0.85, -110), { prop: "crate", hand: "both", at: { L: [0.28, -0.1, 0], R: [-0.28, -0.1, 0] }, over: 2 }]]) {
		const b = build({ a: [[30, "hold", o]] }, scene), took = b.rows.filter(r => /:took$/.test(r.key));
		console.log(`  d. ${name}: ${took.map(r => `${r.key} ${r.value.toFixed(1)} mm (${r.note})`).join(" | ") || "no took row"}`);
		assert.ok(took.length > 0, `${name}: a took row`);
		for (const r of took) {
			const n = [...r.note.matchAll(/held it (\d+) mm short|was (\d+) mm beyond/g)].reduce((s, m) => s + Number(m[1] ?? m[2]), 0);
			assert.ok(Math.abs(n - r.value) <= 3, `${name}: the reason accounts for ${n} mm of the ${r.value.toFixed(1)} mm pull`);
		}
	}
});

if (failed.length) { console.log(`FAIL verify-told-blends: part ${failed.join(", ")}`); process.exit(1); }
console.log("PASS verify-told-blends");
