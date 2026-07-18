import assert from "node:assert/strict";
import { test } from "node:test";
import type { RenderQaFramesRequestV1, RenderQaFramesResultV1 } from "@oh-my-blender/protocol";
import { createRenderQaFramesHandler } from "../src/render-qa-frames-service.ts";

const revision = "a".repeat(64);
const request: RenderQaFramesRequestV1 = { schema_version: 1, revision_id: revision, frames: [3, 8] };
const result: RenderQaFramesResultV1 = {
	schema_version: 1,
	revision_id: revision,
	profile_version: "omb-qa-png-v1",
	frames: request.frames.map((frame) => {
		const sha256 = "b".repeat(64);
		return {
			frame,
			width: 640,
			height: 360,
			profile_version: "omb-qa-png-v1",
			byte_length: 42,
			sha256,
			uri: `omb-artifact://sha256/${sha256}`,
		};
	}),
};

test("G011: runtime binds render_qa_frames to the existing protocol-v2 bridge with the exact revision", async () => {
	let received: RenderQaFramesRequestV1 | undefined;
	const output = await createRenderQaFramesHandler()(request, {
		signal: new AbortController().signal,
		request: { expected_revision_id: revision },
		renderQaFrames: async (value) => {
			received = value;
			return result;
		},
	});
	assert.deepEqual(received, request);
	assert.deepEqual(output, { result, resulting_revision_id: revision });
});

test("G011: runtime rejects stale revision before dispatch", async () => {
	let dispatched = false;
	await assert.rejects(
		createRenderQaFramesHandler()(request, {
			signal: new AbortController().signal,
			request: { expected_revision_id: "b".repeat(64) },
			renderQaFrames: async () => {
				dispatched = true;
				return result;
			},
		}),
		/STALE_BASE/,
	);
	assert.equal(dispatched, false);
});
