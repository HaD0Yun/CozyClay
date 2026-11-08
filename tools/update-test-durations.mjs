#!/usr/bin/env node
// Usage: node tools/update-test-durations.mjs [RUN_ID]
// Refreshes tools/test-durations.json from the test-durations-N artifacts of
// the latest successful pages.yml run on main (or of RUN_ID). Only main runs
// are full runs, so only they feed the file. A person runs this and commits
// the result in a pull request; no workflow writes to main (#632).
// GH_REPO overrides the repository (default HaD0Yun/CozyClay).
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DURATIONS_PATH, readDurations, writeDurations } from "./test-shards.mjs";

const repo = process.env.GH_REPO || "HaD0Yun/CozyClay";
const gh = (...arguments_) => execFileSync("gh", [...arguments_, "--repo", repo], { encoding: "utf8" });
const latest = () => JSON.parse(gh("run", "list", "--workflow", "pages.yml", "--branch", "main", "--status", "success", "--limit", "1", "--json", "databaseId"))[0]?.databaseId;
const runId = process.argv[2] ?? latest();
if (!runId) throw new Error(`no successful pages.yml run on main in ${repo}`);

const scratch = mkdtempSync(join(tmpdir(), "cozyclay-test-durations-"));
try {
	gh("run", "download", String(runId), "--pattern", "test-durations-*", "--dir", scratch);
	const merged = readDurations();
	let measured = 0;
	for (const artifact of readdirSync(scratch)) {
		for (const file of readdirSync(join(scratch, artifact)).filter((name) => name.endsWith(".json"))) {
			for (const [test, seconds] of Object.entries(JSON.parse(readFileSync(join(scratch, artifact, file), "utf8")))) {
				if (!Number.isFinite(seconds)) continue;
				merged[test] = seconds;
				measured += 1;
			}
		}
	}
	if (measured === 0) throw new Error(`run ${runId} has no test-durations-N artifacts with entries`);
	// Files deleted since the last refresh drop out; files the run did not
	// execute keep their old record.
	const kept = Object.fromEntries(Object.entries(merged).filter(([test]) => existsSync(new URL(`../${test}`, import.meta.url))));
	writeDurations(DURATIONS_PATH, kept);
	console.log(`test durations: ${measured} files measured in run ${runId}, ${Object.keys(kept).length} recorded in tools/test-durations.json`);
} finally {
	rmSync(scratch, { recursive: true, force: true });
}
