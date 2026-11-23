import assert from "node:assert/strict";
import { BLURMOVE, blurRgba, blurmoveRefSize, createBlurmoveDecorator, gridRows, isMosaicFrame, mosaicRgba, segmentIndex } from "../src/blurmove-ref.js";
import { AI_REFERENCE_VIDEO, AI_REFERENCE_ZIP, REFERENCE_MAX_SECONDS, aiReferenceEntries, buildAiReferencePack } from "../src/ai-reference-pack.js";

// The setting is locked: 1 light mosaic frame in 4, 96 cells across, blur 32 cells and sigma 25 at 1280 wide.
assert.ok(Object.isFrozen(BLURMOVE), "the blurmove setting cannot be changed at runtime");
assert.deepEqual({ ...BLURMOVE }, { cycle: 4, on: 1, mosaicCols: 96, blurCols: 32, blurSigma: 25, baseWidth: 1280 });

// Size: 1280 wide, the shot aspect, an even height.
assert.deepEqual(blurmoveRefSize(1920, 1080), { width: 1280, height: 720 });
assert.deepEqual(blurmoveRefSize(1080, 1920), { width: 1280, height: 2276 });
assert.equal(blurmoveRefSize(2048, 858).height % 2, 0);
assert.equal(gridRows(96, 1280, 720), 54, "96 cells across is 96x54 on 16:9");
assert.equal(gridRows(32, 1280, 720), 18, "32 cells across is 32x18 on 16:9");

// The cycle restarts at each shot start: a cut always opens on a mosaic frame.
const starts = [0, 38, 160];
assert.equal(segmentIndex(37, starts), 37);
assert.equal(segmentIndex(38, starts), 0);
assert.equal(segmentIndex(170, starts), 10);
assert.equal(segmentIndex(5, [10, 20]), 5, "frames before the first shot count from 0");
assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7, 8].map((frame) => isMosaicFrame(frame, [0])), [true, false, false, false, true, false, false, false, true]);
assert.ok(isMosaicFrame(38, starts) && isMosaicFrame(160, starts), "every shot's first frame is a mosaic frame");
assert.ok(!isMosaicFrame(40, starts), "frame 40 is the third frame of shot 2, a blur frame");
assert.equal(segmentIndex(38, [160, 0, 38]), 0, "unsorted starts still resolve");

// A test frame: a hard-edged checkerboard with a bright square, 128x72.
const W = 128, H = 72;
const frame = new Uint8ClampedArray(W * H * 4);
for (let y = 0; y < H; y += 1) {
	for (let x = 0; x < W; x += 1) {
		const i = (y * W + x) * 4;
		const on = ((x >> 2) + (y >> 2)) % 2 === 0 || (x > 40 && x < 60 && y > 20 && y < 40);
		frame[i] = on ? 240 : 10;
		frame[i + 1] = on ? 200 : 20;
		frame[i + 2] = on ? 100 : 30;
		frame[i + 3] = 255;
	}
}
const mean = (pixels) => {
	let sum = 0;
	for (let i = 0; i < pixels.length; i += 4) sum += pixels[i] + pixels[i + 1] + pixels[i + 2];
	return sum / ((pixels.length / 4) * 3);
};

// Mosaic: flat blocks of the cell average, opaque, mean brightness kept.
const mosaic = mosaicRgba(frame, W, H, 16);
const cell = W / 16;
for (let y = 0; y < cell; y += 1) {
	for (let x = 0; x < cell; x += 1) {
		const i = (y * W + x) * 4;
		assert.equal(mosaic[i], mosaic[0], "a mosaic cell is one flat colour");
	}
}
assert.equal(mosaic[3], 255);
assert.ok(Math.abs(mean(mosaic) - mean(frame)) < 1, "the mosaic keeps the frame's brightness");

// Blur: no hard edges left, brightness kept (no flicker between mosaic and blur frames).
const blurred = blurRgba(frame, W, H, 8, BLURMOVE.blurSigma);
let maxStep = 0;
for (let y = 0; y < H; y += 1) {
	for (let x = 1; x < W; x += 1) {
		const i = (y * W + x) * 4;
		maxStep = Math.max(maxStep, Math.abs(blurred[i] - blurred[i - 4]));
	}
}
assert.ok(maxStep < 12, `the blur leaves no edges (largest step between neighbours ${maxStep})`);
assert.ok(Math.abs(mean(blurred) - mean(frame)) < 6, `the blur keeps the brightness (${mean(blurred).toFixed(1)} vs ${mean(frame).toFixed(1)})`);
assert.equal(blurred[3], 255);

// Decorator: mosaic on cycle starts, blur otherwise; same size out; deterministic.
const decorate = createBlurmoveDecorator({ width: W, height: H, segmentStarts: [0, 6] });
const at0 = Uint8ClampedArray.from(decorate(0, frame));
assert.deepEqual(at0, mosaicRgba(frame, W, H, BLURMOVE.mosaicCols), "frame 0 is the 96-cell mosaic");
const at1 = Uint8ClampedArray.from(decorate(1, frame));
assert.deepEqual(at1, blurRgba(frame, W, H, BLURMOVE.blurCols, BLURMOVE.blurSigma), "frame 1 is the blur");
assert.deepEqual(Uint8ClampedArray.from(decorate(6, frame)), at0, "a new shot at frame 6 restarts on a mosaic frame");
assert.deepEqual(Uint8ClampedArray.from(decorate(1, frame)), at1, "the same frame decorates to the same pixels");
assert.equal(decorate(2, frame).length, W * H * 4);

// Pack: the video, a README, the fixed names.
const video = new Uint8Array([1, 2, 3]);
const entries = aiReferenceEntries({ video, fps: 24, frameCount: 720, shotCount: 4, size: { width: 1280, height: 720 } });
assert.deepEqual(entries.map((entry) => entry.name), [AI_REFERENCE_VIDEO, "README.txt"]);
assert.equal(entries[0].data, video);
assert.match(entries[1].data, /4 shots, 30\.00 s, 1280x720/);
assert.doesNotMatch(entries[1].data, /longer than/, "30 s fits the Seedance reference limit");
const long = aiReferenceEntries({ video, fps: 24, frameCount: 24 * (REFERENCE_MAX_SECONDS + 1), shotCount: 1, size: { width: 1280, height: 720 } });
assert.match(long.at(-1).data, /longer than 30 s/, "a timeline over 30 s is flagged");
const withExtra = aiReferenceEntries({ video, fps: 24, frameCount: 24, shotCount: 1, size: { width: 1280, height: 720 }, extra: [{ name: "prompt.txt", data: "x\n" }] });
assert.deepEqual(withExtra.map((entry) => entry.name), [AI_REFERENCE_VIDEO, "prompt.txt", "README.txt"]);
assert.ok(buildAiReferencePack({ video, fps: 24, frameCount: 24, shotCount: 1, size: { width: 1280, height: 720 } }) instanceof Uint8Array);
assert.equal(AI_REFERENCE_ZIP, "cozyclay-ai-reference.zip");

console.log("blurmove reference verified");
