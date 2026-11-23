#!/usr/bin/env node
// Where a motion's bodies meet the objects it uses (src/lowvis/studio/contacts.js): contact rows read from the clip and
// the engine's ties, their places in each object's own frame, the probes a gap measure reads, and the gap rows. Bodies
// here stand in the rest pose (arms out, hands at x = +-0.71..0.9 m, 1.44 m high), moved and sized per frame.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fk, qAxisAngle, qRotate } from "../../src/lowvis/rig17.js";
import { auxOf, contactLine, contactsOf, gapLine, gapsOf, probesOf } from "../../src/lowvis/studio/contacts.js";

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
	const pack = contactsOf(clipOf([body("a", still([0, 1.043, 0]))], [prop("pack", [0.3, 0.4, 0.15], still([0, 1.3, -0.15]))]), { rides: [{ prop: "pack", f: 0, joint: "Spine2", of: "a", next: null }] }).get("pack");
	assert.deepEqual(parts(pack), ["a Spine2 0-23"]);
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
	const many = { gaps: [4, 3, 2, 1].map(k => ({ size: k, text: `g${k}` })), within: 2 };
	assert.equal(gapLine("bike (o2)", many), "bike (o2), off the drawn look: g4; g3; g2; 1 more; 2 contacts within 0.03 m", "at most three, the count of the rest and of those within");
	assert.equal(gapLine("stool (s1)", gapsOf(rows, probes, measured(0.45))), null);
	assert.match(contactLine("stool (s1)", rows), /^stool \(s1\), where bodies meet it: .*a seat at \[0, 0.45, 0\] f0-23/);
	assert.ok(seatRow >= 0);
	console.log("PASS gaps: a seat floating, nothing under it, legs inside; one line per object, worst first");
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
