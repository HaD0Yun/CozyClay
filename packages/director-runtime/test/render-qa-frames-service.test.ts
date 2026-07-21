import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { RenderQaFramesRequestV1, RenderQaFramesResultV1 } from "@oh-my-blender/protocol";
import { createRenderQaFramesHandler } from "../src/render-qa-frames-service.ts";

const revision = "a".repeat(64);
const request: RenderQaFramesRequestV1 = { schema_version: 1, revision_id: revision, frames: [3, 8] };
const imageData = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=";
const imageBytes = Buffer.from(imageData, "base64");
type RenderResultWithImage = RenderQaFramesResultV1 & {
	readonly frames: ReadonlyArray<
		RenderQaFramesResultV1["frames"][number] & {
			readonly image: { readonly mime_type: "image/png"; readonly data_base64: string };
			readonly thumbnail: {
				readonly mime_type: "image/jpeg";
				readonly data_base64: string;
				readonly width: number;
				readonly height: number;
			};
		}
	>;
};
const result: RenderResultWithImage = {
	schema_version: 1,
	revision_id: revision,
	profile_version: "omb-qa-png-v1",
	frames: request.frames.map((frame) => {
		const sha256 = createHash("sha256").update(imageBytes).digest("hex");
		return {
			frame,
			width: 640,
			height: 360,
			profile_version: "omb-qa-png-v1",
			byte_length: imageBytes.byteLength,
			sha256,
			uri: `omb-artifact://sha256/${sha256}`,
			image: { mime_type: "image/png" as const, data_base64: imageData },
			thumbnail: {
				mime_type: "image/jpeg" as const,
				data_base64: Buffer.from("jpeg-thumbnail-payload").toString("base64"),
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

test("render QA image cap violations retain their distinct protocol code", async () => {
	const oversized = {
		...result,
		frames: [
			{
				...result.frames[0],
				image: {
					mime_type: "image/png" as const,
					data_base64: Buffer.alloc(2 * 1024 * 1024 + 1).toString("base64"),
				},
				thumbnail: {
					mime_type: "image/jpeg" as const,
					data_base64: Buffer.from("jpeg-thumbnail-payload").toString("base64"),
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
