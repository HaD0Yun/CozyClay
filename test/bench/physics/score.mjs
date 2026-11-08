#!/usr/bin/env node
// take.json + its task -> one score (docs/qa/physics-bench.md, PR 3): the task conditions (tasks.mjs) and the shared
// violations (checks.mjs). Diagnostic only; the human verdicts decide quality.
//   node test/bench/physics/score.mjs <take.json> <set id or task> [--out score.json]
//   node test/bench/physics/score.mjs --runs-dir ~/physics-bench/runs     (every run with a take: <run>/score.json)
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { measure, shared } from "./checks.mjs";
import { loadSets } from "./sets.mjs";
import { readTake } from "./take.mjs";
import { TASKS } from "./tasks.mjs";

/** The score of one take of `set`. */
function scoreTake(take, set) {
	const m = measure(take, set), conditions = TASKS[set.task](m);
	return { set: set.id, task: set.task, frames: take.frames, passed: conditions.filter(x => x.pass).length, total: conditions.length, conditions, shared: shared(m) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const at = n => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : null; };
	if (at("runs-dir")) {
		const sets = loadSets(), dir = at("runs-dir");
		for (const d of readdirSync(dir).filter(d => existsSync(join(dir, d, "take.json")) && !d.includes("probe"))) {
			const set = sets.find(s => d.startsWith(`${s.id}-`));
			try { const sc = scoreTake(readTake(join(dir, d, "take.json")), set); writeFileSync(join(dir, d, "score.json"), JSON.stringify(sc, null, 1)); console.log(`${d}: ${sc.passed}/${sc.total}`); } catch (e) { console.log(`${d}: ${e.message}`); }
		}
	} else {
		const [file, which] = process.argv.slice(2), [set] = loadSets([which]);
		const sc = scoreTake(readTake(file), set);
		if (at("out")) writeFileSync(at("out"), JSON.stringify(sc, null, 1));
		for (const x of sc.conditions) console.log(`${x.pass ? "PASS" : "FAIL"}  ${x.name}  ${x.value ?? ""}`);
		console.log(`${sc.passed}/${sc.total}; shared: ${JSON.stringify(sc.shared)}`);
	}
}
