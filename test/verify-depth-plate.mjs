#!/usr/bin/env node
// The depth plate (src/depth-plate.js): the greys of a depth video and a depth still are made from a half-float
// read-back of the pass. These checks hand it synthetic read-backs and pin what a plate promises: nearer is lighter,
// sky stays black, the relief inside one surface is drawn larger than the tone curve alone draws it, an edge between
// two surfaces gets no band, the pre-pass walks a bounded number of frames, and a renderer without half floats gets
// the 8-bit plate.
import assert from "node:assert/strict";
import { DEPTH_SOFTEN_PX, PLATE_PASS, createDepthSoftener, depthRangeOverFrames, depthStill, surveyedDepthPlate } from "../src/depth-plate.js";

// a number as the 16 bits of a half float (the values here are 0 or within 2^-14 .. 1)
function half(value) {
	if (!(value > 0)) return 0;
	const exponent = Math.floor(Math.log2(value)), mantissa = Math.round((value / 2 ** exponent - 1) * 1024);
	return mantissa === 1024 ? ((exponent + 16) << 10) : ((exponent + 15) << 10) | mantissa;
}
const W = 96, H = 64;
/** A read-back (RGBA half floats) from `at(x, y)`, the nearness of each pixel. */
const readBack = (at) => { const out = new Uint16Array(W * H * 4); for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) out[(y * W + x) * 4] = half(at(x, y)); return out; };
const grey = (bytes, x, y) => bytes[(y * W + x) * 4];
// a plate maker answers each frame in one buffer of its own: a check that holds two frames copies them
const plateOf = async (frames) => { const plate = await surveyedDepthPlate({ width: W, height: H }, 0, frames.length - 1, (frame) => frames[frame]); return { bytes: (frame) => plate.bytes(frame).slice() }; };

assert.deepEqual({ ...PLATE_PASS }, { depthCurve: "ratio", precise: true }, "a plate is made from the precise pass, by ratio");
assert.ok(DEPTH_SOFTEN_PX > 0 && DEPTH_SOFTEN_PX < 1, "the softness is under a pixel");

// 1. Order: a far wall on the left, a near wall on the right, sky above.
{
	const frame = readBack((x, y) => (y < 8 ? 0 : x < W / 2 ? 0.4 : 0.7));
	const bytes = (await plateOf([frame])).bytes(frame);
	assert.ok(bytes instanceof Uint8Array && bytes.length === W * H * 4, "a plate is RGBA bytes of the frame's size");
	assert.equal(grey(bytes, 20, 2), 0, "sky stays black");
	assert.ok(grey(bytes, 70, 40) > grey(bytes, 20, 40) + 40, `the near wall is lighter than the far wall (${grey(bytes, 70, 40)} against ${grey(bytes, 20, 40)})`);
	assert.ok(grey(bytes, 20, 40) > 0, "the farthest surface is not the sky");
	assert.equal(bytes[(40 * W + 20) * 4 + 3], 255, "the plate is opaque");
	// no band where the two walls meet: every pixel of the row stays within the two walls' greys
	const far = grey(bytes, 10, 40), near = grey(bytes, 86, 40);
	for (let x = 4; x < W - 4; x += 1) assert.ok(grey(bytes, x, 40) >= far - 1 && grey(bytes, x, 40) <= near + 1, `no overshoot at the edge (x ${x}: ${grey(bytes, x, 40)} outside ${far}..${near})`);
	console.log("PASS depth plate: nearer is lighter, sky is black, no band at an edge");
}

// 2. Relief: a small patch slightly nearer than the wall it sits on stands out by more than the tone curve gives the
// same two nearnesses where they are two wide areas (there the level around a pixel is its own, and no relief is drawn).
{
	const wall = 0.5, bump = 0.508, patch = (x, y) => x >= 28 && x < 36 && y >= 28 && y < 36;
	const small = readBack((x, y) => (x >= 80 ? 0.9 : patch(x, y) ? bump : wall));
	const wide = readBack((x) => (x >= 80 ? 0.9 : x < 40 ? wall : bump));
	const plate = await plateOf([small, wide]);
	const withRelief = plate.bytes(small), toneOnly = plate.bytes(wide);
	const lift = grey(withRelief, 32, 32) - grey(withRelief, 10, 10), tone = grey(toneOnly, 70, 32) - grey(toneOnly, 10, 32);
	assert.ok(tone >= 0, "the nearer area is not darker");
	assert.ok(lift > tone + 3, `the patch stands out by more than the tone curve gives it (${lift} against ${tone})`);
	console.log(`PASS depth plate: relief inside a surface is drawn larger (${lift} greys against ${tone})`);
}

// 2b. A slope has no relief: a ramp from far to near steps only one way, at the frame's border and beside a nearer box too.
{
	const ramp = readBack((x, y) => (x >= 40 && x < 56 && y >= 20 && y < 44 ? 0.95 : 0.3 + (x / W) * 0.3));
	const bytes = (await plateOf([ramp])).bytes(ramp);
	for (const y of [8, 32, 56]) {
		let last = -1;
		for (let x = 0; x < W; x += 1) {
			if (y === 32 && x >= 38 && x < 58) continue;
			assert.ok(grey(bytes, x, y) >= last - 1, `the ramp does not step back (row ${y}, x ${x}: ${grey(bytes, x, y)} after ${last})`);
			last = grey(bytes, x, y);
		}
	}
	assert.ok(grey(bytes, 0, 8) > 0, "the far end of the ramp is not the sky");
	assert.ok(Math.abs(grey(bytes, 30, 32) - grey(bytes, 30, 8)) <= 2 && Math.abs(grey(bytes, 64, 32) - grey(bytes, 64, 8)) <= 2, "the ramp beside the box is the ramp away from it: no band around the box");
	console.log("PASS depth plate: a slope has no relief, at the border and beside an edge");
}

// 3. One curve for the shot: the same nearness is the same grey in every frame of it.
{
	const a = readBack((x) => (x < W / 2 ? 0.3 : 0.6)), b = readBack((x) => (x < W / 2 ? 0.6 : 0.9));
	const plate = await plateOf([a, b]);
	const inA = grey(plate.bytes(a), 70, 30), inB = grey(plate.bytes(b), 20, 30);
	assert.ok(Math.abs(inA - inB) <= 1, `0.6 is one grey in both frames (${inA}, ${inB})`);
	console.log("PASS depth plate: one tone curve for the whole shot");
}

// 4. The pre-pass walks a bounded number of frames, the first and the last among them.
{
	const frame = readBack(() => 0.5), walked = [], stepped = [];
	await surveyedDepthPlate({ width: W, height: H }, 10, 1009, (n) => { walked.push(n); return frame; }, async (n) => { stepped.push(n); });
	assert.ok(walked.length <= 125 && walked.length >= 100, `about 120 of 1000 frames are walked (${walked.length})`);
	assert.equal(walked[0], 10, "the first frame is walked");
	assert.equal(walked.at(-1), 1009, "the last frame is walked");
	assert.deepEqual(stepped, walked, "the caller's step runs after each walked frame");
	const short = [];
	await surveyedDepthPlate({ width: W, height: H }, 0, 4, (n) => { short.push(n); return frame; });
	assert.deepEqual(short, [0, 1, 2, 3, 4], "a short shot is walked whole");
	console.log("PASS depth plate: the pre-pass is bounded and keeps both ends");
}

// 5. The softener: a hard step gives over about two pixels.
{
	const w = 9, row = new Uint8ClampedArray(w * 4);
	for (let i = 0; i < w; i += 1) row[i * 4] = i < 4 ? 0 : 255;
	const out = createDepthSoftener(w, 1, 0.6)(0, row), values = Array.from({ length: w }, (_, i) => out[i * 4]);
	assert.deepEqual(values.slice(0, 2), [0, 0]);
	assert.deepEqual(values.slice(-2), [255, 255]);
	for (let i = 1; i < w; i += 1) assert.ok(values[i] >= values[i - 1], "the step stays monotone");
	assert.ok(values[3] > 20 && values[3] < 80 && values[4] > 180 && values[4] < 240, `the step is shared by its two pixels (${values.join(" ")})`);
	console.log("PASS depth plate: the softener spreads a step over about two pixels");
}

// 6. The 8-bit range ("linear", "inverse"): the counted surface but for a sliver at each end, sky left out.
{
	const frame = new Uint8Array(4096 * 4);
	for (let i = 0; i < 4096; i += 1) frame[i * 4] = i < 1024 ? 0 : i < 1030 ? 250 : i < 2560 ? 200 : 100;
	const range = await depthRangeOverFrames(0, 1, 0.1, "linear", () => frame);
	assert.ok(range.near > 0.1 && range.far > range.near && range.far < 40, `a range inside the stage's depth (${JSON.stringify(range)})`);
	const without = new Uint8Array(frame); for (let i = 1024; i < 1030; i += 1) without[i * 4] = 200;
	const same = await depthRangeOverFrames(0, 1, 0.1, "linear", () => without);
	assert.ok(Math.abs(same.near - range.near) < 1e-9, "a sliver beside the lens does not move the near end");
	assert.deepEqual(await depthRangeOverFrames(0, 0, 0.25, "linear", () => new Uint8Array(4096 * 4)), { near: 0.25, far: 40 }, "a shot of sky keeps the stage's range");
	console.log("PASS depth plate: the 8-bit range leaves out a sliver at each end and the sky");
}

// 7. The still: a renderer with half floats gets the plate, one without gets the 8-bit pass drawn twice (range, then plate).
{
	const scene = { overrideMaterial: null, background: null, traverse() {} }, camera = { near: 0.1 };
	const precise = { scene, precise: true, calls: [], render(options) { this.calls.push(options ?? null); return readBack((x) => (x < W / 2 ? 0.4 : 0.7)); } };
	const still = depthStill(precise, camera, { width: W, height: H }, (bytes) => bytes);
	assert.deepEqual(precise.calls, [{ precise: true }], "the plate still asks once, for the precise pass");
	assert.ok(grey(still, 70, 40) > grey(still, 20, 40), "and is a plate");
	const plain = { scene, precise: false, calls: [], render(options) { this.calls.push(options ?? null); const out = new Uint8Array(W * H * 4); for (let i = 0; i < W * H; i += 1) out[i * 4] = i % W < W / 2 ? 90 : 180; return out; } };
	const flat = depthStill(plain, camera, { width: W, height: H }, (bytes) => bytes);
	assert.deepEqual(plain.calls, [null, null], "the 8-bit still is drawn twice and never asks for half floats");
	assert.equal(flat.length, W * H * 4);
	assert.equal(depthStill({ scene, precise: true, render: () => null }, camera, { width: W, height: H }, () => "x"), null, "no read-back, no still");
	console.log("PASS depth plate: the still follows what the renderer can read back");
}
console.log("all depth plate checks PASS");
