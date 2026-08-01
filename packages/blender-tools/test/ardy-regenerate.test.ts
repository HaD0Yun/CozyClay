import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ArdyRegenerateRequestV1 } from "@cclay/protocol";
import { Value } from "typebox/value";
import { createArdyRegenerateTool } from "../src/ardy-regenerate.ts";

const request: Omit<ArdyRegenerateRequestV1, "schema_version"> = {
	request_id: "regenerate-42",
	entity_id: "123e4567-e89b-42d3-a456-426614174000",
	base_motion_id: "walk-cycle",
	expected_revision_id: "a".repeat(64),
	effectors: [],
	full_body: [],
	root_2d: [],
	requested_at_ms: 1_700_000_000_000,
};

const success = {
	schema_version: 1 as const,
	request_id: request.request_id,
	status: "succeeded" as const,
	result: {
		schema_version: 1 as const,
		request_id: request.request_id,
		motion_id: "walk-cycle-regenerated",
		frames: 12,
		achieved_error_m: null,
		residual: null,
		continuity: { mean_jump_m: 0, max_jump_m: 0, max_jump_frame: 0 },
		dropped_constraints: [],
	},
	resulting_revision_id: "b".repeat(64),
};

describe("ardy_regenerate", () => {
	it("forwards the canonical request with schema version while preserving caller request_id", async () => {
		let received: ArdyRegenerateRequestV1 | undefined;
		const tool = createArdyRegenerateTool({
			regenerate: async (value) => {
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
		const tool = createArdyRegenerateTool({ regenerate: async () => success });
		assert.equal(tool.parameters.additionalProperties, false);
		assert.equal(Value.Check(tool.parameters, request), true);
		assert.equal(Value.Check(tool.parameters, { schema_version: 1, ...request }), false);
	});

	it("reports a durable queue failure as JSON content and details", async () => {
		const failure = {
			schema_version: 1 as const,
			request_id: request.request_id,
			status: "failed" as const,
			error_code: "REVISION_MISMATCH" as const,
			message: "Project revision changed.",
		};
		const tool = createArdyRegenerateTool({ regenerate: async () => failure });
		const result = await tool.execute("call", request, undefined, undefined, undefined as never);
		assert.equal(result.content[0]?.type === "text" ? result.content[0].text : undefined, JSON.stringify(failure));
		assert.equal(result.details, failure);
	});
});
