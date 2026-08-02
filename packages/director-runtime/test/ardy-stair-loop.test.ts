// The in-process orchestration harness for the issue-#1 stair loop: ONE
// request set drives ardy_generate -> the add-on's evaluated-pose capture ->
// ardy_inbetween -> apply, and the whole chain must compose through the REAL
// production runners (startGenerateQueueRunner / startInbetweenQueueRunner,
// including their startup recovery, serialized sweeps, write-ahead bindings,
// kernels and production per-request context), the REAL write-ahead machinery
// (ardy-queue.ts), the REAL MotionArchiveStore, the REAL apply_motion plan
// builder, the REAL canonicalization (canonicalizeStageScenePlan +
// buildSceneManifestV4Revision), and the REAL durable commit
// (commitStageSceneMutation against a real ProjectStore). The revisions R1
// and R2 are DERIVED by that canonicalization and PERSISTED by the project
// store -- the harness never chooses them. This is the last thing that can be
// verified without a real ARDY host: live acceptance on real Blender with a
// real GPU host is blocked on CCLAY_ARDY_HOST, which is unset in CI.
//
// The COMPLETE fake surface:
//   - The wrapper script (a stand-in for scripts/cclay-ardy-generate): the
//     GPU host's stand-in, driven through the runners' real wrapperPath seam
//     and their real execFile discipline. It records argv, stages the
//     generated npz exactly like the real wrapper's scp download, and prints
//     the contract JSON line. Its reported frames count (1) matches the
//     single-frame fixture it writes, so metadata and archive agree.
//   - The two Blender-side calls in the apply dispatch. The production glue
//     (apps/cclay-extension/src/cclay/index.ts) is canonicalize ->
//     bridge.stageScene -> commitStageSceneMutation ->
//     bridge.finishDurableCommit. CI has no Blender, so bridge.stageScene is
//     simulated by recomputing the add-on's mutation candidate with the SAME
//     canonical child-revision derivation the durable commit validates
//     against, and bridge.finishDurableCommit (the transaction ack) is a
//     no-op that advances the live-revision getter exactly as the real
//     bridge's ack advances bridge.revisionId. Canonicalization and the
//     durable ProjectStore commit are REAL.
//   - capture_evaluated_pose: Blender-side (blender-addon/cclay/
//     constraint_capture.py) and covered by its own real-Blender tests; this
//     harness stands in for it by minting ONLY the synthetic pose archives
//     the add-on's capture step leaves on disk (cclay-pose-<request_id>-<n>,
//     1-based, derived with the service's own inbetweenSyntheticPoseIds
//     rule) with the real archive fixture. It deliberately never touches the
//     base clip: the archive the generate stage committed is what the
//     in-between stage must consume, and the harness hashes it across the
//     planting step to prove it.
//
// Two smaller stand-ins, listed because an incomplete fake inventory is how
// this harness overstated itself twice already:
//   - The prepared-transaction envelope is short-circuited. The harness hands
//     commitStageSceneMutation a naked candidate rather than driving the real
//     transaction/request envelope, ack transport and reconciliation, which
//     need a live Blender transaction.
//   - The runners' onError callbacks throw, so a swallowed background error
//     fails the test loudly. Production reports rather than throws.
//
// Everything else -- the runners' startup recovery, both kernels, both
// queues, the write-ahead records, the staleness guards, the synthetic-pose
// retirement, the derived R0 -> R1 -> R2 chain in the project store -- is the
// real code under test.
//
// What this harness CANNOT establish is the live leg: the real wrapper's
// host/SSH/SCP behaviour, remote GPU generation, agreement between real
// wrapper metadata and real NPZ bytes, real capture_evaluated_pose, real
// stage_scene/apply_motion in Blender, extension startup wiring, crash and
// restart recovery windows, and whether the resulting motion is any good.
// That is story S9b and it needs a configured CCLAY_ARDY_HOST.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { buildSceneManifestV4Revision, type ManifestForHashing, ProjectStore } from "@cclay/director-core";
import {
	commitStageSceneMutation,
	generateQueuePaths,
	inbetweenQueuePaths,
	inbetweenSyntheticPoseIds,
	MotionArchiveStore,
} from "@cclay/director-runtime";
import {
	ARDY_CONSTRAINED_DURATION_SECONDS,
	ARDY_CONSTRAINED_PROMPT,
	type ArdyGenerateRequestV1,
	type ArdyInbetweenRequestV1,
	canonicalizeStageScenePlan,
	parseSceneManifestV4,
	type SceneManifestV4,
	type StageSceneAppliedHandShape,
	type StageSceneMutationCandidate,
	type StageScenePlanV1,
	type StageSceneRequestV1,
} from "@cclay/protocol";
import { startGenerateQueueRunner } from "../../../apps/cclay-extension/src/generate-queue-runner.ts";
import { startInbetweenQueueRunner } from "../../../apps/cclay-extension/src/inbetween-queue-runner.ts";
import { validMotionArchive } from "./ardy-archive-fixture.ts";

const ENTITY = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const GENERATE_REQUEST_ID = "0123456789abcdef0123456789abcdef";
const INBETWEEN_REQUEST_ID = "fedcba9876543210fedcba9876543210";
const PROMPT = "a person waves both hands";
const INBETWEEN_CONTINUITY = { mean_jump_m: 0.042, max_jump_m: 0.121, max_jump_frame: 24 };

// The project the loop starts from: a REAL V4 scene manifest (the same
// director-core parity fixture the stage-scene commit tests use), written
// into a REAL ProjectStore. R0 is the manifest's own recorded revision -- the
// harness does not mint revisions, it reads them.
const initialManifest = parseSceneManifestV4(
	JSON.parse(
		await readFile(
			new URL("../../director-core/test/fixtures/scene-manifest-v4-parity.json", import.meta.url),
			"utf8",
		),
	),
);
const R0 = initialManifest.revisionId;

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

function inbetweenRequest(options: { baseMotionId: string; expectedRevisionId: string }): ArdyInbetweenRequestV1 {
	return {
		schema_version: 1,
		request_id: INBETWEEN_REQUEST_ID,
		entity_id: ENTITY,
		expected_revision_id: options.expectedRevisionId,
		base_motion_id: options.baseMotionId,
		pose_frames: [
			{ scene_frame: 100, clip_frame: 0 },
			{ scene_frame: 160, clip_frame: 60 },
			{ scene_frame: 220, clip_frame: 120 },
		],
		requested_at_ms: 1_700_000_000_000,
	};
}

// The fake wrapper: a real executable the runners spawn through their
// wrapperPath seam with the real execFile discipline. It records argv,
// stages the npz like the real wrapper's scp download, and prints the
// contract JSON line. The motion id comes from a counter file so the two
// capabilities get distinct, deterministic ids; the reported frames count
// matches the single-frame fixture (metadata and archive agree).
const FAKE_WRAPPER_SOURCE = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const argv = process.argv.slice(2);
const logPath = process.env.CCLAY_STAIR_ARGV_LOG;
if (logPath !== undefined) {
  fs.appendFileSync(logPath, JSON.stringify(argv) + "\\n");
}
const cwd = process.cwd();
const counterPath = path.join(cwd, ".cclay", "fake-wrapper-counter");
let count = 1;
try {
  count = Number(fs.readFileSync(counterPath, "utf8")) + 1;
} catch (error) {}
fs.mkdirSync(path.join(cwd, ".cclay", "motions"), { recursive: true });
fs.writeFileSync(counterPath, String(count));
const motionId = "motion-" + String(count).padStart(12, "0");
const npzBase64 = process.env.CCLAY_STAIR_NPZ_B64;
if (npzBase64 !== undefined) {
  fs.writeFileSync(path.join(cwd, ".cclay", "motions", motionId + ".npz"), Buffer.from(npzBase64, "base64"));
}
const durationIndex = argv.indexOf("--duration");
const durationS = durationIndex === -1 ? undefined : Number(argv[durationIndex + 1]);
const baseIndex = argv.indexOf("--base-motion");
const isInbetween = argv[0] === "regenerate";
const payload = {
  motion_id: motionId,
  path: ".cclay/motions/" + motionId + ".npz",
  frames: 1,
  duration_s: isInbetween ? 600 : durationS
};
if (isInbetween) {
  payload.base_motion_id = baseIndex === -1 ? undefined : argv[baseIndex + 1];
  payload.continuity = { mean_jump_m: 0.042, max_jump_m: 0.121, max_jump_frame: 24 };
}
process.stdout.write(JSON.stringify(payload) + "\\n");
`;

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

// The runners must hand the apply dispatch the production request context
// (AbortSignal timeout + the request's expected_revision_id), not an empty
// stand-in: the generate and in-between runners build it themselves.
function assertProductionContext(context: unknown, expectedRevisionId: string, label: string): void {
	const record = context as { request?: { expected_revision_id?: unknown }; signal?: unknown } | null;
	assert.ok(
		record !== null && typeof record === "object",
		`${label}: the runner must pass the production request context`,
	);
	assert.equal(
		record.request?.expected_revision_id,
		expectedRevisionId,
		`${label}: the context binds the request's expected revision`,
	);
	assert.ok(record.signal instanceof AbortSignal, `${label}: the context carries the production AbortSignal timeout`);
}

interface Harness {
	readonly project: string;
	readonly store: MotionArchiveStore;
	readonly projectStore: ProjectStore;
	readonly motionsDir: string;
	readonly generatePaths: ReturnType<typeof generateQueuePaths>;
	readonly inbetweenPaths: ReturnType<typeof inbetweenQueuePaths>;
	// Mirrors the real bridge's revisionId: advanced by the fake
	// finishDurableCommit ack, read fresh by the runners' staleness guards.
	readonly bridgeRevision: { current: string };
	// Every apply_motion plan the real plan builder produced, in apply order.
	readonly applyPlans: StageSceneRequestV1[];
	// The production contexts the apply dispatches observed, in apply order.
	readonly bridgeContexts: unknown[];
	// What the apply dispatch observed at the queue's apply point: the
	// captured poses still on disk and the outcome not yet durable (see
	// observePosesFor).
	readonly poseObservation: { seen: boolean; posesPresent: boolean[]; outcomeDurable: boolean };
	readonly generateRunner: ReturnType<typeof startGenerateQueueRunner>;
	readonly inbetweenRunner: ReturnType<typeof startInbetweenQueueRunner>;
	runCalls(): Promise<string[][]>;
	// Arms the pose-lifetime observation for the next apply dispatch.
	observePosesFor(poseIds: string[]): void;
}

async function makeHarness(project: string): Promise<Harness> {
	const projectStore = new ProjectStore(project);
	await projectStore.writeProject({
		project_id: initialManifest.projectId,
		schema_version: 1,
		current_revision_id: R0,
		manifest: initialManifest,
	});
	const store = new MotionArchiveStore(project);
	const generatePaths = generateQueuePaths(project);
	const inbetweenPaths = inbetweenQueuePaths(project);
	const bridgeRevision = { current: R0 };
	const applyPlans: StageSceneRequestV1[] = [];
	const bridgeContexts: unknown[] = [];
	const poseObservation: { seen: boolean; posesPresent: boolean[]; outcomeDurable: boolean } = {
		seen: false,
		posesPresent: [],
		outcomeDurable: false,
	};
	let expectedPoseIds: string[] = [];

	const fakeWrapperPath = join(project, "fake-ardy-wrapper");
	await writeFile(fakeWrapperPath, FAKE_WRAPPER_SOURCE, "utf8");
	await chmod(fakeWrapperPath, 0o755);
	process.env.CCLAY_STAIR_ARGV_LOG = join(project, "argv.log");
	process.env.CCLAY_STAIR_NPZ_B64 = Buffer.from(validMotionArchive()).toString("base64");

	// The production mutation glue (apps/cclay-extension/src/cclay/index.ts),
	// with ONLY the two Blender-side calls faked.
	const mutationBridge = {
		stageScene: async (plan: StageScenePlanV1, context: unknown): Promise<StageSceneMutationCandidate> => {
			bridgeContexts.push(context);
			// The add-on's mutation candidate, rebuilt with the SAME canonical
			// child-revision derivation commitStageSceneMutation validates
			// against: the manifest hashes and the child revision id are
			// computed by production code, never chosen here.
			const current = await projectStore.readProject();
			const durableManifest = current.manifest as SceneManifestV4;
			const { revisionId: _revisionId, sceneHash: _sceneHash, ...hashFree } = durableManifest;
			const manifestForHashing: ManifestForHashing = hashFree;
			const candidateManifest = buildSceneManifestV4Revision(manifestForHashing, plan.expected_revision_id, plan);
			const appliedHandShapes: StageSceneAppliedHandShape[] = [];
			for (const [index, operation] of plan.operations.entries()) {
				if (operation.op !== "apply_motion") continue;
				appliedHandShapes.push({
					operation_index: index,
					entity_id: operation.entity_id,
					motion_id: operation.motion_id,
					left: "relaxed",
					right: "relaxed",
					library_version: "1.1.0",
				});
			}
			return {
				expected_revision_id: plan.expected_revision_id,
				scene_hash: candidateManifest.sceneHash,
				manifest: candidateManifest,
				entity_identities: [],
				applied_hand_shapes: appliedHandShapes,
			};
		},
		finishDurableCommit: (resultingRevisionId: string): void => {
			// The Blender transaction ack; the real bridge also advances
			// bridge.revisionId here. Mirror exactly that: the live-revision
			// getter the runners' staleness guards read.
			bridgeRevision.current = resultingRevisionId;
		},
	};
	const stageScene = async (request: StageSceneRequestV1, context: unknown) => {
		applyPlans.push(request);
		// The pose-lifetime observation sits at the queue's apply point: the
		// production runners' writeAhead.apply IS this stageScene dispatch,
		// which runs after the kernel committed the archive and BEFORE the
		// applied-progress and outcome writes retire anything. No timing
		// guesses needed.
		if (expectedPoseIds.length > 0) {
			poseObservation.seen = true;
			poseObservation.posesPresent = await Promise.all(
				expectedPoseIds.map(async (poseId) => existsOnDisk(join(inbetweenPaths.motions, `${poseId}.npz`))),
			);
			poseObservation.outcomeDurable = await existsOnDisk(
				join(inbetweenPaths.outcomes, `${INBETWEEN_REQUEST_ID}.json`),
			);
			expectedPoseIds = [];
		}
		const plan = canonicalizeStageScenePlan(request, randomUUID);
		const candidate = await mutationBridge.stageScene(plan, context);
		const result = await commitStageSceneMutation(projectStore, plan, candidate);
		await mutationBridge.finishDurableCommit(result.resulting_revision_id);
		return result;
	};

	const generateRunner = startGenerateQueueRunner({
		cwd: project,
		liveRevisionId: () => bridgeRevision.current,
		stageScene,
		wrapperPath: fakeWrapperPath,
		tickMs: 60_000,
		onError: (error) => {
			throw error;
		},
	});
	const inbetweenRunner = startInbetweenQueueRunner({
		cwd: project,
		liveRevisionId: () => bridgeRevision.current,
		stageScene,
		wrapperPath: fakeWrapperPath,
		tickMs: 60_000,
		onError: (error) => {
			throw error;
		},
	});
	await Promise.all([generateRunner.started, inbetweenRunner.started]);

	return {
		project,
		store,
		projectStore,
		motionsDir: inbetweenPaths.motions,
		generatePaths,
		inbetweenPaths,
		bridgeRevision,
		applyPlans,
		bridgeContexts,
		poseObservation,
		generateRunner,
		inbetweenRunner,
		runCalls: async () => {
			const logPath = join(project, "argv.log");
			const text = await readFile(logPath, "utf8").catch(() => "");
			return text
				.split("\n")
				.filter((line) => line.trim() !== "")
				.map((line) => JSON.parse(line) as string[]);
		},
		observePosesFor: (poseIds) => {
			expectedPoseIds = poseIds;
		},
	};
}

// Plants the request's synthetic pose archives the way the add-on's capture
// step leaves them (capture_evaluated_pose). The capture step itself is
// Blender-side and covered by its own real-Blender tests; this stands in for
// it with the real archive fixture, minting exactly the ids the add-on's rule
// produces. It writes ONLY the pose archives: the base clip is the GENERATE
// stage's committed output and must survive byte-identical into the
// in-between stage -- the harness hashes it across this call.
async function plantCapturedPoses(h: Harness, request: ArdyInbetweenRequestV1): Promise<void> {
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
		if (h !== undefined) {
			await h.generateRunner.stop();
			await h.inbetweenRunner.stop();
		}
		delete process.env.CCLAY_STAIR_ARGV_LOG;
		delete process.env.CCLAY_STAIR_NPZ_B64;
		await rm(project, { recursive: true, force: true });
	});

	it("ONE request set drives generate -> captured poses -> in-between -> apply through the production runners: the canonical R0 -> R1 -> R2 chain is derived and persisted", async () => {
		// --- Step 1: ardy_generate advances R0 -> R1 and applies the base
		// motion, all through the real runner, queue, kernel and durable
		// commit. ---
		const generateOutcome = await h.generateRunner.generate(generateRequest());
		assert.equal(
			generateOutcome.status,
			"succeeded",
			generateOutcome.status === "failed" ? generateOutcome.message : "",
		);
		assert.equal(generateOutcome.request_id, GENERATE_REQUEST_ID);
		const R1 = (await h.projectStore.readProject()).current_revision_id;
		assert.equal(
			generateOutcome.resulting_revision_id,
			R1,
			"the generate apply commits the canonical child revision",
		);
		assert.notEqual(R1, R0, "the canonical child revision must differ from its parent");
		assert.deepEqual(generateOutcome.result, {
			schema_version: 1,
			request_id: GENERATE_REQUEST_ID,
			motion_id: "motion-000000000001",
			frames: 1,
			duration_seconds: 5,
			seed: 7,
		});
		assert.equal(h.bridgeRevision.current, R1, "the fake ack advances the live revision exactly as the bridge does");
		// The exact unconstrained argv rode through the real queue once, and
		// the apply dispatch carried the REAL apply_motion plan bound to R0
		// with the production request context.
		assert.deepEqual(await h.runCalls(), [[PROMPT, "--duration", "5", "--seed", "7"]]);
		assert.deepEqual(h.applyPlans, [
			{
				schema_version: 1,
				expected_revision_id: R0,
				operations: [{ op: "apply_motion", entity_id: ENTITY, motion_id: "motion-000000000001" }],
			},
		]);
		assertProductionContext(h.bridgeContexts[0], R0, "the generate apply dispatch");
		const baseArchiveAfterGenerate = await readFile(join(h.motionsDir, "motion-000000000001.npz"));

		// --- Step 2: the add-on's evaluated-pose capture (Blender-side; the
		// harness stands in for it, see plantCapturedPoses). The in-between
		// request is built against the CURRENT revision and the generate
		// output as its base clip. ---
		const generateResult = generateOutcome.status === "succeeded" ? generateOutcome.result : undefined;
		assert.ok(generateResult !== undefined, "the generate outcome must carry a result");
		const inbetween = inbetweenRequest({
			baseMotionId: generateResult.motion_id,
			expectedRevisionId: R1,
		});
		assert.equal(
			inbetween.expected_revision_id,
			R1,
			"the in-between request must carry R1, the revision ardy_generate applied and advanced to -- a harness that passed with R0 would be proving the staleness check is broken",
		);
		await plantCapturedPoses(h, inbetween);
		// F1: capture planting must never touch the base archive. The
		// in-between stage consumes the archive the GENERATE stage actually
		// committed -- that handoff is the point of this harness.
		const baseArchiveAfterPlant = await readFile(join(h.motionsDir, "motion-000000000001.npz"));
		assert.deepEqual(
			baseArchiveAfterPlant,
			baseArchiveAfterGenerate,
			"the generated base archive must be byte-identical after capture planting: the in-between stage consumes what the generate stage actually committed",
		);
		h.observePosesFor(inbetweenSyntheticPoseIds(inbetween));

		// --- Step 3: ardy_inbetween advances R1 -> R2 and applies the
		// in-between motion. ---
		const inbetweenOutcome = await h.inbetweenRunner.inbetween(inbetween);
		assert.equal(
			inbetweenOutcome.status,
			"succeeded",
			inbetweenOutcome.status === "failed" ? inbetweenOutcome.message : "",
		);
		assert.equal(inbetweenOutcome.request_id, INBETWEEN_REQUEST_ID);
		const R2 = (await h.projectStore.readProject()).current_revision_id;
		assert.equal(
			inbetweenOutcome.resulting_revision_id,
			R2,
			"the in-between apply commits the canonical child revision of R1",
		);
		assert.notEqual(R2, R1, "each apply must derive a new canonical revision");
		assert.equal(new Set([R0, R1, R2]).size, 3, "the three revisions are distinct values");
		assert.equal(h.bridgeRevision.current, R2);
		// The wrapper ran exactly twice across the whole loop: once per
		// capability.
		const poseIds = inbetweenSyntheticPoseIds(inbetween);
		assert.deepEqual(await h.runCalls(), [
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
		assertProductionContext(h.bridgeContexts[1], R1, "the in-between apply dispatch");
		// The apply dispatch observed the captured poses on disk AFTER
		// capture and BEFORE the outcome was durable; the sweep retired them
		// by the time it returned.
		assert.equal(h.poseObservation.seen, true, "the queue's apply point must observe the pose lifecycle");
		assert.deepEqual(
			h.poseObservation.posesPresent,
			[true, true, true],
			"captured poses must still be on disk at the queue's apply point (after capture, before the outcome is durable)",
		);
		assert.equal(
			h.poseObservation.outcomeDurable,
			false,
			"the outcome must not be durable yet while the queue is still applying",
		);
		for (const poseId of poseIds) {
			assert.equal(
				await existsOnDisk(join(h.motionsDir, `${poseId}.npz`)),
				false,
				`the synthetic pose ${poseId} must be gone after the sweep retired the request`,
			);
		}
		// The final result carries dropped_constraints, continuity, motion_id
		// and resulting_revision_id, and they reach the caller intact.
		// dropped_constraints is pinned to [] by the real in-between
		// adapter's wrapper-JSON projection and the protocol's clip-frame
		// ceiling makes an out-of-range destination frame structurally
		// unreachable (ardy-inbetween-service.ts), so asserting it proves the
		// field survives serialization intact -- adapter plumbing, not
		// constraint-retention coverage.
		const inbetweenResult = inbetweenOutcome.status === "succeeded" ? inbetweenOutcome.result : undefined;
		assert.ok(inbetweenResult !== undefined, "the in-between outcome must carry a result");
		assert.deepEqual(inbetweenResult, {
			schema_version: 1,
			request_id: INBETWEEN_REQUEST_ID,
			motion_id: "motion-000000000002",
			frames: 1,
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
		// F3: the project store holds the derived chain durably -- the
		// current revision, the manifest's own revisionId, and one
		// stage_scene journal record per apply, chained R0 -> R1 -> R2.
		const durableProject = await h.projectStore.readProject();
		assert.equal(durableProject.current_revision_id, R2);
		assert.equal((durableProject.manifest as SceneManifestV4).revisionId, R2);
		const journalRecords = (await readFile(h.projectStore.journalPath, "utf8"))
			.trim()
			.split("\n")
			.map(
				(line) =>
					JSON.parse(line) as {
						expected_revision_id: string;
						target_revision_id: string;
						journal_entry: { operation: string };
					},
			);
		assert.deepEqual(
			journalRecords.map((record) => record.expected_revision_id),
			[R0, R1],
			"each commit names its canonical parent revision",
		);
		assert.deepEqual(
			journalRecords.map((record) => record.target_revision_id),
			[R1, R2],
			"each commit lands the canonical child revision",
		);
		assert.ok(
			journalRecords.every((record) => record.journal_entry.operation === "stage_scene"),
			"both durable commits are stage_scene operations",
		);
		// One committed archive per capability; the base clip is the generate
		// output, and the captured poses are retired.
		assert.deepEqual(await motionFiles(h), ["motion-000000000001.npz", "motion-000000000002.npz"]);
		// Terminal queue state: requests and progress retired, both outcomes
		// durable.
		assert.deepEqual(await readdir(h.generatePaths.requests), []);
		assert.deepEqual(await readdir(h.inbetweenPaths.requests), []);
		assert.deepEqual(await readdir(h.generatePaths.outcomes), [`${GENERATE_REQUEST_ID}.json`]);
		assert.deepEqual(await readdir(h.inbetweenPaths.outcomes), [`${INBETWEEN_REQUEST_ID}.json`]);
		assert.deepEqual(await readdir(h.generatePaths.progress!), []);
		assert.deepEqual(await readdir(h.inbetweenPaths.progress), []);

		// --- Step 4: resubmitting BOTH request ids is a read of the recorded
		// outcome, never another run: no wrapper invocation, no archive
		// entry, no revision, and the second read comes from the SAME outcome
		// file (same inode and mtime, byte-identical content -- a regenerated
		// outcome would be a temp-rename rewrite and a new inode). ---
		const generateOutcomePath = join(h.generatePaths.outcomes, `${GENERATE_REQUEST_ID}.json`);
		const inbetweenOutcomePath = join(h.inbetweenPaths.outcomes, `${INBETWEEN_REQUEST_ID}.json`);
		const generateBefore = await readFile(generateOutcomePath);
		const inbetweenBefore = await readFile(inbetweenOutcomePath);
		const generateStatBefore = await stat(generateOutcomePath);
		const inbetweenStatBefore = await stat(inbetweenOutcomePath);

		const generateAgain = await h.generateRunner.generate(generateRequest());
		assert.deepEqual(
			generateAgain,
			generateOutcome,
			"the second generate read returns the identical recorded outcome",
		);
		const inbetweenAgain = await h.inbetweenRunner.inbetween(inbetween);
		assert.deepEqual(
			inbetweenAgain,
			inbetweenOutcome,
			"the second in-between read returns the identical recorded outcome",
		);

		assert.deepEqual(
			await h.runCalls(),
			[
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
			],
			"resubmitting both request ids must not invoke the wrapper a third time",
		);
		assert.equal(h.applyPlans.length, 2, "resubmitting must not apply again");
		assert.equal(h.bridgeRevision.current, R2, "resubmitting must not commit another revision");
		assert.equal((await h.projectStore.readProject()).current_revision_id, R2);
		assert.deepEqual(
			await motionFiles(h),
			["motion-000000000001.npz", "motion-000000000002.npz"],
			"no additional archive entry",
		);
		assert.equal(
			await existsOnDisk(join(h.motionsDir, "motion-000000000003.npz")),
			false,
			"the wrapper must not have run a third time",
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
		const generateOutcome = await h.generateRunner.generate(generateRequest());
		assert.equal(
			generateOutcome.status,
			"succeeded",
			generateOutcome.status === "failed" ? generateOutcome.message : "",
		);
		const R1 = (await h.projectStore.readProject()).current_revision_id;
		assert.notEqual(R1, R0);
		assert.equal(h.bridgeRevision.current, R1);
		assert.equal((await h.runCalls()).length, 1);

		// The animator's in-between request was captured against the OLD
		// scene (R0) -- the generate apply has since advanced the revision,
		// so the request is stale before the wrapper is ever considered.
		const stale = inbetweenRequest({ baseMotionId: "motion-000000000001", expectedRevisionId: R0 });
		await plantCapturedPoses(h, stale);

		const outcome = await h.inbetweenRunner.inbetween(stale);
		assert.equal(outcome.status, "failed");
		assert.equal(outcome.status === "failed" && outcome.error_code, "REVISION_MISMATCH");
		assert.deepEqual(
			await h.runCalls(),
			[[PROMPT, "--duration", "5", "--seed", "7"]],
			"a stale in-between request must never call the wrapper",
		);
		assert.equal(h.applyPlans.length, 1, "no apply plan may be built for the stale request");
		assert.equal(h.poseObservation.seen, false, "the in-between apply must never have run");
		assert.equal(h.bridgeRevision.current, R1, "the revision must not advance for a stale request");
		assert.equal((await h.projectStore.readProject()).current_revision_id, R1);
		const journalRecords = (await readFile(h.projectStore.journalPath, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { target_revision_id: string });
		assert.deepEqual(
			journalRecords.map((record) => record.target_revision_id),
			[R1],
			"exactly one durable commit, the generate apply",
		);
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
		assert.deepEqual(await readdir(h.inbetweenPaths.requests), []);
		assert.deepEqual(await readdir(h.inbetweenPaths.outcomes), [`${INBETWEEN_REQUEST_ID}.json`]);
		// The stale request never ran the kernel, so it must not have
		// recorded any progress at all.
		assert.equal(
			await existsOnDisk(join(h.inbetweenPaths.progress, `${INBETWEEN_REQUEST_ID}.json`)),
			false,
			"a stale request must never record write-ahead progress",
		);
	});
});
