import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export interface ViewportCapture {
	readonly mime_type: string;
	readonly data_base64: string;
	readonly width: number;
	readonly height: number;
	readonly method: string;
}

export interface CaptureViewportBridge {
	captureViewport(): Promise<{ readonly revision: string; readonly viewport: ViewportCapture }>;
}

export function createCaptureViewportTool(bridge: CaptureViewportBridge) {
	return defineTool({
		name: "capture_viewport",
		label: "capture_viewport",
		description:
			"Capture the active Blender 3D viewport as a small JPEG image and return it as an image content block. This is the fast visual QA path: it renders the viewport through a GPU offscreen buffer in under a second and costs ~2-4 KB of context, vs render_qa_frames which does a full render and costs hundreds of KB. Use capture_viewport for every iterative QA check while building or adjusting a scene; reserve render_qa_frames for a final quality check at target resolution. The viewport reflects the user's current camera angle — orbit the camera with transform_entity between captures to inspect multiple angles.",
		parameters: Type.Object({}),
		execute: async () => {
			const result = await bridge.captureViewport();
			return {
				content: [
					{
						type: "image" as const,
						mimeType: result.viewport.mime_type,
						data: result.viewport.data_base64,
					},
					{
						type: "text" as const,
						text: `viewport ${result.viewport.width}x${result.viewport.height} via ${result.viewport.method}, revision ${result.revision.slice(0, 12)}`,
					},
				],
				details: result,
			};
		},
	});
}
