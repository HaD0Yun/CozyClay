#!/usr/bin/env node
// The repeat count of a difference (src/lowvis/pi/compile-tool.mjs, measure.mjs inARow): a check past its spike value
// that was past it in the compile before says for how many compiles in a row it has been, inside its [..] mark. The
// identity is the check, the character and the prop, not the frame: a place that moves a few frames stays the same
// difference. A look with the scene and spec unchanged, or the same spec sent again, does not count. A row in its normal
// range (a hand on a carried prop) never gets a count, and a call with no repeated spike has no count anywhere.
// The scene and spec are written here: a box carried and placed at a target out of reach, then within reach.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCompileTool } from "../../src/lowvis/pi/compile-tool.mjs";
import { inARow, rowId } from "../../src/lowvis/pi/measure.mjs";
import { systemPrompt } from "../../src/lowvis/pi/prompt.mjs";

const dir = mkdtempSync(join(tmpdir(), "lowvis-repeat-"));
const scene = { frames: 72, characters: [{ id: "a", at: [0, 0], heading: 0 }], props: [{ id: "box", size: [0.4, 0.3, 0.3], at: [0, 0.15, 0.6] }] };
const spec = (z, f = 40) => ({ a: [[0, "idle"], [10, "pose", { hands: { prop: "box" }, bow: 40, over: 14 }], [24, "carry", { prop: "box", at: [0, 0.1, 0.35] }], [f, "place", { prop: "box", at: [0, 0.15, z], over: 12 }]] });
const place = text => text.split("\n").find(l => l.startsWith("- place: box"));
try {
	const ids = { key: "place:box", prop: "box", value: 900, spike: 30, worse: 1 };
	assert.deepEqual(inARow([ids, { key: "carryGap", who: "a", prop: "box", value: 30, spike: 80, worse: 1 }], { [rowId(ids)]: 2 }), { [rowId(ids)]: 3 }, "only rows past their spike are counted, one more than before");

	// the inside flag is off: the carried box stands against the chest in every compile here (its own count would mix in)
	// the balance row is off: the body bent toward a target out of reach is off balance on every compile (verify-balance-row.mjs)
	const tool = createCompileTool({ name: "repeat", outDir: join(dir, "out"), clipFile: join(dir, "clip.json"), variant: "studio", off: ["inside", "balance"] });
	const first = tool.call({ scene, spec: spec(2.5) });
	assert.equal(first.status, "ok", first.text);
	assert.doesNotMatch(first.text, /in a row/, "the first compile has no count");
	assert.match(place(first.text), /^- place: box let go this far from its target: \d+\.\d mm @f\d+$/, "the first compile's row is as before");

	assert.match(place(tool.call({ spec: spec(2.4) }).text), /\[was \d+\.\d; spike 2 compiles in a row\]$/, "second compile: 2 in a row");
	assert.match(place(tool.call({ spec: spec(2.3, 44) }).text), /\[was \d+\.\d; spike 3 compiles in a row\]$/, "the place moved 4 frames: the same difference, 3 in a row");
	// three: the place and both hands off the place's target (reach rows, told in studio)
	assert.match(tool.call({ look: { view: "side" } }).text, /^checks: every number is the same as in the previous compile; 3 past their spike for 3 compiles in a row$/m, "a look does not count");
	assert.match(tool.call({ spec: spec(2.3, 44) }).text, /^checks: every number is the same as in the previous compile; 3 past their spike for 3 compiles in a row$/m, "the same spec again does not count");
	assert.match(place(tool.call({ spec: spec(2.2) }).text), /spike 4 compiles in a row\]$/, "a changed spec counts again");

	const fixed = tool.call({ spec: spec(0.7) });
	assert.doesNotMatch(fixed.text, /in a row/, `a place within reach is no spike and has no count:\n${fixed.text}`);
	assert.match(fixed.text, /^- carry: widest wrist gap to the prop: 30\.0 mm .*\[same\]$/m, "a hand on the carried prop stays [same], no count");
	const again = tool.call({ spec: spec(2.5) });
	assert.match(place(again.text), /\[was \d+\.\d, worse\]$/, `the spike that comes back starts again at 1:\n${again.text}`);

	for (const variant of ["base", "studio"]) assert.match(systemPrompt(variant), /for how many compiles in a row it has been one/, `the ${variant} prompt describes the count`);
	console.log("ok: counts 2, 3 (moved frames), 3 (look, same spec), 4, none after the fix, none for a hand on a prop, restart at 1");
} finally {
	rmSync(dir, { recursive: true, force: true });
}
console.log("PASS verify-repeat-count");
