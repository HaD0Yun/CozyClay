#!/usr/bin/env node
// Standalone programs are not test-runner modules. Each needs its own process
// and, for browser QA, a fresh profile/page lifetime (including storage).
import { installSignalCleanup, spawnOwned, terminateOwned, waitForExit } from "./process-supervisor.mjs";
import { statSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

const programs = process.argv.slice(2);
const nodeOnly = programs[0] === "--node";
if (nodeOnly) programs.shift();
if (!programs.length || programs.some((program) => program.startsWith("-"))) {
	console.error("usage: node tools/run-qa.mjs [--node] <program.mjs> [...]");
	process.exit(2);
}
// Helpers (camera-browser-harness, cast-identity-scenario, browser-* and the
// HDR harness) are imported by programs, never executed as successful suites.
for (const program of programs) {
	if (!/^(?:qa-.+-browser|verify(?:-.+)?|cast-browser-smoke)\.mjs$/.test(basename(program)) || !statSync(program, { throwIfNoEntry: false })?.isFile()) {
		console.error(`Not a standalone QA program: ${program}`);
		process.exit(2);
	}
}

let child;
let stopping = false;
let failures = 0;
const removeSignalCleanup = installSignalCleanup(() => {
	stopping = true;
	return child ? [child] : [];
});
try {
	for (const program of programs) {
		if (stopping) break;
		console.log(`\nRUNNING ${program}`);
		child = spawnOwned(process.execPath, nodeOnly
			? [program]
			: [fileURLToPath(new URL("./qa-browser.mjs", import.meta.url)), "--", process.execPath, program]);
		const { code, signal } = await waitForExit(child);
		if (code !== 0) failures += 1;
		console.log(`${code === 0 ? "PASS" : "FAIL"} ${program} (${signal || `exit ${code}`})`);
	}
	if (failures) process.exitCode = 1;
} finally {
	await terminateOwned(child);
	removeSignalCleanup();
}
