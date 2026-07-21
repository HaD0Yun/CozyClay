import assert from "node:assert/strict";
import { test } from "node:test";
import type { RenderQaFramesRequestV1, RenderQaFramesResultV1 } from "@oh-my-blender/protocol";
import { createRenderQaFramesTool } from "../src/render-qa-frames.ts";

const request: RenderQaFramesRequestV1 = { schema_version: 1, revision_id: "a".repeat(64), frames: [80] };
const pngBase64 = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64");
const result: RenderQaFramesResultV1 = {
	schema_version: 1,
	revision_id: request.revision_id,
	profile_version: "omb-qa-png-v1",
	frames: [
		{
			frame: 80,
			width: 640,
			height: 360,
			profile_version: "omb-qa-png-v1",
			byte_length: 8,
			sha256: "b".repeat(64),
			uri: `omb-artifact://sha256/${"b".repeat(64)}`,
			image: { mime_type: "image/png", data_base64: pngBase64 },
			thumbnail: { mime_type: "image/jpeg" as const, data_base64: "thumb", width: 256, height: 144 },
		},
	],
};

test("G011: render_qa_frames is an exact allowlist tool requiring revision_id with no arbitrary paths", () => {
	const tool = createRenderQaFramesTool({ renderQaFrames: async () => result });
	assert.equal(tool.name, "render_qa_frames");
	assert.ok("revision_id" in tool.parameters.properties);
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
		revision_id: result.revision_id,
		profile_version: result.profile_version,
		frames: [
			{
				frame: 80,
				width: 640,
				height: 360,
				profile_version: "omb-qa-png-v1",
				byte_length: 8,
				sha256: "b".repeat(64),
				uri: `omb-artifact://sha256/${"b".repeat(64)}`,
				thumbnail: { mime_type: "image/jpeg", width: 256, height: 144 },
			},
		],
	});
	assert.equal(metadataText.includes(pngBase64), false);
	assert.deepEqual(output.content, [
		{ type: "text", text: metadataText },
		{ type: "image", mimeType: "image/jpeg", data: "thumb" },
	]);
});
