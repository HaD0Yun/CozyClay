#!/usr/bin/env node
// The depth video's 8-bit pre-pass (the "linear" and "inverse" curves, and "log" on a renderer without half floats):
// a frame is drawn over the stage's whole depth, the bytes are decoded back into metres, and the shot's range is
// counted over every frame (src/depth-plate.js depthRangeOverFrames, src/render-passes.js greyDistance). These checks
// write the bytes the capture target would hold and pin the decode, the range over a whole shot, and the sky.
import assert from "node:assert/strict";
import * as THREE from "three";
import { DEPTH_RANGE_M, depthGrey, greyDistance, passFileName } from "../src/render-passes.js";
import { depthRangeOverFrames } from "../src/depth-plate.js";
import { normalizeFrameRange } from "../src/offscreen-export.js";

assert.deepEqual(normalizeFrameRange(12, 21), { startFrame: 12, endFrame: 21, frameCount: 10 });
assert.equal(passFileName("depth"), "blocking-frame-depth.png");
console.log("PASS depth video addresses an inclusive shot range");

const NEAR = 0.1;
// The byte the capture target holds for a surface `distance` away. The target is sRGB: for "linear" and "inverse" the
// hardware encodes the shader's linear grey; "log" is written so that the stored byte is the grey itself.
function byteAt(distance, curve) {
	const grey = depthGrey(distance, NEAR, DEPTH_RANGE_M, curve);
	return Math.round((curve === "log" ? grey : new THREE.Color().setRGB(grey, grey, grey).getRGB({}, THREE.SRGBColorSpace).r) * 255);
}
// A pre-pass frame: `surfaces` is [distance, share of the frame] pairs, the rest is sky (byte 0).
function frameOf(surfaces, curve, pixels = 4096) {
	const frame = new Uint8Array(pixels * 4);
	let at = 0;
	for (const [distance, share] of surfaces) for (const end = at + Math.round(share * pixels); at < end; at += 1) frame[at * 4] = byteAt(distance, curve);
	return frame;
}

// 1. The decode is the inverse of what the pass writes, for every curve, within what one byte can hold.
for (const [curve, within] of [["linear", (d, back) => Math.abs(back - d) < 0.2], ["inverse", (d, back) => Math.abs(back - d) / d < 0.05], ["log", (d, back) => Math.abs(back - d) / d < 0.02]]) {
	for (const distance of [0.5, 2, 8.5, 13.6, 30]) {
		const back = greyDistance(byteAt(distance, curve), NEAR, DEPTH_RANGE_M, curve);
		assert.ok(within(distance, back), `${curve}: ${distance} m is written and read back as ${distance} m (${back})`);
	}
	assert.ok(byteAt(1, curve) > byteAt(4, curve) && byteAt(4, curve) > byteAt(20, curve), `${curve}: lighter is closer`);
}
assert.ok(Math.abs((byteAt(1, "log") - byteAt(2, "log")) - (byteAt(4, "log") - byteAt(8, "log"))) <= 1, "log: 1 m to 2 m takes as many greys as 4 m to 8 m");
assert.ok(byteAt(1, "linear") - byteAt(2, "linear") < byteAt(4, "linear") - byteAt(8, "linear"), "linear: it does not");
console.log("PASS depth pre-pass bytes decode back to their distance on every curve; lighter is closer");

// 2. The range holds the surfaces of the frame and stays close to them: a figure at 8.5 m before a wall at 13.6 m.
for (const curve of ["linear", "inverse", "log"]) {
	const covered = await depthRangeOverFrames(0, 0, NEAR, curve, () => frameOf([[8.5, 0.3], [13.6, 0.7]], curve));
	assert.ok(covered.near < 8.5 && covered.near > 6.5 && covered.far > 13.6 && covered.far < 17, `${curve}: the range holds the figure and the wall and little else (${JSON.stringify(covered)})`);
	// sky takes no part: the same surfaces under half a frame of sky give the same range
	const sky = await depthRangeOverFrames(0, 0, NEAR, curve, () => frameOf([[8.5, 0.15], [13.6, 0.35]], curve));
	assert.deepEqual(sky, covered, `${curve}: sky does not move the range`);
}
console.log("PASS depth video range holds the frame's surfaces; sky takes no part");

// 3. The range is the shot's, not a frame's: the nearest surface is in one frame and the farthest in another, and the
// caller's step runs after every frame.
{
	const frames = [frameOf([[8, 1]], "linear"), frameOf([[3, 1]], "linear"), frameOf([[19, 1]], "linear")], stepped = [];
	const shot = await depthRangeOverFrames(10, 12, NEAR, "linear", (frame) => frames[frame - 10], async (frame) => { stepped.push(frame); });
	assert.ok(shot.near < 3 && shot.near > 2 && shot.far > 19 && shot.far < 23, `the range reaches from the nearest frame to the farthest (${JSON.stringify(shot)})`);
	assert.deepEqual(stepped, [10, 11, 12], "every frame of the shot is counted, in order");
	const unsampled = await depthRangeOverFrames(0, 3, 0.25, "linear", () => new Uint8Array(4096 * 4));
	assert.deepEqual(unsampled, { near: 0.25, far: DEPTH_RANGE_M }, "a shot whose samples hit no surface keeps the stage's range, not a near plane at the far end");
}
console.log("PASS depth normalisation range is computed from the whole shot");
