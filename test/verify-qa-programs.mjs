import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Only the CDP transport is replaced: finish() and Node's exit status are real.
const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
	globalThis.fetch = async () => ({ json: async () => [{ type: "page", url: "/app/", webSocketDebuggerUrl: "ws://qa" }] });
	globalThis.WebSocket = class {
		constructor() { queueMicrotask(() => this.onopen()); }
		close() {}
	};
	const { connectStudio } = await import("./test/qa-stage-hdr-harness.mjs");
	process.exitCode = 7;
	const { finish } = await connectStudio(0);
	finish("later-pass");
	console.log("REACHED_AGGREGATE_RESULT");
`], { cwd: new URL("..", import.meta.url), encoding: "utf8" });
assert.equal(result.status, 7, `a later successful QA must preserve the earlier failure:\n${result.stdout}\n${result.stderr}`);
assert.match(result.stdout, /REACHED_AGGREGATE_RESULT/, "success returns control to the aggregate runner");
console.log("PASS successful HDR QA preserves earlier failure and returns to its caller");

const directory = mkdtempSync(join(tmpdir(), "cozyclay-qa-programs-"));
const cwd = new URL("..", import.meta.url);
const run = (...args) => spawnSync(process.execPath, ["tools/run-qa.mjs", "--node", ...args], { cwd, encoding: "utf8", timeout: 10000 });
try {
	const fail = join(directory, "verify-fail.mjs");
	const pass = join(directory, "verify-pass.mjs");
	const crash = join(directory, "verify-crash.mjs");
	writeFileSync(fail, "console.error('EARLIER_FAILURE'); process.exitCode = 3;");
	writeFileSync(pass, "console.log('LATER_SUCCESS'); process.exit(0);");
	writeFileSync(crash, "throw new Error('UNCAUGHT_FAILURE');");
	for (const first of [fail, crash]) {
		const combined = run(first, pass);
		assert.equal(combined.status, 1, combined.stdout + combined.stderr);
		assert.ok(combined.stdout.includes(`FAIL ${first} (exit ${first === fail ? 3 : 1})`), combined.stdout);
		assert.ok(combined.stdout.includes(`PASS ${pass} (exit 0)`), "later program still runs and gets its own result");
		assert.match(combined.stderr, first === fail ? /EARLIER_FAILURE/ : /UNCAUGHT_FAILURE/);
		console.log(`PASS combined run attributes ${first === fail ? "exit status" : "uncaught assertion"} failure despite later explicit success`);
	}
	const clean = run(pass, pass);
	assert.equal(clean.status, 0, clean.stderr);
	assert.equal(clean.stdout.split(`PASS ${pass} (exit 0)`).length - 1, 2);
	console.log("PASS clean combined programs each report success");
	const cast = join(directory, "cast-browser-smoke.mjs");
	writeFileSync(cast, "console.log('CAST_PROGRAM_RAN');");
	const selfOwned = run(cast);
	assert.equal(selfOwned.status, 0, selfOwned.stderr);
	assert.match(selfOwned.stdout, /CAST_PROGRAM_RAN/, "the self-owned cast program actually executes");
	console.log("PASS self-owned cast smoke runs as a program rather than a helper");
	for (const helper of ["test/camera-browser-harness.mjs", "test/cast-identity-scenario.mjs", "test/qa-stage-hdr-harness.mjs", "test/bus/browser-frame-state.mjs"]) {
		const refused = run(pass, helper);
		assert.equal(refused.status, 2, refused.stderr);
		assert.ok(refused.stderr.includes(`Not a standalone QA program: ${helper}`));
		assert.doesNotMatch(refused.stdout, /RUNNING/, "preflight rejects helpers before running any program");
	}
	assert.equal(run().status, 2, "empty program list is not a successful run");
	assert.equal(run(join(directory, "verify-missing.mjs")).status, 2, "missing program is rejected");
	console.log("PASS helpers, missing files and empty lists are refused before execution");
} finally {
	rmSync(directory, { recursive: true, force: true });
}
