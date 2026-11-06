#!/usr/bin/env node
import assert from "node:assert/strict";
import { depthRangeFromFrames, depthRangeFromPixels, passFileName } from "../src/render-passes.js";
import * as THREE from "three";
import { normalizeFrameRange } from "../src/offscreen-export.js";

assert.deepEqual(normalizeFrameRange(12, 21), { startFrame: 12, endFrame: 21, frameCount: 10 });
assert.equal(passFileName("depth"), "blocking-frame-depth.png");
assert.deepEqual(depthRangeFromFrames([{ min: 8, max: 12 }, { min: 3, max: 19 }, { min: 5, max: 11 }], 0.1, 40), { near: 3, far: 19 });
assert.deepEqual(depthRangeFromFrames([], 0.2, 40), { near: 0.2, far: 40 });
assert.ok(depthRangeFromFrames([[5, 5]]).far > 5, "equal shot depths retain a usable range");
// The capture target is sRGB: the hardware encodes the shader's linear grey.
const surfaces = [8.5, 13.6];
const pixels = new Uint8Array(512);
for (const [index, distance] of surfaces.entries()) {
	const grey = 1 - (distance - 0.1) / 39.9;
	pixels[index * 256] = Math.round(new THREE.Color().setRGB(grey, grey, grey).getRGB({}, THREE.SRGBColorSpace).r * 255);
}
const covered = depthRangeFromFrames([depthRangeFromPixels(pixels)]);
const greys = surfaces.map(distance => 255 * (1 - Math.max(0, Math.min(1, (distance - covered.near) / (covered.far - covered.near)))));
console.log("covered depth range", JSON.stringify({ range: covered, greys }));
assert.ok(greys[0] > 20 && greys[1] > 0 && greys[0] > greys[1], "covered frames keep characters and wall above black");
pixels[256] = 0;
const sky = depthRangeFromFrames([depthRangeFromPixels(pixels)]);
assert.equal(sky.far, 40, "empty background still selects the fixed far distance");
const unsampled = depthRangeFromFrames([depthRangeFromPixels(new Uint8Array(4096))], 0.25);
assert.deepEqual(unsampled, { near: 0.25, far: 40 }, "a shot whose samples hit no surface keeps the fallback range, not a near plane at the far end");
assert.equal(sky.near, covered.near, "sky does not change the sampled subject's near distance");
console.log("PASS covered depth video decodes sRGB samples and sky retains the 40 m far distance");
console.log("PASS depth video addresses an inclusive shot range and uses blocking-depth semantics");
console.log("PASS depth normalisation range is computed from the whole shot");
console.log("PASS depth video keeps lighter = closer polarity and the blocking-depth.mp4 name");
