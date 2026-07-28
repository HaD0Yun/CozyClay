import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export interface ApplyPerformanceModeBridge {
	applyPerformanceMode(params: {
		expected_revision_id: string;
		profile: "editing" | "playback" | "performance";
	}): Promise<Record<string, unknown>>;
}

export function createApplyPerformanceModeTool(bridge: ApplyPerformanceModeBridge) {
	return defineTool({
		name: "apply_performance_mode",
		label: "apply_performance_mode",
		description:
			"Apply a revision-bound Blender playback profile. `editing` restores normal editing behavior, `playback` uses Solid/Flat viewports and Frame Dropping, and `performance` also hides City_* background and *_Joints meshes during viewport playback. This does not advance the project revision or render frames; it is deliberately scoped to viewport and playback settings so a stale durable revision is rejected as STALE_BASE. Use inspect_performance first and report which profile was applied.",
		parameters: Type.Object(
			{
				expected_revision_id: Type.String({ pattern: "^[0-9a-f]{64}$" }),
				profile: Type.Union([Type.Literal("editing"), Type.Literal("playback"), Type.Literal("performance")]),
			},
			{ additionalProperties: false },
		),
		execute: async (_toolCallId, params) => {
			const result = await bridge.applyPerformanceMode(params);
			return {
				content: [{ type: "text" as const, text: JSON.stringify(result) }],
				details: result,
			};
		},
	});
}
