import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildSceneManifestV3Revision, type DirectorProject } from "@oh-my-blender/director-core";
import { type CameraPlanV1, parseSceneManifestV2 } from "@oh-my-blender/protocol";
import {
	type CameraPlanRevisionStore,
	commitCameraPlanMutation,
	createApplyCameraPlanHandler,
} from "../src/apply-camera-plan-service.ts";

const plan: CameraPlanV1 = {
	schema_version: 1,
	expected_revision_id: "a".repeat(64),
	evidence_sha256: "b".repeat(64),
	output_format: { width: 640, height: 360 },
	keyframes: [
		{
			frame: 1,
			pose: {
				position: [0, 0, 50],
				look_at: [0, 0, 0],
				up: [0, 1, 0],
				vertical_fov_radians: 0.5,
			},
			transition: "smooth",
		},
	],
};

const manifest = parseSceneManifestV2(
	JSON.parse(
		await readFile(
			new URL("../../director-core/test/fixtures/scene-manifest-v2-parity.json", import.meta.url),
			"utf8",
		),
	),
);

function fakeStore(events: string[] = []): CameraPlanRevisionStore {
	const current: DirectorProject = {
		project_id: manifest.projectId,
		schema_version: 1,
		current_revision_id: plan.expected_revision_id,
	};
	return {
		readProject: async () => current,
		commitRevision: async (expected, child, journal) => {
			assert.equal(expected, plan.expected_revision_id);
			assert.equal(child.current_revision_id, manifest.revisionId);
			assert.equal(child.manifest, manifest);
			assert.deepEqual(journal, {
				type: "apply_camera_plan",
				evidence_sha256: plan.evidence_sha256,
				expected_revision_id: plan.expected_revision_id,
				resulting_revision_id: manifest.revisionId,
				scene_hash: manifest.sceneHash,
			});
			events.push("commit:durable");
		},
	};
}

test("row 35: live main-thread V2 hash differs — STALE_BASE", async () => {
	let dispatched = false;
	await assert.rejects(
		createApplyCameraPlanHandler({ store: fakeStore() })(plan, {
			signal: new AbortController().signal,
			request: { expected_revision_id: "c".repeat(64) },
			applyCameraPlan: async () => {
				dispatched = true;
				return { expected_revision_id: plan.expected_revision_id, scene_hash: manifest.sceneHash, manifest };
			},
		}),
		/STALE_BASE/,
	);
	assert.equal(dispatched, false);
});

test("commits the mutation candidate durably before returning the top-level response", async () => {
	const controller = new AbortController();
	const progress: Array<[string, number, number]> = [];
	const events: string[] = [];
	let received: CameraPlanV1 | undefined;
	const output = await createApplyCameraPlanHandler({ store: fakeStore(events) })(plan, {
		signal: controller.signal,
		request: { expected_revision_id: plan.expected_revision_id },
		reportProgress: (phase, completed, total) => progress.push([phase, completed, total]),
		beginDurableCommit: () => events.push("commit:owned"),
		applyCameraPlan: async (value, context) => {
			received = value;
			assert.equal(context.signal, controller.signal);
			context.reportProgress({ phase: "mutating", completed: 1, total: 2 });
			events.push("bridge:result");
			return { expected_revision_id: plan.expected_revision_id, scene_hash: manifest.sceneHash, manifest };
		},
	});
	events.push("handler:resolved");
	assert.deepEqual(received, plan);
	assert.deepEqual(progress, [["mutating", 1, 2]]);
	assert.deepEqual(events, ["bridge:result", "commit:owned", "commit:durable", "handler:resolved"]);
	assert.equal(output.resulting_revision_id, manifest.revisionId);
});

test("commit conflict rejects the mutation so the add-on receives a top-level error", async () => {
	const store = fakeStore();
	store.commitRevision = async () => {
		throw new Error("STALE_BASE: commit conflict");
	};
	await assert.rejects(
		createApplyCameraPlanHandler({ store })(plan, {
			signal: new AbortController().signal,
			request: { expected_revision_id: plan.expected_revision_id },
			applyCameraPlan: async () => ({
				expected_revision_id: plan.expected_revision_id,
				scene_hash: manifest.sceneHash,
				manifest,
			}),
		}),
		/STALE_BASE: commit conflict/,
	);
});

test("rejects a mutation candidate whose manifest content does not match its supplied hashes", async () => {
	const tampered = structuredClone(manifest);
	tampered.cameraAnimations[0]!.fcurves[0]!.keyframes[0]!.value += 1;
	let committed = false;
	const store = fakeStore();
	store.commitRevision = async () => {
		committed = true;
	};
	await assert.rejects(
		createApplyCameraPlanHandler({ store })(plan, {
			signal: new AbortController().signal,
			request: { expected_revision_id: plan.expected_revision_id },
			applyCameraPlan: async () => ({
				expected_revision_id: plan.expected_revision_id,
				scene_hash: tampered.sceneHash,
				manifest: tampered,
			}),
		}),
		/INVALID_MUTATION_RESULT/,
	);
	assert.equal(committed, false);
});

test("rejects a mutation candidate whose revisionId does not match the recomputed revision", async () => {
	const tampered = { ...manifest, revisionId: "d".repeat(64) };
	let committed = false;
	const store = fakeStore();
	store.commitRevision = async () => {
		committed = true;
	};
	await assert.rejects(
		createApplyCameraPlanHandler({ store })(plan, {
			signal: new AbortController().signal,
			request: { expected_revision_id: plan.expected_revision_id },
			applyCameraPlan: async () => ({
				expected_revision_id: plan.expected_revision_id,
				scene_hash: tampered.sceneHash,
				manifest: tampered,
			}),
		}),
		/INVALID_MUTATION_RESULT/,
	);
	assert.equal(committed, false);
});

test("preserves a durable V3 substrate and derives the camera child through its parent chain", async () => {
	const { schemaVersion: _schemaVersion, revisionId: _revisionId, sceneHash: _sceneHash, ...v2HashFree } = manifest;
	const stagedManifest = buildSceneManifestV3Revision(
		{
			...v2HashFree,
			schemaVersion: 3,
			lights: manifest.lights.map((light) => ({ ...light, areaSize: null })),
			stagePrimitives: [{ objectId: manifest.objects[1]!.entityId, primitiveType: "CUBE" }],
			stageMaterials: [],
		},
		"c".repeat(64),
		{ schema_version: 1, operations: ["stage"] },
	);
	const stagedPlan: CameraPlanV1 = { ...plan, expected_revision_id: stagedManifest.revisionId };
	const { revisionId: _stagedRevisionId, sceneHash: _stagedSceneHash, ...stagedHashFree } = stagedManifest;
	const cameraManifest = buildSceneManifestV3Revision(stagedHashFree, stagedPlan.expected_revision_id, stagedPlan);
	let committedManifest: typeof cameraManifest | undefined;
	const store: CameraPlanRevisionStore = {
		readProject: async () => ({
			project_id: stagedManifest.projectId,
			schema_version: 1,
			current_revision_id: stagedManifest.revisionId,
			manifest: stagedManifest,
		}),
		commitRevision: async (expectedRevisionId, child) => {
			assert.equal(expectedRevisionId, stagedManifest.revisionId);
			committedManifest = child.manifest as typeof cameraManifest;
		},
	};

	const result = await commitCameraPlanMutation(store, stagedPlan, {
		expected_revision_id: stagedPlan.expected_revision_id,
		scene_hash: cameraManifest.sceneHash,
		manifest: cameraManifest,
	});

	assert.equal(result.resulting_revision_id, cameraManifest.revisionId);
	assert.notEqual(cameraManifest.revisionId, stagedManifest.revisionId);
	assert.equal(committedManifest?.schemaVersion, 3);
	assert.deepEqual(committedManifest?.stagePrimitives, stagedManifest.stagePrimitives);
	assert.deepEqual(committedManifest?.stageMaterials, stagedManifest.stageMaterials);
});
test("does not call commitRevision when cancellation wins the durable-commit barrier", async () => {
	let committed = false;
	const store = fakeStore();
	store.commitRevision = async () => {
		committed = true;
	};
	await assert.rejects(
		createApplyCameraPlanHandler({ store })(plan, {
			signal: AbortSignal.abort(),
			request: { expected_revision_id: plan.expected_revision_id },
			beginDurableCommit: () => {
				throw new Error("CANCELLED: cancellation won before durable commit");
			},
			applyCameraPlan: async () => ({
				expected_revision_id: plan.expected_revision_id,
				scene_hash: manifest.sceneHash,
				manifest,
			}),
		}),
		/CANCELLED/,
	);
	assert.equal(committed, false);
});
