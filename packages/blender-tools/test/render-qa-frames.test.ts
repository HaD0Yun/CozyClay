import assert from "node:assert/strict";
import { test } from "node:test";
import type { RenderQaFramesRequestV1, RenderQaFramesResultV1 } from "@cclay/protocol";
import { createRenderQaFramesTool } from "../src/render-qa-frames.ts";

const request: RenderQaFramesRequestV1 = { schema_version: 1, expected_revision_id: "a".repeat(64), frames: [80] };
const result: RenderQaFramesResultV1 = {
	schema_version: 1,
	expected_revision_id: request.expected_revision_id,
	profile_version: "cclay-qa-png-v1",
	frames: [
		{
			frame: 80,
			width: 640,
			height: 360,
			profile_version: "cclay-qa-png-v1",
			byte_length: 8,
			sha256: "b".repeat(64),
			uri: `cclay-artifact://sha256/${"b".repeat(64)}`,
			thumbnail: { mime_type: "image/jpeg" as const, data_base64: "thumb", width: 256, height: 144 },
		},
	],
};

test("G011: render_qa_frames is an exact allowlist tool requiring expected_revision_id with no arbitrary paths", () => {
	const tool = createRenderQaFramesTool({ renderQaFrames: async () => result });
	assert.equal(tool.name, "render_qa_frames");
	assert.ok("expected_revision_id" in tool.parameters.properties);
	assert.ok(!("path" in tool.parameters.properties));
	assert.equal(tool.parameters.additionalProperties, false);
});

test("G016: render_qa_frames returns metadata plus proper Pi image content blocks", async () => {
	let received: RenderQaFramesRequestV1 | undefined;
	const tool = createRenderQaFramesTool({
		renderQaFrames: async (value) => {
			received = value;
			return result;
		},
	});
	const output = await tool.execute("call", request, undefined, undefined, undefined as never);
	assert.deepEqual(received, request);
	assert.equal(output.details, result);
	const metadataText = JSON.stringify({
		schema_version: result.schema_version,
		expected_revision_id: result.expected_revision_id,
		profile_version: result.profile_version,
		frames: [
			{
				frame: 80,
				width: 640,
				height: 360,
				profile_version: "cclay-qa-png-v1",
				byte_length: 8,
				sha256: "b".repeat(64),
				uri: `cclay-artifact://sha256/${"b".repeat(64)}`,
				thumbnail: { mime_type: "image/jpeg", width: 256, height: 144 },
			},
		],
	});
	// The model text carries thumbnail dimensions only: no base64 payload of any
	// kind, and no restated PNG (the result type no longer has a slot for one).
	assert.equal(metadataText.includes("data_base64"), false);
	assert.equal("image" in result.frames[0]!, false);
	assert.deepEqual(output.content, [
		{ type: "text", text: metadataText },
		{ type: "image", mimeType: "image/jpeg", data: "thumb" },
	]);
});
