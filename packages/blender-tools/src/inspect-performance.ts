import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export interface InspectPerformanceBridge {
	inspectPerformance(params: { expected_revision_id: string }): Promise<Record<string, unknown>>;
}

export function createInspectPerformanceTool(bridge: InspectPerformanceBridge) {
	return defineTool({
		name: "inspect_performance",
		label: "inspect_performance",
		description:
			"Collect a read-only Blender performance baseline for diagnosing playback lag: scene fps and sync mode, editor/viewport count and shading modes, animation channel and keyframe counts, mesh vertex/polygon totals, and vertices affected by armature modifiers. Use this when the user reports lag before guessing at geometry. It reports measurements only; apply_performance_mode changes the playback profile.",
		parameters: Type.Object(
			{
				expected_revision_id: Type.String({ pattern: "^[0-9a-f]{64}$" }),
			},
			{ additionalProperties: false },
		),
		execute: async (_toolCallId, params) => {
			const result = await bridge.inspectPerformance(params);
			return {
				content: [{ type: "text" as const, text: JSON.stringify(result) }],
				details: result,
			};
		},
	});
}
