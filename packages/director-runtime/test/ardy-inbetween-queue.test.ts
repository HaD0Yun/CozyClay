// The in-between queue's write-ahead instantiation, driven through the REAL
// queue functions (sweepInbetweenRequests / recoverAbandonedInbetweenClaims)
// with the real MotionArchiveStore and the real ArdyInbetweenKernel -- only
// runCli and the apply dispatch are faked. The synthetic pose archives are
// planted exactly where capture_evaluated_pose mints them, and the sweep
// owns deleting them on retirement.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { ArdyInbetweenRequestV1 } from "@cclay/protocol";
import { parseArdyInbetweenRequest } from "@cclay/protocol";
import { MotionArchiveStore } from "../src/ardy-archive-service.ts";
import {
	type ArdyInbetweenQueueHandler,
	type ArdyInbetweenSweepOptions,
	inbetweenQueuePaths,
	recoverAbandonedInbetweenClaims,
	sweepInbetweenRequests,
	writeInbetweenRequest,
} from "../src/ardy-inbetween-queue.ts";
import {
	type ArdyInbetweenCliRunner,
	ArdyInbetweenKernel,
	inbetweenSyntheticPoseIds,
} from "../src/ardy-inbetween-service.ts";
import { type ArdyQueueWriteAhead, writeArdyQueueProgress } from "../src/ardy-queue.ts";
import { removeOrphanedSyntheticPoses, writeRegenerateRequest } from "../src/ardy-regenerate-queue.ts";
import { validMotionArchive } from "./ardy-archive-fixture.ts";

const REVISION = "a".repeat(64);
const ADVANCED_REVISION = "b".repeat(64);
const ENTITY = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const REQUEST_ID = "0123456789abcdef0123456789abcdef";
const BASE_MOTION = "walk-forward-01";

function aRequest(requestId: string = REQUEST_ID): ArdyInbetweenRequestV1 {
	return {
		schema_version: 1,
		request_id: requestId,
		entity_id: ENTITY,
		expected_revision_id: REVISION,
		base_motion_id: BASE_MOTION,
		pose_frames: [
			{ scene_frame: 100, clip_frame: 0 },
			{ scene_frame: 160, clip_frame: 60 },
			{ scene_frame: 220, clip_frame: 120 },
		],
		requested_at_ms: 1_700_000_000_000,
	};
}

function wrapperJson(motionId: string): string {
	return JSON.stringify({
		motion_id: motionId,
		duration_s: 600,
		path: `.cclay/motions/${motionId}.npz`,
		base_motion_id: BASE_MOTION,
		frames: 12000,
		fps: 20,
		target_space: "skeleton_joint_center",
		surface_contact_verified: false,
		residual: { max_error_m: 0.031, mean_error_m: 0.018, worst_frame: 24, worst_joint: "RightHand" },
		continuity: { mean_jump_m: 0.042, max_jump_m: 0.121, max_jump_frame: 24 },
		waypoints: [],
	});
}

interface Harness {
	readonly project: string;
	readonly store: MotionArchiveStore;
	readonly motionsDir: string;
	readonly progressDir: string;
	readonly counters: { runCli: number; applies: number };
	readonly revision: { current: string };
	readonly runCalls: string[][];
	sweep(options?: Partial<ArdyInbetweenSweepOptions>): ReturnType<typeof sweepInbetweenRequests>;
	recover(): Promise<string[]>;
}

async function makeHarness(project: string): Promise<Harness> {
	const store = new MotionArchiveStore(project);
	const paths = inbetweenQueuePaths(project);
	const counters = { runCli: 0, applies: 0 };
	const revision = { current: REVISION };
	const runCalls: string[][] = [];
	// The fake wrapper: records argv, stages the generated npz exactly like
	// the real wrapper's scp download, and prints the contract JSON line.
	const runCli: ArdyInbetweenCliRunner = async (argv) => {
		runCalls.push([...argv]);
		counters.runCli += 1;
		const motionId = `motion-${String(counters.runCli).padStart(12, "0")}`;
		await store.write(motionId, validMotionArchive());
		return { status: 0, stdout: wrapperJson(motionId), stderr: "" };
	};
	// The generate-only kernel: base and pose preflights, runCli, the
	// `generated` record via the onGenerated seam, then the commit. It never
	// applies -- the queue is the single apply point.
	const kernel = new ArdyInbetweenKernel({
		runCli,
		archive: {
			read: (motionId) => store.read(motionId),
			commitGenerated: (motionId) => store.commitGenerated(motionId),
		},
		onGenerated: async (motionId, result) => {
			await writeArdyQueueProgress(paths.progress, {
				schema_version: 1,
				request_id: result.request_id,
				status: "generated",
				motion_id: motionId,
				result,
			});
		},
	});
	const handler: ArdyInbetweenQueueHandler = async (params) => ({
		result: await kernel.inbetween(parseArdyInbetweenRequest(params)),
	});
	const writeAhead: ArdyQueueWriteAhead<ArdyInbetweenRequestV1> = {
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
		motionsDir: paths.motions,
		progressDir: paths.progress,
		counters,
		revision,
		runCalls,
		sweep: (options = {}) =>
			sweepInbetweenRequests({
				projectDirectory: project,
				handler,
				writeAhead,
				contextFor: () => ({}),
				...options,
			}),
		recover: () => recoverAbandonedInbetweenClaims(project),
	};
}

// Plants the base clip and the request's synthetic pose archives the way the
// add-on's capture step leaves them (capture_evaluated_pose + the applied
// base clip).
async function plantCapturedPoses(h: Harness, request: ArdyInbetweenRequestV1): Promise<void> {
	await h.store.write(request.base_motion_id, validMotionArchive());
	for (const poseId of inbetweenSyntheticPoseIds(request)) {
		await h.store.write(poseId, validMotionArchive());
	}
}

async function motionFiles(h: Harness): Promise<string[]> {
	return (await readdir(h.motionsDir).catch(() => [] as string[])).filter((name) => name.endsWith(".npz")).sort();
}

describe("ardy inbetween queue", () => {
	let project: string;
	let h: Harness;

	beforeEach(async () => {
		project = await mkdtemp(join(tmpdir(), "cclay-inbetween-queue-"));
		h = await makeHarness(project);
	});

	afterEach(async () => {
		await rm(project, { recursive: true, force: true });
	});

	it("submitting the same request_id twice yields one generation, one archive entry, one revision, and two identical outcomes", async () => {
		const request = aRequest();
		await plantCapturedPoses(h, request);
		await writeInbetweenRequest(project, request);

		const first = await h.sweep();
		assert.equal(first.length, 1);
		assert.equal(
			first[0]!.outcome.status,
			"succeeded",
			first[0]!.outcome.status === "failed" ? first[0]!.outcome.message : "",
		);
		const firstOutcome = first[0]!.outcome;

		await writeInbetweenRequest(project, request);
		const second = await h.sweep();
		assert.equal(second.length, 1);
		assert.deepEqual(second[0]!.outcome, firstOutcome, "both sweeps return the identical outcome");

		assert.equal(h.counters.runCli, 1, "the generator must run exactly once across both submissions");
		assert.equal(h.counters.applies, 1, "the apply must land exactly once");
		assert.equal(h.revision.current, ADVANCED_REVISION);
		// The generated archive is the only NEW entry; the base clip remains.
		assert.deepEqual(
			await motionFiles(h),
			["motion-000000000001.npz", `${BASE_MOTION}.npz`],
			"exactly one generated archive entry; the captured poses are retired with the request",
		);
		// The exact constrained argv rode through the real queue once, with
		// --base-motion present and one four-word --constrain-pose block per
		// captured pose.
		assert.deepEqual(h.runCalls, [
			[
				"regenerate",
				"--duration",
				"600",
				"--base-motion",
				BASE_MOTION,
				"--constrain-pose",
				`cclay-pose-${REQUEST_ID}-1`,
				"0",
				"0",
				"--constrain-pose",
				`cclay-pose-${REQUEST_ID}-2`,
				"0",
				"60",
				"--constrain-pose",
				`cclay-pose-${REQUEST_ID}-3`,
				"0",
				"120",
			],
		]);

		const paths = inbetweenQueuePaths(project);
		assert.deepEqual(await readdir(paths.requests), []);
		assert.deepEqual(await readdir(paths.outcomes), [`${REQUEST_ID}.json`]);
		assert.deepEqual(await readdir(paths.progress), []);
	});

	it("a request whose generated record already exists on disk makes ZERO runCli calls", async () => {
		const paths = inbetweenQueuePaths(project);
		const request = aRequest();
		const motionId = "motion-replayed-01";
		await plantCapturedPoses(h, request);
		await mkdir(paths.requests, { recursive: true });
		await writeFile(join(paths.requests, `${REQUEST_ID}.json.claimed`), JSON.stringify(request), "utf8");
		const recordedResult = {
			schema_version: 1 as const,
			request_id: REQUEST_ID,
			motion_id: motionId,
			frames: 12000,
			captured_frames: 3,
			base_motion_id: BASE_MOTION,
			continuity: { mean_jump_m: 0.042, max_jump_m: 0.121, max_jump_frame: 24 },
			dropped_constraints: [],
		};
		await writeArdyQueueProgress(paths.progress, {
			schema_version: 1,
			request_id: REQUEST_ID,
			status: "generated",
			motion_id: motionId,
			result: recordedResult,
		});
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
		assert.deepEqual(
			entries[0]!.outcome.status === "succeeded" ? entries[0]!.outcome.result : undefined,
			recordedResult,
			"the RECORDED result is returned verbatim",
		);
		assert.deepEqual(await readdir(paths.requests), []);
		assert.deepEqual(await readdir(paths.progress), []);
		// The captured poses are retired with the replayed claim.
		assert.deepEqual(await motionFiles(h), ["motion-replayed-01.npz", `${BASE_MOTION}.npz`]);
	});

	it("a request whose captured pose archive is missing fails as POSE_CAPTURE_FAILED with ZERO runCli calls", async () => {
		const request = aRequest();
		// Only the base clip is planted; the synthetic poses never landed
		// (a host died between capture and sweep, or the capture failed).
		await h.store.write(request.base_motion_id, validMotionArchive());
		await writeInbetweenRequest(project, request);

		const entries = await h.sweep();
		assert.equal(entries.length, 1);
		const outcome = entries[0]!.outcome;
		assert.equal(outcome.status, "failed");
		assert.equal(outcome.status === "failed" && outcome.error_code, "POSE_CAPTURE_FAILED");
		assert.equal(h.counters.runCli, 0, "the wrapper must not run when a captured pose is missing");
		assert.equal(h.counters.applies, 0);
		// The failure still retires the request so the queue keeps moving.
		assert.deepEqual(await readdir(inbetweenQueuePaths(project).requests), []);
	});

	it("deletes the request's synthetic poses whether it succeeded or failed", async () => {
		// Failure is the case that matters: the add-on mints a fresh
		// request_id per attempt, so a leaked archive is never overwritten.
		const doomed = aRequest("11111111111111111111111111111111");
		await plantCapturedPoses(h, doomed);
		await writeInbetweenRequest(project, doomed);
		// The runner fails after the wrapper "ran"; the poses must still go.
		const failingHarness = await makeHarness(project);

		const entries = await failingHarness.sweep({
			handler: async () => {
				throw new Error("wrapper exited 1: checkpoint missing");
			},
		});
		assert.equal(entries.length, 1);
		assert.equal(entries[0]!.outcome.status, "failed");

		assert.deepEqual(
			await motionFiles(failingHarness),
			[`${BASE_MOTION}.npz`],
			"the captured poses are deleted on the failure path; the base clip survives",
		);
		assert.deepEqual(await readdir(inbetweenQueuePaths(project).requests), []);
	});

	it("the shared orphan sweep protects poses referenced by EITHER queue", async () => {
		// Both surfaces mint cclay-pose-* into the same motions directory, so
		// the host's single orphan sweep must treat a pending request in
		// either queue as the owner of its archives.
		const inbetween = aRequest();
		const regenerateId = "cclay-pose-regen-referenced";
		await plantCapturedPoses(h, inbetween);
		await writeInbetweenRequest(project, inbetween);
		await writeRegenerateRequest(project, {
			schema_version: 1,
			request_id: "abcdefabcdefabcdefabcdefabcdefab",
			entity_id: ENTITY,
			base_motion_id: BASE_MOTION,
			expected_revision_id: REVISION,
			effectors: [],
			full_body: [{ frame: 8, synthetic_motion_id: regenerateId }],
			root_2d: [],
			requested_at_ms: 1_700_000_000_000,
		});
		await h.store.write(regenerateId, validMotionArchive());
		await h.store.write("cclay-pose-orphan-f1", validMotionArchive());
		await h.store.write("a-real-clip", validMotionArchive());

		const removed = await removeOrphanedSyntheticPoses(project);

		assert.deepEqual(removed, ["cclay-pose-orphan-f1.npz"]);
		assert.deepEqual(await motionFiles(h), [
			"a-real-clip.npz",
			...inbetweenSyntheticPoseIds(inbetween).map((id) => `${id}.npz`),
			"cclay-pose-regen-referenced.npz",
			`${BASE_MOTION}.npz`,
		]);
	});
});
