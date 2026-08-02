// The generate queue's write-ahead instantiation, driven through the REAL
// queue functions (sweepGenerateRequests / recoverAbandonedGenerateClaims)
// with the real MotionArchiveStore and the real ArdyGenerateKernel -- only
// runCli and the apply dispatch are faked. This is the production-shaped
// wiring the crash-matrix harness exercises generically: the kernel records
// `generated` through its onGenerated seam, the queue commits, applies
// exactly once, and a recorded request never runs the generator again.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { ArdyGenerateRequestV1 } from "@cclay/protocol";
import { parseArdyGenerateRequest } from "@cclay/protocol";
import { MotionArchiveStore } from "../src/ardy-archive-service.ts";
import {
	type ArdyGenerateQueueHandler,
	type ArdyGenerateSweepOptions,
	generateQueuePaths,
	recoverAbandonedGenerateClaims,
	sweepGenerateRequests,
	writeGenerateRequest,
} from "../src/ardy-generate-queue.ts";
import { type ArdyGenerateCliRunner, ArdyGenerateKernel } from "../src/ardy-generate-service.ts";
import { type ArdyQueueWriteAhead, writeArdyQueueProgress } from "../src/ardy-queue.ts";
import { validMotionArchive } from "./ardy-archive-fixture.ts";

const REVISION = "a".repeat(64);
// The revision a successful apply commits. The simulated director revision
// state advances from REVISION to this on every successful apply.
const ADVANCED_REVISION = "b".repeat(64);
const ENTITY = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const REQUEST_ID = "0123456789abcdef0123456789abcdef";

function aRequest(requestId: string = REQUEST_ID): ArdyGenerateRequestV1 {
	return {
		schema_version: 1,
		request_id: requestId,
		entity_id: ENTITY,
		expected_revision_id: REVISION,
		prompt: "a person waves both hands",
		duration_seconds: 5,
		seed: 7,
		requested_at_ms: 1_700_000_000_000,
	};
}

function wrapperJson(motionId: string): string {
	return JSON.stringify({
		motion_id: motionId,
		frames: 100,
		fps: 20,
		duration_s: 5,
		path: `.cclay/motions/${motionId}.npz`,
		continuity: { mean_jump_m: 0.012, max_jump_m: 0.04, max_jump_frame: 47 },
	});
}

interface Harness {
	readonly project: string;
	readonly store: MotionArchiveStore;
	readonly progressDir: string;
	// runCli and applies accumulate across every sweep of a test; they are
	// never reset.
	readonly counters: { runCli: number; applies: number };
	readonly revision: { current: string };
	readonly runCalls: string[][];
	sweep(options?: Partial<ArdyGenerateSweepOptions>): ReturnType<typeof sweepGenerateRequests>;
	recover(): Promise<string[]>;
}

async function makeHarness(project: string): Promise<Harness> {
	const store = new MotionArchiveStore(project);
	const progressDir = generateQueuePaths(project).progress;
	const counters = { runCli: 0, applies: 0 };
	const revision = { current: REVISION };
	const runCalls: string[][] = [];
	// The fake wrapper: records argv, stages the generated npz exactly like
	// the real wrapper's scp download, and prints the contract JSON line.
	const runCli: ArdyGenerateCliRunner = async (argv) => {
		runCalls.push([...argv]);
		counters.runCli += 1;
		const motionId = `motion-${String(counters.runCli).padStart(12, "0")}`;
		await store.write(motionId, validMotionArchive());
		return { status: 0, stdout: wrapperJson(motionId), stderr: "" };
	};
	// The generate-only kernel: runCli, the `generated` record via the
	// onGenerated seam (carrying the full parsed result), then the commit.
	// It never applies -- the queue is the single apply point.
	const kernel = new ArdyGenerateKernel({
		runCli,
		archive: { commitGenerated: (motionId) => store.commitGenerated(motionId) },
		onGenerated: async (motionId, result) => {
			await writeArdyQueueProgress(progressDir, {
				schema_version: 1,
				request_id: result.request_id,
				status: "generated",
				motion_id: motionId,
				result,
			});
		},
	});
	const handler: ArdyGenerateQueueHandler = async (params) => ({
		result: await kernel.generate(parseArdyGenerateRequest(params)),
	});
	const writeAhead: ArdyQueueWriteAhead<ArdyGenerateRequestV1> = {
		recoverGenerated: (motionId) => store.recoverGenerated(motionId),
		read: (motionId) => store.read(motionId),
		commitGenerated: (motionId) => store.commitGenerated(motionId),
		removeStaleClaims: (motionId) => store.removeStaleGeneratedClaims(motionId),
		apply: async (request) => {
			counters.applies += 1;
			if (request.expected_revision_id !== revision.current) {
				throw new Error(
					`revision mismatch: expected ${request.expected_revision_id}, current revision is ${revision.current}`,
				);
			}
			revision.current = ADVANCED_REVISION;
			return { resulting_revision_id: revision.current };
		},
	};
	return {
		project,
		store,
		progressDir,
		counters,
		revision,
		runCalls,
		sweep: (options = {}) =>
			sweepGenerateRequests({
				projectDirectory: project,
				handler,
				writeAhead,
				contextFor: () => ({}),
				liveRevisionId: () => revision.current,
				...options,
			}),
		recover: () => recoverAbandonedGenerateClaims(project),
	};
}

describe("ardy generate queue", () => {
	let project: string;
	let h: Harness;

	beforeEach(async () => {
		project = await mkdtemp(join(tmpdir(), "cclay-generate-queue-"));
		h = await makeHarness(project);
	});

	afterEach(async () => {
		await rm(project, { recursive: true, force: true });
	});

	it("returns nothing when the add-on has never published a request", async () => {
		assert.deepEqual(await h.sweep(), []);
	});

	it("submitting the same request_id twice yields one generation, one archive entry, one revision, and two identical outcomes", async () => {
		await writeGenerateRequest(project, aRequest());

		const first = await h.sweep();
		assert.equal(first.length, 1);
		assert.equal(
			first[0]!.outcome.status,
			"succeeded",
			first[0]!.outcome.status === "failed" ? first[0]!.outcome.message : "",
		);
		const firstOutcome = first[0]!.outcome;

		// The add-on retries by writing the same request_id again; the queue
		// must answer from the recorded outcome instead of generating twice.
		await writeGenerateRequest(project, aRequest());
		const second = await h.sweep();
		assert.equal(second.length, 1);
		assert.deepEqual(second[0]!.outcome, firstOutcome, "both sweeps return the identical outcome");

		// One generation, one committed archive, one applied revision.
		assert.equal(h.counters.runCli, 1, "the generator must run exactly once across both submissions");
		assert.equal(h.counters.applies, 1, "the apply must land exactly once");
		assert.equal(h.revision.current, ADVANCED_REVISION);
		assert.deepEqual(
			(await readdir(join(project, ".cclay", "motions"))).filter((name) => name.endsWith(".npz")),
			["motion-000000000001.npz"],
			"exactly one archive entry",
		);
		// The exact unconstrained argv rode through the real queue once.
		assert.deepEqual(h.runCalls, [["a person waves both hands", "--duration", "5", "--seed", "7"]]);

		// Terminal state: request and progress retired, outcome durable.
		const paths = generateQueuePaths(project);
		assert.deepEqual(await readdir(paths.requests), []);
		assert.deepEqual(await readdir(paths.outcomes), [`${REQUEST_ID}.json`]);
		assert.deepEqual(await readdir(paths.progress), []);
	});

	it("a request whose generated record already exists on disk makes ZERO runCli calls", async () => {
		const paths = generateQueuePaths(project);
		const motionId = "motion-replayed-01";
		await mkdir(paths.requests, { recursive: true });
		await writeFile(join(paths.requests, `${REQUEST_ID}.json.claimed`), JSON.stringify(aRequest()), "utf8");
		const recordedResult = {
			schema_version: 1 as const,
			request_id: REQUEST_ID,
			motion_id: motionId,
			frames: 100,
			duration_seconds: 5,
			seed: 7,
		};
		await writeArdyQueueProgress(paths.progress, {
			schema_version: 1,
			request_id: REQUEST_ID,
			status: "generated",
			motion_id: motionId,
			result: recordedResult,
		});
		// The canonical bytes exist (commit had republished them), so the
		// replay's recover-read-commit trio validates and republishes them.
		await h.store.write(motionId, validMotionArchive());

		assert.deepEqual(await h.sweep(), [], "a claim is not pending work");
		const recovered = await h.recover();
		assert.equal(recovered.length, 1);

		const entries = await h.sweep();
		assert.equal(entries.length, 1);
		assert.equal(
			entries[0]!.outcome.status,
			"succeeded",
			entries[0]!.outcome.status === "failed" ? entries[0]!.outcome.message : "",
		);
		assert.equal(h.counters.runCli, 0, "a recorded request must never call the generator again");
		assert.equal(h.counters.applies, 1, "the replay applies exactly once");
		assert.equal(h.revision.current, ADVANCED_REVISION);
		// The RECORDED result is returned verbatim, not a synthesis.
		assert.deepEqual(
			entries[0]!.outcome.status === "succeeded" ? entries[0]!.outcome.result : undefined,
			recordedResult,
		);
		assert.deepEqual(await readdir(paths.requests), [], "the replayed claim is retired");
		assert.deepEqual(await readdir(paths.progress), []);
	});

	it("fails a malformed queued request as INVALID_ARDY_GENERATE_REQUEST without running the generator", async () => {
		const paths = generateQueuePaths(project);
		await mkdir(paths.requests, { recursive: true });
		// A well-formed 32-hex request filename whose body is not a generate
		// request at all. (A filename outside the closed 32-hex grammar can
		// never produce a valid outcome -- the outcome schema pins request_id
		// to it -- so the queue rejects such a foreign file loudly instead of
		// consuming it.)
		const badId = "fedcba9876543210fedcba9876543210";
		await writeFile(join(paths.requests, `${badId}.json`), JSON.stringify({ schema_version: 1 }), "utf8");

		const entries = await h.sweep();
		assert.equal(entries.length, 1);
		const outcome = entries[0]!.outcome;
		assert.equal(outcome.status, "failed");
		assert.equal(outcome.status === "failed" && outcome.error_code, "INVALID_ARDY_GENERATE_REQUEST");
		assert.equal(outcome.request_id, badId, "addressed by filename when the body cannot be read");
		assert.equal(h.counters.runCli, 0);
		assert.deepEqual(await readdir(paths.requests), []);
	});

	it("a stale queued request fails as REVISION_MISMATCH with ZERO runCli calls", async () => {
		// The live-revision guard must live on the write-ahead path itself:
		// the queue's handler is the generate-only kernel, which has no
		// revision notion of its own, so a stale request would otherwise
		// spend a multi-minute GPU run before failing at apply time. The
		// sweep checks expected_revision_id against the CURRENT revision
		// before the kernel executes.
		await writeGenerateRequest(project, aRequest());

		const entries = await h.sweep({ liveRevisionId: () => "b".repeat(64) });

		assert.equal(entries.length, 1);
		const outcome = entries[0]!.outcome;
		assert.equal(outcome.status, "failed");
		assert.equal(outcome.status === "failed" && outcome.error_code, "REVISION_MISMATCH");
		assert.equal(h.counters.runCli, 0, "a stale queued request must never call the generator");
		assert.equal(h.counters.applies, 0, "a stale queued request must never reach the apply");
		assert.equal(h.revision.current, REVISION, "the revision must not advance for a stale request");
	});
});
