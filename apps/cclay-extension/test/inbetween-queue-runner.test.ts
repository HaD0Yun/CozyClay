// The wiring, not the queue. The queue's own semantics are covered in
// director-runtime; what is unproven here is that anything in a running host
// ever looks at the directory the add-on writes to. For the in-between queue
// specifically: the write-ahead path runs the generate-only kernel, so the
// runner must bind the live-revision staleness guard into the sweep -- a
// stale queued request must make ZERO wrapper invocations.
import assert from "node:assert/strict";
import type { ArdyInbetweenRequestV1 } from "@cclay/protocol";
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
import { startInbetweenQueueRunner } from "../src/inbetween-queue-runner.ts";

const REVISION = "a".repeat(64);
const ENTITY = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const REQUEST_ID = "0123456789abcdef0123456789abcdef";
const BASE_MOTION = "walk-forward-01";

function aRequest(overrides: Partial<ArdyInbetweenRequestV1> = {}): ArdyInbetweenRequestV1 {
	return {
		schema_version: 1,
		request_id: REQUEST_ID,
		entity_id: ENTITY,
		expected_revision_id: REVISION,
		base_motion_id: BASE_MOTION,
		pose_frames: [{ scene_frame: 100, clip_frame: 0 }],
		requested_at_ms: 1_700_000_000_000,
		...overrides,
	};
}

// Stands in for scripts/cclay-ardy-generate: prints the one JSON line the
// handler parses, and records the argv it was handed. The in-between result
// schema requires the measured continuity.
const FAKE_WRAPPER = `#!/bin/sh
printf '%s\\n' "$@" > "$ARGV_LOG"
echo '{"motion_id":"inbetween-clip","frames":12000,"duration_s":600,"base_motion_id":"walk-forward-01","continuity":{"mean_jump_m":0,"max_jump_m":0.01,"max_jump_frame":0}}'
`;

const FAILING_WRAPPER = `#!/bin/sh
echo "checkpoint missing" >&2
exit 3
`;

describe("inbetween queue runner", () => {
	let project: string;
	let wrapper: string;

	beforeEach(async () => {
		project = await mkdtemp(join(tmpdir(), "cclay-inbetween-runner-"));
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
		const directory = join(project, ".cclay", "inbetween-requests");
		await mkdir(directory, { recursive: true });
		await writeFile(
			join(directory, `${(request as { request_id: string }).request_id}.json`),
			JSON.stringify(request),
			"utf8",
		);
	}
	function fakeArchive(events: string[] = []) {
		return {
			async read(motionId: string): Promise<Uint8Array> {
				events.push(`read:${motionId}`);
				return new Uint8Array();
			},
			async commitGenerated(motionId: string): Promise<void> {
				events.push(`commit:${motionId}`);
			},
			async recoverGenerated(motionId: string) {
				return { outcome: "none" as const, claimsRemoved: 0 as const };
			},
			async removeStaleGeneratedClaims(): Promise<void> {},
		};
	}

	it("consumes a request the add-on published and applies the clip", async () => {
		await installWrapper(FAKE_WRAPPER);
		process.env.ARGV_LOG = join(project, "argv.log");
		await publish(aRequest());

		const applied: Array<{ motionId: unknown; revision: unknown }> = [];
		const archiveEvents: string[] = [];
		const runner = startInbetweenQueueRunner({
			cwd: project,
			liveRevisionId: () => REVISION,
			wrapperPath: wrapper,
			tickMs: 60_000,
			stageScene: async (request) => {
				const operation = request.operations[0] as { motion_id?: string };
				applied.push({
					motionId: operation.motion_id,
					revision: request.expected_revision_id,
				});
				archiveEvents.push("apply");
				return { resulting_revision_id: "b".repeat(64) };
			},
			archive: fakeArchive(archiveEvents),
			onError: (error) => {
				throw error;
			},
		});
		await runner.started;
		await runner.stop();

		assert.deepEqual(applied, [{ motionId: "inbetween-clip", revision: REVISION }]);
		assert.deepEqual(archiveEvents, [
			"read:walk-forward-01",
			"read:cclay-pose-0123456789abcdef0123456789abcdef-1",
			"commit:inbetween-clip",
			"apply",
		]);
		const outcome = JSON.parse(
			await readFile(join(project, ".cclay", "inbetween-outcomes", `${REQUEST_ID}.json`), "utf8"),
		);
		assert.equal(outcome.status, "succeeded");
		assert.equal(outcome.result.motion_id, "inbetween-clip");
		assert.deepEqual(await readdir(join(project, ".cclay", "inbetween-requests")), []);
	});

	it("submits a model request through the same durable queue and returns its outcome", async () => {
		await installWrapper(FAKE_WRAPPER);
		process.env.ARGV_LOG = join(project, "argv.log");
		const runner = startInbetweenQueueRunner({
			cwd: project,
			liveRevisionId: () => REVISION,
			wrapperPath: wrapper,
			tickMs: 60_000,
			stageScene: async () => ({ resulting_revision_id: "b".repeat(64) }),
			archive: fakeArchive(),
			onError: (error) => {
				throw error;
			},
		});
		await runner.started;

		const outcome = await runner.inbetween(aRequest());
		await runner.stop();

		assert.equal(outcome.status, "succeeded");
		assert.equal(outcome.request_id, REQUEST_ID);
		if (outcome.status === "succeeded") {
			assert.equal(outcome.result.motion_id, "inbetween-clip");
			assert.equal(outcome.resulting_revision_id, "b".repeat(64));
		}
		assert.deepEqual(await readdir(join(project, ".cclay", "inbetween-requests")), []);
	});

	it("a stale queued request makes ZERO wrapper invocations and fails as REVISION_MISMATCH", async () => {
		// The queue path runs the generate-only kernel, which has no revision
		// notion of its own; the runner binds the live revision into the
		// sweep, and the pre-kernel guard must stop a stale request before
		// the wrapper is ever spawned.
		await installWrapper(FAKE_WRAPPER);
		const argvLog = join(project, "argv.log");
		process.env.ARGV_LOG = argvLog;
		await publish(aRequest());

		const runner = startInbetweenQueueRunner({
			cwd: project,
			// The scene moved after the request was built.
			liveRevisionId: () => "b".repeat(64),
			wrapperPath: wrapper,
			tickMs: 60_000,
			stageScene: async () => ({ resulting_revision_id: "c".repeat(64) }),
			archive: fakeArchive(),
			onError: (error) => {
				throw error;
			},
		});
		await runner.started;
		await runner.stop();

		const outcome = JSON.parse(
			await readFile(join(project, ".cclay", "inbetween-outcomes", `${REQUEST_ID}.json`), "utf8"),
		);
		assert.equal(outcome.status, "failed");
		assert.equal(outcome.error_code, "REVISION_MISMATCH");
		await assert.rejects(access(argvLog), (error: unknown) => {
			return (error as NodeJS.ErrnoException).code === "ENOENT";
		});
	});

	it("records a wrapper failure instead of applying anything", async () => {
		// The add-on has already detached by now, so a failure that produced no
		// file would be indistinguishable from a host that never started.
		await installWrapper(FAILING_WRAPPER);
		await publish(aRequest());

		let applications = 0;
		const runner = startInbetweenQueueRunner({
			cwd: project,
			liveRevisionId: () => REVISION,
			wrapperPath: wrapper,
			tickMs: 60_000,
			stageScene: async () => {
				applications += 1;
				return { resulting_revision_id: "b".repeat(64) };
			},
			archive: fakeArchive(),
			onError: (error) => {
				throw error;
			},
		});
		await runner.started;
		await runner.stop();

		assert.equal(applications, 0, "a failed generation must not commit a revision");
		const outcome = JSON.parse(
			await readFile(join(project, ".cclay", "inbetween-outcomes", `${REQUEST_ID}.json`), "utf8"),
		);
		assert.equal(outcome.status, "failed");
		assert.equal(outcome.error_code, "GENERATION_FAILED");
		assert.match(outcome.message, /checkpoint missing/);
	});

	it("defaults the generator to the repository wrapper, not one under the project", async () => {
		const runner = startInbetweenQueueRunner({
			cwd: project,
			liveRevisionId: () => REVISION,
			tickMs: 60_000,
			stageScene: async () => ({ resulting_revision_id: "b".repeat(64) }),
			onError: (error) => {
				throw error;
			},
		});
		await runner.started;
		await runner.stop();

		const expected = fileURLToPath(new URL("../../../scripts/cclay-ardy-generate", import.meta.url));
		assert.equal(runner.wrapperPath, expected);
		assert.ok(
			!runner.wrapperPath.startsWith(project),
			`the wrapper must not be looked for inside the project: ${runner.wrapperPath}`,
		);
		// Resolving to a path is worthless if nothing executable is there.
		await access(runner.wrapperPath, constants.X_OK);
	});
});
