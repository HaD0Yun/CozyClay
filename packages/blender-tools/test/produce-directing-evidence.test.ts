import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProduceDirectingEvidenceResultV1 } from "@cclay/protocol";
import { createProduceDirectingEvidenceTool } from "../src/produce-directing-evidence.ts";

const result: ProduceDirectingEvidenceResultV1 = {
	schema_version: 1,
	evidence_sha256: "a".repeat(64),
	revision_id: "b".repeat(64),
	scene_hash: "c".repeat(64),
	frame_range: { start: 1, end: 250 },
	byte_length: 2048,
};

test("produce_directing_evidence exposes only optional frame bounds in a closed schema", () => {
	const tool = createProduceDirectingEvidenceTool({ produceDirectingEvidence: async () => result });
	assert.equal(tool.name, "produce_directing_evidence");
	assert.ok("frame_start" in tool.parameters.properties);
	assert.ok("frame_end" in tool.parameters.properties);
	assert.equal(Object.keys(tool.parameters.properties).length, 2);
	assert.ok(!("evidence_sha256" in tool.parameters.properties));
	assert.equal(tool.parameters.additionalProperties, false);
});

test("produce_directing_evidence dispatches the frame bounds and returns JSON text plus details", async () => {
	let received: { frame_start?: number; frame_end?: number } | undefined;
	const tool = createProduceDirectingEvidenceTool({
		produceDirectingEvidence: async (request) => {
			received = request;
			return result;
		},
	});
	const output = await tool.execute(
		"call",
		{ frame_start: 10, frame_end: 90 },
		undefined,
		undefined,
		undefined as never,
	);
	assert.deepEqual(received, { frame_start: 10, frame_end: 90 });
	const content = output.content[0];
	assert.equal(content?.type, "text");
	assert.equal(content?.type === "text" ? content.text : undefined, JSON.stringify(result));
	assert.equal(output.details, result);
});

test("produce_directing_evidence passes an empty request through unchanged", async () => {
	let received: { frame_start?: number; frame_end?: number } | undefined;
	const tool = createProduceDirectingEvidenceTool({
		produceDirectingEvidence: async (request) => {
			received = request;
			return result;
		},
	});
	await tool.execute("call", {}, undefined, undefined, undefined as never);
	assert.deepEqual(received, {});
});
