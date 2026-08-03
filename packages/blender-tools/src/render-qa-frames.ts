import {
	type RenderQaFramesRequestV1,
	RenderQaFramesRequestV1Schema,
	type RenderQaFramesResultV1,
} from "@cclay/protocol";
import { defineTool } from "@earendil-works/pi-coding-agent";

export interface RenderQaFramesProgress {
	readonly phase: string;
	readonly completed: number;
	readonly total: number;
}

export interface RenderQaFramesBridge {
	renderQaFrames(
		request: RenderQaFramesRequestV1,
		context: {
			readonly signal: AbortSignal | undefined;
			readonly reportProgress: (progress: RenderQaFramesProgress) => void;
		},
	): Promise<RenderQaFramesResultV1>;
}

export function createRenderQaFramesTool(bridge: RenderQaFramesBridge) {
	return defineTool({
		name: "render_qa_frames",
		label: "render_qa_frames",
		description:
			"Render up to 12 deterministic 640x360 QA PNG frames for an exact Blender revision. The full PNGs are streamed into the artifact store and referenced by canonical URI; the model receives one small JPEG thumbnail per frame, capped at 2 MiB per frame and 12 MiB per batch.",
		parameters: RenderQaFramesRequestV1Schema,
		executionMode: "sequential",
		execute: async (_toolCallId, request, signal, onUpdate) => {
			const result = await bridge.renderQaFrames(request, {
				signal,
				reportProgress: (progress) =>
					onUpdate?.({
						content: [{ type: "text" as const, text: JSON.stringify(progress) }],
						details: progress,
					}),
			});
			const modelMetadata = {
				schema_version: result.schema_version,
				expected_revision_id: result.expected_revision_id,
				profile_version: result.profile_version,
				frames: result.frames.map((frame) => ({
					frame: frame.frame,
					width: frame.width,
					height: frame.height,
					profile_version: frame.profile_version,
					byte_length: frame.byte_length,
					sha256: frame.sha256,
					uri: frame.uri,
					thumbnail: {
						mime_type: frame.thumbnail.mime_type,
						width: frame.thumbnail.width,
						height: frame.thumbnail.height,
					},
				})),
			};
			return {
				content: [
					{ type: "text" as const, text: JSON.stringify(modelMetadata) },
					...result.frames.map((frame) => ({
						type: "image" as const,
						mimeType: frame.thumbnail.mime_type,
						data: frame.thumbnail.data_base64,
					})),
				],
				details: result,
			};
		},
	});
}
