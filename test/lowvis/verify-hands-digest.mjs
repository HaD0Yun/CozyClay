#!/usr/bin/env node
// A spec that uses none of the words for a prop's own axes (aim {x, y, z}), a prop riding on another (ride), a place
// on the own body ({joint}) or an elbow target (elbowL / elbowR) compiles to exactly the clip and the aux it compiled
// to before those words: sha256 of every engine demo's serialized clip and aux, taken at the commit before them.
// The one note that changed with them (notes.js, stored in every clip) is put back to its old text before hashing.
// The aux numbers are rounded to 5 decimals (10 µm), as serializeClip rounds the clip: arm64 and x86_64 differ in the
// last bit of some doubles (aux.reach distances near 0 differ by up to 5e-16 m), which raw doubles would hash apart.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { buildClip } from "../../src/lowvis/engine-simple/engine.js";
import { serializeClip } from "../../src/lowvis/clip.js";
import { DEMO_IDS } from "../../src/lowvis/demos.js";
import { NOTES } from "../../src/lowvis/engine-simple/notes.js";

const OLD_NOTE = "elbow and knee directions come from one fixed pole hint; there is no hands-on-hips or crossed-arms pose";
const NEW_NOTE = "knee directions come from one fixed pole hint; an elbow's too unless pose elbowL / elbowR gives it a target";
assert.ok(NOTES.includes(NEW_NOTE), "the clip's notes say that an elbow can be given a target");
// the note that changed with a prop held by several hands (share.js) goes back to its old text too
const OLD_HELD = "a prop in one hand is held by that hand only (no second hand on the grip); its long axis must be its z axis";
const NEW_HELD = "a held prop has no weight and pulls no body: it goes where the hands that hold it put it; a prop fixed in one hand has its long axis along its z axis";
assert.ok(NOTES.includes(NEW_HELD), "the clip's notes say what a prop held by several hands does");

const BEFORE = {
	locomotion: "4b102ce748c4e84499e261466067abbde83b27c9a4becd9f80d39b888f21a016",
	sit: "1da2ec2bfab4cd8e9764ad743f8d1d145feff0fe01d2713dbf3da69e2c05f025",
	object: "1fe85de78b73151338ec0ebd65f534670d4aa2e40590ab00a2018423ce4487d0",
	duo: "b1cc640c4fd6b8a7c98b0998ac5a5c4ce8f2ab1050ddfda9f144323034d7cb52",
	push: "d9d3dc233b49abf2d85d1a58aa06717be028f079fb56ac132e0eeab6aa977e84",
	chop: "096f46dec760c8155a8ffdb48754482d3614d8cd95de51abb176f825d0ca68e7",
	bowl: "f3fec6e7daaa40a96e4ee747784b2170bbab070a77f9d505f361b2e2a811143b",
};
const round5 = (_, v) => (typeof v === "number" ? Math.round(v * 1e5) / 1e5 : v);
const now = {};
for (const demo of DEMO_IDS) {
	const { default: spec } = await import(`../../src/lowvis/engine-simple/demos/${demo}.js`);
	const { clip, aux: { seats, ...aux } } = buildClip(spec); // aux.seats came later (verify-body-start.mjs pins it)
	assert.ok(Array.isArray(seats), `${demo}: aux.seats is a list`);
	clip.notes = clip.notes.map(n => (n === NEW_NOTE ? OLD_NOTE : n === NEW_HELD ? OLD_HELD : n));
	now[demo] = createHash("sha256").update(serializeClip(clip)).update(JSON.stringify(aux, round5)).digest("hex");
}
if (process.argv.includes("--print")) { console.log(JSON.stringify(now, null, "\t")); process.exit(0); }
for (const demo of DEMO_IDS) assert.equal(now[demo], BEFORE[demo], `${demo}: the same clip and aux as before the new words`);
console.log(`ok ${DEMO_IDS.length} demos: clip and aux byte for byte as before`);
console.log("PASS verify-hands-digest");
