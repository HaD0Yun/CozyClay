#!/usr/bin/env node
// tools/lowvis/pi/replay.mjs: the prop column of compare, read from the inside rows of the rebuilt clips (it read a row
// the clips no longer have, so it was 0 for every clip).
//  1. a body that walks through a prop, and the same walk with the prop out of the way: the build keeps the body's
//     inside row, and compare counts the clear build as better on prop and the other way round as worse, in the row's mm
//  2. a build nothing says has the inside measure (no inside: true in its _meta.json, no inside row in a clip, as a tree
//     without the measure builds it): prop is left out of the comparison with a line that says so; it is not read as 0
//  3. a build whose _meta.json lacks the mark (an older replay wrote none) but whose clips hold inside rows is compared
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../.."), TOOL = join(ROOT, "tools/lowvis/pi/replay.mjs"), OUT = join(ROOT, "lowvis-out/replay");
const tmp = mkdtempSync(join(tmpdir(), "replay-prop-")), tag = k => `verify-replay-prop-${process.pid}-${k}`, TAGS = ["through", "clear", "unmarked", "bare"].map(tag);
const load = f => JSON.parse(readFileSync(f, "utf8"));
const { COZYCLAY_FIGURE: _look, ...ENV } = process.env; // the default look, whatever this test was started with
const replay = (...args) => { const r = spawnSync(process.execPath, [TOOL, ...args], { cwd: ROOT, encoding: "utf8", env: ENV }); assert.equal(r.status, 0, `replay ${args.join(" ")}: ${r.stderr}`); return r.stdout; };
const result = out => JSON.parse(out.split("\n").find(line => line.startsWith("{\"runs\"")));

try {
	// one stored run per build: the crate stands on the walk's path, or 1.5 m beside it
	const run = x => ({ request: "walks", variant: "studio", final: { scene: { frames: 60, characters: [{ id: "a", at: [0, 0], heading: 0 }], props: [{ id: "crate", size: [0.6, 1, 0.6], at: [x, 0.5, 1] }] }, spec: { a: [[0, "idle"], [6, "walk", { to: [0, 2] }]] } } });
	for (const [k, x] of [["through", 0], ["clear", 1.5]]) {
		mkdirSync(join(tmp, k, "walk"), { recursive: true });
		writeFileSync(join(tmp, k, "walk", "run.json"), JSON.stringify(run(x)));
		assert.match(replay("build", tag(k), "--runs", join(tmp, k)), /built 1 runs .* failed 0/);
	}
	const rows = k => Object.entries(load(join(OUT, tag(k), "walk.json")).stats.checks).filter(([key]) => key.startsWith("inside:"));
	const [through] = rows("through");
	assert.equal(rows("through").length, 1, "the walk through the crate has one inside row");
	assert.equal(through[0], "inside:a>crate");
	assert.ok(through[1].value > 100, `and it is deep (${through[1].value} mm)`);
	assert.equal(rows("clear").length, 0, "the walk beside the crate has none");
	assert.equal(load(join(OUT, tag("through"), "_meta.json")).inside, true, "build marks that its tree has the inside measure");

	// --- 1 ---
	const better = replay("compare", tag("through"), tag("clear")), worse = replay("compare", tag("clear"), tag("through"));
	assert.deepEqual(result(better), { runs: 1, unchanged: 0, changed: 1, failedBefore: 0, failedAfter: 0, newlyFailed: [], missingInB: 0, worse: 0, better: { reach: 0, floor: 0, prop: 1, slide: 0 } }, "the crate out of the way: better on prop only");
	assert.equal(result(worse).worse, 1);
	assert.deepEqual(result(worse).better, { reach: 0, floor: 0, prop: 0, slide: 0 });
	assert.ok(worse.includes(`walk prop 0 -> ${through[1].value.toFixed(0)} mm`), `the crate into the way: worse on prop by the row's depth:\n${worse}`);
	assert.ok(!better.includes("not compared") && !worse.includes("not compared"));

	// --- 2 and 3: the through build again, without the mark; and without its inside rows too ---
	for (const [k, strip] of [["unmarked", false], ["bare", true]]) {
		const { inside: _mark, ...meta } = load(join(OUT, tag("through"), "_meta.json")), clip = load(join(OUT, tag("through"), "walk.json"));
		if (strip) clip.stats.checks = Object.fromEntries(Object.entries(clip.stats.checks).filter(([key]) => !key.startsWith("inside:")));
		mkdirSync(join(OUT, tag(k)), { recursive: true });
		writeFileSync(join(OUT, tag(k), "_meta.json"), JSON.stringify(meta));
		writeFileSync(join(OUT, tag(k), "walk.json"), JSON.stringify(clip));
	}
	for (const [x, y] of [["bare", "clear"], ["clear", "bare"]]) {
		const out = replay("compare", tag(x), tag(y));
		assert.ok(out.includes(`prop: not compared: nothing says that ${tag("bare")} was built with the inside measure`), `${x} against ${y}: the line that prop is left out:\n${out}`);
		assert.deepEqual(result(out).better, { reach: 0, floor: 0, slide: 0 }, "and no prop count");
		assert.equal(result(out).worse, 0, "nor a prop line");
	}
	assert.deepEqual(result(replay("compare", tag("unmarked"), tag("clear"))).better, { reach: 0, floor: 0, prop: 1, slide: 0 }, "no mark but inside rows in the clips: compared");
	assert.equal(result(replay("compare", tag("clear"), tag("unmarked"))).worse, 1);
	console.log(`PASS verify-replay-prop: prop reads the body's inside row (${through[1].value.toFixed(0)} mm), better and worse are counted from it, and a build not known to have the measure is left out with a line`);
} finally {
	for (const t of TAGS) rmSync(join(OUT, t), { recursive: true, force: true });
	rmSync(tmp, { recursive: true, force: true });
}
