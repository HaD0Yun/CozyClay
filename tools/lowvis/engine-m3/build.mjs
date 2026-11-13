#!/usr/bin/env node
// Builds the m3 engines' clips: public/lowvis/clips/m3-xbot/<demo>.json and public/lowvis/clips/m3-17/<demo>.json.
//   node tools/lowvis/engine-m3/build.mjs [--engine m3-xbot|m3-17] [--demo <id>] [--verbose]
// Each clip is checked with validateClip before it is written; buildMs (time inside the compiler) is printed per demo.
import { mkdirSync, writeFileSync } from "node:fs";
import { serializeClip, validateClip } from "../../../src/lowvis/clip.js";
import { ENGINES, buildDemo } from "../../../src/lowvis/engine-m3/engine.js";
import { SPECS } from "../../../src/lowvis/engine-m3/specs/index.js";

const arg = name => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? null : process.argv[i + 1]; };
const engines = arg("engine") ? [arg("engine")] : Object.keys(ENGINES), demos = arg("demo") ? [arg("demo")] : Object.keys(SPECS), verbose = process.argv.includes("--verbose");
let failed = 0;
for (const engine of engines) {
	const outDir = new URL(`../../../public/lowvis/clips/${engine}/`, import.meta.url);
	mkdirSync(outDir, { recursive: true });
	for (const demo of demos) {
		let built;
		try { built = buildDemo(engine, demo); } catch (error) {
			failed += 1;
			console.error(`${engine}/${demo}: FAILED ${verbose ? error.stack : error.message.split("\n")[0]}`);
			continue;
		}
		const { clip, detail } = built, text = serializeClip(clip), check = validateClip(JSON.parse(text));
		if (!check.ok) { failed += 1; console.error(`${engine}/${demo}: INVALID ${check.errors.join("; ")}`); continue; }
		writeFileSync(new URL(`${demo}.json`, outDir), text);
		console.log(`${engine}/${demo}: ok, ${clip.frameCount} frames, buildMs ${clip.stats.buildMs}, stretch ${check.stretch.toExponential(1)} m, QA problems ${JSON.stringify(clip.stats.qaProblems)}, ${(text.length / 1024).toFixed(0)} KB`);
		if (verbose) console.log(JSON.stringify(detail, null, 1), clip.notes);
	}
}
process.exit(failed ? 1 : 0);
