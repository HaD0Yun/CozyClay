import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { StageSceneAppliedHandShape, StageSceneEntityIdentity, StageSceneRequestV1 } from "@cclay/protocol";
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
			stageScene: async () => ({
				resulting_revision_id: "b".repeat(64),
				entity_identities: [],
				applied_hand_shapes: [],
			}),
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

	it("exposes adopt_entity as a closed caller-addressed operation", () => {
		const tool = createStageSceneTool({
			stageScene: async () => ({
				resulting_revision_id: "b".repeat(64),
				entity_identities: [],
				applied_hand_shapes: [],
			}),
		});
		const operationUnion = tool.parameters.properties.operations.items;
		const adoptSchema = operationUnion.anyOf.find(
			(schema: { properties?: { op?: { const?: string } } }) => schema.properties?.op?.const === "adopt_entity",
		);
		assert.ok(adoptSchema);
		assert.equal(adoptSchema.additionalProperties, false);
		assert.deepEqual(Object.keys(adoptSchema.properties).sort(), ["entity_id", "op"]);
		assert.deepEqual(adoptSchema.required?.slice().sort(), ["entity_id", "op"]);
	});

	it("exposes independent 11-preset hand-shape guidance and request schema", () => {
		const tool = createStageSceneTool({
			stageScene: async () => ({
				resulting_revision_id: "b".repeat(64),
				entity_identities: [],
				applied_hand_shapes: [],
			}),
		});
		assert.match(tool.description, /11 visually calibrated presets from library version 1\.1\.0/);
		assert.match(tool.description, /independently to left and right/);
		assert.match(tool.description, /Omitted sides default to relaxed/);
		assert.match(tool.description, /legacy hand_pose relaxed\/open/);
		assert.match(tool.description, /use hand_track instead when a side must change shape/);
		assert.match(tool.description, /mutually exclusive/);
		// The description must not claim the motion model animates fingers.
		assert.match(tool.description, /not produced by the motion model/);
		assert.match(JSON.stringify(tool.parameters), /hand_shapes/);
		assert.match(JSON.stringify(tool.parameters), /three_finger/);
		const operationUnion = tool.parameters.properties.operations.items;
		const applyUnion = operationUnion.anyOf.find(
			(schema: { anyOf?: readonly { additionalProperties?: boolean; properties?: Record<string, unknown> }[] }) =>
				schema.anyOf?.some(
					(variant) => (variant.properties?.op as { const?: string } | undefined)?.const === "apply_motion",
				),
		);
		assert.ok(applyUnion?.anyOf);
		assert.deepEqual(
			applyUnion.anyOf.map((variant: { properties?: Record<string, unknown> }) =>
				Object.keys(variant.properties ?? {}).sort(),
			),
			[
				["entity_id", "motion_id", "op", "start_frame"],
				["entity_id", "hand_pose", "motion_id", "op", "start_frame"],
				["entity_id", "hand_shapes", "motion_id", "op", "start_frame"],
				["entity_id", "hand_shapes", "motion_id", "op", "start_frame"],
				["entity_id", "hand_shapes", "motion_id", "op", "start_frame"],
				["entity_id", "hand_track", "motion_id", "op", "start_frame"],
				["entity_id", "hand_track", "motion_id", "op", "start_frame"],
				["entity_id", "hand_track", "motion_id", "op", "start_frame"],
			],
		);
		for (const variant of applyUnion.anyOf) {
			assert.equal(variant.additionalProperties, false);
			for (const field of ["optimization", "mode", "tolerance", "fallback"]) {
				assert.equal(field in (variant.properties ?? {}), false);
			}
		}
	});

	it("forwards mixed and repeated apply_motion operations without protocol additions", async () => {
		const mixedRequest: StageSceneRequestV1 = {
			schema_version: 1,
			expected_revision_id: "a".repeat(64),
			operations: [
				{ op: "set_render_settings", fps: 24 },
				{
					op: "apply_motion",
					entity_id: "0f8b8d67-3d5e-4a94-8b6f-1af6f5f5c0aa",
					motion_id: "idle",
				},
				{
					op: "apply_motion",
					entity_id: "0f8b8d67-3d5e-4a94-8b6f-1af6f5f5c0aa",
					motion_id: "wave",
					hand_pose: "open",
				},
			],
		};
		const applied: StageSceneAppliedHandShape[] = [
			{
				operation_index: 1,
				entity_id: "0f8b8d67-3d5e-4a94-8b6f-1af6f5f5c0aa",
				motion_id: "idle",
				left: "relaxed",
				right: "relaxed",
				library_version: "1.1.0",
			},
			{
				operation_index: 2,
				entity_id: "0f8b8d67-3d5e-4a94-8b6f-1af6f5f5c0aa",
				motion_id: "wave",
				left: "open",
				right: "open",
				library_version: "1.1.0",
			},
		];
		let received: StageSceneRequestV1 | undefined;
		const tool = createStageSceneTool({
			stageScene: async (value) => {
				received = value;
				return {
					resulting_revision_id: "b".repeat(64),
					entity_identities: [],
					applied_hand_shapes: applied,
				};
			},
		});

		const result = await tool.execute(
			"call",
			mixedRequest,
			new AbortController().signal,
			() => {},
			undefined as never,
		);
		assert.deepEqual(received, mixedRequest);
		assert.deepEqual(
			(result.details as { applied_hand_shapes: readonly StageSceneAppliedHandShape[] }).applied_hand_shapes,
			applied,
		);
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
		const applied: StageSceneAppliedHandShape = {
			operation_index: 0,
			entity_id: identity.entity_id,
			motion_id: "wave",
			left: "point",
			right: "open",
			library_version: "1.1.0",
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
					applied_hand_shapes: [applied],
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
		const details = result.details as {
			entity_identities: readonly StageSceneEntityIdentity[];
			applied_hand_shapes: readonly StageSceneAppliedHandShape[];
		};
		assert.deepEqual(details.entity_identities, [identity]);
		assert.equal(details.entity_identities[0]?.actual_name, "Hero Cube.001");
		assert.deepEqual(details.applied_hand_shapes, [applied]);
	});
});
