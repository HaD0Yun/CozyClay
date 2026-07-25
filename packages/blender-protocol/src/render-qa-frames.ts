import { createHash } from "node:crypto";
import { type Static, type TSchema, Type } from "typebox";
import { Parse } from "typebox/value";

const HASH_64 = "^[0-9a-f]{64}$";
const ARTIFACT_URI = "^cclay-artifact://sha256/[0-9a-f]{64}$";
const exact = <T extends Record<string, TSchema>>(properties: T) =>
	Type.Object(properties, { additionalProperties: false });
export const RENDER_QA_PROFILE_VERSION = "cclay-qa-png-v1" as const;
/** Model-visible low-resolution PNG cap; G011 artifact storage limits remain unchanged. */
export const RENDER_QA_MAX_IMAGE_FRAME_BYTES = 2 * 1024 * 1024;
/** Aggregate decoded bytes exposed to the model for one render_qa_frames result. */
export const RENDER_QA_MAX_IMAGE_BATCH_BYTES = 12 * 1024 * 1024;
const MAX_IMAGE_BASE64_LENGTH = 4 * Math.ceil(RENDER_QA_MAX_IMAGE_FRAME_BYTES / 3);
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export const RenderQaFramesRequestV1Schema = exact({
	schema_version: Type.Literal(1),
	revision_id: Type.String({ pattern: HASH_64 }),
	frames: Type.Array(Type.Integer({ minimum: 0, maximum: 1_000_000 }), { minItems: 1 }),
});
const RenderQaFrameImageV1Schema = exact({
	mime_type: Type.Literal("image/png"),
	data_base64: Type.String({ minLength: 12 }),
});
const RenderQaFrameThumbnailV1Schema = exact({
	mime_type: Type.Literal("image/jpeg"),
	data_base64: Type.String({ minLength: 12 }),
	width: Type.Integer({ minimum: 1, maximum: 1024 }),
	height: Type.Integer({ minimum: 1, maximum: 1024 }),
});

const RenderQaFrameArtifactV1Schema = exact({
	frame: Type.Integer({ minimum: 0, maximum: 1_000_000 }),
	width: Type.Literal(640),
	height: Type.Literal(360),
	profile_version: Type.Literal(RENDER_QA_PROFILE_VERSION),
	byte_length: Type.Integer({ minimum: 1, maximum: 16 * 1024 * 1024 }),
	sha256: Type.String({ pattern: HASH_64 }),
	uri: Type.String({ pattern: ARTIFACT_URI }),
	image: RenderQaFrameImageV1Schema,
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

function rejectOversizedEncodedImages(input: unknown): void {
	if (typeof input !== "object" || input === null || !("frames" in input) || !Array.isArray(input.frames)) return;
	for (const frame of input.frames) {
		if (typeof frame !== "object" || frame === null || !("image" in frame)) continue;
		const image = frame.image;
		if (
			typeof image === "object" &&
			image !== null &&
			"data_base64" in image &&
			typeof image.data_base64 === "string" &&
			image.data_base64.length > MAX_IMAGE_BASE64_LENGTH
		) {
			throw new Error("RENDER_QA_IMAGE_CONTENT_LIMIT: frame image exceeds 2 MiB");
		}
	}
}

export function parseRenderQaFramesResult(input: unknown): RenderQaFramesResultV1 {
	rejectOversizedEncodedImages(input);
	const parsed = Parse(RenderQaFramesResultV1Schema, input);
	let previous = -1;
	let totalImageBytes = 0;
	for (const frame of parsed.frames) {
		if (frame.uri !== `cclay-artifact://sha256/${frame.sha256}`) {
			throw new Error("INVALID_RENDER_QA_RESULT: artifact URI must bind its SHA-256");
		}
		if (frame.frame <= previous) throw new Error("INVALID_RENDER_QA_RESULT: frames must be unique and sorted");
		previous = frame.frame;

		const imageBytes = Buffer.from(frame.image.data_base64, "base64");
		if (imageBytes.byteLength > RENDER_QA_MAX_IMAGE_FRAME_BYTES) {
			throw new Error("RENDER_QA_IMAGE_CONTENT_LIMIT: frame image exceeds 2 MiB");
		}
		totalImageBytes += imageBytes.byteLength;
		if (totalImageBytes > RENDER_QA_MAX_IMAGE_BATCH_BYTES) {
			throw new Error("RENDER_QA_IMAGE_CONTENT_LIMIT: batch images exceed 12 MiB");
		}
		if (imageBytes.toString("base64") !== frame.image.data_base64) {
			throw new Error("INVALID_RENDER_QA_RESULT: image data must be canonical base64");
		}
		if (imageBytes.byteLength !== frame.byte_length) {
			throw new Error("INVALID_RENDER_QA_RESULT: image byte length must match artifact metadata");
		}
		if (!imageBytes.subarray(0, PNG_SIGNATURE.byteLength).equals(PNG_SIGNATURE)) {
			throw new Error("INVALID_RENDER_QA_RESULT: image content must be a PNG");
		}
		if (createHash("sha256").update(imageBytes).digest("hex") !== frame.sha256) {
			throw new Error("INVALID_RENDER_QA_RESULT: image digest must match artifact metadata");
		}
	}
	if (parsed.frames.reduce((total, frame) => total + frame.byte_length, 0) > 128 * 1024 * 1024) {
		throw new Error("INVALID_RENDER_QA_RESULT: batch exceeds 128 MiB");
	}
	return parsed;
}
