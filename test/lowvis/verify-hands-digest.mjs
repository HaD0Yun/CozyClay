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
// (the knee half of it was said again when a knee's side came from knee.js: was "knee directions come from one fixed pole hint; ...")
const NEW_NOTE = "the side a knee bends to is the engine's: no spec word sets it; an elbow's too unless pose elbowL / elbowR gives it a target";
assert.ok(NOTES.includes(NEW_NOTE), "the clip's notes say that an elbow can be given a target");
// the note that changed with a prop held by several hands (share.js) goes back to its old text too
const OLD_HELD = "a prop in one hand is held by that hand only (no second hand on the grip); its long axis must be its z axis";
const NEW_HELD = "a held prop has no weight and pulls no body: it goes where the hands that hold it put it";
assert.ok(NOTES.includes(NEW_HELD), "the clip's notes say what a prop held by several hands does");

// pinned again when a walk's sway changed (a walk's sway grows with its walking share, unless the walk begins the clip;
// upper-layer keys flow on into the next; push the same): was
// locomotion 4b102ce7..., sit 1da2ec2b..., object 45d87982..., duo 45330261..., push 4f65ce12..., chop a773f584..., bowl 75232c8f...
const BEFORE = {
	locomotion: "bdc5009bcbe6f6dd392e76c2aee19ef8f58210b15300f1ce453d56a19cd6f0a6",
	sit: "3bcc2356b75a7599c6cf1fb65047162ad6e80e5ed61ce750c778f7280817937c",
	object: "4732cdec73934c15f3f530726e1c10a24a394d587d57d559d0aa5798cb75304f", // pinned again when aux.placed entries named who placed (who, held); clip and miss the same
	// duo, chop and bowl pinned again with the counted walk (verify-counted-walk.mjs; their walks with steps or facing changed)
	duo: "14533d7f3f331bdca598f72e971af64c2743a796e85ed4078c89e8f4a3c6f3d8", // was 0a1c7791..., then a4a10796... (the counted walk before its repairs), then 105d53d3... (before a burst was fitted to how far its feet trail the hips)
	push: "4f65ce126b7e575aaaa3e8147b82ece3cb1ba583fb15e2e80d6e5d506d950935",
	chop: "5744cf7780906abaf219774b5eb6b3f1552795ec685c747e52cc227a10c90a78", // was 623cc406..., then 3b131397..., then 7edaa06c... (before a prop key started where the key before has the prop), then 721996eb... (before a hand took a prop as it lies)
	bowl: "c3bd185499566c735bbb7e5b0e6c4f37e44d3e80ab2e54398fea3eed4bb9c786", // was 9cda1765..., then 8b1243fc..., then 11ba09d1... (before a prop key started where the key before has the prop), then cff65983... (before a hand took a prop as it lies)
};
const round5 = (_, v) => (typeof v === "number" ? Math.round(v * 1e5) / 1e5 : v);
const now = {};
for (const demo of DEMO_IDS) {
	const { default: spec } = await import(`../../src/lowvis/engine-simple/demos/${demo}.js`);
	const { clip, aux: { seats, walks, ...aux } } = buildClip(spec); // aux.seats came later (verify-body-start.mjs pins it), aux.walks too (verify-counted-walk.mjs)
	assert.ok(Array.isArray(seats) && Array.isArray(walks), `${demo}: aux.seats and aux.walks are lists`);
	clip.notes = clip.notes.map(n => (n === NEW_NOTE ? OLD_NOTE : n === NEW_HELD ? OLD_HELD : n));
	for (const p of clip.props) delete p.by; // what carries a moving prop on each frame came later (verify-prop-owner.mjs)
	now[demo] = createHash("sha256").update(serializeClip(clip)).update(JSON.stringify(aux, round5)).digest("hex");
}
if (process.argv.includes("--print")) { console.log(JSON.stringify(now, null, "\t")); process.exit(0); }
for (const demo of DEMO_IDS) assert.equal(now[demo], BEFORE[demo], `${demo}: the same clip and aux as before the new words`);
console.log(`ok ${DEMO_IDS.length} demos: clip and aux byte for byte as before`);
console.log("PASS verify-hands-digest");
