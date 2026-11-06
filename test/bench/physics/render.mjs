#!/usr/bin/env node
// Render every counted take of a task with the same renderer and the same two cameras (docs/qa/physics-bench.md,
// PR 5). The camera box is the union of every take of the task (both tools, all runs) and the set's objects, so the
// framing never tells the tools apart. Writes <run>/side.mp4 and <run>/front.mp4.
//   node test/bench/physics/render.mjs --sets 10 [--runs-dir ~/physics-bench/runs] [--force]
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BLENDER } from "./blender-run.mjs";
import { loadSets } from "./sets.mjs";
import { landmarksAt, objectMatrixAt, readTake } from "./take.mjs";

const HERE = new URL(".", import.meta.url).pathname, REPO = join(HERE, "../../..");
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const RUNS = arg("runs-dir", join(homedir(), "physics-bench/runs")), FORCE = process.argv.includes("--force");

/** The counted run dirs of a set that hold a take (probes excluded). */
function takesOf(set, runsDir = RUNS) {
	const re = new RegExp(`^${set.id}-(cozyclay|blender)-r\\d+$`);
	return readdirSync(runsDir).filter(d => re.test(d) && existsSync(join(runsDir, d, "take.json"))).map(d => join(runsDir, d));
}

function viewBox(set, dirs) {
	const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
	const grow = p => p.forEach((v, i) => { lo[i] = Math.min(lo[i], v); hi[i] = Math.max(hi[i], v); });
	for (const o of set.objects.filter(o => o.size)) for (const s of [-1, 1]) grow(o.center.map((c, i) => c + (s * o.size[i]) / 2));
	grow(set.character.position);
	for (const dir of dirs) {
		const take = readTake(join(dir, "take.json"));
		for (let f = 0; f < take.frames; f += 2) {
			Object.values(landmarksAt(take, "char-a", f)).forEach(grow);
			for (const id of Object.keys(take.objects)) if (take.objects[id].matrix.length > 1) { const m = objectMatrixAt(take, id, f); grow([m[3], m[7], m[11]]); }
		}
	}
	return { min: lo, max: hi };
}

for (const set of loadSets(arg("sets", "").split(",").filter(Boolean))) {
	const dirs = takesOf(set);
	if (!dirs.length) { console.log(`${set.id}: no takes`); continue; }
	const view = viewBox(set, dirs), viewPath = join(RUNS, `${set.id}.view.json`);
	writeFileSync(viewPath, JSON.stringify(view));
	for (const dir of dirs) {
		if (!FORCE && existsSync(join(dir, "side.mp4")) && existsSync(join(dir, "front.mp4"))) continue;
		const start = join(dir, "render-start.blend");
		execFileSync(BLENDER, ["-b", "--factory-startup", "--python", join(HERE, "blender/build_scene.py"), "--", join(HERE, "sets", `${set.id}.json`), join(REPO, "public/models/y-bot-tpose.fbx"), start], { stdio: "ignore", timeout: 300_000 });
		const t0 = Date.now();
		execFileSync(BLENDER, ["-b", start, "--python", join(HERE, "blender/render.py"), "--", join(dir, "take.json"), dir, viewPath], { stdio: "ignore", timeout: 3_600_000 });
		console.log(`${dir}: rendered in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
	}
}
