import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const UUID_V4_LOWERCASE = "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";

export interface InspectVisualQaMetricsBridge {
	inspectVisualQaMetrics(params: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export function createInspectVisualQaMetricsTool(bridge: InspectVisualQaMetricsBridge) {
	return defineTool({
		name: "inspect_visual_qa_metrics",
		label: "inspect_visual_qa_metrics",
		description:
			"Collect deterministic Visual QA metrics without rendering: active camera lens/sensor and action keyframe count, emission-material count, and per-frame subject screen position, distance to camera, ground gap, and below-ground depth. Use this alongside rendered QA frames to reject obvious misses before reading images: subject off-screen, subject below ground, no camera action, or residual emission materials after VFX removal. It does not render or mutate the scene.",
		parameters: Type.Object(
			{
				expected_revision_id: Type.String({ pattern: "^[0-9a-f]{64}$" }),
				frames: Type.Array(Type.Integer({ minimum: 0, maximum: 100000 }), {
					minItems: 1,
					maxItems: 64,
					uniqueItems: true,
				}),
				subject_entity_ids: Type.Array(Type.String({ pattern: UUID_V4_LOWERCASE }), {
					minItems: 1,
					maxItems: 32,
					uniqueItems: true,
				}),
				ground_z: Type.Optional(Type.Number()),
			},
			{ additionalProperties: false },
		),
		execute: async (_toolCallId, params) => {
			const result = await bridge.inspectVisualQaMetrics(params);
			return {
				content: [{ type: "text" as const, text: JSON.stringify(result) }],
				details: result,
			};
		},
	});
}
