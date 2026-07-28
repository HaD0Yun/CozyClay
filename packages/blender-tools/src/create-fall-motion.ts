import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export interface CreateFallMotionBridge {
	createFallMotion(params: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export function createFallMotionTool(bridge: CreateFallMotionBridge) {
	return defineTool({
		name: "create_fall_motion",
		label: "create_fall_motion",
		description:
			"Create a deterministic gravity-bound character fall action directly in Blender. Use this instead of hand-assembled fall poses when the user wants a realistic fall from a known height: the add-on derives the impact frame from sqrt(2*h/g), replaces the old character action so stale keys cannot leak, and reports expected/actual fall seconds plus the physics timing error. This is a revision-bound mutation; it does not update the project manifest or generate ARDY motion. The returned action must then be verified with capture/read_image and the scene must be saved by the owning workflow.",
		parameters: Type.Object(
			{
				expected_revision_id: Type.String({ pattern: "^[0-9a-f]{64}$" }),
				character_entity_id: Type.String({
					pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
				}),
				start_frame: Type.Integer({ minimum: 0, maximum: 100000 }),
				drop_height_m: Type.Number({ minimum: 0.5 }),
				fps: Type.Integer({ minimum: 1, maximum: 120 }),
				direction_xy: Type.Optional(Type.Array(Type.Number(), { minItems: 2, maxItems: 2 })),
				end_frame: Type.Optional(Type.Integer({ minimum: 0, maximum: 100000 })),
				gravity_mps2: Type.Optional(Type.Number({ minimum: 0.1 })),
			},
			{ additionalProperties: false },
		),
		execute: async (_toolCallId, params) => {
			const result = await bridge.createFallMotion(params);
			return {
				content: [{ type: "text" as const, text: JSON.stringify(result) }],
				details: result,
			};
		},
	});
}
