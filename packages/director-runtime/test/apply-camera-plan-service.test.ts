import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildSceneManifestV4Revision, type DirectorProject } from "@cclay/director-core";
import { type CameraPlanV1, parseSceneManifestV4, type SceneManifestV4 } from "@cclay/protocol";
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

const manifest = parseSceneManifestV4(
	JSON.parse(
		await readFile(
			new URL("../../director-core/test/fixtures/scene-manifest-v4-parity.json", import.meta.url),
			"utf8",
		),
	),
);
const { revisionId: _revisionId, sceneHash: _sceneHash, ...hashFreeManifest } = manifest;
const cameraCandidate = buildSceneManifestV4Revision(hashFreeManifest, plan.expected_revision_id, plan);

function fakeStore(events: string[] = []): CameraPlanRevisionStore {
	const current: DirectorProject = {
		project_id: manifest.projectId,
		schema_version: 1,
		current_revision_id: plan.expected_revision_id,
		manifest,
	};
	return {
		readProject: async () => current,
		commitRevision: async (idempotencyKey, expected, child, journal) => {
			assert.match(idempotencyKey, /^[0-9a-f-]{36}$/);
			assert.equal(expected, plan.expected_revision_id);
			assert.deepEqual(Object.keys(child).sort(), [
				"current_revision_id",
				"extensionsDigest",
				"manifest",
				"project_id",
				"schema_version",
			]);
			assert.equal(child.current_revision_id, cameraCandidate.revisionId);
			assert.equal(child.manifest, cameraCandidate);
			assert.equal(journal.schema_version, 2);
			assert.equal(journal.operation, "apply_camera_plan");
			assert.match(journal.request_id, /^[0-9a-f-]{36}$/);
			assert.match(journal.plan_sha256, /^[0-9a-f]{64}$/);
			assert.equal(journal.base_scene_hash, manifest.sceneHash);
			assert.equal(journal.candidate_scene_hash, cameraCandidate.sceneHash);
			events.push("commit:durable");
		},
		reconcileRevision: async () => ({
			status: "base_authoritative",
			revisionId: current.current_revision_id,
		}),
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
				return {
					expected_revision_id: plan.expected_revision_id,
					scene_hash: cameraCandidate.sceneHash,
					manifest: cameraCandidate,
				};
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
			return {
				expected_revision_id: plan.expected_revision_id,
				scene_hash: cameraCandidate.sceneHash,
				manifest: cameraCandidate,
			};
		},
	});
	events.push("handler:resolved");
	assert.deepEqual(received, plan);
	assert.deepEqual(progress, [["mutating", 1, 2]]);
	assert.deepEqual(events, ["bridge:result", "commit:owned", "commit:durable", "handler:resolved"]);
	assert.equal(output.resulting_revision_id, cameraCandidate.revisionId);
});
test("commits a camera plan without directing evidence", async () => {
	const { evidence_sha256: _evidenceSha256, ...planWithoutEvidence } = plan;
	const candidate = buildSceneManifestV4Revision(
		hashFreeManifest,
		planWithoutEvidence.expected_revision_id,
		planWithoutEvidence,
	);
	const store = fakeStore();
	store.commitRevision = async () => {};
	const result = await commitCameraPlanMutation(store, planWithoutEvidence, {
		expected_revision_id: planWithoutEvidence.expected_revision_id,
		scene_hash: candidate.sceneHash,
		manifest: candidate,
	});
	assert.equal(result.resulting_revision_id, candidate.revisionId);
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
				scene_hash: cameraCandidate.sceneHash,
				manifest: cameraCandidate,
			}),
		}),
		/STALE_BASE: commit conflict/,
	);
});

test("rejects a mutation candidate whose manifest content does not match its supplied hashes", async () => {
	const tampered = structuredClone(cameraCandidate);
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
	const tampered = { ...cameraCandidate, revisionId: "d".repeat(64) };
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

test("preserves a durable V4 substrate and derives the camera child through its parent chain", async () => {
	const { revisionId: _revisionId, sceneHash: _sceneHash, ...hashFree } = manifest;
	const stagedManifest = buildSceneManifestV4Revision(
		{
			...hashFree,
			lights: manifest.lights.map((light) => ({ ...light, areaSize: null })),
			stagePrimitives: [{ objectId: manifest.objects[1]!.entityId, primitiveType: "CUBE" }],
			stageMaterials: [],
		},
		"c".repeat(64),
		{ schema_version: 1, operations: ["stage"] },
	);
	const stagedPlan: CameraPlanV1 = { ...plan, expected_revision_id: stagedManifest.revisionId };
	const { revisionId: _stagedRevisionId, sceneHash: _stagedSceneHash, ...stagedHashFree } = stagedManifest;
	const cameraManifest = buildSceneManifestV4Revision(stagedHashFree, stagedPlan.expected_revision_id, stagedPlan);
	let committedManifest: SceneManifestV4 | undefined;
	const store: CameraPlanRevisionStore = {
		readProject: async () => ({
			project_id: stagedManifest.projectId,
			schema_version: 1,
			current_revision_id: stagedManifest.revisionId,
			manifest: stagedManifest,
		}),
		commitRevision: async (_idempotencyKey, expectedRevisionId, child) => {
			assert.equal(expectedRevisionId, stagedManifest.revisionId);
			if (child.manifest.schemaVersion !== 4) {
				throw new Error("expected a normalized V4 recovery manifest");
			}
			committedManifest = child.manifest;
		},
		reconcileRevision: async () => ({
			status: "base_authoritative",
			revisionId: stagedManifest.revisionId,
		}),
	};

	const result = await commitCameraPlanMutation(store, stagedPlan, {
		expected_revision_id: stagedPlan.expected_revision_id,
		scene_hash: cameraManifest.sceneHash,
		manifest: cameraManifest,
	});

	assert.equal(result.resulting_revision_id, cameraManifest.revisionId);
	assert.notEqual(cameraManifest.revisionId, stagedManifest.revisionId);
	assert.equal(committedManifest?.schemaVersion, 4);
	assert.deepEqual(committedManifest?.stagePrimitives, stagedManifest.stagePrimitives);
	assert.deepEqual(committedManifest?.stageMaterials, stagedManifest.stageMaterials);
});

test("commits a flat V4 camera candidate over a V4 durable substrate", async () => {
	const { revisionId: _revisionId, sceneHash: _sceneHash, ...hashFree } = manifest;
	const stagedManifest = buildSceneManifestV4Revision(
		{
			...hashFree,
			lights: manifest.lights.map((light) => ({ ...light, areaSize: null })),
			stagePrimitives: [{ objectId: manifest.objects[1]!.entityId, primitiveType: "CUBE" }],
			stageMaterials: [],
		},
		"c".repeat(64),
		{ schema_version: 1, operations: ["stage"] },
	);
	const durableV4 = parseSceneManifestV4(stagedManifest);
	const stagedPlan: CameraPlanV1 = { ...plan, expected_revision_id: stagedManifest.revisionId };
	const { revisionId: _stagedRevisionId, sceneHash: _stagedSceneHash, ...stagedHashFree } = stagedManifest;
	const cameraManifest = buildSceneManifestV4Revision(stagedHashFree, stagedPlan.expected_revision_id, stagedPlan);
	let committedRevisionId: string | undefined;
	const store: CameraPlanRevisionStore = {
		readProject: async () => ({
			project_id: durableV4.projectId,
			schema_version: 1,
			current_revision_id: durableV4.revisionId,
			manifest: durableV4,
		}),
		commitRevision: async (_idempotencyKey, _expectedRevisionId, child) => {
			committedRevisionId = child.current_revision_id;
		},
		reconcileRevision: async () => ({
			status: "base_authoritative",
			revisionId: durableV4.revisionId,
		}),
	};

	const result = await commitCameraPlanMutation(store, stagedPlan, {
		expected_revision_id: stagedPlan.expected_revision_id,
		scene_hash: cameraManifest.sceneHash,
		manifest: cameraManifest,
	});

	assert.equal(result.resulting_revision_id, cameraManifest.revisionId);
	assert.equal(committedRevisionId, cameraManifest.revisionId);
});

const ASSEMBLY_ID = "33333333-3333-4333-8333-333333333333";

function hierarchicalFixture() {
	const { schemaVersion: _schemaVersion, revisionId: _revisionId, sceneHash: _sceneHash, ...v2HashFree } = manifest;
	const rootId = manifest.objects[1]!.entityId;
	const durable = buildSceneManifestV4Revision(
		{
			...v2HashFree,
			schemaVersion: 4,
			objects: manifest.objects.map((object, index) => ({
				...object,
				type: index === 1 ? "EMPTY" : object.type,
				parentId: null,
			})),
			lights: manifest.lights.map((light) => ({ ...light, areaSize: null })),
			stagePrimitives: [],
			stageMaterials: [],
			assemblies: [{ assemblyId: ASSEMBLY_ID, name: "Assembly", rootEntityId: rootId, memberIds: [rootId] }],
		},
		"c".repeat(64),
		{ schema_version: 1, operations: ["stage"] },
	);
	return { durable, rootId };
}

function hierarchyStore(
	durable: SceneManifestV4,
	onCommit: (manifest: SceneManifestV4) => void,
): CameraPlanRevisionStore {
	return {
		readProject: async () => ({
			project_id: durable.projectId,
			schema_version: 1,
			current_revision_id: durable.revisionId,
			manifest: durable,
		}),
		commitRevision: async (_idempotencyKey, _expectedRevisionId, child) => {
			if (child.manifest.schemaVersion !== 4) throw new Error("expected V4");
			onCommit(child.manifest);
		},
		reconcileRevision: async () => ({ status: "base_authoritative", revisionId: durable.revisionId }),
	};
}

test("rejects a V4 camera candidate that drops a hierarchical durable manifest", async () => {
	const { durable } = hierarchicalFixture();
	const stagedPlan = { ...plan, expected_revision_id: durable.revisionId };
	const { assemblies: _assemblies, revisionId: _revision, sceneHash: _hash, ...rest } = durable;
	const candidate = buildSceneManifestV4Revision(
		{ ...rest, assemblies: [] },
		stagedPlan.expected_revision_id,
		stagedPlan,
	);
	await assert.rejects(
		commitCameraPlanMutation(
			hierarchyStore(durable, () => assert.fail("committed")),
			stagedPlan,
			{
				expected_revision_id: stagedPlan.expected_revision_id,
				scene_hash: candidate.sceneHash,
				manifest: candidate,
			},
		),
		/INVALID_MUTATION_RESULT/,
	);
});

test("rejects a V4 camera candidate that mutates durable assemblies", async () => {
	const { durable, rootId } = hierarchicalFixture();
	const stagedPlan = { ...plan, expected_revision_id: durable.revisionId };
	const { revisionId: _revision, sceneHash: _hash, ...hashFree } = durable;
	const candidate = buildSceneManifestV4Revision(
		{ ...hashFree, assemblies: [{ ...durable.assemblies[0]!, name: "Changed", memberIds: [rootId] }] },
		stagedPlan.expected_revision_id,
		stagedPlan,
	);
	await assert.rejects(
		commitCameraPlanMutation(
			hierarchyStore(durable, () => assert.fail("committed")),
			stagedPlan,
			{
				expected_revision_id: stagedPlan.expected_revision_id,
				scene_hash: candidate.sceneHash,
				manifest: candidate,
			},
		),
		/INVALID_MUTATION_RESULT/,
	);
});

test("rejects a hierarchy-introducing V4 camera candidate over a flat durable manifest", async () => {
	const flat = manifest;
	const stagedPlan = { ...plan, expected_revision_id: flat.revisionId };
	const { revisionId: _revision, sceneHash: _hash, ...hashFree } = flat;
	const rootId = flat.objects[1]!.entityId;
	const candidate = buildSceneManifestV4Revision(
		{
			...hashFree,
			objects: flat.objects.map((object, index) => ({ ...object, type: index === 1 ? "EMPTY" : object.type })),
			assemblies: [{ assemblyId: ASSEMBLY_ID, name: "Assembly", rootEntityId: rootId, memberIds: [rootId] }],
		},
		stagedPlan.expected_revision_id,
		stagedPlan,
	);
	await assert.rejects(
		commitCameraPlanMutation(
			hierarchyStore(flat, () => assert.fail("committed")),
			stagedPlan,
			{
				expected_revision_id: stagedPlan.expected_revision_id,
				scene_hash: candidate.sceneHash,
				manifest: candidate,
			},
		),
		/INVALID_MUTATION_RESULT/,
	);
});

test("commits a V4 camera candidate that preserves durable hierarchy", async () => {
	const { durable } = hierarchicalFixture();
	const stagedPlan = { ...plan, expected_revision_id: durable.revisionId };
	const { revisionId: _revision, sceneHash: _hash, ...hashFree } = durable;
	const candidate = buildSceneManifestV4Revision(hashFree, stagedPlan.expected_revision_id, stagedPlan);
	let committed = false;
	await commitCameraPlanMutation(
		hierarchyStore(durable, () => {
			committed = true;
		}),
		stagedPlan,
		{
			expected_revision_id: stagedPlan.expected_revision_id,
			scene_hash: candidate.sceneHash,
			manifest: candidate,
		},
	);
	assert.equal(committed, true);
});
test("rejects a V4 camera candidate that reparents or unparents an existing edge", async () => {
	// Build a durable manifest with a REAL child->root parent edge.
	const { schemaVersion: _schemaVersion, revisionId: _revisionId, sceneHash: _sceneHash, ...v2HashFree } = manifest;
	const rootId = manifest.objects[1]!.entityId;
	const childId = manifest.objects[0]!.entityId;
	const durable = buildSceneManifestV4Revision(
		{
			...v2HashFree,
			schemaVersion: 4,
			objects: manifest.objects.map((object, index) => ({
				...object,
				type: index === 1 ? "EMPTY" : object.type,
				parentId: index === 0 ? rootId : null,
			})),
			lights: manifest.lights.map((light) => ({ ...light, areaSize: null })),
			stagePrimitives: [],
			stageMaterials: [],
			assemblies: [
				{ assemblyId: ASSEMBLY_ID, name: "Assembly", rootEntityId: rootId, memberIds: [childId, rootId].sort() },
			],
		},
		"c".repeat(64),
		{ schema_version: 1, operations: ["stage"] },
	);
	const stagedPlan = { ...plan, expected_revision_id: durable.revisionId };
	const { revisionId: _rev, sceneHash: _hash, ...hashFree } = durable;
	// Unparent the child: the non-null edge disappears.
	const unparented = buildSceneManifestV4Revision(
		{
			...hashFree,
			objects: hashFree.objects.map((object) => ({ ...object, parentId: null })),
		},
		stagedPlan.expected_revision_id,
		stagedPlan,
	);
	await assert.rejects(
		commitCameraPlanMutation(
			hierarchyStore(durable, () => assert.fail("committed")),
			stagedPlan,
			{
				expected_revision_id: stagedPlan.expected_revision_id,
				scene_hash: unparented.sceneHash,
				manifest: unparented,
			},
		),
		/INVALID_MUTATION_RESULT/,
	);
});

test("commits a V4 camera candidate that adds a new parentless camera object", async () => {
	// apply_camera_plan legitimately stages a new flat camera object; only
	// non-null parent edges and assemblies constitute the fenced hierarchy.
	const { durable } = hierarchicalFixture();
	const stagedPlan = { ...plan, expected_revision_id: durable.revisionId };
	const { revisionId: _revision, sceneHash: _hash, ...hashFree } = durable;
	const stagedCameraId = "44444444-4444-4444-8444-444444444444" as const;
	const candidate = buildSceneManifestV4Revision(
		{
			...hashFree,
			objects: [
				...hashFree.objects,
				{
					entityId: stagedCameraId,
					name: "Staged Camera",
					type: "CAMERA",
					parentId: null,
					visible: true,
					location: [0, 0, 0] as [number, number, number],
					rotationQuaternion: [1, 0, 0, 0] as [number, number, number, number],
					scale: [1, 1, 1] as [number, number, number],
				},
			].sort((left, right) => (left.entityId < right.entityId ? -1 : 1)),
			cameras: [
				...hashFree.cameras,
				{
					objectId: stagedCameraId,
					lens: 50,
					sensorFit: "AUTO" as const,
					sensorWidth: 36,
					sensorHeight: 24,
					verticalFovRadians: 0.5,
					clipStart: 0.1,
					clipEnd: 100,
				},
			].sort((left, right) => (left.objectId < right.objectId ? -1 : 1)),
		},
		stagedPlan.expected_revision_id,
		stagedPlan,
	);
	let committed = false;
	const result = await commitCameraPlanMutation(
		hierarchyStore(durable, () => {
			committed = true;
		}),
		stagedPlan,
		{
			expected_revision_id: stagedPlan.expected_revision_id,
			scene_hash: candidate.sceneHash,
			manifest: candidate,
		},
	);
	assert.equal(result.resulting_revision_id, candidate.revisionId);
	assert.equal(committed, true);
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
				scene_hash: cameraCandidate.sceneHash,
				manifest: cameraCandidate,
			}),
		}),
		/CANCELLED/,
	);
	assert.equal(committed, false);
});
