#!/usr/bin/env node
// The pace of a travel (src/lowvis/pi/compile-tool.mjs, feature pace): with the features of variant studio the
// motion tool's answer to a walking spec has a travel line with the distance, the speed and the steps per minute;
// with pace switched off it has none. The scene and the spec are written here: a 3 m walk over 60 frames.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCompileTool } from "../../src/lowvis/pi/compile-tool.mjs";

const dir = mkdtempSync(join(tmpdir(), "lowvis-pace-"));
const scene = { frames: 60, characters: [{ id: "a", at: [0, 0], heading: 0 }], props: [] };
const spec = { a: [[0, "walk", { to: [0, 3] }]] };
const answer = off => createCompileTool({ name: `pace-${off.length}`, outDir: join(dir, `out-${off.length}`), clipFile: join(dir, `clip-${off.length}.json`), variant: "studio", off }).call({ scene, spec });
try {
	const on = answer([]);
	assert.equal(on.status, "ok", on.text);
	const lines = on.text.split("\n"), head = lines.indexOf("travel (what each stretch of walk, run or push came out as):");
	assert.ok(head >= 0, `a travel block is in the answer:\n${on.text}`);
	const line = lines[head + 1], m = /^- a f(\d+)-(\d+) walk: ([\d.]+) m in ([\d.]+) s = ([\d.]+) m\/s, (\d+) steps? = (\d+) per minute$/.exec(line);
	assert.ok(m, `one line with distance, speed and steps per minute: ${line}`);
	const [distance, seconds, speed, steps, cadence] = [m[3], m[4], m[5], m[6], m[7]].map(Number);
	assert.ok(Math.abs(distance - 3) < 0.35, `about 3 m walked: ${distance}`);
	assert.ok(seconds > 0 && seconds <= 2.5 && Math.abs(speed - distance / seconds) < 0.02, `speed is distance over time: ${line}`);
	assert.ok(steps >= 2 && cadence > 0, `steps and a cadence: ${line}`);
	console.log(`ok studio: ${line}`);

	const off = answer(["pace"]);
	assert.equal(off.status, "ok", off.text);
	assert.ok(!/^travel /m.test(off.text) && !/ walk: [\d.]+ m in /.test(off.text), `no travel line with pace off:\n${off.text}`);
	console.log("ok studio, off pace: no travel line");
} finally {
	rmSync(dir, { recursive: true, force: true });
}
console.log("PASS verify-pace-line");
