#!/usr/bin/env node
import { frameFromClientX } from "../../src/motion/timeline-coordinates.js";

let failures = 0;
function expect(name, actual, wanted) {
	const ok = actual === wanted;
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` — got ${actual}, wanted ${wanted}`}`);
	if (!ok) failures += 1;
}
function clientXForFrame(frame, left, width, displayFrameCount) {
	return left + (frame / (displayFrameCount - 1)) * width;
}
const frameCount = 181; // frames 0..180, matching the screenshot's ruler
const left = 148;
const width = 1452;
for (const zoom of [0.25, 0.5, 1]) {
	const displayFrameCount = zoom < 1 ? Math.ceil(frameCount / zoom) : frameCount;
	const x = clientXForFrame(140, left, width, displayFrameCount);
	expect(`${zoom}x click on tick 140 resolves frame 140`, frameFromClientX(x, left, width, displayFrameCount, frameCount), 140);
}
const zoomedWidth = width * 2;
const scrolledLeft = left - 600;
const scrolledX = clientXForFrame(100, scrolledLeft, zoomedWidth, frameCount);
expect("2x scrolled click resolves frame 100", frameFromClientX(scrolledX, scrolledLeft, zoomedWidth, frameCount, frameCount), 100);
expect("zoom-out virtual frames beyond clip clamp to final frame", frameFromClientX(left + width, left, width, 724, frameCount), 180);
expect("left of lane clamps to frame 0", frameFromClientX(left - 500, left, width, frameCount, frameCount), 0);

if (failures) process.exit(1);
console.log("all timeline coordinate checks PASS");
