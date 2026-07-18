import assert from "node:assert/strict";
import { test } from "node:test";
import type { RenderQaFramesRequestV1, RenderQaFramesResultV1 } from "@oh-my-blender/protocol";
import { createRenderQaFramesTool } from "../src/render-qa-frames.ts";

const request: RenderQaFramesRequestV1 = { schema_version: 1, revision_id: "a".repeat(64), frames: [80, 161, 199] };
const result: RenderQaFramesResultV1 = {
	schema_version: 1,
	revision_id: request.revision_id,
	profile_version: "omb-qa-png-v1",
	frames: [],
};

test("G011: render_qa_frames is an exact allowlist tool requiring revision_id with no arbitrary paths", () => {
	const tool = createRenderQaFramesTool({ renderQaFrames: async () => result });
	assert.equal(tool.name, "render_qa_frames");
	assert.ok("revision_id" in tool.parameters.properties);
	assert.ok(!("path" in tool.parameters.properties));
	assert.equal(tool.parameters.additionalProperties, false);
});

test("G011: render_qa_frames dispatches through the supplied existing bridge and returns metadata only", async () => {
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
	assert.equal(JSON.stringify(output).includes("image_bytes"), false);
});
