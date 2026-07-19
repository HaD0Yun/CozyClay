import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
	canonicalizeStageScenePlan,
	parseStageSceneMutationCandidate,
	parseStageScenePlan,
	type StageScenePlanV1,
	StageSceneValidationError,
} from "../src/stage-scene.ts";

const fixture = (name: string): Promise<unknown> =>
	readFile(new URL(`fixtures/stage-scene/${name}.json`, import.meta.url), "utf8").then(JSON.parse);

const IDS = [
	"11111111-1111-4111-8111-111111111111",
	"22222222-2222-4222-8222-222222222222",
	"33333333-3333-4333-8333-333333333333",
];

test("parses the committed closed StageScenePlanV1 fixture", async () => {
	const plan = parseStageScenePlan(await fixture("valid-plan"));
	assert.equal(plan.operations.length, 4);
	assert.deepEqual(
		plan.operations.map((operation) => operation.op),
		["add_primitive", "set_material_color", "upsert_area_light", "delete_entity"],
	);
});

test("rejects unknown fields with the schema-only error code", async () => {
	const value = await fixture("invalid-unknown-field");
	assert.throws(
		() => parseStageScenePlan(value),
		(error: unknown) =>
			error instanceof StageSceneValidationError && error.code === "INVALID_STAGE_SCENE_PLAN_SCHEMA",
	);
});

test("parses a closed per-entity identity mapping", async () => {
	const v2 = JSON.parse(
		await readFile(
			new URL("../../director-core/test/fixtures/scene-manifest-v2-parity.json", import.meta.url),
			"utf8",
		),
	) as Record<string, unknown>;
	const manifest = {
		...v2,
		schemaVersion: 3,
		lights: [],
		stagePrimitives: [],
		stageMaterials: [],
	};
	const candidate = parseStageSceneMutationCandidate({
		expected_revision_id: "a".repeat(64),
		scene_hash: v2.sceneHash as string,
		manifest,
		entity_identities: [
			{
				entity_id: IDS[0],
				requested_name: "Requested Name",
				actual_name: "Actual Name.001",
			},
		],
	});
	assert.equal(candidate.entity_identities[0]?.actual_name, "Actual Name.001");

	const extra = structuredClone(candidate);
	(extra.entity_identities[0] as Record<string, unknown>).unexpected = true;
	assert.throws(() => parseStageSceneMutationCandidate(extra), /INVALID_MUTATION_RESULT/);
});

test("rejects duplicate daemon-issued entity IDs with a distinct code", async () => {
	const value = await fixture("invalid-duplicate-entity-id");
	assert.throws(
		() => parseStageScenePlan(value),
		(error: unknown) =>
			error instanceof StageSceneValidationError && error.code === "STAGE_SCENE_ENTITY_ID_DUPLICATE",
	);
});

test("rejects duplicate stable names with a distinct code", async () => {
	const plan = (await fixture("valid-plan")) as StageScenePlanV1;
	const light = plan.operations[2] as Extract<StageScenePlanV1["operations"][number], { op: "upsert_area_light" }>;
	plan.operations[2] = { ...light, name: "Floor" };
	assert.throws(
		() => parseStageScenePlan(plan),
		(error: unknown) =>
			error instanceof StageSceneValidationError && error.code === "STAGE_SCENE_STABLE_NAME_DUPLICATE",
	);
});

test("daemon canonicalization allocates UUIDs only for newly created entities", () => {
	const allocated = [...IDS];
	const plan = canonicalizeStageScenePlan(
		{
			schema_version: 1,
			expected_revision_id: "a".repeat(64),
			operations: [
				{
					op: "add_primitive",
					primitive_type: "CUBE",
					name: "Hero Cube",
					location: [0, 0, 1],
					rotation: [0, 0, 0],
					scale: [1, 1, 1],
				},
				{
					op: "set_material_color",
					object_name: "Hero Cube",
					color: [0.8, 0.2, 0.1, 1],
				},
				{
					op: "upsert_area_light",
					name: "Key Light",
					location: [4, -4, 6],
					rotation: [0.5, 0, 0.8],
					scale: [1, 1, 1],
					energy: 800,
					color: [1, 0.9, 0.8],
					size: 3,
				},
				{
					op: "upsert_area_light",
					entity_id: IDS[2],
					name: "Existing Fill",
					location: [-4, 2, 3],
					rotation: [0, 0, -0.8],
					scale: [1, 1, 1],
					energy: 200,
					color: [0.5, 0.7, 1],
					size: 2,
				},
			],
		},
		() => allocated.shift()!,
	);
	assert.deepEqual(
		plan.operations.map((operation) =>
			operation.op === "add_primitive" || operation.op === "upsert_area_light" ? operation.entity_id : undefined,
		),
		[IDS[0], undefined, IDS[1], IDS[2]],
	);
	assert.equal(allocated.length, 1);
	assert.equal(plan.operations[1]?.op, "set_material_color");
	assert.equal(plan.operations[1]?.op === "set_material_color" ? plan.operations[1].entity_id : undefined, IDS[0]);
});

test("request-side callers cannot choose an add_primitive entity ID", () => {
	assert.throws(
		() =>
			canonicalizeStageScenePlan(
				{
					schema_version: 1,
					expected_revision_id: "a".repeat(64),
					operations: [
						{
							op: "add_primitive",
							entity_id: IDS[0],
							primitive_type: "PLANE",
							name: "Floor",
							location: [0, 0, 0],
							rotation: [0, 0, 0],
							scale: [5, 5, 1],
						},
					],
				},
				() => IDS[1],
			),
		(error: unknown) =>
			error instanceof StageSceneValidationError && error.code === "INVALID_STAGE_SCENE_REQUEST_SCHEMA",
	);
});
