#!/usr/bin/env node
// A spec that uses none of the words for a prop's own axes (aim {x, y, z}), a prop riding on another (ride), a place
// on the own body ({joint}) or an elbow target (elbowL / elbowR) compiles to exactly the clip and the aux it compiled
// to before those words: sha256 of every engine demo's serialized clip and aux, taken at the commit before them.
// The one note that changed with them (notes.js, stored in every clip) is put back to its old text before hashing.
// Pinned again when the reach entries got the facts of their reasons (aux.reach: t, r, beyond, bend, ...; the object
// demo's two rows from frames inside an overshooting blend are gone); the clips stayed byte for byte (verify-body-start.mjs).
// Pinned again when an arm's entries also carried the reach assist's drop; clips and every entry's {key, d} the same.
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
	object: "cfc84d1f2b2823ae7662f69566b62e5251dec5b67738305e756c349558fccba7",
	duo: "0a1c779150672ec2c891670b7c4afc942f7bc2dd9536d7f10c13b0ff11fb470f",
	push: "4f65ce126b7e575aaaa3e8147b82ece3cb1ba583fb15e2e80d6e5d506d950935",
	chop: "623cc406072ba4ca9e52af4cc5d5364ed9fff4acf78d9b9d46ab7562388ab314",
	bowl: "9cda1765b58f6cd17d298d94167df94e453b6ac4b2c8517086136c2ef6fe28dc",
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
