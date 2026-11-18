#!/usr/bin/env node
// Specs that use the prop words of before the ride on a joint (ride {on}, hold, carry, place, release) compile to the
// clip and aux they compiled to before it: sha256 of the serialized clip and the aux (numbers rounded to 5 decimals, as
// verify-hands-digest.mjs does, so the hash is the same on another CPU type), taken at the commit before the change. aux.rides, which came with it, is left out.
// Every scene here is made up for this test.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { buildClip } from "../../src/lowvis/engine-simple/engine.js";
import { serializeClip } from "../../src/lowvis/clip.js";

const TABLE = { id: "desk", size: [1.0, 0.72, 0.5], at: [0, 0.36, 1.0] };
const CASES = {
	// a crate carried with a box riding on it, a second figure takes the box off and puts it on the desk
	rideCarry: [{ frames: 150, characters: [{ id: "p", at: [0, -0.4], heading: 0 }, { id: "q", at: [1.2, 1.4], heading: 225 }],
		props: [TABLE, { id: "crate", size: [0.4, 0.2, 0.3], at: [-0.2, 0.82, 0.95], moves: true }, { id: "box", size: [0.1, 0.12, 0.1], at: [-0.2, 0.98, 0.95], moves: true }] },
	{ p: [[0, "walk", { to: [-0.2, 0.45] }], [26, "pose", { hands: { prop: "crate" }, bow: 25, over: 12 }], [40, "carry", { prop: "crate", at: [0, 1.0, 0.4], over: 12 }], [56, "walk", { to: [0.9, 0.9], heading: 90 }]],
		q: [[90, "pose", { R: { prop: "box" }, over: 12 }], [102, "hold", { prop: "box", hand: "R" }], [106, "place", { prop: "box", at: [0.3, 0.78, 1.0], over: 18 }], [130, "pose", { R: "rest", over: 12 }]],
		box: [[0, "ride", { on: "crate" }]] }],
	// one hand holds at a place, both hands share, one hand lets go, a ride written while held starts at the let-go
	holdShare: [{ frames: 130, characters: [{ id: "p", at: [0, 0.3], heading: 0 }],
		props: [TABLE, { id: "tray", size: [0.45, 0.03, 0.3], at: [0, 0.735, 0.95], moves: true }, { id: "pot", size: [0.15, 0.15, 0.15], at: [0, 0.825, 0.95], moves: true }] },
	{ p: [[0, "hold", { prop: "tray", hand: "both", at: { L: [0.22, 0, 0], R: [-0.22, 0, 0] }, over: 20 }], [30, "pose", { bow: 10, over: 12 }], [40, "pose", { hands: [0.25, 0.25, 0.45], over: 20 }],
		[70, "release", { prop: "tray", hand: "L" }], [90, "release", { prop: "tray" }], [96, "pose", { hands: "rest", bow: 0, over: 16 }]],
	pot: [[0, "ride", { on: "tray" }]] }],
	// a roll and a keyed prop with a rider
	rollKey: [{ frames: 110, characters: [{ id: "p", at: [0, 0], heading: 90 }],
		props: [{ id: "ball", size: [0.2, 0.2, 0.2], at: [0.4, 0.95, 0.1], moves: true, shape: "sphere" }, { id: "plank", size: [0.6, 0.04, 0.2], at: [-0.8, 0.5, 0], moves: true }, { id: "can", size: [0.08, 0.12, 0.08], at: [-0.8, 0.58, 0], moves: true }] },
	{ p: [[0, "hold", { prop: "ball", hand: "R" }], [10, "pose", { R: [-0.2, 0.3, 0.5], over: 14, fast: true }], [26, "release", { prop: "ball", roll: true }]],
		plank: [[20, "move", { to: [-0.8, 0.9, 0.6], axis: [0, 1, 0], deg: 60, over: 40 }]], can: [[0, "ride", { on: "plank" }], [80, "tip", { pivot: [-0.8, 0.88, 0.6], axis: [1, 0, 0], deg: 30, over: 12 }]] }],
};
const round5 = (_, v) => (typeof v === "number" ? Math.round(v * 1e5) / 1e5 : v);
const BEFORE = {
	rideCarry: "de27b72fcc147fb40959202ab51cdffda00443b75d63df8b749fb9770521fe2b",
	holdShare: "a301a50f6fdf636419fbc2940aed8f28029f0e0a6fa50063d850a1f312efbae6",
	rollKey: "18b0abf907fcdfc7f0841505f841b12b9d3bb7d01c8403f81a1be98152791813",
};
const now = Object.fromEntries(Object.entries(CASES).map(([name, [scene, spec]]) => {
	const { clip, aux: { rides, ...aux } } = buildClip(structuredClone({ demo: name, ...spec }), scene); // aux.rides came with it (the rows of a ride)
	assert.ok(Array.isArray(rides), `${name}: aux.rides lists its ride keys`);
	return [name, createHash("sha256").update(serializeClip(clip)).update(JSON.stringify(aux, round5)).digest("hex")];
}));
if (process.argv.includes("--print")) { console.log(JSON.stringify(now, null, "\t")); process.exit(0); }
for (const name of Object.keys(CASES)) assert.equal(now[name], BEFORE[name], `${name}: the same clip and aux as before the ride on a joint`);
console.log(`ok ${Object.keys(CASES).length} specs with ride {on}, hold, carry, place and release: clip and aux byte for byte as before`);
console.log("PASS verify-ride-before");
