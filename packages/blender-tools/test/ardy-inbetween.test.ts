import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ArdyInbetweenRequestV1 } from "@cclay/protocol";
import { Value } from "typebox/value";
import { createArdyInbetweenTool } from "../src/ardy-inbetween.ts";

const request: Omit<ArdyInbetweenRequestV1, "schema_version"> = {
	request_id: "0123456789abcdef0123456789abcdef",
	entity_id: "123e4567-e89b-42d3-a456-426614174000",
	expected_revision_id: "a".repeat(64),
	base_motion_id: "walk-cycle",
	pose_frames: [
		{ scene_frame: 1, clip_frame: 0 },
		{ scene_frame: 20, clip_frame: 19 },
	],
	requested_at_ms: 1_700_000_000_000,
};

const success = {
	schema_version: 1 as const,
	request_id: request.request_id,
	status: "succeeded" as const,
	result: {
		schema_version: 1 as const,
		request_id: request.request_id,
		motion_id: "inbetween-01",
		frames: 40,
		captured_frames: 2,
		base_motion_id: "walk-cycle",
		continuity: { mean_jump_m: 0, max_jump_m: 0, max_jump_frame: 0 },
		dropped_constraints: [],
	},
	resulting_revision_id: "b".repeat(64),
};

describe("ardy_inbetween", () => {
	it("forwards the canonical request with schema version while preserving caller request_id", async () => {
		let received: ArdyInbetweenRequestV1 | undefined;
		const tool = createArdyInbetweenTool({
			inbetween: async (value) => {
				received = value;
				return success;
			},
		});

		const result = await tool.execute("call", request, undefined, undefined, undefined as never);
		assert.deepEqual(received, { schema_version: 1, ...request });
		assert.equal(received?.request_id, request.request_id);
		assert.equal(result.content[0]?.type, "text");
		assert.equal(result.content[0]?.type === "text" ? result.content[0].text : undefined, JSON.stringify(success));
		assert.equal(result.details, success);
	});

	it("exposes a closed schema that accepts explicit audit fields and rejects schema_version", () => {
		const tool = createArdyInbetweenTool({ inbetween: async () => success });
		assert.equal(tool.parameters.additionalProperties, false);
		assert.equal(Value.Check(tool.parameters, request), true);
		assert.equal(Value.Check(tool.parameters, { schema_version: 1, ...request }), false);
	});

	it("describes a durable host-queue operation that does not verify ground contact", () => {
		const tool = createArdyInbetweenTool({ inbetween: async () => success });
		assert.match(tool.description, /durable host queue/);
		assert.match(tool.description, /sole contact/);
		assert.match(tool.description, /residual near zero is not ground-contact verification/);
	});

	it("reports a durable queue failure as JSON content and details", async () => {
		const failure = {
			schema_version: 1 as const,
			request_id: request.request_id,
			status: "failed" as const,
			error_code: "POSE_CAPTURE_FAILED" as const,
			message: "Could not capture the requested pose frames.",
		};
		const tool = createArdyInbetweenTool({ inbetween: async () => failure });
		const result = await tool.execute("call", request, undefined, undefined, undefined as never);
		assert.equal(result.content[0]?.type === "text" ? result.content[0].text : undefined, JSON.stringify(failure));
		assert.equal(result.details, failure);
	});
});
