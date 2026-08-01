import assert from "node:assert/strict";
import test from "node:test";
import {
	canonicalizeStageScenePlan,
	parseStageScenePlan,
	type StageSceneOperationV1,
	StageSceneValidationError,
} from "../src/stage-scene.ts";

const IDS = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"] as const;
const revision = "a".repeat(64);

const retainedOperations = [
	{
		op: "add_character",
		entity_id: IDS[0],
		character_type: "Y_BOT",
		name: "Fighter",
		location: [0, 0, 0],
		rotation: [0, 0, 0],
		scale: [1, 1, 1],
	},
	{ op: "adopt_entity", entity_id: IDS[1] },
	{ op: "set_render_settings", fps: 24 },
	{ op: "apply_motion", entity_id: IDS[0], motion_id: "walk", hand_shapes: { left: "open" } },
] satisfies StageSceneOperationV1[];

const removedOperations = [
	"add_primitive",
	"add_camera",
	"set_material_color",
	"upsert_area_light",
	"delete_entity",
	"create_assembly",
	"set_parent",
	"transform_assembly",
	"transform_entity",
	"set_light_property",
	"set_camera_property",
	"rename_entity",
	"set_camera_focus_distance",
	"set_light_cutoff_distance",
] as const;

const assertClosedPlanSchema = (operations: unknown[]) => {
	assert.throws(
		() => parseStageScenePlan({ schema_version: 1, expected_revision_id: revision, operations }),
		(error: unknown) =>
			error instanceof StageSceneValidationError && error.code === "INVALID_STAGE_SCENE_PLAN_SCHEMA",
	);
};

const assertClosedRequestSchema = (operations: unknown[]) => {
	assert.throws(
		() => canonicalizeStageScenePlan({ schema_version: 1, expected_revision_id: revision, operations }, () => IDS[0]),
		(error: unknown) =>
			error instanceof StageSceneValidationError && error.code === "INVALID_STAGE_SCENE_REQUEST_SCHEMA",
	);
};

test("stage scene binds exactly the retained operation union", () => {
	const plan = parseStageScenePlan({
		schema_version: 1,
		expected_revision_id: revision,
		operations: retainedOperations,
	});
	assert.deepEqual(
		plan.operations.map((operation) => operation.op),
		["add_character", "adopt_entity", "set_render_settings", "apply_motion"],
	);
});

test("stage scene rejects every removed operation in both closed schemas", () => {
	for (const op of removedOperations) {
		assertClosedPlanSchema([{ op }]);
		assertClosedRequestSchema([{ op }]);
	}
});

test("stage scene schemas reject unexpected fields", () => {
	assertClosedPlanSchema([{ ...retainedOperations[0], unexpected: true }]);
	assertClosedRequestSchema([
		{
			op: "add_character",
			character_type: "Y_BOT",
			name: "Fighter",
			location: [0, 0, 0],
			rotation: [0, 0, 0],
			scale: [1, 1, 1],
			unexpected: true,
		},
	]);
});

test("canonicalization allocates IDs only for add_character", () => {
	const requestOperations = [
		{
			op: "add_character",
			character_type: "X_BOT",
			name: "Fighter",
			location: [0, 0, 0],
			rotation: [0, 0, 0],
			scale: [1, 1, 1],
		},
		{ op: "adopt_entity", entity_id: IDS[1] },
		{ op: "set_render_settings", fps: 24 },
		{ op: "apply_motion", entity_id: IDS[1], motion_id: "walk" },
	];
	const plan = canonicalizeStageScenePlan(
		{ schema_version: 1, expected_revision_id: revision, operations: requestOperations },
		() => IDS[0],
	);
	assert.deepEqual(plan.operations, [{ ...requestOperations[0], entity_id: IDS[0] }, ...requestOperations.slice(1)]);
});
