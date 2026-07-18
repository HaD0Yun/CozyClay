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
			"Render up to 12 deterministic 640x360 QA PNG frames for an exact Blender revision. revision_id is required; results contain artifact metadata and canonical URIs only.",
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
			return {
				content: [{ type: "text" as const, text: JSON.stringify(result) }],
				details: result,
			};
		},
	});
}
