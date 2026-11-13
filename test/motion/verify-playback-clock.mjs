import assert from "node:assert/strict";
import { createPlaybackClock } from "../../src/motion/playback-clock.js";

for (const fps of [24, 29.97, 30, 60]) for (const speed of [.5, 1, 2]) {
	for (const callbacks of [[41, 84, 125, 166, 1000, 4200], [260, 530, 970, 1886, 4200], [4200]]) {
		const tick = createPlaybackClock(fps, speed, 100);
		let frames = 0;
		for (const time of callbacks) frames += tick(100 + time);
		assert.equal(frames, Math.floor(4.2 * fps * speed + 1e-8));
		assert.equal(tick(4300), 0, "no duplicate advances");
		assert.equal(tick(200), 0, "backwards timestamps cannot rewind");
		assert.equal(tick(NaN), 0);
	}
}
const clock = createPlaybackClock(24, 1, 0);
assert.equal(clock(20), 0);
assert.equal(clock(42), 1);
assert.equal(clock(1000), 23, "catch up after a stalled render");
assert.equal(createPlaybackClock(24, 1, 5000)(5042), 1, "resume starts a fresh epoch");
console.log("PASS playback clock: stalled timers, fractional rates, preview speed, no duplicate frames, resume");
