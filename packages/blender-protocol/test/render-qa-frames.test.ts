import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRenderQaFramesRequest, parseRenderQaFramesResult } from "../src/render-qa-frames.ts";

const revision = "a".repeat(64);

test("G011: request takes a revision id and <=12 unique in-range frames, deduped and sorted ascending", () => {
	assert.deepEqual(parseRenderQaFramesRequest({ schema_version: 1, revision_id: revision, frames: [9, 1, 9, 3] }), {
		schema_version: 1,
		revision_id: revision,
		frames: [1, 3, 9],
	});
	assert.throws(() =>
		parseRenderQaFramesRequest({
			schema_version: 1,
			revision_id: revision,
			frames: Array.from({ length: 13 }, (_, index) => index),
		}),
	);
	assert.throws(() => parseRenderQaFramesRequest({ schema_version: 1, revision_id: revision, frames: [-1] }));
	assert.throws(() => parseRenderQaFramesRequest({ schema_version: 1, revision_id: revision, frames: [1.5] }));
});

test("G011: request is closed and rejects unknown fields", () => {
	assert.throws(() =>
		parseRenderQaFramesRequest({ schema_version: 1, revision_id: revision, frames: [1], path: "/tmp/x" }),
	);
});

test("G011: result binds exact revision and per-frame 640x360 profile/hash/URI metadata", () => {
	const sha256 = "b".repeat(64);
	const result = parseRenderQaFramesResult({
		schema_version: 1,
		revision_id: revision,
		profile_version: "omb-qa-png-v1",
		frames: [
			{
				frame: 3,
				width: 640,
				height: 360,
				profile_version: "omb-qa-png-v1",
				byte_length: 42,
				sha256,
				uri: `omb-artifact://sha256/${sha256}`,
			},
		],
	});
	assert.equal(result.revision_id, revision);
	assert.throws(() => parseRenderQaFramesResult({ ...result, revision_id: "stale" }));
	assert.throws(() =>
		parseRenderQaFramesResult({ ...result, frames: [{ ...result.frames[0], uri: "file:///tmp/x" }] }),
	);
	assert.throws(() => parseRenderQaFramesResult({ ...result, frames: [{ ...result.frames[0], width: 1 }] }));
	assert.throws(
		() =>
			parseRenderQaFramesResult({
				...result,
				frames: Array.from({ length: 9 }, (_, frame) => ({
					...result.frames[0],
					frame,
					byte_length: 16 * 1024 * 1024,
				})),
			}),
		/128 MiB/,
	);
});
