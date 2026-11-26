#!/usr/bin/env node
// A posture as the clip's start state and a posture change of a written length (src/lowvis/engine-simple/spec-layers.js,
// the body layer's `over`).
//  1. nothing said: every engine demo compiles to the same clip, byte for byte, as at the commit before `over` on
//     the body layer (sha256 of the serialized clip)
//  2. over: a sit, a stand, a kneel and a lie end their change after `over` frames and then hold the posture
//  3. over: 0 at frame 0: the figure is in the posture on the first frame, the same pose a full change ends in
//  4. what cannot be held is told: an unknown prop and a bad `over` are errors; how far the hips end from the seat
//     top and how many feet stand inside the seat are in aux.seats, at the body's own size
// --sheet <file.png> also writes a contact sheet of a figure that starts seated and stands up in 18 frames.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { buildClip } from "../../src/lowvis/engine-simple/engine.js";
import { serializeClip, validateClip } from "../../src/lowvis/clip.js";
import { DEMO_IDS } from "../../src/lowvis/demos.js";
import { INDEX as J, JOINT_COUNT } from "../../src/lowvis/rig17.js";

const hash = text => createHash("sha256").update(text).digest("hex").slice(0, 16);
const hipsY = (clip, f, c = 0) => clip.characters[c].pos[(f * JOINT_COUNT + J.Hips) * 3 + 1];
const pose = (clip, f) => Array.from(clip.characters[0].pos.slice(f * JOINT_COUNT * 3, (f + 1) * JOINT_COUNT * 3));
const worst = (a, b) => a.reduce((m, v, i) => Math.max(m, Math.abs(v - b[i])), 0);

// --- 1. nothing said: the demos are the clips of before ---
{
	// the elbow note that came later (verify-hands-digest.mjs) is put back to its old text before hashing
	const OLD_NOTE = "elbow and knee directions come from one fixed pole hint; there is no hands-on-hips or crossed-arms pose";
	// (its knee half said again when a knee's side came from knee.js: was "knee directions come from one fixed pole hint; ...")
	const LATER_NOTE = "the side a knee bends to is the engine's: no spec word sets it; an elbow's too unless pose elbowL / elbowR gives it a target";
	// and so is the held-prop note that came with several hands on one prop (verify-share-hands.mjs)
	const HELD_WAS = "a prop in one hand is held by that hand only (no second hand on the grip); its long axis must be its z axis";
	const HELD_NOW = "a held prop has no weight and pulls no body: it goes where the hands that hold it put it";
	// duo, chop and bowl pinned again with the counted walk (verify-counted-walk.mjs): a walk with steps takes the path
	// as any walk does and a backward move rolls its feet in reverse (was duo 7161b3b6dec47653, chop 0a274e59fda21b52, bowl 4667a47117f935bb);
	// again with its repairs: the last plant of a backward move lands flat, a counted walk's hips arrive when its last foot
	// lands (was duo 7aa86333d97a5ab1, chop 2d258b2a5d03117e, bowl 660c2527df5ed7d7); duo again when its burst was fitted
	// to how far its feet trail the hips (was 166268fe9a9621fe)
	// pinned again when a walk's sway changed (a walk's sway grows with its walking share, unless the walk begins the
	// clip; upper-layer keys that flow on into the next) (push the same); were locomotion 2d1a6d6afc122219, sit 69ae9ec17d853bb6, object 800f6742b10944e6, duo c856198951e663f2, push ff755b870529e06d, chop 6577f662ae05285a, bowl d85e95275202dc36)
	// chop and bowl again when a prop key starts where the key before has the prop on its frame (were chop 598b98622653d95a,
	// bowl a0b912519da349db), and again when a hand takes a prop as it lies (were chop 74ac71e5e65d558b, bowl 6d8e8f512143c0b1)
	// and so is the run note, said again when a run came to move by captured runs (gait-data.js)
	const RUN_WAS = "run is a short-stride jog at the demo's speed (about 1.2 m/s)";
	const RUN_NOW = "a run's steps, pelvis, chest and arms follow captured runners of its speed, about 2 to 5 m/s for a body of scale 1 (slower or faster is not captured); its start and its stop (where it has one) take half a second, as a walk's do";
	// locomotion, sit and bowl pinned again with that run (locomotion: its run) and when a plant of any travel came to stay
	// in the air until the pelvis is within a steady pace's reach of it (sit and bowl: the last steps of a walk that ends
	// fast); were locomotion 4c58c177f5cba59f, sit f2ddb31cc94c2acd, bowl b6fda58a89c2aece
	// locomotion, sit, object, duo and push again when a walk, run or push along a path came to lower its pelvis over the
	// frames around a planted foot's reach (leg-reach.js: hips down only, by at most 61, 56, 2, 2 and 46 mm, on frames
	// 97-208, 0-251, 0-2, 0-2 and 1-51; chop and bowl are the same clips); were locomotion 6f0eb4a5a4fd90c8, sit
	// 9822cd9f58deade4, object 9099578f0aa12435, duo e577d20d50c20b28, push ff755b870529e06d
	// object, duo, push, chop and bowl again when a pose key's inout blend became the minimum-jerk curve (math.js poseEase);
	// were object aaf885032f862635, duo d0449834e7919d7a, push f76161ac170ff467, chop d0ba3462c327a127, bowl f40598adcca6642a
	const BEFORE = { locomotion: "25befceded8c9fdc", sit: "84d6a8d4032f4b35", object: "f80816d6d9d79b1e", duo: "56a74df97ef6e8cb", push: "04f8b34932c751ed", chop: "efe2085789d85493", bowl: "d2f2ce56d3fe5889" };
	assert.deepEqual(DEMO_IDS.slice().sort(), Object.keys(BEFORE).sort(), "every demo has a digest");
	for (const demo of DEMO_IDS) {
		const { default: spec } = await import(`../../src/lowvis/engine-simple/demos/${demo}.js`);
		const { clip } = buildClip(structuredClone(spec));
		clip.notes = clip.notes.map(n => (n === LATER_NOTE ? OLD_NOTE : n === HELD_NOW ? HELD_WAS : n === RUN_NOW ? RUN_WAS : n));
		for (const p of clip.props) delete p.by; // what carries a moving prop on each frame came later (verify-prop-owner.mjs)
		assert.equal(hash(serializeClip(clip)), BEFORE[demo], `demo ${demo}: the same clip as before, byte for byte`);
	}
	console.log(`ok digests: ${DEMO_IDS.length} demos compile to the clips of before`);
}

const SCENE = { frames: 120, characters: [{ id: "a", at: [0, 0.35], heading: 0 }], props: [{ id: "seat", size: [0.45, 0.45, 0.45], at: [0, 0.225, 0] }, { id: "mat", size: [0.9, 0.1, 2.0], at: [2, 0.05, 0] }] };
const build = (a, scene = SCENE) => buildClip({ demo: "x", a }, structuredClone(scene));

// --- 2. over: the change takes that many frames, then the posture holds ---
{
	const full = build([[0, "idle"], [10, "sit", { on: "seat" }], [110, "idle"]]).clip, short = build([[0, "idle"], [10, "sit", { on: "seat" }], [80, "idle"]]).clip;
	const fast = build([[0, "idle"], [10, "sit", { on: "seat", over: 14 }], [110, "idle"]]).clip;
	const seated = hipsY(short, 79);
	assert.ok(hipsY(full, 30) - seated > 0.1, `without over the sit is still on its way 20 frames in (hips ${hipsY(full, 30).toFixed(3)} m)`);
	for (const f of [30, 60, 100]) assert.ok(Math.abs(hipsY(fast, f) - seated) < 0.01, `over 14: seated at frame ${f} (hips ${hipsY(fast, f).toFixed(3)} vs ${seated.toFixed(3)} m)`);
	const up = build([[0, "idle"], [4, "sit", { on: "seat", over: 12 }], [30, "stand", { over: 10 }], [110, "idle"]]).clip, standY = hipsY(up, 0);
	assert.ok(Math.abs(hipsY(up, 50) - standY) < 0.01 && hipsY(up, 34) < standY - 0.05, `stand over 10: on its way at frame 34, up by frame 50 (${hipsY(up, 34).toFixed(3)}, ${hipsY(up, 50).toFixed(3)} m)`);
	const kneelFull = build([[0, "idle"], [10, "kneel"], [100, "idle"]]).clip, kneelFast = build([[0, "idle"], [10, "kneel", { over: 16 }], [100, "idle"]]).clip;
	assert.ok(worst(pose(kneelFast, 40), pose(kneelFull, 99)) < 0.01 && hipsY(kneelFull, 40) - hipsY(kneelFast, 40) > 0.05, "kneel over 16: knelt at frame 40, the default is still going down");
	const lie = build([[0, "idle"], [5, "kneel", { over: 15 }], [20, "lie", { on: "mat", head: 0, over: 20 }], [110, "idle"]], { ...SCENE, characters: [{ id: "a", at: [2, -0.6], heading: 0 }] }).clip;
	assert.ok(Math.abs(hipsY(lie, 45) - hipsY(lie, 100)) < 0.005 && hipsY(lie, 45) < 0.3, `lie over 20: lying at frame 45 (hips ${hipsY(lie, 45).toFixed(3)} m)`);
	assert.throws(() => build([[0, "sit", { on: "seat", over: -2 }]]), /over wants a number of frames >= 0/);
	assert.throws(() => build([[0, "sit", { on: "seat", over: "slow" }]]), /over wants a number of frames >= 0/);
	console.log("ok over: sit, stand, kneel and lie end their change after over frames and hold");
}

// --- 3. over: 0 at frame 0: the clip starts in the posture ---
{
	const ends = build([[0, "sit", { on: "seat" }], [119, "idle"]]).clip, start = build([[0, "sit", { on: "seat", over: 0 }]]).clip;
	assert.ok(worst(pose(start, 0), pose(ends, 118)) < 0.01, `seated at frame 0: the pose a full sit ends in (worst ${(worst(pose(start, 0), pose(ends, 118)) * 1000).toFixed(1)} mm)`);
	assert.ok(worst(pose(start, 0), pose(start, 119)) < 1e-9, "and it holds");
	const startUp = build([[0, "sit", { on: "seat", over: 0 }], [40, "stand", { over: 18 }]]).clip, standY = hipsY(build([[0, "idle"]]).clip, 0);
	assert.ok(hipsY(startUp, 39) < standY - 0.2 && Math.abs(hipsY(startUp, 60) - standY) < 0.01, "starts seated, is up 18 frames after the stand");
	const height = build([[0, "sit", { height: 0.6, over: 0 }]]).clip;
	assert.ok(Math.abs(hipsY(height, 0) - hipsY(start, 0) - 0.15) < 0.01, "a start on a height sits at that height");
	const kneelEnd = build([[0, "kneel"], [119, "idle"]]).clip, kneel0 = build([[0, "kneel", { over: 0 }]]).clip;
	assert.ok(worst(pose(kneel0, 0), pose(kneelEnd, 118)) < 0.01, "knelt at frame 0");
	const mat = { ...SCENE, characters: [{ id: "a", at: [2, -0.6], heading: 0 }] };
	const lieEnd = build([[0, "lie", { on: "mat", head: 0 }], [119, "idle"]], mat).clip, lie0 = build([[0, "lie", { on: "mat", head: 0, over: 0 }]], mat).clip;
	assert.ok(worst(pose(lie0, 0), pose(lieEnd, 118)) < 0.01, "lying on the mat at frame 0");
	for (const c of [start, startUp, kneel0, lie0]) assert.ok(validateClip(JSON.parse(serializeClip(c))).ok, "the clip is valid");
	console.log("ok start: seated, on a height, knelt and lying at frame 0, each the pose its full change ends in");
}

// --- 4. what cannot be held is told ---
{
	assert.throws(() => build([[0, "sit", { on: "sofa", over: 0 }]]), /a sit at frame 0: no prop "sofa" in the scene/);
	assert.throws(() => build([[0, "lie", { on: "bed", over: 0 }]]), /no prop "bed"/);
	assert.throws(() => build([[0, "sit", { over: 0 }]]), /wants \{on: propId\} or \{height\}/);
	assert.deepEqual(build([[0, "sit", { on: "seat", over: 0 }]]).aux.seats, [{ who: "a", f: 0, verb: "sit", prop: "seat", off: 0, feetIn: 0 }], "in front of the seat: on it, feet outside");
	const far = build([[0, "sit", { on: "seat", over: 0 }]], { ...SCENE, characters: [{ id: "a", at: [0, 1.2], heading: 0 }] }).aux.seats[0];
	assert.ok(far.off > 0.4, `1.2 m from the seat: the hips end ${far.off.toFixed(2)} m off its top`);
	const inside = build([[0, "sit", { on: "seat", over: 0 }]], { ...SCENE, characters: [{ id: "a", at: [0, 0], heading: 0 }] }).aux.seats[0];
	assert.equal(inside.feetIn, 2, "standing on the seat's spot: both feet inside it");
	const big = { frames: 40, characters: [{ id: "a", at: [0, 2.4], heading: 0, scale: 2 }], props: [{ id: "seat", size: [0.9, 0.9, 0.9], at: [0, 0.45, 0] }] };
	const unit = { frames: 40, characters: [{ id: "a", at: [0, 1.2], heading: 0 }], props: [{ id: "seat", size: [0.45, 0.45, 0.45], at: [0, 0.225, 0] }] };
	const offBig = build([[0, "sit", { on: "seat", over: 0 }]], big).aux.seats[0].off, offUnit = build([[0, "sit", { on: "seat", over: 0 }]], unit).aux.seats[0].off;
	assert.ok(Math.abs(offBig - 2 * offUnit) < 1e-9, `a body of scale 2: the gap in world metres (${offBig.toFixed(3)} = 2 x ${offUnit.toFixed(3)})`);
	console.log("ok told: an unknown prop and a bad over are errors; the seat gap and the feet inside the seat are in aux.seats");
}

const at = process.argv.indexOf("--sheet");
if (at > 0) {
	const { drawSheet, encodePng } = await import("../../src/lowvis/pi/render.mjs");
	const scene = { frames: 96, characters: [{ id: "a", at: [0, 0.35], heading: 0 }], props: [{ id: "seat", size: [0.45, 0.45, 0.45], at: [0, 0.225, 0] }] };
	const spec = { demo: "x", a: [[0, "sit", { on: "seat", over: 0 }], [36, "stand", { over: 18 }], [54, "idle"], [66, "walk", { to: [0, 1.4] }]] };
	const parsed = JSON.parse(serializeClip(buildClip(spec, scene).clip));
	const sheet = drawSheet(parsed, { frames: [0, 30, 36, 40, 44, 48, 54, 95], view: "side", cols: 4, label: "starts seated - stands up f36-54" });
	writeFileSync(process.argv[at + 1], encodePng(sheet.rgba, sheet.width, sheet.height));
	console.log(`sheet: ${process.argv[at + 1]}`);
}
console.log("PASS verify-body-start");
