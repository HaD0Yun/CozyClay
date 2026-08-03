import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
	parseRenderQaFramesRequest,
	parseRenderQaFramesResult,
	RENDER_QA_MAX_IMAGE_BATCH_BYTES,
	RENDER_QA_MAX_IMAGE_FRAME_BYTES,
} from "../src/render-qa-frames.ts";

const revision = "a".repeat(64);
const thumbnailBase64 = Buffer.from("jpeg-thumbnail-payload").toString("base64");

test("G011: request takes a revision id and <=12 unique in-range frames, deduped and sorted ascending", () => {
	assert.deepEqual(
		parseRenderQaFramesRequest({ schema_version: 1, expected_revision_id: revision, frames: [9, 1, 9, 3] }),
		{
			schema_version: 1,
			expected_revision_id: revision,
			frames: [1, 3, 9],
		},
	);
	assert.throws(() =>
		parseRenderQaFramesRequest({
			schema_version: 1,
			expected_revision_id: revision,
			frames: Array.from({ length: 13 }, (_, index) => index),
		}),
	);
	assert.throws(() => parseRenderQaFramesRequest({ schema_version: 1, expected_revision_id: revision, frames: [-1] }));
	assert.throws(() =>
		parseRenderQaFramesRequest({ schema_version: 1, expected_revision_id: revision, frames: [1.5] }),
	);
});

test("G011: request is closed and rejects unknown fields", () => {
	assert.throws(() =>
		parseRenderQaFramesRequest({ schema_version: 1, expected_revision_id: revision, frames: [1], path: "/tmp/x" }),
	);
});

test("G011/G016: result binds artifact metadata to a closed thumbnail payload and never restates the PNG", () => {
	const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from("bounded-image")]);
	const sha256 = createHash("sha256").update(png).digest("hex");
	const frame = {
		frame: 3,
		width: 640,
		height: 360,
		profile_version: "cclay-qa-png-v1",
		byte_length: png.byteLength,
		sha256,
		uri: `cclay-artifact://sha256/${sha256}`,
		thumbnail: {
			mime_type: "image/jpeg",
			data_base64: thumbnailBase64,
			width: 256,
			height: 144,
		},
	};
	const result = parseRenderQaFramesResult({
		schema_version: 1,
		expected_revision_id: revision,
		profile_version: "cclay-qa-png-v1",
		frames: [frame],
	});
	assert.equal(result.expected_revision_id, revision);
	assert.equal(result.frames[0]!.thumbnail.data_base64, thumbnailBase64);

	// The full PNG is streamed as artifact chunks; restating it here once
	// overflowed the addon's 1 MiB frame limit, so the schema must refuse it.
	assert.throws(
		() =>
			parseRenderQaFramesResult({
				schema_version: 1,
				expected_revision_id: revision,
				profile_version: "cclay-qa-png-v1",
				frames: [{ ...frame, image: { mime_type: "image/png", data_base64: png.toString("base64") } }],
			}),
		/Parse/,
	);

	assert.throws(() => parseRenderQaFramesResult({ ...result, expected_revision_id: "stale" }));
	assert.throws(() =>
		parseRenderQaFramesResult({ ...result, frames: [{ ...result.frames[0], uri: "file:///tmp/x" }] }),
	);
	assert.throws(() => parseRenderQaFramesResult({ ...result, frames: [{ ...result.frames[0], width: 1 }] }));
	assert.throws(() =>
		parseRenderQaFramesResult({
			...result,
			frames: [{ ...result.frames[0], thumbnail: { ...result.frames[0]!.thumbnail, extra: true } }],
		}),
	);
	assert.throws(() =>
		parseRenderQaFramesResult({
			...result,
			frames: [{ ...result.frames[0], thumbnail: { ...result.frames[0]!.thumbnail, mime_type: "image/png" } }],
		}),
	);
	assert.throws(
		() =>
			parseRenderQaFramesResult({
				...result,
				frames: [
					{ ...result.frames[0], thumbnail: { ...result.frames[0]!.thumbnail, data_base64: "!!!!!!!!!!!!" } },
				],
			}),
		/INVALID_RENDER_QA_RESULT/,
	);
});

test("G016: model-visible thumbnail content has distinct per-frame and batch size errors", () => {
	assert.equal(RENDER_QA_MAX_IMAGE_FRAME_BYTES, 2 * 1024 * 1024);
	assert.equal(RENDER_QA_MAX_IMAGE_BATCH_BYTES, 12 * 1024 * 1024);
	const oversizedBase64 = "A".repeat(4 * Math.ceil((RENDER_QA_MAX_IMAGE_FRAME_BYTES + 1) / 3));
	assert.throws(
		() =>
			parseRenderQaFramesResult({
				schema_version: 1,
				expected_revision_id: revision,
				profile_version: "cclay-qa-png-v1",
				frames: [
					{
						frame: 1,
						width: 640,
						height: 360,
						profile_version: "cclay-qa-png-v1",
						byte_length: RENDER_QA_MAX_IMAGE_FRAME_BYTES + 1,
						sha256: "b".repeat(64),
						uri: `cclay-artifact://sha256/${"b".repeat(64)}`,
						thumbnail: { mime_type: "image/jpeg", data_base64: oversizedBase64, width: 256, height: 144 },
					},
				],
			}),
		/RENDER_QA_IMAGE_CONTENT_LIMIT/,
	);

	const fullThumbnail = Buffer.alloc(RENDER_QA_MAX_IMAGE_FRAME_BYTES, 7);
	const batchPayloads = [...Array.from({ length: 6 }, () => fullThumbnail), Buffer.from("small-thumbnail")];
	assert.throws(
		() =>
			parseRenderQaFramesResult({
				schema_version: 1,
				expected_revision_id: revision,
				profile_version: "cclay-qa-png-v1",
				frames: batchPayloads.map((payload, frame) => {
					const sha256 = createHash("sha256").update(payload).digest("hex");
					return {
						frame,
						width: 640 as const,
						height: 360 as const,
						profile_version: "cclay-qa-png-v1" as const,
						byte_length: payload.byteLength,
						sha256,
						uri: `cclay-artifact://sha256/${sha256}`,
						thumbnail: {
							mime_type: "image/jpeg" as const,
							data_base64: payload.toString("base64"),
							width: 256 as const,
							height: 144 as const,
						},
					};
				}),
			}),
		/RENDER_QA_IMAGE_CONTENT_LIMIT: batch/,
	);
});
