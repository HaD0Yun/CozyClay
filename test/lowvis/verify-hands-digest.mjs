#!/usr/bin/env node
// A spec that uses none of the words for a prop's own axes (aim {x, y, z}), a prop riding on another (ride), a place
// on the own body ({joint}) or an elbow target (elbowL / elbowR) compiles to exactly the clip and the aux it compiled
// to before those words: sha256 of every engine demo's serialized clip and aux, taken at the commit before them.
// The one note that changed with them (notes.js, stored in every clip) is put back to its old text before hashing.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { buildClip } from "../../src/lowvis/engine-simple/engine.js";
import { serializeClip } from "../../src/lowvis/clip.js";
import { DEMO_IDS } from "../../src/lowvis/demos.js";
import { NOTES } from "../../src/lowvis/engine-simple/notes.js";

const OLD_NOTE = "elbow and knee directions come from one fixed pole hint; there is no hands-on-hips or crossed-arms pose";
const NEW_NOTE = "knee directions come from one fixed pole hint; an elbow's too unless pose elbowL / elbowR gives it a target";
assert.ok(NOTES.includes(NEW_NOTE), "the clip's notes say that an elbow can be given a target");

const BEFORE = {
	locomotion: "4b102ce748c4e84499e261466067abbde83b27c9a4becd9f80d39b888f21a016",
	sit: "1da2ec2bfab4cd8e9764ad743f8d1d145feff0fe01d2713dbf3da69e2c05f025",
	object: "c58c56ee426e9ff0cc80aa1f9122b2b372cc95f25bad15edfcb35c9dfcf6412a",
	duo: "dade3b4544e20edad5c9d992fc514d63ce4cb5279aff737d9538506632c5d4ad",
	push: "8f156442151aefdfb71782be17864c82e011a02d634831d0f32c92e2543c6e84",
	chop: "006527d28b4845513c2a2f955ef50037cc05fea2f45e293748baa3c556a8a485",
	bowl: "3cf6567a9884d8e95b012941ebb1b0609779a9e436c4815c5ebeefc8fcca9294",
};
const now = {};
for (const demo of DEMO_IDS) {
	const { default: spec } = await import(`../../src/lowvis/engine-simple/demos/${demo}.js`);
	const { clip, aux } = buildClip(spec);
	clip.notes = clip.notes.map(n => (n === NEW_NOTE ? OLD_NOTE : n));
	now[demo] = createHash("sha256").update(serializeClip(clip)).update(JSON.stringify(aux)).digest("hex");
}
if (process.argv.includes("--print")) { console.log(JSON.stringify(now, null, "\t")); process.exit(0); }
for (const demo of DEMO_IDS) assert.equal(now[demo], BEFORE[demo], `${demo}: the same clip and aux as before the new words`);
console.log(`ok ${DEMO_IDS.length} demos: clip and aux byte for byte as before`);
console.log("PASS verify-hands-digest");
