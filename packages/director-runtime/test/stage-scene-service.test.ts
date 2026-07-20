import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildSceneManifestV3Revision, type DirectorProject } from "@oh-my-blender/director-core";
import {
	parseSceneManifestV2,
	type StageSceneMutationCandidate,
	type StageScenePlanV1,
	type StageSceneRequestV1,
} from "@oh-my-blender/protocol";
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
