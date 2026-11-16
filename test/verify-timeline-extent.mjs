#!/usr/bin/env node
import assert from "node:assert/strict";
import { shotsFollowingTake, timelineContentExtent, timelineSpan } from "../src/timeline-extent.js";

const charA = { id: "characterA", sessionMotion: { frames: 136 } };
const charB = { id: "characterB", sessionMotion: { frames: 192 } };

assert.equal(
	timelineContentExtent([charA, charB], "characterA", { frames: 136 }),
	192,
	"the shared clock spans the longest remaining cast take",
);
assert.equal(
	timelineContentExtent([charA], "characterA", { frames: 136 }),
	136,
	"deleting the longer character shrinks the clock",
);
assert.equal(
	timelineContentExtent([charA], "characterA", { frames: 72 }),
	72,
	"the active character's editing take, not its stored one, is measured",
);
assert.equal(
	timelineContentExtent([], null, null, 240),
	240,
	"ingested footage remains on the shared clock before any take",
);
assert.equal(
	timelineContentExtent([charA], "characterA", { frames: 136 }, 240),
	136,
	"a shorter take wins over its older, longer source footage",
);
assert.equal(
	timelineContentExtent([], null, null, 0),
	0,
	"empty content leaves the existing authored duration untouched",
);

const shots = [{ startFrame: 0, endFrame: 95 }, { startFrame: 96, endFrame: 239 }];
assert.equal(timelineSpan(136, shots), 240, "the timeline covers the last shot's inclusive end frame");
assert.equal(timelineSpan(300, shots), 300, "longer content keeps its own extent");
assert.equal(timelineSpan(136, []), 136, "no shots: the content extent wins");
assert.equal(timelineSpan(0, shots, 120), 240, "an empty scene still grows to cover its shots");
assert.equal(timelineSpan(0, [{ startFrame: 0, endFrame: 47 }], 120), 120, "an empty scene never shrinks under its authored duration");
assert.equal(timelineSpan(0, [], 120), 120, "no content and no shots keep the existing duration");
assert.equal(timelineSpan(136, [{ startFrame: 0 }, null]), 136, "a shot without an end frame sets no floor");

// a timing edit moves the take's last frame: the shot that ended with it follows, so the span follows the take
const overTake = [{ startFrame: 0, endFrame: 99 }, { startFrame: 100, endFrame: 229 }];
const trimmed = shotsFollowingTake(overTake, 229, 110);
assert.deepEqual(trimmed.map(shot => shot.endFrame), [99, 110], "a trim pulls the shot that ended with the take to the new end");
assert.equal(timelineSpan(111, trimmed), 111, "after a trim the timeline is the trimmed take's length");
assert.equal(timelineSpan(111, overTake), 230, "without the follow the old shot holds the old length");
assert.equal(shotsFollowingTake(overTake, 229, 329)[1].endFrame, 329, "a slow-down stretches it with the take");
assert.equal(shotsFollowingTake(overTake, 229, 50)[1].endFrame, 100, "a shot never ends before its own first frame");
assert.equal(shotsFollowingTake(overTake, 239, 110)[1], overTake[1], "a shot that did not end with the take keeps its range");
assert.equal(shotsFollowingTake(overTake, 229, 229), overTake, "no change in length leaves the shots as they are");

console.log("verify-timeline-extent: all checks passed");
