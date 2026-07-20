import assert from "node:assert/strict";
import test from "node:test";
import { canonicalizeStageScenePlan, parseStageScenePlan, StageSceneValidationError } from "../src/stage-scene.ts";

const ENTITY_ID = "11111111-1111-4111-8111-111111111111";
const PARENT_ID = "22222222-2222-4222-8222-222222222222";
const ASSEMBLY_ID = "33333333-3333-4333-8333-333333333333";
const base = { schema_version: 1, expected_revision_id: "a".repeat(64) };
const invalidSchema = (operation: unknown) =>
	assert.throws(
		() => parseStageScenePlan({ ...base, operations: [operation] }),
		(error: unknown) =>
			error instanceof StageSceneValidationError && error.code === "INVALID_STAGE_SCENE_PLAN_SCHEMA",
	);

test("new assembly operations accept valid closed wire shapes", () => {
	const operations = [
		{ op: "create_assembly", name: "Vehicle" },
		{ op: "set_parent", entity_id: ENTITY_ID, parent_id: PARENT_ID },
		{ op: "set_parent", entity_id: ENTITY_ID, parent_id: null },
		{ op: "transform_assembly", assembly_id: ASSEMBLY_ID, translation: [1, 2, 3] },
		{ op: "transform_assembly", assembly_id: ASSEMBLY_ID, rotation_euler: [0, 0, 1], scale: [2, 2, 2] },
	];
	assert.deepEqual(parseStageScenePlan({ ...base, operations }).operations, operations);
});

test("set_parent rejects self-parenting", () => {
	invalidSchema({ op: "set_parent", entity_id: ENTITY_ID, parent_id: ENTITY_ID });
});

test("add_primitive rejects parenting the new entity to itself", () => {
	invalidSchema({ ...addPrimitive, parent_id: ENTITY_ID });
});

test("each new assembly operation rejects invalid and unknown fields", () => {
	invalidSchema({ op: "create_assembly", name: "Vehicle", unknown: true });
	invalidSchema({ op: "create_assembly", name: "" });
	invalidSchema({ op: "set_parent", entity_id: ENTITY_ID, parent_id: "not-a-uuid" });
	invalidSchema({ op: "set_parent", entity_id: ENTITY_ID, parent_id: null, unknown: true });
	invalidSchema({ op: "transform_assembly", assembly_id: ASSEMBLY_ID });
	invalidSchema({ op: "transform_assembly", assembly_id: ASSEMBLY_ID, translation: [1, 2] });
	invalidSchema({ op: "transform_assembly", assembly_id: ASSEMBLY_ID, scale: [1, 1, 1], unknown: true });
});

const addPrimitive = {
	op: "add_primitive",
	entity_id: ENTITY_ID,
	primitive_type: "CUBE",
	name: "Body",
	location: [0, 0, 0],
	rotation: [0, 0, 0],
	scale: [1, 1, 1],
};

test("add_primitive accepts an optional parent_id and rejects invalid values", () => {
	assert.equal(parseStageScenePlan({ ...base, operations: [addPrimitive] }).operations[0]?.op, "add_primitive");
	const parented = { ...addPrimitive, parent_id: PARENT_ID };
	assert.deepEqual(parseStageScenePlan({ ...base, operations: [parented] }).operations[0], parented);
	invalidSchema({ ...addPrimitive, parent_id: null });
	invalidSchema({ ...addPrimitive, parent_id: "not-a-uuid" });
});

test("request canonicalization preserves parent_id and create_assembly", () => {
	const plan = canonicalizeStageScenePlan(
		{
			...base,
			operations: [
				{ op: "create_assembly", name: "Vehicle" },
				{
					op: "add_primitive",
					primitive_type: "CUBE",
					name: "Body",
					location: [0, 0, 0],
					rotation: [0, 0, 0],
					scale: [1, 1, 1],
					parent_id: PARENT_ID,
				},
			],
		},
		() => ENTITY_ID,
	);
	assert.deepEqual(plan.operations[0], { op: "create_assembly", name: "Vehicle" });
	assert.equal(plan.operations[1]?.op === "add_primitive" ? plan.operations[1].parent_id : undefined, PARENT_ID);
});
