#!/usr/bin/env node
// ride {joint, of, at?, axis?, deg?} (src/lowvis/engine-simple/ride.js): a prop keeps a place and turn on a joint of a
// character's body, however the body moves.
//  1. Props of different sizes on six joints of three bodies (one of scale 1.3) that walk, bow, turn and nod the head,
//     tilt, sit and lie: on every frame each is within 1 mm and 0.5 deg of its place in the joint's frame; without at it
//     keeps the place it had when the ride began. A prop riding on one of them goes with it; a hand target on one of
//     them stays on it. The clip is the same with the characters and the props listed in another order.
//  2. A hand takes the prop off the head and puts it back: the ride ends at the take, a ride written while it is held
//     begins at the let-go.
//  3. The engine's errors and the rows the writer is told (a ride that never began, a jump onto its place).
// Every scene here is made up for this test.
import assert from "node:assert/strict";
import { buildClip } from "../../src/lowvis/engine-simple/engine.js";
import { serializeClip } from "../../src/lowvis/clip.js";
import { INDEX as J, JOINT_COUNT, qAxisAngle, qMul, qRotate } from "../../src/lowvis/rig17.js";
import { measure } from "../../src/lowvis/pi/measure.mjs";

const build = (spec, scene) => { const b = buildClip(structuredClone({ demo: "x", ...spec }), scene); return { ...b, parsed: JSON.parse(serializeClip(b.clip)) }; };
const jointAt = (clip, id, f, j) => { const c = clip.characters.find(ch => ch.id === id), i = (f * JOINT_COUNT + j) * 3, k = (f * JOINT_COUNT + j) * 4; return { c: [c.pos[i], c.pos[i + 1], c.pos[i + 2]], q: [c.quat[k], c.quat[k + 1], c.quat[k + 2], c.quat[k + 3]] }; };
const prop = (clip, id, f) => { const p = clip.props.find(q => q.id === id), i = p.pos.length === 3 ? 0 : f; return { c: Array.from(p.pos.slice(i * 3, i * 3 + 3)), q: Array.from(p.quat.slice(i * 4, i * 4 + 4)) }; };
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const angle = (a, b) => { const d = qMul([-a[0], -a[1], -a[2], a[3]], b); return 2 * Math.asin(Math.min(1, Math.hypot(d[0], d[1], d[2]))) * 180 / Math.PI; }; // well conditioned near 0 (the clip rounds to 1e-5)
const rad = d => d * Math.PI / 180;
const NONE = [0, 0, 0, 1];
/** The worst distance (m) and turn (deg) of prop id from its place { c, q } on a carrier, over frames a..b; carrier(f) = { c, q }. */
function worst(clip, id, carrier, place, a, b) {
	let d = 0, t = 0;
	for (let f = a; f <= b; f++) {
		const car = carrier(f), p = prop(clip, id, f), o = qRotate(car.q, place.c);
		d = Math.max(d, dist(p.c, [car.c[0] + o[0], car.c[1] + o[1], car.c[2] + o[2]])); t = Math.max(t, angle(p.q, qMul(car.q, place.q)));
	}
	return { d, t };
}

// --- 1. six joints, three bodies ---
const SCENE = {
	frames: 220,
	characters: [{ id: "w", at: [0, 0], heading: 0 }, { id: "s", at: [2.2, 0.6], heading: 180, scale: 1.3 }, { id: "h", at: [-0.1, 2.35], heading: 0 }],
	props: [
		{ id: "bench", size: [0.5, 0.55, 0.5], at: [2.2, 0.275, 0.05] }, { id: "mat", size: [0.9, 0.1, 2.4], at: [3.6, 0.05, 1.0] },
		{ id: "cap", size: [0.22, 0.1, 0.25], at: [0, 2, 0], moves: true }, { id: "pack", size: [0.3, 0.42, 0.16], at: [0, 1, -0.5], moves: true },
		{ id: "pouch", size: [0.12, 0.1, 0.06], at: [0.5, 1, 0], moves: true }, { id: "pin", size: [0.04, 0.04, 0.02], at: [0, 2.2, 0], moves: true },
		{ id: "pad", size: [0.14, 0.06, 0.16], at: [2.5, 1.9, 0.6], moves: true }, { id: "band", size: [0.1, 0.08, 0.1], at: [2.1, 0.7, 0.6], moves: true },
		{ id: "lamp", size: [0.08, 0.08, 0.08], at: [2.2, 2.35, 0.62], moves: true },
	],
};
const SPEC = {
	w: [[0, "walk", { to: [0, 3] }], [70, "pose", { bow: 45, over: 20 }], [96, "pose", { bow: 0, look: [3, 1.6, 6], nod: 2, over: 30 }], [130, "pose", { look: "fwd", shake: 2, over: 20 }],
		[150, "turn", { heading: 120 }], [180, "pose", { tilt: [25, 15], over: 20 }]],
	s: [[0, "sit", { on: "bench", over: 30 }], [60, "pose", { lean: 20, look: [0, 1.6, 3], over: 20 }], [90, "stand", { over: 24 }], [120, "walk", { to: [3.6, 0.3], heading: 0 }], [170, "lie", { on: "mat", head: 0, over: 40 }]],
	h: [[100, "pose", { R: { on: "pack", at: [-0.08, 0.1, -0.08] }, over: 16 }], [140, "pose", { R: "rest", over: 16 }]],
	cap: [[0, "ride", { joint: "Head", of: "w", at: [0, 0.16, 0.02] }]],
	pack: [[0, "ride", { joint: "Spine2", of: "w", at: [0, -0.02, -0.16], axis: [1, 0, 0], deg: -8 }]],
	pouch: [[0, "ride", { joint: "Hips", of: "w", at: [0.17, 0, 0.04], axis: [0, 1, 0], deg: 30 }]],
	pin: [[0, "ride", { on: "cap", at: [0, 0.06, 0.05] }]],
	pad: [[0, "ride", { joint: "LeftArm", of: "s", at: [0.04, 0.07, 0] }]],
	band: [[0, "ride", { joint: "RightLeg", of: "s", at: [0, -0.08, 0.07], axis: [0, 0, 1], deg: 90 }]],
	lamp: [[0, "ride", { joint: "Head", of: "s" }]], // no at: the place it has on frame 0
};
const PLACES = {
	cap: ["w", "Head", { c: [0, 0.16, 0.02], q: NONE }], pack: ["w", "Spine2", { c: [0, -0.02, -0.16], q: qAxisAngle([1, 0, 0], rad(-8)) }],
	pouch: ["w", "Hips", { c: [0.17, 0, 0.04], q: qAxisAngle([0, 1, 0], rad(30)) }], pad: ["s", "LeftArm", { c: [0.04, 0.07, 0], q: NONE }],
	band: ["s", "RightLeg", { c: [0, -0.08, 0.07], q: qAxisAngle([0, 0, 1], rad(90)) }],
};
{
	const r = build(SPEC, SCENE), F = SCENE.frames;
	for (const [id, [who, name, place]] of Object.entries(PLACES)) {
		const w = worst(r.parsed, id, f => jointAt(r.parsed, who, f, J[name]), place, 0, F - 1);
		assert.ok(w.d < 0.001 && w.t < 0.5, `${id} on ${who}'s ${name}: within 1 mm and 0.5 deg of its place on every frame (worst ${(w.d * 1000).toFixed(3)} mm, ${w.t.toFixed(3)} deg)`);
	}
	const moved = id => dist(prop(r.parsed, id, 0).c, prop(r.parsed, id, F - 1).c);
	assert.ok(moved("cap") > 2.5 && moved("band") > 1, `the props travel with the bodies (cap ${moved("cap").toFixed(2)} m, band ${moved("band").toFixed(2)} m)`);
	// no at: the place on the joint as the body ended frame 0, and the prop is where the scene put it on frame 0
	const head = f => jointAt(r.parsed, "s", f, J.Head), h0 = head(0), l0 = prop(r.parsed, "lamp", 0);
	assert.ok(dist(l0.c, SCENE.props.find(p => p.id === "lamp").at) < 1e-4, "without at the prop starts where the scene put it");
	const lampPlace = { c: qRotate([-h0.q[0], -h0.q[1], -h0.q[2], h0.q[3]], l0.c.map((v, k) => v - h0.c[k])), q: qMul([-h0.q[0], -h0.q[1], -h0.q[2], h0.q[3]], l0.q) };
	const lw = worst(r.parsed, "lamp", head, lampPlace, 0, F - 1);
	assert.ok(lw.d < 0.001 && lw.t < 0.5, `lamp without at keeps its frame-0 place on s's Head (worst ${(lw.d * 1000).toFixed(3)} mm, ${lw.t.toFixed(3)} deg)`);
	// a prop riding on a prop that rides on a body
	const pin = worst(r.parsed, "pin", f => prop(r.parsed, "cap", f), { c: [0, 0.06, 0.05], q: NONE }, 0, F - 1);
	assert.ok(pin.d < 0.001 && pin.t < 0.5, `pin rides on the cap (worst ${(pin.d * 1000).toFixed(3)} mm)`);
	// a hand target on a prop that rides on a body: the reach entry measures it against the prop as it ended each frame
	const reach = r.aux.reach.h.slice(120, 140).map(e => e[1]?.d ?? Infinity), hand = Math.max(...reach);
	assert.ok(hand < 0.01, `h's right hand stays on its place on the pack while w nods and shakes its head (worst ${(hand * 1000).toFixed(1)} mm)`);
	const rows = measure(r.parsed, r.aux).filter(x => x.key.startsWith("ride:"));
	assert.deepEqual(rows, [], "rides that began at frame 0 and were kept have no row");
	console.log(`ok six joints: cap, pack, pouch, pad, band and lamp within 1 mm and 0.5 deg on all ${F} frames; pin on the cap; h's hand on the pack ${(hand * 1000).toFixed(1)} mm`);

	// another order of the characters and of the props: the same clip
	const other = build(SPEC, { ...SCENE, characters: SCENE.characters.slice().reverse(), props: SCENE.props.slice().reverse() });
	for (const p of r.parsed.props) assert.deepEqual(other.parsed.props.find(q => q.id === p.id).pos, p.pos, `${p.id}: the same track with the scene listed in another order`);
	for (const c of r.parsed.characters) assert.deepEqual(other.parsed.characters.find(q => q.id === c.id).pos, c.pos, `${c.id}: the same body with the scene listed in another order`);
	console.log("ok order: characters and props listed the other way round give the same clip");
}

// --- 2. take the cap off the head and put it back ---
{
	const scene = { frames: 160, characters: [{ id: "t", at: [0, 0], heading: 30 }], props: [{ id: "cap", size: [0.22, 0.1, 0.25], at: [0, 0, 0], moves: true }] };
	const AT = [0, 0.16, 0.02], GRIP = [-0.13, 0, 0];
	const spec = put => ({
		t: [[0, "walk", { to: [0.5, 0.8] }], [40, "hold", { prop: "cap", hand: "R", at: GRIP, over: 16 }], [60, "pose", { R: [-0.25, 0.25, 0.4], over: 18 }],
			[90, "pose", { R: { joint: "Head", at: [AT[0] + GRIP[0], AT[1] + GRIP[1], AT[2] + GRIP[2]] }, over: 18 }], [112, "release", { prop: "cap" }], [116, "pose", { R: "rest", over: 16 }], [132, "walk", { to: [0.5, 1.6] }]],
		cap: [[0, "ride", { joint: "Head", of: "t", at: AT }], [95, "ride", { joint: "Head", of: "t", ...put }]],
	});
	for (const put of [{ at: AT }, {}]) {
		const r = build(spec(put), scene), head = f => jointAt(r.parsed, "t", f, J.Head), place = { c: AT, q: NONE };
		const on = worst(r.parsed, "cap", head, place, 0, 55), off = worst(r.parsed, "cap", head, place, 70, 85);
		assert.ok(on.d < 0.001 && on.t < 0.5, `on the head until the hand takes it at f56 (worst ${(on.d * 1000).toFixed(3)} mm)`);
		assert.ok(off.d > 0.1, `in the hand it is off the head (${off.d.toFixed(2)} m)`);
		// with at it goes from where the hand let it go to its place over the ride's over (12 frames)
		const kept = r.aux.rides.find(x => x.f === 95), back = put.at ? place : kept.rel, again = worst(r.parsed, "cap", head, back, put.at ? 124 : 112, 159), going = worst(r.parsed, "cap", head, back, 112, 123);
		assert.equal(kept.began, 112, "the ride written while the hand holds it begins at the let-go");
		assert.ok(again.d < 0.001 && again.t < 0.5, `back on the head from the let-go on, through the walk (worst ${(again.d * 1000).toFixed(3)} mm)`);
		assert.ok(going.d < 0.002, `from the let-go it is no farther from its place than the hand left it (${(going.d * 1000).toFixed(3)} mm)`);
		const jump = measure(r.parsed, r.aux).find(x => x.key === "ride:cap:95");
		// the hand brought it to its place on the head, so it does not jump there (a row only past 5 mm or 2 deg)
		assert.equal(jump, undefined, `put back where its place is: no jump, no row (${jump?.value.toFixed(1)} mm)`);
		console.log(`ok take and put back ${put.at ? "with at" : "without at"}: on the head to f55, in the hand, again on it from f${put.at ? "124 (on its way from f112: within " + (going.d * 1000).toFixed(3) + " mm)" : 112} (worst ${(again.d * 1000).toFixed(3)} mm)${jump ? `; row: ${jump.label}: ${jump.value.toFixed(1)} mm` : ""}`);
	}
}

// --- 3. errors and rows ---
{
	const scene = { frames: 60, characters: [{ id: "u", at: [0, 0], heading: 0 }], props: [{ id: "box", size: [0.2, 0.2, 0.2], at: [0.6, 0.1, 0], moves: true }, { id: "tag", size: [0.05, 0.05, 0.05], at: [0.6, 0.3, 0], moves: true }] };
	const fails = (ride, re, why) => assert.throws(() => build({ box: [[0, "ride", ride]] }, scene), re, why);
	fails({ joint: "Hat", of: "u" }, /box ride at frame 0: unknown joint "Hat"; want one of Hips, /, "an unknown joint is refused with the names");
	fails({ joint: "Head", of: "v" }, /\{joint, of\} wants a character id, got "v"; characters: u/, "an unknown character is refused with the ids");
	fails({ joint: "Head" }, /\{joint, of\} wants a character id, got undefined/, "a joint ride needs of");
	fails({ joint: "Head", of: "u", on: "tag" }, /not both/, "a joint and a prop at once are refused");
	fails({ joint: "Head", of: "u", at: [0, 1] }, /at wants \[x, y, z\]/, "a wrong at is refused");
	fails({ joint: "Head", of: "u", deg: 20 }, /deg wants a number and axis/, "deg without axis is refused");
	assert.throws(() => build({ box: [[0, "ride", { joint: "Head", of: "u" }]] }, { ...scene, props: scene.props.map(p => ({ ...p, moves: false })) }), /box rides on u's Head but has no moves: true in the scene/, "a prop that does not move cannot ride");
	// held from the key to the end: the ride never began
	const held = build({ u: [[0, "hold", { prop: "box", hand: "R" }]], box: [[10, "ride", { joint: "Head", of: "u" }]] }, scene);
	const never = measure(held.parsed, held.aux).find(x => x.key === "ride:box:10");
	assert.ok(never && never.label === "ride: box never rode on u's Head, the key at f10" && never.value === 50 && never.note === "who held it from that frame to the last frame: u f10-59", `a ride that never began is a row (${never && `${never.label}: ${never.value} ${never.unit} (${never.note})`})`);
	fails({ joint: "Head", of: "u", over: -2 }, /over wants a count of frames, 0 or more, got -2/, "a negative over is refused");
	fails({ joint: "Head", of: "u", ease: "soft" }, /ease wants one of linear, inout/, "an unknown ease is refused");
	// a ride with at that begins 1.2 m away from its place: over 0 the jump is a row on its first frame; by default it
	// goes there over 12 frames, and its fastest frame is the row
	const jumped = build({ u: [[0, "walk", { to: [0, 1] }]], tag: [[20, "ride", { joint: "Spine2", of: "u", at: [0, 0, -0.12], over: 0 }]] }, scene);
	const jump = measure(jumped.parsed, jumped.aux).find(x => x.key === "ride:tag:20");
	assert.ok(jump && jump.frame === 20 && jump.value > 1000 && jump.short === "ride jump" && jump.spike === 10, `the jump onto the place is a row (${jump && `${jump.label}: ${jump.value.toFixed(0)} mm @f${jump.frame} (${jump.note})`})`);
	const went = build({ u: [[0, "walk", { to: [0, 1] }]], tag: [[20, "ride", { joint: "Spine2", of: "u", at: [0, 0, -0.12] }]] }, scene), way = measure(went.parsed, went.aux).find(x => x.key === "ride:tag:20");
	assert.ok(way && way.frame > 20 && way.frame < 32 && way.value < 160 && way.value > 100 && / over 12 frames$/.test(way.note), `over 12 frames the fastest frame is the row (${way && `${way.value.toFixed(0)} mm @f${way.frame} (${way.note})`})`);
	console.log(`ok errors: unknown joint, unknown or missing character, joint and prop at once, bad at, deg without axis, no moves; rows: "${never.label}" and "${jump.label}: ${jump.value.toFixed(0)} mm"`);
}
console.log("PASS verify-ride-joint");
