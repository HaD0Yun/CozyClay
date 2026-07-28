import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildSceneManifestV3Revision, type DirectorProject } from "@cclay/director-core";
import {
	parseSceneManifestV2,
	type StageSceneMutationCandidate,
	type StageScenePlanV1,
	type StageSceneRequestV1,
} from "@cclay/protocol";
import { createStageSceneHandler, type StageSceneRevisionStore } from "../src/stage-scene-service.ts";

const ENTITY_ID = "00000000-0000-4000-8000-000000000002";
const parent = "a".repeat(64);
const request: StageSceneRequestV1 = {
	schema_version: 1,
	expected_revision_id: parent,
	operations: [
		{
			op: "add_primitive",
			primitive_type: "CUBE",
			name: "Parity Subject",
			location: [0, 0, 0],
			rotation: [0, 0, 0],
			scale: [1, 1, 1],
		},
	],
};
const motionRequest: StageSceneRequestV1 = {
	schema_version: 1,
	expected_revision_id: parent,
	operations: [
		{ op: "set_render_settings", fps: 24 },
		{
			op: "apply_motion",
			entity_id: ENTITY_ID,
			motion_id: "walk",
			hand_shapes: { left: "point", right: "cup" },
		},
		{
			op: "apply_motion",
			entity_id: ENTITY_ID,
			motion_id: "wave",
			hand_shapes: { right: "open" },
		},
	],
};
const v2 = parseSceneManifestV2(
	JSON.parse(
		await readFile(
			new URL("../../director-core/test/fixtures/scene-manifest-v2-parity.json", import.meta.url),
			"utf8",
		),
	),
);

function candidate(plan: StageScenePlanV1): StageSceneMutationCandidate {
	const { revisionId: _revisionId, sceneHash: _sceneHash, ...base } = v2;
	const manifest = buildSceneManifestV3Revision(
		{
			...base,
			schemaVersion: 3,
			lights: [],
			stagePrimitives: [{ objectId: ENTITY_ID, primitiveType: "CUBE" }],
			stageMaterials: [],
		},
		parent,
		plan,
	);
	return {
		expected_revision_id: parent,
		scene_hash: manifest.sceneHash,
		manifest,
		entity_identities: [
			{
				entity_id: ENTITY_ID,
				requested_name: "Parity Subject",
				actual_name: "Parity Subject",
			},
		],
		applied_hand_shapes: [],
	};
}

function motionCandidate(plan: StageScenePlanV1): StageSceneMutationCandidate {
	const value = candidate(plan);
	return {
		...value,
		entity_identities: [],
		applied_hand_shapes: [
			{
				operation_index: 1,
				entity_id: ENTITY_ID,
				motion_id: "walk",
				left: "point",
				right: "cup",
				library_version: "1.1.0",
			},
			{
				operation_index: 2,
				entity_id: ENTITY_ID,
				motion_id: "wave",
				left: "relaxed",
				right: "open",
				library_version: "1.1.0",
			},
		],
	};
}

function fakeStore(events: string[]): StageSceneRevisionStore {
	const current: DirectorProject = {
		project_id: v2.projectId,
		schema_version: 1,
		current_revision_id: parent,
		manifest: v2,
	};
	return {
		readProject: async () => current,
		commitRevision: async (idempotencyKey, expected, child, journal) => {
			const manifest = child.manifest as { revisionId: string; sceneHash: string } | undefined;
			assert.match(idempotencyKey, /^[0-9a-f-]{36}$/);
			assert.equal(expected, parent);
			assert.equal(child.current_revision_id, manifest?.revisionId);
			assert.equal(journal.schema_version, 2);
			assert.equal(journal.operation, "stage_scene");
			assert.match(journal.request_id, /^[0-9a-f-]{36}$/);
			assert.match(journal.plan_sha256, /^[0-9a-f]{64}$/);
			assert.equal(journal.base_scene_hash, v2.sceneHash);
			assert.equal(journal.candidate_scene_hash, manifest?.sceneHash);
			events.push("commit:durable");
		},
	};
}

test("allocates daemon-owned IDs before dispatch and commits the real child revision", async () => {
	const events: string[] = [];
	let dispatched: StageScenePlanV1 | undefined;
	const output = await createStageSceneHandler({
		store: fakeStore(events),
		allocateEntityId: () => ENTITY_ID,
	})(request, {
		signal: new AbortController().signal,
		request: { expected_revision_id: parent },
		beginDurableCommit: () => events.push("commit:owned"),
		stageScene: async (plan) => {
			dispatched = plan;
			events.push("bridge:result");
			return candidate(plan);
		},
	});
	assert.equal(dispatched?.operations[0]?.op, "add_primitive");
	assert.equal(
		dispatched?.operations[0]?.op === "add_primitive" ? dispatched.operations[0].entity_id : undefined,
		ENTITY_ID,
	);
	assert.deepEqual(events, ["bridge:result", "commit:owned", "commit:durable"]);
	assert.equal(output.resulting_revision_id, output.result.resulting_revision_id);
	assert.deepEqual(output.result.entity_identities, [
		{
			entity_id: ENTITY_ID,
			requested_name: "Parity Subject",
			actual_name: "Parity Subject",
		},
	]);
});

test("forwards mixed motion operations exactly and returns ordered applied hand-shape rows", async () => {
	const events: string[] = [];
	let dispatched: StageScenePlanV1 | undefined;
	const output = await createStageSceneHandler({ store: fakeStore(events) })(motionRequest, {
		signal: new AbortController().signal,
		request: { expected_revision_id: parent },
		beginDurableCommit: () => events.push("commit:owned"),
		stageScene: async (plan) => {
			dispatched = plan;
			return motionCandidate(plan);
		},
	});
	assert.ok(dispatched);
	assert.deepEqual(dispatched, motionRequest);
	for (const operation of dispatched.operations.filter((value) => value.op === "apply_motion")) {
		assert.equal("optimization" in operation, false);
		assert.equal("mode" in operation, false);
		assert.equal("tolerance" in operation, false);
		assert.equal("fallback" in operation, false);
	}
	assert.deepEqual(output.result.applied_hand_shapes, [
		{
			operation_index: 1,
			entity_id: ENTITY_ID,
			motion_id: "walk",
			left: "point",
			right: "cup",
			library_version: "1.1.0",
		},
		{
			operation_index: 2,
			entity_id: ENTITY_ID,
			motion_id: "wave",
			left: "relaxed",
			right: "open",
			library_version: "1.1.0",
		},
	]);
	assert.deepEqual(events, ["commit:owned", "commit:durable"]);
});

test("forwards the absent apply_motion hand form without injecting defaults", async () => {
	const singleMotionRequest: StageSceneRequestV1 = {
		schema_version: 1,
		expected_revision_id: parent,
		operations: [{ op: "apply_motion", entity_id: ENTITY_ID, motion_id: "idle" }],
	};
	let dispatched: StageScenePlanV1 | undefined;
	const output = await createStageSceneHandler({ store: fakeStore([]) })(singleMotionRequest, {
		signal: new AbortController().signal,
		request: { expected_revision_id: parent },
		stageScene: async (plan) => {
			dispatched = plan;
			const value = candidate(plan);
			return {
				...value,
				entity_identities: [],
				applied_hand_shapes: [
					{
						operation_index: 0,
						entity_id: ENTITY_ID,
						motion_id: "idle",
						left: "relaxed",
						right: "relaxed",
						library_version: "1.1.0",
					},
				],
			};
		},
	});
	assert.ok(dispatched);
	assert.deepEqual(dispatched, singleMotionRequest);
	assert.deepEqual(Object.keys(dispatched.operations[0]!).sort(), ["entity_id", "motion_id", "op"]);
	assert.deepEqual(output.result.applied_hand_shapes, [
		{
			operation_index: 0,
			entity_id: ENTITY_ID,
			motion_id: "idle",
			left: "relaxed",
			right: "relaxed",
			library_version: "1.1.0",
		},
	]);
});

test("rejects forged or reordered applied hand-shape rows before durable commit", async () => {
	for (const mutate of [
		(rows: StageSceneMutationCandidate["applied_hand_shapes"]) => rows.slice().reverse(),
		(rows: StageSceneMutationCandidate["applied_hand_shapes"]) => [{ ...rows[0]!, left: "fist" as const }, rows[1]!],
	]) {
		let committed = false;
		const store = fakeStore([]);
		store.commitRevision = async () => {
			committed = true;
		};
		await assert.rejects(
			createStageSceneHandler({ store })(motionRequest, {
				signal: new AbortController().signal,
				request: { expected_revision_id: parent },
				stageScene: async (plan) => {
					const value = motionCandidate(plan);
					return { ...value, applied_hand_shapes: mutate(value.applied_hand_shapes) };
				},
			}),
			/INVALID_MUTATION_RESULT/,
		);
		assert.equal(committed, false);
	}
});
test("rejects forged or incorrectly chained candidate revisions before durable commit", async () => {
	let committed = false;
	const store = fakeStore([]);
	store.commitRevision = async () => {
		committed = true;
	};
	await assert.rejects(
		createStageSceneHandler({ store, allocateEntityId: () => ENTITY_ID })(request, {
			signal: new AbortController().signal,
			request: { expected_revision_id: parent },
			stageScene: async (plan) => {
				const value = candidate(plan);
				return { ...value, manifest: { ...value.manifest, revisionId: "f".repeat(64) } };
			},
		}),
		/INVALID_MUTATION_RESULT/,
	);
	assert.equal(committed, false);
});

test("rejects identity mappings that disagree with the plan or candidate manifest", async () => {
	let committed = false;
	const store = fakeStore([]);
	store.commitRevision = async () => {
		committed = true;
	};
	await assert.rejects(
		createStageSceneHandler({ store, allocateEntityId: () => ENTITY_ID })(request, {
			signal: new AbortController().signal,
			request: { expected_revision_id: parent },
			stageScene: async (plan) => {
				const value = candidate(plan);
				return {
					...value,
					entity_identities: [{ ...value.entity_identities[0]!, actual_name: "Parity Subject.001" }],
				};
			},
		}),
		/INVALID_MUTATION_RESULT/,
	);
	assert.equal(committed, false);
});

test("rejects a stale request before allocating or dispatching", async () => {
	let allocated = false;
	let dispatched = false;
	await assert.rejects(
		createStageSceneHandler({
			store: fakeStore([]),
			allocateEntityId: () => {
				allocated = true;
				return ENTITY_ID;
			},
		})(request, {
			signal: new AbortController().signal,
			request: { expected_revision_id: "b".repeat(64) },
			stageScene: async () => {
				dispatched = true;
				throw new Error("not reached");
			},
		}),
		/STALE_BASE/,
	);
	assert.equal(allocated, false);
	assert.equal(dispatched, false);
});
