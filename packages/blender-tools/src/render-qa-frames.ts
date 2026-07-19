import { defineTool } from "@earendil-works/pi-coding-agent";
import {
	type RenderQaFramesRequestV1,
	RenderQaFramesRequestV1Schema,
	type RenderQaFramesResultV1,
} from "@oh-my-blender/protocol";

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
			"Render up to 12 deterministic 640x360 QA PNG frames for an exact Blender revision. Returns canonical artifact URIs plus model-visible image/png content capped at 2 MiB per frame and 12 MiB per batch.",
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
				revision_id: result.revision_id,
				profile_version: result.profile_version,
				frames: result.frames.map((frame) => ({
					frame: frame.frame,
					width: frame.width,
					height: frame.height,
					profile_version: frame.profile_version,
					byte_length: frame.byte_length,
					sha256: frame.sha256,
					uri: frame.uri,
					image: { mime_type: frame.image.mime_type },
				})),
			};
			return {
				content: [
					{ type: "text" as const, text: JSON.stringify(modelMetadata) },
					...result.frames.map((frame) => ({
						type: "image" as const,
						mimeType: frame.image.mime_type,
						data: frame.image.data_base64,
					})),
				],
				details: result,
			};
		},
	});
}
