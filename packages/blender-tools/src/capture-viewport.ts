import { parseViewportCaptureResult, VIEWPORT_CAPTURE_VIEW_NAMES, type ViewportCaptureResultV1 } from "@cclay/protocol";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const UUID_V4_LOWERCASE = "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";

export interface CaptureViewportBridge {
	captureViewport(request: {
		readonly subject?: string;
		readonly views?: readonly string[];
	}): Promise<ViewportCaptureResultV1>;
}

export function createCaptureViewportTool(bridge: CaptureViewportBridge) {
	return defineTool({
		name: "capture_viewport",
		label: "capture_viewport",
		description:
			"Capture one or more aspect-matched JPEG views of the current Blender scene and return each as an image content block. Every view stays inside the same ~0.6 MP budget (1024x576 equivalent, ~786 vision tokens) but the ratio follows the evidence: a no-subject capture keeps the human viewport's own aspect instead of forcing 16:9, and a subject capture uses wide/portrait/footprint-matched frames per named view. With no subject, captures the human's live viewport as a single image named `viewport`. With a subject (an entity id), synthesizes several purposeful angles of that entity from its evaluated world bounds: named views `three_quarter`, `front`, `side`, `top`, `contact_low`; the default set is `three_quarter`, `side`, `contact_low`. No scene mutation occurs -- the camera, viewport, and objects do not move. This is the fast visual QA path: a capture renders through a GPU offscreen buffer in under a second and costs ~2-4 KB of context per view, vs render_qa_frames which does a full render and costs hundreds of KB. Use capture_viewport for every iterative QA check while building or adjusting a scene; reserve render_qa_frames for a final quality check at target resolution.",
		parameters: Type.Object(
			{
				subject: Type.Optional(Type.String({ pattern: UUID_V4_LOWERCASE })),
				views: Type.Optional(
					Type.Array(Type.Union(VIEWPORT_CAPTURE_VIEW_NAMES.map((name) => Type.Literal(name))), {
						minItems: 1,
						maxItems: 8,
						uniqueItems: true,
					}),
				),
			},
			{ additionalProperties: false },
		),
		execute: async (_toolCallId, request) => {
			// Named views only mean something for a subject capture: the
			// no-subject path is the human's live viewport, which cannot be
			// re-framed. Silently ignoring `views` would hand back a different
			// image than the model asked for, so refuse the combination.
			if (request.views !== undefined && request.subject === undefined) {
				throw new Error(
					"capture_viewport: `views` requires `subject`; a no-subject capture returns the live viewport",
				);
			}
			const bridgeRequest: { subject?: string; views?: readonly string[] } = {};
			if (request.subject !== undefined) bridgeRequest.subject = request.subject;
			if (request.views !== undefined) bridgeRequest.views = request.views;
			// Parse at this boundary too, with the same canonical schema the
			// extension bridge uses. `CaptureViewportBridge` is an interface: a
			// skewed or hostile implementation must not be able to make this
			// tool emit an image block with a missing, empty, unsupported, or
			// non-canonical payload. Such a block serializes as
			// `data:undefined;base64,undefined`, and the provider API then
			// rejects every later request in the session -- the conversation
			// cannot recover, which is exactly the incident this tool caused.
			const result = parseViewportCaptureResult(await bridge.captureViewport(bridgeRequest));
			const content: Array<
				| { readonly type: "text"; readonly text: string }
				| { readonly type: "image"; readonly mimeType: string; readonly data: string }
			> = [];
			for (const view of result.views) {
				content.push({
					type: "text",
					text: `view ${view.name}: ${view.width}x${view.height} via ${view.method}`,
				});
				content.push({
					type: "image",
					mimeType: view.mime_type,
					data: view.data_base64,
				});
			}
			content.push({
				type: "text",
				text: `capture_viewport: ${result.views.length} view(s), revision ${result.revision.slice(0, 12)}`,
			});
			return {
				content,
				details: result,
			};
		},
	});
}
