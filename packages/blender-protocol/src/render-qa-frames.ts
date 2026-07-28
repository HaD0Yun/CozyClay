import { type Static, type TSchema, Type } from "typebox";
import { Parse } from "typebox/value";

const HASH_64 = "^[0-9a-f]{64}$";
const ARTIFACT_URI = "^cclay-artifact://sha256/[0-9a-f]{64}$";
const exact = <T extends Record<string, TSchema>>(properties: T) =>
	Type.Object(properties, { additionalProperties: false });
export const RENDER_QA_PROFILE_VERSION = "cclay-qa-png-v1" as const;
/** Model-visible thumbnail cap per frame; G011 artifact storage limits remain unchanged. */
export const RENDER_QA_MAX_IMAGE_FRAME_BYTES = 2 * 1024 * 1024;
/** Aggregate decoded thumbnail bytes exposed to the model for one render_qa_frames result. */
export const RENDER_QA_MAX_IMAGE_BATCH_BYTES = 12 * 1024 * 1024;
const MAX_IMAGE_BASE64_LENGTH = 4 * Math.ceil(RENDER_QA_MAX_IMAGE_FRAME_BYTES / 3);

export const RenderQaFramesRequestV1Schema = exact({
	schema_version: Type.Literal(1),
	revision_id: Type.String({ pattern: HASH_64 }),
	frames: Type.Array(Type.Integer({ minimum: 0, maximum: 1_000_000 }), { minItems: 1 }),
});
const RenderQaFrameThumbnailV1Schema = exact({
	mime_type: Type.Literal("image/jpeg"),
	data_base64: Type.String({ minLength: 12 }),
	width: Type.Integer({ minimum: 1, maximum: 1024 }),
	height: Type.Integer({ minimum: 1, maximum: 1024 }),
});

// The full PNG never crosses the wire inside this metadata: it is streamed as
// bounded artifact chunks and reassembled by the bridge, which verifies
// `byte_length`/`sha256` against the bytes it actually received. Restating the
// PNG here once overflowed the addon's 1 MiB WebSocket frame limit on
// multi-frame batches and killed the transport, so only the small model-visible
// thumbnail travels with the result.
const RenderQaFrameArtifactV1Schema = exact({
	frame: Type.Integer({ minimum: 0, maximum: 1_000_000 }),
	width: Type.Literal(640),
	height: Type.Literal(360),
	profile_version: Type.Literal(RENDER_QA_PROFILE_VERSION),
	byte_length: Type.Integer({ minimum: 1, maximum: 16 * 1024 * 1024 }),
	sha256: Type.String({ pattern: HASH_64 }),
	uri: Type.String({ pattern: ARTIFACT_URI }),
	thumbnail: RenderQaFrameThumbnailV1Schema,
});

export const RenderQaFramesResultV1Schema = exact({
	schema_version: Type.Literal(1),
	revision_id: Type.String({ pattern: HASH_64 }),
	profile_version: Type.Literal(RENDER_QA_PROFILE_VERSION),
	frames: Type.Array(RenderQaFrameArtifactV1Schema, { maxItems: 12 }),
});

export type RenderQaFramesRequestV1 = Static<typeof RenderQaFramesRequestV1Schema>;
export type RenderQaFrameArtifactV1 = Static<typeof RenderQaFrameArtifactV1Schema>;
export type RenderQaFramesResultV1 = Static<typeof RenderQaFramesResultV1Schema>;

export function parseRenderQaFramesRequest(input: unknown): RenderQaFramesRequestV1 {
	const parsed = Parse(RenderQaFramesRequestV1Schema, input);
	const frames = [...new Set(parsed.frames)].sort((left, right) => left - right);
	if (frames.length > 12) throw new Error("RENDER_QA_FRAME_LIMIT: at most 12 unique frames are allowed");
	return { ...parsed, frames };
}

/** Fail an oversized thumbnail with its coded error before schema parsing walks it. */
function rejectOversizedEncodedThumbnails(input: unknown): void {
	if (typeof input !== "object" || input === null || !("frames" in input) || !Array.isArray(input.frames)) return;
	for (const frame of input.frames) {
		if (typeof frame !== "object" || frame === null || !("thumbnail" in frame)) continue;
		const thumbnail = frame.thumbnail;
		if (
			typeof thumbnail === "object" &&
			thumbnail !== null &&
			"data_base64" in thumbnail &&
			typeof thumbnail.data_base64 === "string" &&
			thumbnail.data_base64.length > MAX_IMAGE_BASE64_LENGTH
		) {
			throw new Error("RENDER_QA_IMAGE_CONTENT_LIMIT: frame image exceeds 2 MiB");
		}
	}
}

export function parseRenderQaFramesResult(input: unknown): RenderQaFramesResultV1 {
	rejectOversizedEncodedThumbnails(input);
	const parsed = Parse(RenderQaFramesResultV1Schema, input);
	let previous = -1;
	let totalImageBytes = 0;
	for (const frame of parsed.frames) {
		if (frame.uri !== `cclay-artifact://sha256/${frame.sha256}`) {
			throw new Error("INVALID_RENDER_QA_RESULT: artifact URI must bind its SHA-256");
		}
		if (frame.frame <= previous) throw new Error("INVALID_RENDER_QA_RESULT: frames must be unique and sorted");
		previous = frame.frame;

		const thumbnailBytes = Buffer.from(frame.thumbnail.data_base64, "base64");
		if (thumbnailBytes.byteLength > RENDER_QA_MAX_IMAGE_FRAME_BYTES) {
			throw new Error("RENDER_QA_IMAGE_CONTENT_LIMIT: frame image exceeds 2 MiB");
		}
		totalImageBytes += thumbnailBytes.byteLength;
		if (totalImageBytes > RENDER_QA_MAX_IMAGE_BATCH_BYTES) {
			throw new Error("RENDER_QA_IMAGE_CONTENT_LIMIT: batch images exceed 12 MiB");
		}
		if (thumbnailBytes.toString("base64") !== frame.thumbnail.data_base64) {
			throw new Error("INVALID_RENDER_QA_RESULT: thumbnail data must be canonical base64");
		}
	}
	if (parsed.frames.reduce((total, frame) => total + frame.byte_length, 0) > 128 * 1024 * 1024) {
		throw new Error("INVALID_RENDER_QA_RESULT: batch exceeds 128 MiB");
	}
	return parsed;
}
