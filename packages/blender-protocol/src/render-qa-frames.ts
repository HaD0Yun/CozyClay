import { type Static, type TSchema, Type } from "typebox";
import { Parse } from "typebox/value";

const HASH_64 = "^[0-9a-f]{64}$";
const ARTIFACT_URI = "^omb-artifact://sha256/[0-9a-f]{64}$";
const exact = <T extends Record<string, TSchema>>(properties: T) =>
	Type.Object(properties, { additionalProperties: false });
export const RENDER_QA_PROFILE_VERSION = "omb-qa-png-v1" as const;

export const RenderQaFramesRequestV1Schema = exact({
	schema_version: Type.Literal(1),
	revision_id: Type.String({ pattern: HASH_64 }),
	frames: Type.Array(Type.Integer({ minimum: 0, maximum: 1_000_000 }), { minItems: 1 }),
});

const RenderQaFrameArtifactV1Schema = exact({
	frame: Type.Integer({ minimum: 0, maximum: 1_000_000 }),
	width: Type.Literal(640),
	height: Type.Literal(360),
	profile_version: Type.Literal(RENDER_QA_PROFILE_VERSION),
	byte_length: Type.Integer({ minimum: 1, maximum: 16 * 1024 * 1024 }),
	sha256: Type.String({ pattern: HASH_64 }),
	uri: Type.String({ pattern: ARTIFACT_URI }),
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

export function parseRenderQaFramesResult(input: unknown): RenderQaFramesResultV1 {
	const parsed = Parse(RenderQaFramesResultV1Schema, input);
	let previous = -1;
	for (const frame of parsed.frames) {
		if (frame.uri !== `omb-artifact://sha256/${frame.sha256}`) {
			throw new Error("INVALID_RENDER_QA_RESULT: artifact URI must bind its SHA-256");
		}
		if (frame.frame <= previous) throw new Error("INVALID_RENDER_QA_RESULT: frames must be unique and sorted");
		previous = frame.frame;
	}
	if (parsed.frames.reduce((total, frame) => total + frame.byte_length, 0) > 128 * 1024 * 1024) {
		throw new Error("INVALID_RENDER_QA_RESULT: batch exceeds 128 MiB");
	}
	return parsed;
}
