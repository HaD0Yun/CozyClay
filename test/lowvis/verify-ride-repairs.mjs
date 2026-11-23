#!/usr/bin/env node
// The moments a ride begins and ends (src/lowvis/engine-simple/ride.js), each on bodies that move:
//  1. A hand puts a prop on a joint or on a prop that rides one and lets go (ride with no at): from the let-go the prop
//     keeps the place the hand gave it, on the let-go frame too (it does not stand still for a frame).
//  2. A hand takes a prop off a moving carrier: on the take frame the prop still goes with the carrier.
//  3. A ride that has not begun while hands hold the prop begins on the first frame no hand holds it; a ride that never
//     began is told with what the clip shows (who held it on which frames, or the key of its frame that drives the prop).
//  4. carry of a prop that rode keeps the heading the ride gave it.
//  5. axis and deg without at are refused; with at they turn the prop.
// Every scene here is made up for this test.
import assert from "node:assert/strict";
import { buildClip } from "../../src/lowvis/engine-simple/engine.js";
import { serializeClip } from "../../src/lowvis/clip.js";
import { INDEX as J, JOINT_COUNT, qMul, qRotate } from "../../src/lowvis/rig17.js";
import { measure } from "../../src/lowvis/pi/measure.mjs";

const build = (spec, scene) => { const b = buildClip(structuredClone({ demo: "x", ...spec }), structuredClone(scene)), parsed = JSON.parse(serializeClip(b.clip)); return { aux: b.aux, parsed, rows: measure(parsed, b.aux) }; };
const joint = (clip, id, f, name) => { const c = clip.characters.find(ch => ch.id === id), i = (f * JOINT_COUNT + J[name]) * 3, k = (f * JOINT_COUNT + J[name]) * 4; return { c: [c.pos[i], c.pos[i + 1], c.pos[i + 2]], q: [c.quat[k], c.quat[k + 1], c.quat[k + 2], c.quat[k + 3]] }; };
const prop = (clip, id, f) => { const p = clip.props.find(q => q.id === id), i = p.pos.length === 3 ? 0 : f; return { c: Array.from(p.pos.slice(i * 3, i * 3 + 3)), q: Array.from(p.quat.slice(i * 4, i * 4 + 4)) }; };
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const conj = q => [-q[0], -q[1], -q[2], q[3]];
const place = (car, p) => qRotate(conj(car.q), [p.c[0] - car.c[0], p.c[1] - car.c[1], p.c[2] - car.c[2]]);
const yaw = q => { const z = qRotate(q, [0, 0, 1]); return Math.atan2(z[0], z[2]) * 180 / Math.PI; };
const wrap = d => ((d + 540) % 360) - 180;
const mm = v => (v * 1000).toFixed(1);

// --- 1. put on with no at while the body moves ---
{
	const CASES = [ // [name, body actions, joint, scale, heading]; the first is the reviewer's walk on the Head
		["walk, Head", [[0, "walk", { to: [0, 6] }]], "Head", 1, 0],
		["run, Spine2, scale 0.8, heading 135", [[0, "run", { to: [4, -4] }]], "Spine2", 0.8, 135],
		["walk back, LeftArm, scale 1.2, heading 250", [[0, "walk", { to: [1.2, 1.5], facing: 250 }]], "LeftArm", 1.2, 250],
		["bow and twist, Spine2", [[40, "pose", { bow: 50, twist: 30, over: 30 }]], "Spine2", 1, 40],
	];
	for (const [name, body, jn, scale, heading] of CASES) {
		const scene = { frames: 110, characters: [{ id: "t", at: [0, 0], heading, scale }], props: [{ id: "tag", size: [0.12, 0.08, 0.1], at: [0, 1, 0.4], moves: true }] };
		const r = build({ t: [...body, [0, "hold", { prop: "tag", hand: "R", at: [-0.08, 0, 0], over: 10 }], [14, "pose", { R: { joint: jn, at: [-0.12, 0.12, 0.06] }, over: 24 }], [58, "release", { prop: "tag" }], [62, "pose", { R: "rest", over: 16 }]],
			tag: [[30, "ride", { joint: jn, of: "t" }]] }, scene);
		const ride = r.aux.rides[0], at = f => place(joint(r.parsed, "t", f, jn), prop(r.parsed, "tag", f));
		assert.equal(ride.began, 58, `${name}: the ride begins at the let-go`);
		const step = dist(joint(r.parsed, "t", 58, jn).c, joint(r.parsed, "t", 57, jn).c);
		assert.ok(step > 0.005, `${name}: the ${jn} moves on the let-go frame (${mm(step)} mm)`);
		let kept = 0; for (let f = 58; f < 110; f++) kept = Math.max(kept, dist(at(f), at(57)));
		assert.ok(kept < 0.001, `${name}: from the let-go the tag keeps the place the hand gave it on the ${jn} (worst ${mm(kept)} mm; the joint moved ${mm(step)} mm on that frame)`);
		console.log(`ok put on, ${name}: place kept within ${mm(kept)} mm from f57 (joint step on the let-go ${mm(step)} mm)`);
	}
	// through a rider: a pin put on a hat that rides a joint, the body walks (the reviewer's) or runs on another heading
	for (const [name, body, heading] of [["walk", [[0, "walk", { to: [0, 6] }]], 0], ["run, heading 300", [[0, "run", { to: [-4, 2.3] }]], 300]]) {
		const scene = { frames: 110, characters: [{ id: "t", at: [0, 0], heading }], props: [{ id: "hat", size: [0.3, 0.1, 0.3], at: [0, 2, 0], moves: true }, { id: "pin", size: [0.04, 0.04, 0.04], at: [0.4, 1, 0], moves: true }] };
		const r = build({ t: [...body, [0, "hold", { prop: "pin", hand: "R", at: [-0.03, 0, 0], over: 10 }], [14, "pose", { R: { on: "hat", at: [-0.05, 0.08, 0.05] }, over: 24 }], [60, "release", { prop: "pin" }], [62, "pose", { R: "rest", over: 16 }]],
			hat: [[0, "ride", { joint: "Head", of: "t", at: [0, 0.17, 0] }]], pin: [[30, "ride", { on: "hat" }]] }, scene);
		const at = f => place(prop(r.parsed, "hat", f), prop(r.parsed, "pin", f));
		let kept = 0; for (let f = 60; f < 110; f++) kept = Math.max(kept, dist(at(f), at(59)));
		assert.ok(kept < 0.001, `pin on the hat, ${name}: keeps its place from the let-go (worst ${mm(kept)} mm)`);
		console.log(`ok put on a rider, ${name}: the pin keeps its place on the hat within ${mm(kept)} mm`);
	}
}

// --- 2. take off a moving carrier ---
{
	const CASES = [ // [name, body, prop on, take action]; the first is the reviewer's
		["walk, Head, hold at over 16", [[0, "walk", { to: [0, 5] }]], { joint: "Head", of: "t", at: [0, 0.17, 0] }, [10, "hold", { prop: "cap", hand: "R", at: [-0.1, 0, 0], over: 16 }], "Head"],
		["run, LeftArm, the other hand", [[0, "run", { to: [3, 4] }]], { joint: "LeftArm", of: "t", at: [0.05, 0.08, 0] }, [8, "hold", { prop: "cap", hand: "R", at: [-0.1, 0, 0], over: 12 }], "LeftArm"],
		["walk at heading 200, Spine2 front, hold L at", [[0, "walk", { to: [-1.5, -4] }]], { joint: "Spine2", of: "t", at: [0, 0, 0.16] }, [6, "hold", { prop: "cap", hand: "L", at: [0.1, 0, 0], over: 14 }], "Spine2"],
	];
	for (const [name, body, on, take, jn] of CASES) {
		const scene = { frames: 80, characters: [{ id: "t", at: [0, 0], heading: name.includes("200") ? 200 : 0 }], props: [{ id: "cap", size: [0.2, 0.08, 0.2], at: [0, 2, 0], moves: true }] };
		const r = build({ t: [...body, take, [40, "pose", { [take[2].hand]: [-0.3, 0.3, 0.3], over: 16 }]], cap: [[0, "ride", on]] }, scene);
		const f = r.aux.holders.cap.findIndex(Boolean), step = g => dist(prop(r.parsed, "cap", g).c, prop(r.parsed, "cap", g - 1).c), jstep = dist(joint(r.parsed, "t", f, jn).c, joint(r.parsed, "t", f - 1, jn).c);
		assert.ok(jstep > 0.03, `${name}: the body moves on the take frame (${mm(jstep)} mm)`);
		assert.ok(step(f) > 0.75 * jstep, `${name}: on the take frame f${f} the cap goes on with the ${jn} (${mm(step(f))} mm against ${mm(jstep)} mm)`);
		console.log(`ok take off, ${name}: f${f} cap ${mm(step(f))} mm, ${jn} ${mm(jstep)} mm`);
	}
	// a rider on a rider: the hand takes the pin off the hat on a walking head
	const scene = { frames: 80, characters: [{ id: "t", at: [0, 0], heading: 0 }], props: [{ id: "hat", size: [0.3, 0.1, 0.3], at: [0, 2, 0], moves: true }, { id: "pin", size: [0.04, 0.04, 0.04], at: [0, 2.1, 0], moves: true }] };
	const r = build({ t: [[0, "walk", { to: [0, 5] }], [10, "hold", { prop: "pin", hand: "R", at: [-0.03, 0, 0], over: 14 }]], hat: [[0, "ride", { joint: "Head", of: "t", at: [0, 0.17, 0] }]], pin: [[0, "ride", { on: "hat", at: [-0.06, 0.07, 0.06] }]] }, scene);
	const f = r.aux.holders.pin.findIndex(Boolean), pin = dist(prop(r.parsed, "pin", f).c, prop(r.parsed, "pin", f - 1).c), hat = dist(prop(r.parsed, "hat", f).c, prop(r.parsed, "hat", f - 1).c);
	assert.ok(pin > 0.75 * hat && hat > 0.03, `the pin goes on with the hat on the take frame (${mm(pin)} mm against ${mm(hat)} mm)`);
	console.log(`ok take a rider off a rider: f${f} pin ${mm(pin)} mm, hat ${mm(hat)} mm`);
}

// --- 3. a ride that waits for the hands, and the row of one that never began ---
{
	const scene = { frames: 120, characters: [{ id: "u", at: [0, 0], heading: 0 }, { id: "v", at: [0.7, 0.5], heading: 270 }], props: [{ id: "box", size: [0.2, 0.2, 0.2], at: [0.3, 1.0, 0.3], moves: true }, { id: "crate", size: [0.4, 0.3, 0.3], at: [-0.8, 0.15, 0.6], moves: true }] };
	const walk = [80, "walk", { to: [0, 2] }];
	const BEGINS = { // name: [spec, the frame it begins]; a and b are the reviewer's
		"a. taken on the key's frame": [{ u: [[10, "hold", { prop: "box", hand: "R" }], [40, "release", { prop: "box" }], walk], box: [[10, "ride", { joint: "Head", of: "u" }]] }, 40],
		"b. taken over by another body": [{ u: [[0, "hold", { prop: "box", hand: "R", at: [-0.1, 0, 0], over: 8 }], [40, "release", { prop: "box", hand: "R" }], walk], v: [[20, "hold", { prop: "box", hand: "L", at: [0.1, 0, 0], over: 12 }], [70, "release", { prop: "box" }]], box: [[15, "ride", { joint: "Head", of: "u" }]] }, 70],
		"d. both hands of one body, on a prop": [{ u: [[0, "hold", { prop: "box", hand: "both", over: 10 }], [50, "release", { prop: "box", hand: "L" }], [64, "release", { prop: "box" }]], box: [[20, "ride", { on: "crate" }]], crate: [[30, "move", { to: [-0.8, 0.15, 1.6], over: 60 }]] }, 64],
		"e. taken on the key's frame by both bodies": [{ u: [[25, "hold", { prop: "box", hand: "R" }], [55, "release", { prop: "box" }]], v: [[25, "hold", { prop: "box", hand: "L", at: [0.1, 0, 0] }], [45, "release", { prop: "box" }]], box: [[25, "ride", { joint: "Spine2", of: "v" }]] }, 55],
	};
	for (const [name, [spec, at]] of Object.entries(BEGINS)) {
		const r = build(spec, scene), ride = r.aux.rides[0];
		assert.equal(r.aux.holders.box[at - 1] != null && r.aux.holders.box[at] == null, true, `${name}: the last hand lets go on f${at}`);
		assert.equal(ride.began, at, `${name}: the ride begins on the first frame no hand holds the box (began ${ride.began})`);
		assert.equal(r.rows.find(x => x.key.startsWith("ride:box")), undefined, `${name}: no ride row`);
		console.log(`ok ${name}: the ride begins on f${at}`);
	}
	const NEVER = { // name: [spec, the note]; c is the reviewer's
		"c. a move key on the same frame": [{ u: [walk], box: [[10, "ride", { joint: "Head", of: "u" }], [10, "move", { to: [1, 1, 1], over: 10 }]] }, "the move key of box on that frame is written after it and drives box"],
		"f. a tip key on the same frame, on a prop": [{ box: [[30, "ride", { on: "crate" }], [30, "tip", { pivot: [0.3, 0.9, 0.3], axis: [1, 0, 0], deg: 30, over: 10 }]] }, "the tip key of box on that frame is written after it and drives box"],
		"g. held to the next key by two bodies": [{ u: [[0, "hold", { prop: "box", hand: "R", at: [-0.1, 0, 0], over: 8 }]], v: [[20, "hold", { prop: "box", hand: "L", at: [0.1, 0, 0], over: 12 }]], box: [[15, "ride", { joint: "Head", of: "u" }], [90, "move", { to: [0, 1, 0], over: 10 }]] },
			"who held it from that frame to its next key at f90: u:R f15-31, u:R+v:L f32-89"],
		"h. held to the last frame": [{ u: [[0, "hold", { prop: "box", hand: "R" }]], box: [[10, "ride", { on: "crate" }]] }, "who held it from that frame to the last frame: u f10-119"],
	};
	for (const [name, [spec, note]] of Object.entries(NEVER)) {
		const r = build(spec, scene), ride = r.aux.rides[0], row = r.rows.find(x => x.key === `ride:box:${ride.f}`);
		assert.equal(ride.began, null, `${name}: the ride never begins`);
		assert.equal(row?.note, note, `${name}: the row tells what the clip shows (${row?.note})`);
		const held = /^who held/.test(note), end = ride.next ?? scene.frames;
		if (held) for (let f = ride.f; f < end; f++) assert.ok(r.aux.holders.box[f], `${name}: a hand holds the box on f${f}, as the row says`);
		console.log(`ok ${name}: "${row.label}: ${row.value} ${row.unit} (${row.note})"`);
	}
}

// --- 4. carry keeps the heading the ride gave it ---
{
	const behind = (h, d) => [-Math.sin(h * Math.PI / 180) * d, -Math.cos(h * Math.PI / 180) * d];
	const CASES = [];
	for (const heading of [120, -70]) CASES.push([`pack on u's Spine2 at heading ${heading}, v carries it`, "pack", 40,
		{ frames: 80, characters: [{ id: "u", at: [0, 0], heading }, { id: "v", at: behind(heading, 0.6), heading }], props: [{ id: "pack", size: [0.3, 0.4, 0.16], at: [0, 1.3, -0.18], moves: true }] },
		{ u: [[0, "idle", {}]], v: [[10, "pose", { hands: { prop: "pack" }, over: 20 }], [40, "carry", { prop: "pack" }]], pack: [[0, "ride", { joint: "Spine2", of: "u", at: [0, -0.02, -0.16] }]] }]);
	CASES.push(["tray on own Hips after a turn to 200, own carry", "tray", 40, { frames: 80, characters: [{ id: "u", at: [0, 0], heading: 0 }], props: [{ id: "tray", size: [0.3, 0.05, 0.2], at: [0, 1, 0.3], moves: true }] },
		{ u: [[0, "turn", { heading: 200 }], [20, "pose", { hands: { prop: "tray" }, over: 16 }], [40, "carry", { prop: "tray" }]], tray: [[0, "ride", { joint: "Hips", of: "u", at: [0, 0.05, 0.3] }]] }]);
	CASES.push(["a can on a plank a key turned 50, carried", "can", 56, { frames: 100, characters: [{ id: "p", at: [0, 0], heading: 90 }], props: [{ id: "plank", size: [0.6, 0.04, 0.2], at: [0.5, 0.9, 0], moves: true }, { id: "can", size: [0.08, 0.12, 0.08], at: [0.5, 0.98, 0], moves: true }] },
		{ p: [[40, "pose", { hands: { prop: "can" }, over: 14 }], [56, "carry", { prop: "can" }]], plank: [[0, "move", { to: [0.5, 1.0, 0.1], axis: [0, 1, 0], deg: 50, over: 30 }]], can: [[0, "ride", { on: "plank" }]] }]);
	for (const [name, id, f, scene, spec] of CASES) {
		const r = build(spec, scene), h = g => yaw(prop(r.parsed, id, g).q), turn = Math.abs(wrap(h(f) - h(f - 1)) - wrap(h(f - 1) - h(f - 2)));
		assert.ok(turn < 1, `${name}: the ${id} turns on the carry frame as on the frame before (${turn.toFixed(2)} deg more)`);
		console.log(`ok carry, ${name}: heading ${yaw(prop(r.parsed, id, f - 1).q).toFixed(1)} -> ${yaw(prop(r.parsed, id, f).q).toFixed(1)} deg`);
	}
	// carry then place: it is put down at the heading it was carried at
	const scene = { frames: 120, characters: [{ id: "u", at: [0, 0], heading: 0 }], props: [{ id: "tray", size: [0.3, 0.05, 0.2], at: [0, 1, 0.3], moves: true }] };
	const r = build({ u: [[0, "turn", { heading: 90 }], [20, "pose", { hands: { prop: "tray" }, over: 16 }], [40, "carry", { prop: "tray" }], [70, "place", { prop: "tray", at: [0.45, 0.8, 0], over: 16 }]], tray: [[0, "ride", { joint: "Hips", of: "u", at: [0, 0.05, 0.3] }]] }, scene);
	const end = yaw(prop(r.parsed, "tray", 119).q), was = yaw(prop(r.parsed, "tray", 39).q);
	assert.ok(Math.abs(wrap(end - was)) < 2, `carry then place: the tray ends at the heading it rode at (${was.toFixed(1)} -> ${end.toFixed(1)} deg)`);
	console.log(`ok carry then place: heading ${was.toFixed(1)} on the hips, ${end.toFixed(1)} on the place`);
}

// --- 5. axis and deg only with at ---
{
	const scene = { frames: 40, characters: [{ id: "u", at: [0, 0], heading: 0 }], props: [{ id: "box", size: [0.2, 0.1, 0.3], at: [0, 1.9, 0], moves: true }, { id: "post", size: [0.2, 1, 0.2], at: [1, 0.5, 1] }] };
	const refused = /box ride at frame 0: axis and deg turn the prop on its at; without at it keeps the turn it has when the ride begins/;
	for (const ride of [{ joint: "Head", of: "u", axis: [0, 1, 0], deg: 90 }, { on: "post", axis: [0, 1, 0], deg: 90 }, { joint: "LeftHand", of: "u", axis: [1, 0, 0], deg: -30 }])
		assert.throws(() => build({ box: [[0, "ride", ride]] }, scene), refused, `axis and deg without at are refused: ${JSON.stringify(ride)}`);
	for (const ride of [{ on: "post", axis: [0, 1, 0] }, { joint: "Head", of: "u", at: [0, 0.2, 0], axis: [0, 0, 1] }])
		assert.throws(() => build({ box: [[0, "ride", ride]] }, scene), /deg wants a number and axis/, `axis without deg is refused: ${JSON.stringify(ride)}`);
	const a = build({ box: [[0, "ride", { on: "post", at: [0, 0.55, 0], axis: [0, 1, 0], deg: 90 }]] }, scene), b = build({ box: [[0, "ride", { on: "post", at: [0, 0.55, 0] }]] }, scene);
	const d = qMul(conj(prop(b.parsed, "box", 20).q), prop(a.parsed, "box", 20).q), deg = 2 * Math.asin(Math.min(1, Math.hypot(d[0], d[1], d[2]))) * 180 / Math.PI;
	assert.ok(Math.abs(deg - 90) < 0.01, `with at the turn is applied (${deg.toFixed(2)} deg)`);
	console.log(`ok axis and deg: refused without at (3 forms) and without deg (2 forms); with at the box turns ${deg.toFixed(2)} deg`);
}
console.log("PASS verify-ride-repairs");
