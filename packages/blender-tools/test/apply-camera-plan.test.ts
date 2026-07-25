import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CameraPlanV1 } from "@cclay/protocol";
import { createApplyCameraPlanTool } from "../src/apply-camera-plan.ts";

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

describe("apply_camera_plan", () => {
	it("requires expected_revision_id in the closed model-facing CameraPlanV1 schema", () => {
		const tool = createApplyCameraPlanTool({
			applyCameraPlan: async () => ({ resulting_revision_id: "c".repeat(64) }),
		});
		assert.equal(tool.name, "apply_camera_plan");
		assert.ok("expected_revision_id" in tool.parameters.properties);
		assert.equal(tool.parameters.additionalProperties, false);
	});

	it("dispatches the exact plan through the mutation bridge and returns JSON text plus details", async () => {
		let received: CameraPlanV1 | undefined;
		const resultValue = { resulting_revision_id: "c".repeat(64), scene_hash: "d".repeat(64) };
		const tool = createApplyCameraPlanTool({
			applyCameraPlan: async (value) => {
				received = value;
				return resultValue;
			},
		});
		const result = await tool.execute("call", plan, undefined, undefined, undefined as never);
		assert.deepEqual(received, plan);
		const content = result.content[0];
		assert.equal(content?.type, "text");
		assert.equal(content?.type === "text" ? content.text : undefined, JSON.stringify(resultValue));
		assert.equal(result.details, resultValue);
	});

	it("passes cancellation and progress through without creating a second bridge", async () => {
		const controller = new AbortController();
		const updates: unknown[] = [];
		let receivedSignal: AbortSignal | undefined;
		const tool = createApplyCameraPlanTool({
			applyCameraPlan: async (_value, context) => {
				receivedSignal = context.signal;
				context.reportProgress({ phase: "mutating", completed: 1, total: 2 });
				return { resulting_revision_id: "c".repeat(64) };
			},
		});
		await tool.execute("call", plan, controller.signal, (update) => updates.push(update), undefined as never);
		assert.equal(receivedSignal, controller.signal);
		assert.equal(updates.length, 1);
	});
});
