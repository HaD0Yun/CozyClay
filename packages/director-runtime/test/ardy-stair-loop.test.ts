// The in-process orchestration harness for the issue-#1 stair loop: ONE
// request set drives ardy_generate -> the add-on's evaluated-pose capture ->
// ardy_inbetween -> apply, and the whole chain must compose through the REAL
// queues (sweepGenerateRequests / sweepInbetweenRequests), the REAL
// write-ahead machinery (ardy-queue.ts), the REAL ArdyMotionKernel bindings
// (ArdyGenerateKernel / ArdyInbetweenKernel), the REAL MotionArchiveStore,
// and the REAL apply_motion plan builder (applyMotionRequest). This is the
// last thing that can be verified without a real ARDY host: live acceptance
// on real Blender with a real GPU host is blocked on CCLAY_ARDY_HOST, which
// is unset in CI.
//
// What is faked, and why:
//   - The wrapper (runCli): the GPU host's stand-in. It records argv, stages
//     the generated npz exactly like the real wrapper's scp download, and
//     prints the contract JSON line. This is the only faked generation
//     component.
//   - The stage_scene bridge inside the apply dispatch. Even the production
//     wiring (apps/cclay-extension/src/{generate,inbetween}-queue-runner.ts)
//     is a two-part seam: applyMotionRequest builds the apply_motion plan
//     (REAL, imported here), and the injected stageScene bridge commits it
//     against expected_revision_id inside a live Blender session. CI has no
//     Blender, so the bridge is simulated: it rejects a stale plan exactly
//     as the mutation boundary would and performs the revision commit the
//     real bridge's stage_scene mutation would land (R0 -> R1 -> R2).
//   - capture_evaluated_pose: Blender-side (blender-addon/cclay/
//     constraint_capture.py) and covered by its own real-Blender tests; this
//     harness does not pretend to exercise the add-on. It stands in for
//     capture by minting the exact archives the add-on's capture step leaves
//     on disk (cclay-pose-<request_id>-<n>, 1-based, derived with the
//     service's own inbetweenSyntheticPoseIds rule) with the real archive
//     fixture.
//
// Everything else -- the archive store, both kernels, both queues, the
// write-ahead records, the staleness guards, the synthetic-pose retirement
// -- is the real code under test.
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { ArdyGenerateRequestV1, ArdyInbetweenRequestV1, StageSceneRequestV1 } from "@cclay/protocol";
import {
	ARDY_CONSTRAINED_DURATION_SECONDS,
	ARDY_CONSTRAINED_PROMPT,
	parseArdyGenerateRequest,
	parseArdyInbetweenRequest,
} from "@cclay/protocol";
import { applyMotionRequest } from "../../../apps/cclay-extension/src/ardy-queue-runner-shared.ts";
import { MotionArchiveStore } from "../src/ardy-archive-service.ts";
import {
	type ArdyGenerateQueueHandler,
	generateQueuePaths,
	sweepGenerateRequests,
	writeGenerateRequest,
} from "../src/ardy-generate-queue.ts";
import { type ArdyGenerateCliRunner, ArdyGenerateKernel } from "../src/ardy-generate-service.ts";
import {
	type ArdyInbetweenQueueHandler,
	inbetweenQueuePaths,
	sweepInbetweenRequests,
	writeInbetweenRequest,
} from "../src/ardy-inbetween-queue.ts";
import { ArdyInbetweenKernel, inbetweenSyntheticPoseIds } from "../src/ardy-inbetween-service.ts";
import { type ArdyQueueWriteAhead, writeArdyQueueProgress } from "../src/ardy-queue.ts";
import { validMotionArchive } from "./ardy-archive-fixture.ts";

// The three revisions the loop must traverse, in order. R0 is the revision
// the generate request is built on; the generate apply commits R1; the
// in-between request carries R1 (issue #1 requirement 5: ardy_generate
// applies and advances the revision) and its apply commits R2.
const R0 = "a".repeat(64);
const R1 = "b".repeat(64);
const R2 = "c".repeat(64);
const ENTITY = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const GENERATE_REQUEST_ID = "0123456789abcdef0123456789abcdef";
const INBETWEEN_REQUEST_ID = "fedcba9876543210fedcba9876543210";
const PROMPT = "a person waves both hands";
const INBETWEEN_CONTINUITY = { mean_jump_m: 0.042, max_jump_m: 0.121, max_jump_frame: 24 };

function generateRequest(): ArdyGenerateRequestV1 {
	return {
		schema_version: 1,
		request_id: GENERATE_REQUEST_ID,
		entity_id: ENTITY,
		expected_revision_id: R0,
		prompt: PROMPT,
		duration_seconds: 5,
		seed: 7,
		requested_at_ms: 1_700_000_000_000,
	};
}

function inbetweenRequest(options: { baseMotionId: string; expectedRevisionId?: string }): ArdyInbetweenRequestV1 {
	return {
		schema_version: 1,
		request_id: INBETWEEN_REQUEST_ID,
		entity_id: ENTITY,
		expected_revision_id: options.expectedRevisionId ?? R1,
		base_motion_id: options.baseMotionId,
		pose_frames: [
			{ scene_frame: 100, clip_frame: 0 },
			{ scene_frame: 160, clip_frame: 60 },
			{ scene_frame: 220, clip_frame: 120 },
		],
		requested_at_ms: 1_700_000_000_000,
	};
}

// The simulated stage_scene commit: the revision the request was built on is
// the only one that may commit, and a successful commit advances the project
// exactly one step along R0 -> R1 -> R2.
function nextRevision(current: string): string {
	if (current === R0) return R1;
	if (current === R1) return R2;
	throw new Error(`unexpected revision transition from ${current}`);
}

async function existsOnDisk(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return false;
		}
		throw error;
	}
}

interface Harness {
	readonly project: string;
	readonly store: MotionArchiveStore;
	readonly motionsDir: string;
	// runCli and applies accumulate across every sweep of a test; they are
	// never reset.
	readonly counters: {
		readonly runCli: { readonly generate: number; readonly inbetween: number; readonly total: number };
		readonly applies: { readonly generate: number; readonly inbetween: number; readonly total: number };
	};
	readonly revision: { current: string };
	// Every revision an apply committed, in commit order.
	readonly revisionHistory: string[];
	readonly runCalls: string[][];
	// Every apply_motion plan the real plan builder produced, in apply order.
	readonly applyPlans: StageSceneRequestV1[];
	// What the queue's own writeAhead.apply callback observed: the captured
	// poses on disk and the outcome not yet durable at the moment the
	// in-between request was applied (see makeHarness).
	readonly poseObservation: { seen: boolean; posesPresent: boolean[]; outcomeDurable: boolean };
	sweepGenerate(): ReturnType<typeof sweepGenerateRequests>;
	sweepInbetween(): ReturnType<typeof sweepInbetweenRequests>;
}

async function makeHarness(project: string): Promise<Harness> {
	const store = new MotionArchiveStore(project);
	const generatePaths = generateQueuePaths(project);
	const inbetweenPaths = inbetweenQueuePaths(project);
	const counters = {
		runCli: { generate: 0, inbetween: 0, total: 0 },
		applies: { generate: 0, inbetween: 0, total: 0 },
	};
	const revision = { current: R0 };
	const revisionHistory: string[] = [];
	const runCalls: string[][] = [];
	const applyPlans: StageSceneRequestV1[] = [];
	const poseObservation: { seen: boolean; posesPresent: boolean[]; outcomeDurable: boolean } = {
		seen: false,
		posesPresent: [],
		outcomeDurable: false,
	};
	// The fake wrapper (the GPU host's stand-in): records argv, stages the
	// generated npz exactly like the real wrapper's scp download, and prints
	// the contract JSON line. The in-between capability is the constrained
	// invocation, whose argv begins with the shared constrained prompt; the
	// unconstrained generate argv begins with the user prompt.
	const runCli: ArdyGenerateCliRunner = async (argv) => {
		runCalls.push([...argv]);
		const capability = argv[0] === ARDY_CONSTRAINED_PROMPT ? "inbetween" : "generate";
		counters.runCli[capability] += 1;
		counters.runCli.total += 1;
		const motionId = `motion-${String(counters.runCli.total).padStart(12, "0")}`;
		await store.write(motionId, validMotionArchive());
		const baseIndex = argv.indexOf("--base-motion");
		const baseMotionId = baseIndex === -1 ? null : (argv[baseIndex + 1] ?? null);
		const common = { motion_id: motionId, path: `.cclay/motions/${motionId}.npz` };
		const stdout =
			capability === "inbetween"
				? JSON.stringify({
						...common,
						duration_s: 600,
						base_motion_id: baseMotionId,
						frames: 12000,
						fps: 20,
						target_space: "skeleton_joint_center",
						surface_contact_verified: false,
						residual: { max_error_m: 0.031, mean_error_m: 0.018, worst_frame: 24, worst_joint: "RightHand" },
						continuity: INBETWEEN_CONTINUITY,
						waypoints: [],
					})
				: JSON.stringify({
						...common,
						frames: 100,
						fps: 20,
						duration_s: 5,
						continuity: { mean_jump_m: 0.012, max_jump_m: 0.04, max_jump_frame: 47 },
					});
		return { status: 0, stdout, stderr: "" };
	};
	// The generate-only kernels: runCli, the `generated` record via the
	// onGenerated seam, then the commit. They never apply -- the queue is the
	// single apply point.
	const generateKernel = new ArdyGenerateKernel({
		runCli,
		archive: { commitGenerated: (motionId) => store.commitGenerated(motionId) },
		onGenerated: async (motionId, result) => {
			await writeArdyQueueProgress(generatePaths.progress, {
				schema_version: 1,
				request_id: result.request_id,
				status: "generated",
				motion_id: motionId,
				result,
			});
		},
	});
	const generateHandler: ArdyGenerateQueueHandler = async (params) => ({
		result: await generateKernel.generate(parseArdyGenerateRequest(params)),
	});
	const inbetweenKernel = new ArdyInbetweenKernel({
		runCli,
		archive: {
			read: (motionId) => store.read(motionId),
			commitGenerated: (motionId) => store.commitGenerated(motionId),
		},
		onGenerated: async (motionId, result) => {
			await writeArdyQueueProgress(inbetweenPaths.progress, {
				schema_version: 1,
				request_id: result.request_id,
				status: "generated",
				motion_id: motionId,
				result,
			});
		},
	});
	const inbetweenHandler: ArdyInbetweenQueueHandler = async (params) => ({
		result: await inbetweenKernel.inbetween(parseArdyInbetweenRequest(params)),
	});
	// The simulated stage_scene bridge. The production runners bind
	// stageScene(applyMotionRequest(...), context); the real bridge commits
	// the plan inside a live Blender session, where a plan whose
	// expected_revision_id is not the current revision is rejected. This
	// bridge performs that commit and rejection.
	const stageScene = async (
		plan: StageSceneRequestV1,
		_context: unknown,
	): Promise<{ resulting_revision_id: string }> => {
		applyPlans.push(plan);
		if (plan.expected_revision_id !== revision.current) {
			throw new Error(
				`revision mismatch: expected ${plan.expected_revision_id}, current revision is ${revision.current}`,
			);
		}
		revision.current = nextRevision(revision.current);
		revisionHistory.push(revision.current);
		return { resulting_revision_id: revision.current };
	};
	const generateWriteAhead: ArdyQueueWriteAhead<ArdyGenerateRequestV1> = {
		recoverGenerated: (motionId) => store.recoverGenerated(motionId),
		read: (motionId) => store.read(motionId),
		commitGenerated: (motionId) => store.commitGenerated(motionId),
		removeStaleClaims: (motionId) => store.removeStaleGeneratedClaims(motionId),
		apply: (request, context, motionId) => {
			counters.applies.generate += 1;
			counters.applies.total += 1;
			return stageScene(applyMotionRequest(motionId, request.entity_id, request.expected_revision_id), context);
		},
	};
	const inbetweenWriteAhead: ArdyQueueWriteAhead<ArdyInbetweenRequestV1> = {
		recoverGenerated: (motionId) => store.recoverGenerated(motionId),
		read: (motionId) => store.read(motionId),
		commitGenerated: (motionId) => store.commitGenerated(motionId),
		removeStaleClaims: (motionId) => store.removeStaleGeneratedClaims(motionId),
		apply: async (request, context, motionId) => {
			counters.applies.inbetween += 1;
			counters.applies.total += 1;
			// The queue's own observation point: writeAhead.apply runs after
			// the kernel's capture preflight and archive commit, and BEFORE
			// the outcome is durable or retireArdyClaim deletes the request's
			// captured poses. The poses must still be on disk here, and the
			// outcome must not exist yet -- no timing guesses needed.
			const poseIds = inbetweenSyntheticPoseIds(request);
			poseObservation.seen = true;
			poseObservation.posesPresent = await Promise.all(
				poseIds.map(async (poseId) => existsOnDisk(join(inbetweenPaths.motions, `${poseId}.npz`))),
			);
			poseObservation.outcomeDurable = await existsOnDisk(
				join(inbetweenPaths.outcomes, `${request.request_id}.json`),
			);
			return stageScene(applyMotionRequest(motionId, request.entity_id, request.expected_revision_id), context);
		},
	};
	return {
		project,
		store,
		motionsDir: inbetweenPaths.motions,
		counters,
		revision,
		revisionHistory,
		runCalls,
		applyPlans,
		poseObservation,
		sweepGenerate: () =>
			sweepGenerateRequests({
				projectDirectory: project,
				handler: generateHandler,
				writeAhead: generateWriteAhead,
				contextFor: () => ({}),
				liveRevisionId: () => revision.current,
			}),
		sweepInbetween: () =>
			sweepInbetweenRequests({
				projectDirectory: project,
				handler: inbetweenHandler,
				writeAhead: inbetweenWriteAhead,
				contextFor: () => ({}),
				liveRevisionId: () => revision.current,
			}),
	};
}

// Plants the base clip and the request's synthetic pose archives the way the
// add-on's capture step leaves them (capture_evaluated_pose + the applied
// base clip). The capture step itself is Blender-side and covered by its own
// real-Blender tests; this stands in for it with the real archive fixture,
// minting exactly the ids the add-on's rule produces.
async function plantCapturedPoses(h: Harness, request: ArdyInbetweenRequestV1): Promise<void> {
	await h.store.write(request.base_motion_id, validMotionArchive());
	for (const poseId of inbetweenSyntheticPoseIds(request)) {
		await h.store.write(poseId, validMotionArchive());
	}
}

async function motionFiles(h: Harness): Promise<string[]> {
	return (await readdir(h.motionsDir).catch(() => [] as string[])).filter((name) => name.endsWith(".npz")).sort();
}

describe("ardy stair loop", () => {
	let project: string;
	let h: Harness;

	beforeEach(async () => {
		project = await mkdtemp(join(tmpdir(), "cclay-stair-loop-"));
		h = await makeHarness(project);
	});

	afterEach(async () => {
		await rm(project, { recursive: true, force: true });
	});

	it("ONE request set drives generate -> captured poses -> in-between -> apply: exactly R0 -> R1 -> R2, one wrapper run per capability", async () => {
		// --- Step 1: ardy_generate advances R0 -> R1 and applies the base
		// motion, all through the real queue and kernel. ---
		await writeGenerateRequest(project, generateRequest());
		const generateEntries = await h.sweepGenerate();
		assert.equal(generateEntries.length, 1);
		const generateOutcome = generateEntries[0]!.outcome;
		assert.equal(
			generateOutcome.status,
			"succeeded",
			generateOutcome.status === "failed" ? generateOutcome.message : "",
		);
		assert.equal(generateOutcome.request_id, GENERATE_REQUEST_ID);
		assert.equal(generateOutcome.resulting_revision_id, R1, "the generate apply commits R1");
		assert.deepEqual(generateOutcome.result, {
			schema_version: 1,
			request_id: GENERATE_REQUEST_ID,
			motion_id: "motion-000000000001",
			frames: 100,
			duration_seconds: 5,
			seed: 7,
		});
		assert.equal(h.revision.current, R1);
		assert.deepEqual(h.revisionHistory, [R1], "the first transition lands exactly once");
		assert.deepEqual(h.counters.runCli, { generate: 1, inbetween: 0, total: 1 });
		assert.deepEqual(h.counters.applies, { generate: 1, inbetween: 0, total: 1 });
		// The exact unconstrained argv rode through the real queue once, and
		// the apply dispatch carried the REAL apply_motion plan bound to R0.
		assert.deepEqual(h.runCalls, [[PROMPT, "--duration", "5", "--seed", "7"]]);
		assert.deepEqual(h.applyPlans, [
			{
				schema_version: 1,
				expected_revision_id: R0,
				operations: [{ op: "apply_motion", entity_id: ENTITY, motion_id: "motion-000000000001" }],
			},
		]);

		// --- Step 2: the add-on's evaluated-pose capture (Blender-side; the
		// harness stands in for it, see plantCapturedPoses). The in-between
		// request is built against the CURRENT revision and the generate
		// output as its base clip. ---
		const generateResult = generateOutcome.status === "succeeded" ? generateOutcome.result : undefined;
		assert.ok(generateResult !== undefined, "the generate outcome must carry a result");
		const inbetween = inbetweenRequest({
			baseMotionId: generateResult.motion_id,
			expectedRevisionId: h.revision.current,
		});
		assert.equal(
			inbetween.expected_revision_id,
			R1,
			"the in-between request must carry R1, the revision ardy_generate applied and advanced to -- a harness that passed with R0 would be proving the staleness check is broken",
		);
		await plantCapturedPoses(h, inbetween);
		await writeInbetweenRequest(project, inbetween);

		// --- Step 3: ardy_inbetween advances R1 -> R2 and applies the
		// in-between motion. ---
		const inbetweenEntries = await h.sweepInbetween();
		assert.equal(inbetweenEntries.length, 1);
		const inbetweenOutcome = inbetweenEntries[0]!.outcome;
		assert.equal(
			inbetweenOutcome.status,
			"succeeded",
			inbetweenOutcome.status === "failed" ? inbetweenOutcome.message : "",
		);
		assert.equal(inbetweenOutcome.request_id, INBETWEEN_REQUEST_ID);
		assert.equal(inbetweenOutcome.resulting_revision_id, R2, "the in-between apply commits R2");
		assert.equal(h.revision.current, R2);
		assert.deepEqual(h.revisionHistory, [R1, R2], "exactly two transitions, R0 -> R1 -> R2, in order");
		assert.equal(new Set([R0, R1, R2]).size, 3, "the three revisions are distinct values");
		// The wrapper ran exactly twice across the whole loop: once per
		// capability.
		assert.deepEqual(h.counters.runCli, { generate: 1, inbetween: 1, total: 2 });
		assert.deepEqual(h.counters.applies, { generate: 1, inbetween: 1, total: 2 });
		// The queue's own callback observed the captured poses on disk AFTER
		// capture and BEFORE the outcome was durable; the sweep retired them
		// by the time it returned.
		assert.equal(h.poseObservation.seen, true, "the queue's apply callback must observe the pose lifecycle");
		assert.deepEqual(
			h.poseObservation.posesPresent,
			[true, true, true],
			"captured poses must still be on disk when the queue applies (after capture, before the outcome is durable)",
		);
		assert.equal(
			h.poseObservation.outcomeDurable,
			false,
			"the outcome must not be durable yet while the queue is still applying",
		);
		const poseIds = inbetweenSyntheticPoseIds(inbetween);
		for (const poseId of poseIds) {
			assert.equal(
				await existsOnDisk(join(h.motionsDir, `${poseId}.npz`)),
				false,
				`the synthetic pose ${poseId} must be gone after the sweep retired the request`,
			);
		}
		// The final result carries dropped_constraints, continuity, motion_id
		// and resulting_revision_id, and they reach the caller intact. The
		// wrapper contract pins in-between dropped_constraints to [] (every
		// pose is structurally in range, see ardy-inbetween-service.ts), and
		// the continuity the wrapper measured is echoed verbatim.
		const inbetweenResult = inbetweenOutcome.status === "succeeded" ? inbetweenOutcome.result : undefined;
		assert.ok(inbetweenResult !== undefined, "the in-between outcome must carry a result");
		assert.deepEqual(inbetweenResult, {
			schema_version: 1,
			request_id: INBETWEEN_REQUEST_ID,
			motion_id: "motion-000000000002",
			frames: 12000,
			captured_frames: 3,
			base_motion_id: "motion-000000000001",
			continuity: INBETWEEN_CONTINUITY,
			dropped_constraints: [],
		});
		assert.equal(inbetweenResult.motion_id, "motion-000000000002");
		assert.deepEqual(
			inbetweenResult.continuity,
			INBETWEEN_CONTINUITY,
			"the measured continuity reaches the caller intact",
		);
		assert.deepEqual(inbetweenResult.dropped_constraints, [], "dropped_constraints is present in the final result");
		// The exact constrained argv rode through the real queue once, with
		// the synthetic pose ids derived by the service's own rule, and the
		// apply dispatch carried the real apply_motion plan bound to R1.
		assert.deepEqual(h.runCalls, [
			[PROMPT, "--duration", "5", "--seed", "7"],
			[
				ARDY_CONSTRAINED_PROMPT,
				"--duration",
				ARDY_CONSTRAINED_DURATION_SECONDS,
				"--base-motion",
				"motion-000000000001",
				"--constrain-pose",
				poseIds[0]!,
				"0",
				"0",
				"--constrain-pose",
				poseIds[1]!,
				"0",
				"60",
				"--constrain-pose",
				poseIds[2]!,
				"0",
				"120",
			],
		]);
		assert.deepEqual(h.applyPlans, [
			{
				schema_version: 1,
				expected_revision_id: R0,
				operations: [{ op: "apply_motion", entity_id: ENTITY, motion_id: "motion-000000000001" }],
			},
			{
				schema_version: 1,
				expected_revision_id: R1,
				operations: [{ op: "apply_motion", entity_id: ENTITY, motion_id: "motion-000000000002" }],
			},
		]);
		assert.equal(h.applyPlans[1]!.expected_revision_id, R1, "the in-between apply plan binds R1, not R0");
		// One committed archive per capability; the base clip is the generate
		// output, and the captured poses are retired.
		assert.deepEqual(await motionFiles(h), ["motion-000000000001.npz", "motion-000000000002.npz"]);
		// Terminal queue state: requests and progress retired, both outcomes
		// durable.
		assert.deepEqual(await readdir(generateQueuePaths(project).requests), []);
		assert.deepEqual(await readdir(inbetweenQueuePaths(project).requests), []);
		assert.deepEqual(await readdir(generateQueuePaths(project).outcomes), [`${GENERATE_REQUEST_ID}.json`]);
		assert.deepEqual(await readdir(inbetweenQueuePaths(project).outcomes), [`${INBETWEEN_REQUEST_ID}.json`]);
		assert.deepEqual(await readdir(generateQueuePaths(project).progress), []);
		assert.deepEqual(await readdir(inbetweenQueuePaths(project).progress), []);

		// --- Step 4: resubmitting BOTH request ids is a read of the recorded
		// outcome, never another run: no wrapper invocation, no archive
		// entry, no revision, and the second read comes from the SAME outcome
		// file (same inode and mtime, byte-identical content -- a regenerated
		// outcome would be a temp-rename rewrite and a new inode). ---
		const generateOutcomePath = join(generateQueuePaths(project).outcomes, `${GENERATE_REQUEST_ID}.json`);
		const inbetweenOutcomePath = join(inbetweenQueuePaths(project).outcomes, `${INBETWEEN_REQUEST_ID}.json`);
		const generateBefore = await readFile(generateOutcomePath);
		const inbetweenBefore = await readFile(inbetweenOutcomePath);
		const generateStatBefore = await stat(generateOutcomePath);
		const inbetweenStatBefore = await stat(inbetweenOutcomePath);

		await writeGenerateRequest(project, generateRequest());
		const generateAgain = await h.sweepGenerate();
		assert.equal(generateAgain.length, 1);
		assert.deepEqual(
			generateAgain[0]!.outcome,
			generateOutcome,
			"the second generate read returns the identical recorded outcome",
		);
		await writeInbetweenRequest(project, inbetween);
		const inbetweenAgain = await h.sweepInbetween();
		assert.equal(inbetweenAgain.length, 1);
		assert.deepEqual(
			inbetweenAgain[0]!.outcome,
			inbetweenOutcome,
			"the second in-between read returns the identical recorded outcome",
		);

		assert.deepEqual(
			h.counters.runCli,
			{ generate: 1, inbetween: 1, total: 2 },
			"resubmitting both request ids must not invoke the wrapper a third time",
		);
		assert.deepEqual(
			h.counters.applies,
			{ generate: 1, inbetween: 1, total: 2 },
			"resubmitting must not apply again",
		);
		assert.equal(h.revision.current, R2, "resubmitting must not commit another revision");
		assert.deepEqual(h.revisionHistory, [R1, R2], "the revision sequence is still exactly two transitions");
		assert.deepEqual(
			await motionFiles(h),
			["motion-000000000001.npz", "motion-000000000002.npz"],
			"no additional archive entry",
		);
		for (const poseId of poseIds) {
			assert.equal(
				await existsOnDisk(join(h.motionsDir, `${poseId}.npz`)),
				false,
				`the synthetic pose ${poseId} stays retired`,
			);
		}

		assert.deepEqual(
			await readFile(generateOutcomePath),
			generateBefore,
			"the generate outcome file is byte-identical",
		);
		const generateStatAfter = await stat(generateOutcomePath);
		assert.equal(
			generateStatAfter.ino,
			generateStatBefore.ino,
			"the second generate read came from the same outcome file, not a regenerated one",
		);
		assert.equal(generateStatAfter.mtimeMs, generateStatBefore.mtimeMs);
		assert.deepEqual(
			await readFile(inbetweenOutcomePath),
			inbetweenBefore,
			"the in-between outcome file is byte-identical",
		);
		const inbetweenStatAfter = await stat(inbetweenOutcomePath);
		assert.equal(
			inbetweenStatAfter.ino,
			inbetweenStatBefore.ino,
			"the second in-between read came from the same outcome file, not a regenerated one",
		);
		assert.equal(inbetweenStatAfter.mtimeMs, inbetweenStatBefore.mtimeMs);
	});

	it("an in-between request carrying the STALE R0 after the generate step advanced the revision is rejected as REVISION_MISMATCH with ZERO wrapper invocations", async () => {
		// R0 -> R1 first, exactly as the main loop does.
		await writeGenerateRequest(project, generateRequest());
		const generateEntries = await h.sweepGenerate();
		assert.equal(generateEntries.length, 1);
		assert.equal(
			generateEntries[0]!.outcome.status,
			"succeeded",
			generateEntries[0]!.outcome.status === "failed" ? generateEntries[0]!.outcome.message : "",
		);
		assert.equal(h.revision.current, R1);
		assert.equal(h.counters.runCli.generate, 1);

		// The animator's in-between request was captured against the OLD
		// scene (R0) -- the generate apply has since advanced the revision,
		// so the request is stale before the wrapper is ever considered.
		const stale = inbetweenRequest({ baseMotionId: "motion-000000000001", expectedRevisionId: R0 });
		await plantCapturedPoses(h, stale);
		await writeInbetweenRequest(project, stale);

		const entries = await h.sweepInbetween();
		assert.equal(entries.length, 1);
		const outcome = entries[0]!.outcome;
		assert.equal(outcome.status, "failed");
		assert.equal(outcome.status === "failed" && outcome.error_code, "REVISION_MISMATCH");
		assert.equal(h.counters.runCli.inbetween, 0, "a stale in-between request must never call the wrapper");
		assert.equal(
			h.counters.runCli.total,
			1,
			"the only wrapper run across the whole test was the generate capability's",
		);
		assert.equal(h.counters.applies.inbetween, 0, "a stale in-between request must never reach the apply");
		assert.equal(h.counters.applies.total, 1);
		assert.equal(h.revision.current, R1, "the revision must not advance for a stale request");
		assert.deepEqual(h.revisionHistory, [R1]);
		assert.equal(h.applyPlans.length, 1, "no apply plan may be built for the stale request");
		assert.equal(h.poseObservation.seen, false, "the in-between apply must never have run");
		// The failure path still retires the captured poses with the request.
		assert.deepEqual(
			await motionFiles(h),
			["motion-000000000001.npz"],
			"captured poses are retired even on the failure path",
		);
		assert.equal(
			await existsOnDisk(join(h.motionsDir, "motion-000000000002.npz")),
			false,
			"the stale request must not produce an archive",
		);
		// Terminal state: one recorded failure outcome, nothing left in
		// flight.
		assert.deepEqual(await readdir(inbetweenQueuePaths(project).requests), []);
		assert.deepEqual(await readdir(inbetweenQueuePaths(project).outcomes), [`${INBETWEEN_REQUEST_ID}.json`]);
		// The stale request never ran the kernel, so it must not have
		// recorded any progress at all (the progress directory may not even
		// exist).
		assert.equal(
			await existsOnDisk(join(inbetweenQueuePaths(project).progress, `${INBETWEEN_REQUEST_ID}.json`)),
			false,
			"a stale request must never record write-ahead progress",
		);
	});
});
