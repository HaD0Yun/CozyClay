// The wiring, not the queue. The queue's own semantics are covered in
// director-runtime; what is unproven here is that anything in a running host
// ever looks at the directory the add-on writes to.
//
// That was the gap: every piece existed and was tested, and a request
// published from Blender still sat on disk forever because no process called
// the sweep.
import assert from "node:assert/strict";
import {
	access,
	chmod,
	constants,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { startRegenerateQueueRunner } from "../src/regenerate-queue-runner.ts";

const REVISION = "a".repeat(64);
const ENTITY = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

function aRequest(requestId: string, overrides: Record<string, unknown> = {}) {
	return {
		schema_version: 1,
		request_id: requestId,
		entity_id: ENTITY,
		base_motion_id: "base-clip",
		expected_revision_id: REVISION,
		effectors: [{ frame: 3, joint: "RightHand", x: 0.1, y: 0.2, z: 0.3 }],
		full_body: [],
		root_2d: [],
		requested_at_ms: 1_700_000_000_000,
		...overrides,
	};
}

// Stands in for scripts/cclay-ardy-generate: prints the one JSON line the
// handler parses, and records the argv it was handed.
const FAKE_WRAPPER = `#!/bin/sh
printf '%s\\n' "$@" > "$ARGV_LOG"
echo '{"motion_id":"regenerated-clip","frames":240,"residual":null,"continuity":{"mean_jump_m":0,"max_jump_m":0.01,"max_jump_frame":0}}'
`;

const FAILING_WRAPPER = `#!/bin/sh
echo "checkpoint missing" >&2
exit 3
`;

describe("regeneration queue runner", () => {
	let project: string;
	let wrapper: string;

	beforeEach(async () => {
		project = await mkdtemp(join(tmpdir(), "cclay-runner-"));
		wrapper = join(project, "fake-ardy");
	});

	afterEach(async () => {
		await rm(project, { recursive: true, force: true });
	});

	async function installWrapper(body: string) {
		await writeFile(wrapper, body, "utf8");
		await chmod(wrapper, 0o755);
	}

	async function publish(request: object) {
		const directory = join(project, ".cclay", "regenerate-requests");
		await mkdir(directory, { recursive: true });
		await writeFile(
			join(directory, `${(request as { request_id: string }).request_id}.json`),
			JSON.stringify(request),
			"utf8",
		);
	}

	it("consumes a request the add-on published and applies the clip", async () => {
		await installWrapper(FAKE_WRAPPER);
		process.env.ARGV_LOG = join(project, "argv.log");
		await publish(aRequest("from-blender"));

		const applied: Array<{ motionId: unknown; revision: unknown }> = [];
		const runner = startRegenerateQueueRunner({
			cwd: project,
			wrapperPath: wrapper,
			tickMs: 60_000,
			stageScene: async (request) => {
				const operation = request.operations[0] as { motion_id?: string };
				applied.push({
					motionId: operation.motion_id,
					revision: request.expected_revision_id,
				});
				return { resulting_revision_id: "b".repeat(64) };
			},
		});
		await runner.started;
		await runner.stop();

		assert.deepEqual(applied, [{ motionId: "regenerated-clip", revision: REVISION }]);
		const outcome = JSON.parse(
			await readFile(join(project, ".cclay", "regenerate-outcomes", "from-blender.json"), "utf8"),
		);
		assert.equal(outcome.status, "succeeded");
		assert.equal(outcome.result.motion_id, "regenerated-clip");
		assert.deepEqual(await readdir(join(project, ".cclay", "regenerate-requests")), []);
	});

	it("passes the constraint through to the wrapper as separate argv words", async () => {
		// A coordinate concatenated into one token, or a shell string, would
		// let a value escape its positional slot in the generator's grammar.
		await installWrapper(FAKE_WRAPPER);
		const argvLog = join(project, "argv.log");
		process.env.ARGV_LOG = argvLog;
		await publish(aRequest("argv-check"));

		const runner = startRegenerateQueueRunner({
			cwd: project,
			wrapperPath: wrapper,
			tickMs: 60_000,
			stageScene: async () => ({ resulting_revision_id: "b".repeat(64) }),
		});
		await runner.started;
		await runner.stop();

		const argv = (await readFile(argvLog, "utf8")).split("\n").filter(Boolean);
		assert.ok(argv.includes("--base-motion"), argv.join(" "));
		assert.ok(argv.includes("base-clip"));
		const constrain = argv.indexOf("--constrain");
		assert.notEqual(constrain, -1);
		assert.deepEqual(argv.slice(constrain + 1, constrain + 6), [
			"3",
			"RightHand",
			"0.1",
			"0.2",
			"0.3",
		]);
	});

	it("records a wrapper failure instead of applying anything", async () => {
		// The add-on has already detached by now, so a failure that produced no
		// file would be indistinguishable from a host that never started.
		await installWrapper(FAILING_WRAPPER);
		await publish(aRequest("doomed"));

		let applications = 0;
		const runner = startRegenerateQueueRunner({
			cwd: project,
			wrapperPath: wrapper,
			tickMs: 60_000,
			stageScene: async () => {
				applications += 1;
				return { resulting_revision_id: "b".repeat(64) };
			},
		});
		await runner.started;
		await runner.stop();

		assert.equal(applications, 0, "a failed generation must not commit a revision");
		const outcome = JSON.parse(
			await readFile(join(project, ".cclay", "regenerate-outcomes", "doomed.json"), "utf8"),
		);
		assert.equal(outcome.status, "failed");
		assert.equal(outcome.error_code, "GENERATION_FAILED");
		assert.match(outcome.message, /checkpoint missing/);
	});

	it("survives a sweep that throws so later requests still get picked up", async () => {
		await installWrapper(FAKE_WRAPPER);
		process.env.ARGV_LOG = join(project, "argv.log");
		// A file where the outcome directory belongs makes the first sweep throw.
		await mkdir(join(project, ".cclay"), { recursive: true });
		await writeFile(join(project, ".cclay", "regenerate-outcomes"), "not a directory", "utf8");
		await publish(aRequest("first"));

		const errors: unknown[] = [];
		const runner = startRegenerateQueueRunner({
			cwd: project,
			wrapperPath: wrapper,
			tickMs: 60_000,
			stageScene: async () => ({ resulting_revision_id: "b".repeat(64) }),
			onError: (error) => errors.push(error),
		});
		await runner.started;
		assert.equal(errors.length, 1, "the failure must be reported, not swallowed");

		// The runner is still alive: clear the obstruction and the next sweep works.
		await rm(join(project, ".cclay", "regenerate-outcomes"), { force: true });
		await runner.sweepNow();
		await runner.stop();

		const outcome = JSON.parse(
			await readFile(join(project, ".cclay", "regenerate-outcomes", "first.json"), "utf8"),
		);
		assert.equal(outcome.status, "succeeded");
	});
	// The host runs with the animator's .blend folder as cwd, which never
	// contains scripts/. Defaulting the wrapper to cwd made every regeneration
	// die on ENOENT after the rig had already been detached and the request
	// published, so the animator paid the full cost for nothing.
	it("defaults the generator to the repository wrapper, not one under the project", async () => {
		const runner = startRegenerateQueueRunner({
			cwd: project,
			tickMs: 60_000,
			stageScene: async () => ({ resulting_revision_id: "b".repeat(64) }),
		});
		await runner.started;
		await runner.stop();

		const expected = fileURLToPath(
			new URL("../../../scripts/cclay-ardy-generate", import.meta.url),
		);
		assert.equal(runner.wrapperPath, expected);
		assert.ok(
			!runner.wrapperPath.startsWith(project),
			`the wrapper must not be looked for inside the project: ${runner.wrapperPath}`,
		);
		// Resolving to a path is worthless if nothing executable is there.
		await access(runner.wrapperPath, constants.X_OK);
	});
});
