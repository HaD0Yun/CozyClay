#!/usr/bin/env node
// A walk, run or push along a path lowers its pelvis to keep a planted foot in reach over the frames around the frame
// that needs it, not for that one frame (leg-reach.js), and only as far as the layers on top leave a need: hips that a
// pose key holds lower are not lowered again, and the frames of a flight that begins as the travel's last frame are no
// frames of the travel. Scenes and specs are written here.
import assert from "node:assert/strict";
import { buildClip } from "../../src/lowvis/engine-simple/engine.js";
import { buildBodySized } from "../../src/lowvis/engine-simple/size.js";
import { JOINT_COUNT } from "../../src/lowvis/rig17.js";

const I = [0, "idle", {}];
/** The Hips' height on every frame of one character's clip. */
function hips(acts, scale = 1, frames = 240) {
	const { clip } = buildClip({ demo: "x", a: acts }, { frames, characters: [{ id: "a", at: [0, 0], heading: 0, ...(scale === 1 ? {} : { scale }) }], props: [] });
	return Array.from({ length: frames }, (_, f) => clip.characters[0].pos[f * JOINT_COUNT * 3 + 1]);
}
/** One-frame drops of the pelvis: frames where it is over 15 mm x scale under the mean of the frames beside it. */
const drops = (y, scale) => y.filter((v, f) => f > 0 && f < y.length - 1 && (y[f - 1] + y[f + 1]) / 2 - v > 0.015 * scale).length;

// --- a straight jog and run, slow to faster than any captured, small and large bodies: no one-frame drop ---
for (const scale of [0.6, 1, 1.4]) for (const v of [1.5, 1.85, 3.5, 6]) {
	const n = drops(hips([I, [16, "run", { to: [0, +(v * scale * 200 / 24).toFixed(3)] }], [216, "idle", {}]], scale), scale);
	assert.equal(n, 0, `a run at ${v} m/s x scale ${scale}: no one-frame pelvis drop over 15 mm x scale (${n})`);
}
console.log("ok 12 straight runs at 1.5 to 6 m/s, scales 0.6 to 1.4: no one-frame pelvis drop");

// --- a walk with a stop: none either ---
{
	const n = drops(hips([I, [8, "walk", { to: [0, 5] }], [108, "idle", {}]], 1, 144), 1);
	assert.equal(n, 0, `a walk of 5 m in 100 frames: no one-frame pelvis drop (${n})`);
	console.log("ok a walk: no one-frame pelvis drop");
}

// --- hips that a pose key holds lower are not lowered again: against the same jog without the key the hips are never
// more than the key under it, and where the plain jog is lowered for a foot's reach they are less than the key under it ---
for (const scale of [0.6, 1, 1.4]) {
	const run = [16, "run", { to: [0, +(1.85 * scale * 200 / 24).toFixed(3)] }], key = 0.15 * scale;
	const plain = hips([I, run, [216, "idle", {}]], scale), low = hips([I, [4, "pose", { hip: [0, -key, 0], over: 6 }], run, [216, "idle", {}]], scale);
	let most = -Infinity, least = Infinity;
	for (let f = 40; f < 200; f++) { const under = plain[f] - low[f]; most = Math.max(most, under); least = Math.min(least, under); }
	assert.ok(most < key + 0.001 * scale, `scale ${scale}: with the hips keyed ${key.toFixed(3)} m down they are never further under the plain jog (${most.toFixed(4)} m)`);
	assert.ok(least < key - 0.01 * scale, `scale ${scale}: where the plain jog is lowered for a foot's reach the keyed hips are not lowered again (least ${least.toFixed(4)} m under, key ${key.toFixed(3)})`);
	assert.equal(drops(low, scale), 0, `scale ${scale}: the keyed jog has no one-frame pelvis drop`);
}
console.log("ok hips keyed down under a jog: not lowered again, scales 0.6 to 1.4");

// --- the body layer: a travel's frames know each other; the frames of a flight after it and of a stand do not ---
{
	const acts = [I, [10, "run", { to: [0, 6] }], [40, "launch", {}], [70, "idle", {}]], F = 100;
	const layer = buildBodySized({ id: "a", at: [0, 0], heading: 0 }, acts, F, { props: {}, ground: () => 0 }, 1);
	const marked = layer.map(B => !!B.reach?.set), air = layer.map(B => !!B.air);
	assert.ok(air.some(Boolean), "the launch has frames in the air");
	assert.ok(layer.every((B, f) => !(air[f] && B.reach)), "no frame in the air is a frame of the travel");
	assert.ok(marked.slice(10, 40).every(Boolean) && !marked.slice(0, 10).some(Boolean) && !marked.slice(40).some(Boolean), `the run's 30 frames know each other, no other frame does (${marked.map(Number).join("")})`);
	assert.equal(new Set(layer.slice(10, 40).map(B => B.reach.set)).size, 1, "one travel, one set of frames");
	assert.deepEqual(layer.slice(10, 40).map(B => B.reach.t), Array.from({ length: 30 }, (_, t) => t), "each frame knows its place");
	console.log("ok a run into a launch: the run's frames are marked, the flight's are not");
}
console.log("PASS verify-leg-reach");
