#!/usr/bin/env node
// Where a motion's bodies meet the objects it uses (src/lowvis/studio/contacts.js): contact rows read from the clip and
// the engine's ties, their places in each object's own frame, the probes a gap measure reads, and the gap rows. Bodies
// here stand in the rest pose (arms out, hands at x = +-0.71..0.9 m, 1.44 m high), moved and sized per frame.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fk, qAxisAngle, qRotate } from "../../src/lowvis/rig17.js";
import { auxOf, contactLine, contactsOf, gapLine, gapsOf, probesOf } from "../../src/lowvis/studio/contacts.js";
import { prop as boxAt, stage, written } from "./studio-draft-harness.mjs";

const F = 24, REST = fk([0, 0, 0]);
const yawQ = deg => qAxisAngle([0, 1, 0], (deg * Math.PI) / 180);
/** A body in the rest pose: at(f) -> [x, y, z] of its Hips at body size s (the hips 1.043 m x s over the soles), turned yaw(f) degrees. */
function body(id, at, s = 1, yaw = () => 0) {
	const pos = [], quat = [];
	for (let f = 0; f < F; f++) for (let j = 0; j < 17; j++) { const h = at(f), q = yawQ(yaw(f)); pos.push(...qRotate(q, REST.pos[j]).map((v, k) => h[k] + v * s)); quat.push(...q); }
	return { id, ...(s === 1 ? {} : { scale: s }), pos, quat };
}
/** A box prop: centre(f), turn(f) about Y (degrees), shown (optional, per frame). */
function prop(id, size, centre, turn = () => 0, shown = null) {
	const moves = [0, F - 1].some(f => JSON.stringify([centre(f), turn(f)]) !== JSON.stringify([centre(0), turn(0)])), n = moves ? F : 1, pos = [], quat = [];
	for (let f = 0; f < n; f++) { pos.push(...centre(f)); quat.push(...qAxisAngle([0, 1, 0], (turn(f) * Math.PI) / 180)); }
	return { id, size, pos, quat, ...(shown ? { shown } : {}) };
}
const clipOf = (characters, props) => ({ frameCount: F, characters, props });
const parts = rows => rows.map(r => `${r.who} ${r.part} ${r.from}-${r.to}`).sort();
const still = v => () => v;

// --- one hand, both hands, a seat, the feet, several bodies; none ---
{
	// a table top under the right hand (its palm 1.44 m high, the top 1.43 m): only that hand meets it
	const one = contactsOf(clipOf([body("a", still([0, 1.043, 0]))], [prop("table", [0.6, 0.4, 0.6], still([-0.8, 1.23, 0]))]));
	assert.deepEqual(parts(one.get("table")), ["a right hand 0-23"]);
	assert.deepEqual(one.get("table")[0].at, [-0.01, 0.41, -0.07], "the hand's middle in the table's frame: from the middle of its underside");
	// a long bar both hands lie on; a seat 0.13 m under the Hips; a deck under the soles
	const both = contactsOf(clipOf([body("a", still([0, 1.043, 0]))], [prop("bar", [2, 0.04, 0.2], still([0, 1.42, -0.05]))]));
	assert.deepEqual(parts(both.get("bar")), ["a left hand 0-23", "a right hand 0-23"]);
	const seat = contactsOf(clipOf([body("a", still([0, 0.58, 0]))], [prop("stool", [0.4, 0.45, 0.4], still([0, 0.225, 0]))]));
	assert.deepEqual(parts(seat.get("stool")).filter(p => p.includes("seat")), ["a seat 0-23"]);
	assert.deepEqual(seat.get("stool").find(r => r.part === "seat").at, [0, 0.45, 0], "the seat on the stool's top");
	const deck = contactsOf(clipOf([body("a", still([0, 1.243, 0]))], [prop("deck", [1, 0.2, 1], still([0, 0.1, 0]))]));
	assert.deepEqual(parts(deck.get("deck")), ["a left foot 0-23", "a right foot 0-23"]);
	const two = contactsOf(clipOf([body("a", still([0, 1.043, 0])), body("b", still([0, 1.043, 0.5]))], [prop("rail", [2, 0.04, 1], still([0, 1.42, 0.2]))]));
	assert.deepEqual(parts(two.get("rail")), ["a left hand 0-23", "a right hand 0-23", "b left hand 0-23", "b right hand 0-23"]);
	assert.equal(contactsOf(clipOf([body("a", still([0, 1.043, 0]))], [prop("crate", [0.5, 0.5, 0.5], still([3, 0.25, 0]))])).size, 0, "no contact: no row");
	console.log("PASS rows: one hand, both, a seat, the feet, two bodies; a box no body meets has none");
}

// --- a hand near a box for 3 frames is a contact, for 2 it is not; a tie counts on any frame ---
{
	const visit = n => body("a", f => [0, 1.043, f >= 10 && f < 10 + n ? 0 : 1]);
	const box = () => prop("post", [0.2, 1.42, 0.2], still([-0.8, 0.71, 0]));
	assert.deepEqual(parts(contactsOf(clipOf([visit(3)], [box()])).get("post")), ["a right hand 10-12"]);
	assert.equal(contactsOf(clipOf([visit(2)], [box()])).size, 0);
	const aux = { reach: { a: Array.from({ length: F }, (_, f) => (f === 5 ? [null, { on: "post", d: 0.2 }] : [])) } };
	assert.deepEqual(parts(contactsOf(clipOf([visit(0)], [box()]), aux).get("post")), ["a right hand 5-5"], "a hand the engine aims at the box on one frame");
	console.log("PASS spans: 3 frames near is a contact, 2 are not; a target on the box counts on its frame");
}

// --- an object that moves and turns, rides a joint, is hidden part of the time; held by the engine ---
{
	// a cup the right hand holds while the body walks and turns, the cup with it: one place in the cup's frame
	const walk = f => [f * 0.05, 1.043, 0], turn = f => f * 4, mid = [-0.809, 0.398, -0.071];
	const cup = prop("cup", [0.08, 0.1, 0.08], f => qRotate(yawQ(turn(f)), mid).map((v, k) => v + walk(f)[k]), turn);
	const grips = { cup: Array.from({ length: F }, () => ({ c: "a", hand: 1 })) }, holders = { cup: Array.from({ length: F }, () => "a") };
	const clip = clipOf([body("a", walk, 1, turn)], [cup]), held = contactsOf(clip, { grips, holders }).get("cup");
	assert.deepEqual(parts(held), ["a right hand 0-23"]);
	assert.equal(held[0].tied, true);
	const probes = probesOf(clip, "cup", held), first = probes.parts[0].local;
	assert.equal(probes.parts.length, 5, "five frames sampled");
	assert.ok(probes.parts.every(p => p.local.every((l, i) => Math.hypot(...l.map((v, k) => v - first[i][k])) < 1e-6)), "the hand keeps its place in the cup's own frame while both move and turn");
	assert.ok(probes.parts.some(p => Math.hypot(...p.world[0].map((v, k) => v - probes.parts[0].world[0][k])) > 0.5), "while it moves in the world");
	// a pack one joint carries, and a box hidden on frames 8-15
	const pack = contactsOf(clipOf([body("a", still([0, 1.043, 0]))], [prop("pack", [0.3, 0.4, 0.15], still([0, 1.3, -0.15]))]), { rides: [{ prop: "pack", f: 0, joint: "Spine2", of: "a", next: null, began: 0 }] }).get("pack");
	assert.deepEqual(parts(pack), ["a Spine2 0-23"]);
	// a ride that waited for a hand to let go (began 10) and was taken off by a hand at 20: carried on frames 10-19 only
	const inHand = Array.from({ length: F }, (_, f) => (f < 10 || f >= 20 ? "a" : null));
	assert.deepEqual(parts(contactsOf(clipOf([body("a", still([0, 1.043, 0]))], [prop("pack", [0.3, 0.4, 0.15], still([0, 1.3, -0.15]))]), { rides: [{ prop: "pack", f: 0, joint: "Spine2", of: "a", next: null, began: 10 }], holders: { pack: inHand } }).get("pack").filter(r => r.part === "Spine2")), ["a Spine2 10-19"]);
	const shown = Array.from({ length: F }, (_, f) => (f >= 8 && f < 16 ? 0 : 1));
	const hidden = contactsOf(clipOf([body("a", still([0, 1.043, 0]))], [prop("table", [0.6, 0.4, 0.6], still([-0.8, 1.23, 0]), () => 0, shown)])).get("table");
	assert.deepEqual(parts(hidden), ["a right hand 0-7", "a right hand 16-23"], "no contact on the frames it is not drawn");
	console.log("PASS objects: held while moving and turning (one place), carried on a joint, hidden part of the time");
}

// --- body sizes 0.5 and 3 ---
{
	for (const s of [0.5, 3]) {
		const hands = contactsOf(clipOf([body("a", still([0, 1.043 * s, 0]), s)], [prop("bar", [2.2 * s, 0.04, 0.2 * s], still([0, 1.42 * s, -0.05 * s]))]));
		assert.deepEqual(parts(hands.get("bar")), ["a left hand 0-23", "a right hand 0-23"], `hands at size ${s}`);
		const seat = contactsOf(clipOf([body("a", still([0, 0.45 + 0.13 * s, 0]), s)], [prop("stool", [0.4, 0.45, 0.4], still([0, 0.225, 0]))]));
		assert.ok(parts(seat.get("stool")).includes("a seat 0-23"), `a seat at size ${s}`);
	}
	console.log("PASS sizes: hands and a seat at body size 0.5 and 3");
}

// --- gap rows from measured distances; the lines ---
{
	const clip = clipOf([body("a", still([0, 0.58, 0]))], [prop("stool", [0.4, 0.45, 0.4], still([0, 0.225, 0]))]);
	const rows = contactsOf(clip).get("stool"), probes = probesOf(clip, "stool", rows), seatRow = rows.findIndex(r => r.part === "seat");
	const far = (d, pts) => pts.map(() => d), measured = top => ({ parts: probes.parts.map(p => far(0.01, p.local)), seats: probes.seats.map(() => top), inside: probes.inside.map(p => far(0.2, p.local)) });
	assert.deepEqual(gapsOf(rows, probes, measured(0.45)).gaps, [], "a seat on its drawn top: no gap");
	const floating = gapsOf(rows, probes, measured(0.35));
	assert.deepEqual(floating.gaps.map(g => g.text), [`a seat at [0, 0.45, 0] f0-23: floats 100 mm over the drawn surface under it`]);
	assert.equal(floating.within, rows.length - 1, "the other contacts are within");
	assert.match(gapsOf(rows, probes, measured(null)).gaps[0].text, /nothing drawn under it/);
	const sunk = { ...measured(0.45), inside: probes.inside.map((p, i) => (i === 0 ? p.local.map(() => -0.081) : far(0.2, p.local))) };
	assert.deepEqual(gapsOf(rows, probes, sunk).gaps.map(g => g.text), [`a legs 81 mm inside the drawn look at f${probes.inside[0].f}`]);
	const line = gapLine("stool (s1)", floating);
	assert.equal(line, "stool (s1), off the drawn look: a seat at [0, 0.45, 0] f0-23: floats 100 mm over the drawn surface under it");
	// a body group inside on one of its five sampled frames weighs a fifth of the frames the body meets the object
	const once = { ...measured(0.35), inside: probes.inside.map((p, i) => (i === 0 ? p.local.map(() => -0.3) : far(0.2, p.local))) }, ranked = gapsOf(rows, probes, once).gaps;
	assert.deepEqual(ranked.map(g => g.text.replace(/ at .*/, "")), ["a seat", "a legs 300 mm inside the drawn look"], "100 mm on 24 frames comes before 300 mm on one sampled frame of five");
	assert.ok(Math.abs(ranked[1].frames - 24 / 5) < 1e-9);
	const many = { gaps: [4, 3, 2, 1].map(k => ({ size: k, text: `g${k}` })), within: 2 };
	assert.equal(gapLine("bike (o2)", many), "bike (o2), off the drawn look: g4; g3; g2; 1 more; 2 contacts within 0.03 m", "at most three, the count of the rest and of those within");
	assert.equal(gapLine("stool (s1)", gapsOf(rows, probes, measured(0.45))), null);
	assert.match(contactLine("stool (s1)", rows), /^stool \(s1\), where bodies meet it: .*a seat at \[0, 0.45, 0\] f0-23/);
	assert.ok(seatRow >= 0);
	console.log("PASS gaps: a seat floating, nothing under it, legs inside; one line per object, worst first");
}

// --- free rows: a seated body's hand or foot the engine holds at a target on no object ---
{
	// a body sits on a box that moves and turns; the writer aims its hands at points of the body's own frame
	const keys = []; for (let f = 12, x = 0; f < 60; f += 6) { x += 0.3; keys.push([f, "move", { to: [x, 0.25, 0.1 * x * x], axis: [0, 1, 0], deg: 10 * x, over: 6, ease: "linear" }]); }
	const scene = stage([boxAt("ride", [0.5, 0.5, 1.4], [0, 0, 0], { moves: true })], 72), sit = [0, "sit", { on: "ride", over: 0 }];
	const rowsOf = (acts, withAux = true) => { const w = written(scene, { a1: [sit, ...acts], ride: keys }); return { clip: w.clip, rows: contactsOf(w.clip, withAux ? auxOf(w.scene, w.spec, w.clip) : null).get("ride") }; };
	const aimed = [0, "pose", { L: [0.25, 1.0, 0.4], R: [-0.25, 1.0, 0.4], over: 6 }], { clip, rows } = rowsOf([aimed]), free = rows.filter(r => r.free);
	assert.deepEqual(free.map(r => `${r.part} ${r.from}-${r.to} ${r.at}`).sort(), ["left hand 8-71 0.23,1.54,0.35", "right hand 8-71 -0.23,1.54,0.35"], "both hands, from the frame after the pose's blend, one place each in the box's frame while it moves and turns");
	assert.ok(rows.some(r => r.part === "seat" && !r.free) && rows.every(r => !r.free || !r.tied));
	const probes = probesOf(clip, "ride", rows), k = rows.indexOf(free[0]), off = probes.parts.filter(p => p.row === k).map(p => Math.hypot(...p.local[2].map((v, i) => v - free[0].at[i])));
	assert.ok(off.slice(1).every(d => d < 0.01) && off[0] < 0.15, `the row's place is the hand's on the sampled frames (its first frame is still on the way: ${off.map(d => d.toFixed(3))})`);
	assert.equal(contactLine("ride (o1)", rows), "ride (o1), where bodies meet it: a1 left foot at [0.08, 0, 0.07] f0-71; a1 right foot at [-0.08, 0, 0.07] f0-71; a1 seat at [0, 0.5, 0.02] f0-71; aimed at no object while the seat meets it: a1 left hand at [0.23, 1.54, 0.35] f8-71; a1 right hand at [-0.23, 1.54, 0.35] f8-71");
	// their gaps stand apart from the contacts' and do not count as contacts
	const far = (d, pts) => pts.map(() => d), found = gapsOf(rows, probes, { parts: probes.parts.map(p => far(rows[p.row].free ? 0.419 : 0.01, p.local)), seats: probes.seats.map(s => s.local[1] - s.up), inside: probes.inside.map(p => far(0.2, p.local)) });
	assert.deepEqual([found.gaps.length, found.within, found.free.length], [0, 3, 2]);
	assert.equal(gapLine("ride (o1)", found), "ride (o1), off the drawn look: aimed at no object while the seat meets it: a1 left hand at [0.23, 1.54, 0.35] f8-71: 419 mm from the drawn look; a1 right hand at [-0.23, 1.54, 0.35] f8-71: 419 mm from the drawn look");
	assert.equal(gapLine("ride (o1)", gapsOf(rows, probes, { parts: probes.parts.map(p => far(0.01, p.local)), seats: probes.seats.map(s => s.local[1] - s.up), inside: probes.inside.map(p => far(0.2, p.local)) })), null, "a drawn part at each: nothing told");
	// none: hands the writer did not aim (the sit's own: on the thighs), hands aimed on the box (contacts), a pose of 8
	// frames, no engine facts, and a hand on the body's own joint is one (the engine's facts do not tell it from a point)
	assert.equal(rowsOf([]).rows.some(r => r.free), false, "hands left to the sit");
	const on = rowsOf([[0, "pose", { L: { on: "ride", at: [0.2, 0.25, 0.5] }, R: { on: "ride", at: [-0.2, 0.25, 0.5] }, over: 6 }]]).rows;
	assert.ok(!on.some(r => r.free) && on.filter(r => r.part.endsWith("hand") && r.tied).length === 2, "hands aimed on the box are its contacts");
	assert.equal(rowsOf([[0, "pose", { L: [0.25, 1.0, 0.4], over: 4 }], [12, "pose", { L: "rest", over: 4 }]]).rows.some(r => r.free), false, "held for 8 frames");
	assert.equal(rowsOf([aimed], false).rows.some(r => r.free), false, "without the engine's facts");
	assert.deepEqual(rowsOf([[0, "pose", { L: { joint: "LeftLeg", at: [0, 0.05, 0] }, R: [-0.25, 1.0, 0.4], over: 6 }]]).rows.filter(r => r.free).map(r => r.part), ["right hand"], "a left hand on the own shin lies in this box: a contact; the right is free");
	// a body that stands by the box (no seat on it) has no free row, nor has a box only free rows would name
	const stand = written(stage([boxAt("post", [0.3, 1, 0.3], [0, 0, 1.5])], 48), { a1: [[0, "idle"], [0, "pose", { L: [0.25, 1.0, 0.4], R: [-0.25, 1.0, 0.4], over: 6 }]] });
	assert.equal(contactsOf(stand.clip, auxOf(stand.scene, stand.spec, stand.clip)).size, 0);
	console.log("PASS free rows: a seated body's aimed hands on no object, apart from the contacts; none for hands not aimed, on the box, held briefly, or without a seat");
}

// --- the engine's ties, read again from a compiled clip (auxOf) ---
{
	const { buildClip } = await import("../../src/lowvis/engine-simple/engine.js");
	const spec = JSON.parse(JSON.stringify((await import("../../src/lowvis/engine-simple/demos/object.js")).default)), scene = JSON.parse(readFileSync(new URL("../../public/lowvis/clips/simple/object.json", import.meta.url), "utf8"));
	const { DEMOS } = await import("../../src/lowvis/demos.js"), def = DEMOS.object;
	const { clip } = buildClip(structuredClone(spec), def), file = JSON.parse(JSON.stringify({ ...clip, characters: clip.characters.map(c => ({ ...c, pos: Array.from(c.pos), quat: Array.from(c.quat) })), props: clip.props.map(p => ({ ...p, pos: Array.from(p.pos), quat: Array.from(p.quat) })) }));
	const aux = auxOf(def, spec, file);
	assert.ok(aux?.grips && aux?.reach, "the same clip built again gives its aux");
	assert.equal(auxOf(def, { ...spec, a: spec.a.slice(0, 2) }, file), null, "another spec: not this clip's aux");
	const rows = contactsOf(file, aux).get("box");
	assert.ok(rows.some(r => r.who === "a" && r.part.endsWith("hand") && r.tied) && rows.some(r => r.who === "b" && r.part.endsWith("hand") && r.tied), "both carriers' hands meet the box");
	assert.ok(scene.frameCount > 0);
	console.log("PASS auxOf: the engine's ties of a compiled clip; another spec gives none");
}
