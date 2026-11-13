#!/usr/bin/env node
import { groupKeyRuns, KEY_RUN_MIN } from "../../src/motion/timeline-coordinates.js";

let failures = 0;
function expect(name, ok, detail = "") {
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` — ${detail}`}`);
	if (!ok) failures += 1;
}
const shape = (runs) => runs.map((run) => `${run.start}-${run.end}:${run.length}`).join(" ");

expect("empty input yields no runs", shape(groupKeyRuns([])) === "", shape(groupKeyRuns([])));
expect("missing input yields no runs", shape(groupKeyRuns()) === "", shape(groupKeyRuns()));
expect("a single key is a run of one", shape(groupKeyRuns([7])) === "7-7:1", shape(groupKeyRuns([7])));

// The bug this exists for: Fix Collisions bakes 43 keys on 44–86 and
// AutoPhysics 17 more on 104–120. Two bars, not sixty diamonds.
const baked = [
	...Array.from({ length: 43 }, (_, i) => 44 + i),
	...Array.from({ length: 17 }, (_, i) => 104 + i),
];
expect("baked passes collapse to two runs", shape(groupKeyRuns(baked)) === "44-86:43 104-120:17", shape(groupKeyRuns(baked)));

// Order is the caller's business, not the helper's — the lane hands over
// whatever the edit history produced.
expect("unsorted input sorts before grouping", shape(groupKeyRuns([9, 2, 10, 1, 3])) === "1-3:3 9-10:2", shape(groupKeyRuns([9, 2, 10, 1, 3])));
expect("duplicate frames never split or lengthen a run", shape(groupKeyRuns([4, 4, 5, 5, 6])) === "4-6:3", shape(groupKeyRuns([4, 4, 5, 5, 6])));

// A gap of one frame is a real gap: 10,11,13 is NOT one run of three.
expect("a one-frame gap starts a new run", shape(groupKeyRuns([10, 11, 13])) === "10-11:2 13-13:1", shape(groupKeyRuns([10, 11, 13])));
expect("adjacent runs stay separate", shape(groupKeyRuns([0, 1, 2, 4, 5, 6])) === "0-2:3 4-6:3", shape(groupKeyRuns([0, 1, 2, 4, 5, 6])));
expect("singletons scattered across the clip stay singletons", shape(groupKeyRuns([0, 12, 24])) === "0-0:1 12-12:1 24-24:1", shape(groupKeyRuns([0, 12, 24])));
expect("frame zero groups like any other frame", shape(groupKeyRuns([0, 1, 2])) === "0-2:3");

// length is exactly the key count, so the tooltip's "(43)" cannot drift from
// the number of keys the removal gesture can reach inside the bar.
const runs = groupKeyRuns(baked);
expect("run length equals the frames it spans", runs.every((run) => run.length === run.end - run.start + 1), JSON.stringify(runs));
expect("every input frame lands in exactly one run", baked.every((f) => runs.filter((run) => f >= run.start && f <= run.end).length === 1));

// Only crowded runs earn the bar; one or two keys keep the diamonds.
expect("the bar threshold leaves 1- and 2-key runs as diamonds", KEY_RUN_MIN === 3, String(KEY_RUN_MIN));
expect("a 2-key run stays below the threshold", groupKeyRuns([30, 31])[0].length < KEY_RUN_MIN);
expect("a 3-key run reaches the threshold", groupKeyRuns([30, 31, 32])[0].length >= KEY_RUN_MIN);

if (failures) process.exit(1);
console.log("all key run checks PASS");
