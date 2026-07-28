import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const UUID_V4_LOWERCASE = "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";

export interface ReplaceCameraActionBridge {
	replaceCameraAction(params: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export function createReplaceCameraActionTool(bridge: ReplaceCameraActionBridge) {
	return defineTool({
		name: "replace_camera_action",
		label: "replace_camera_action",
		description:
			'Atomically replace a Blender camera\'s action with a closed keyframe list. Use this when rebuilding cinematic camera work after an old action has mixed or residual keys: every location and rotation curve is created from this request, the old action is cleared, and the scene frame range expands to cover the requested first/last keyframe. `transition: "cut"` marks the following frame as a hard cut; smooth keys interpolate. This is a revision-bound mutation and does not replace the digest-authorized apply_camera_plan workflow for evidence-based camera planning.',
		parameters: Type.Object(
			{
				expected_revision_id: Type.String({ pattern: "^[0-9a-f]{64}$" }),
				camera_entity_id: Type.String({ pattern: UUID_V4_LOWERCASE }),
				action_name: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
				keyframes: Type.Array(
					Type.Object(
						{
							frame: Type.Integer(),
							location: Type.Tuple([Type.Number(), Type.Number(), Type.Number()]),
							look_at: Type.Tuple([Type.Number(), Type.Number(), Type.Number()]),
							transition: Type.Union([Type.Literal("smooth"), Type.Literal("cut")]),
						},
						{ additionalProperties: false },
					),
					{ minItems: 2, maxItems: 256 },
				),
			},
			{ additionalProperties: false },
		),
		execute: async (_toolCallId, params) => {
			const result = await bridge.replaceCameraAction(params);
			return {
				content: [{ type: "text" as const, text: JSON.stringify(result) }],
				details: result,
			};
		},
	});
}
