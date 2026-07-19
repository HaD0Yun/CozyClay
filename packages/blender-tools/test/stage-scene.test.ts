import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { StageSceneEntityIdentity, StageSceneRequestV1 } from "@oh-my-blender/protocol";
import { createStageSceneTool } from "../src/stage-scene.ts";

const request: StageSceneRequestV1 = {
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
	],
};

describe("stage_scene", () => {
	it("exposes only the closed request grammar without daemon-owned add IDs", () => {
		const tool = createStageSceneTool({
			stageScene: async () => ({ resulting_revision_id: "b".repeat(64), entity_identities: [] }),
		});
		assert.equal(tool.name, "stage_scene");
		assert.equal(tool.parameters.additionalProperties, false);
		const operationUnion = tool.parameters.properties.operations.items;
		const addSchema = operationUnion.anyOf.find(
			(schema: { properties?: { op?: { const?: string } } }) => schema.properties?.op?.const === "add_primitive",
		);
		assert.ok(addSchema);
		assert.equal("entity_id" in addSchema.properties, false);
	});

	it("dispatches cancellation and progress through the one production bridge", async () => {
		const controller = new AbortController();
		const updates: unknown[] = [];
		let received: StageSceneRequestV1 | undefined;
		const identity: StageSceneEntityIdentity = {
			entity_id: "0f8b8d67-3d5e-4a94-8b6f-1af6f5f5c0aa",
			requested_name: "Hero Cube",
			actual_name: "Hero Cube.001",
		};
		const tool = createStageSceneTool({
			stageScene: async (value, context) => {
				received = value;
				assert.equal(context.signal, controller.signal);
				context.reportProgress({ phase: "mutating", completed: 1, total: 1 });
				return {
					resulting_revision_id: "b".repeat(64),
					scene_hash: "c".repeat(64),
					entity_identities: [identity],
				};
			},
		});
		const result = await tool.execute(
			"call",
			request,
			controller.signal,
			(update) => updates.push(update),
			undefined as never,
		);
		assert.deepEqual(received, request);
		assert.equal(updates.length, 1);
		assert.equal(result.content[0]?.type, "text");
		const details = result.details as { entity_identities: readonly StageSceneEntityIdentity[] };
		assert.deepEqual(details.entity_identities, [identity]);
		assert.equal(details.entity_identities[0]?.actual_name, "Hero Cube.001");
	});
});
