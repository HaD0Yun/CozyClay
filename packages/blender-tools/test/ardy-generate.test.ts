import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ArdyGenerateRequestV1 } from "@cclay/protocol";
import { Value } from "typebox/value";
import { createArdyGenerateTool } from "../src/ardy-generate.ts";

const request: Omit<ArdyGenerateRequestV1, "schema_version"> = {
	request_id: "0123456789abcdef0123456789abcdef",
	entity_id: "123e4567-e89b-42d3-a456-426614174000",
	expected_revision_id: "a".repeat(64),
	prompt: "wave both hands",
	duration_seconds: 4,
	seed: null,
	requested_at_ms: 1_700_000_000_000,
};

const success = {
	schema_version: 1 as const,
	request_id: request.request_id,
	status: "succeeded" as const,
	result: {
		schema_version: 1 as const,
		request_id: request.request_id,
		motion_id: "wave-hands-01",
		frames: 80,
		duration_seconds: 4,
		seed: null,
	},
	resulting_revision_id: "b".repeat(64),
};

describe("ardy_generate", () => {
	it("forwards the canonical request with schema version while preserving caller request_id", async () => {
		let received: ArdyGenerateRequestV1 | undefined;
		const tool = createArdyGenerateTool({
			generate: async (value) => {
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
		const tool = createArdyGenerateTool({ generate: async () => success });
		assert.equal(tool.parameters.additionalProperties, false);
		assert.equal(Value.Check(tool.parameters, request), true);
		assert.equal(Value.Check(tool.parameters, { schema_version: 1, ...request }), false);
	});

	it("describes a durable host-queue operation that does not verify ground contact", () => {
		const tool = createArdyGenerateTool({ generate: async () => success });
		assert.match(tool.description, /durable host queue/);
		assert.match(tool.description, /sole contact/);
		assert.match(tool.description, /residual near zero is not ground-contact verification/);
	});

	it("reports a durable queue failure as JSON content and details", async () => {
		const failure = {
			schema_version: 1 as const,
			request_id: request.request_id,
			status: "failed" as const,
			error_code: "REVISION_MISMATCH" as const,
			message: "Project revision changed.",
		};
		const tool = createArdyGenerateTool({ generate: async () => failure });
		const result = await tool.execute("call", request, undefined, undefined, undefined as never);
		assert.equal(result.content[0]?.type === "text" ? result.content[0].text : undefined, JSON.stringify(failure));
		assert.equal(result.details, failure);
	});
});
