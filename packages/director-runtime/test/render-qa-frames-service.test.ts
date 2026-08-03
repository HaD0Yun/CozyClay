import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { RenderQaFramesRequestV1, RenderQaFramesResultV1 } from "@cclay/protocol";
import { createRenderQaFramesHandler } from "../src/render-qa-frames-service.ts";

const revision = "a".repeat(64);
const request: RenderQaFramesRequestV1 = { schema_version: 1, expected_revision_id: revision, frames: [3, 8] };
const artifactBytes = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=",
	"base64",
);
const thumbnailData = Buffer.from("jpeg-thumbnail-payload").toString("base64");
const result: RenderQaFramesResultV1 = {
	schema_version: 1,
	expected_revision_id: revision,
	profile_version: "cclay-qa-png-v1",
	frames: request.frames.map((frame) => {
		const sha256 = createHash("sha256").update(artifactBytes).digest("hex");
		return {
			frame,
			width: 640 as const,
			height: 360 as const,
			profile_version: "cclay-qa-png-v1" as const,
			byte_length: artifactBytes.byteLength,
			sha256,
			uri: `cclay-artifact://sha256/${sha256}`,
			thumbnail: {
				mime_type: "image/jpeg" as const,
				data_base64: thumbnailData,
				width: 256,
				height: 144,
			},
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

test("render QA thumbnail cap violations retain their distinct protocol code", async () => {
	const oversized = {
		...result,
		frames: [
			{
				...result.frames[0],
				thumbnail: {
					mime_type: "image/jpeg" as const,
					data_base64: Buffer.alloc(2 * 1024 * 1024 + 1).toString("base64"),
					width: 256,
					height: 144,
				},
			},
			result.frames[1],
		],
	};
	await assert.rejects(
		createRenderQaFramesHandler()(request, {
			signal: new AbortController().signal,
			request: { expected_revision_id: revision },
			renderQaFrames: async () => oversized,
		}),
		(error: unknown) =>
			error instanceof Error && error.message === "RENDER_QA_IMAGE_CONTENT_LIMIT: frame image exceeds 2 MiB",
	);
});
