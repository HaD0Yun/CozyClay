import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const UUID_V4_LOWERCASE = "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";

export interface InspectEntityBridge {
	inspectEntity(entityId: string, scope: "bones" | "animation" | "material" | "all"): Promise<Record<string, unknown>>;
}

export function createInspectEntityTool(bridge: InspectEntityBridge) {
	return defineTool({
		name: "inspect_entity",
		label: "inspect_entity",
		description:
			"Fetch full detail for one entity on demand. scope 'bones' returns the bone hierarchy and transforms for an armature; 'animation' returns fcurves/keyframes for the entity; 'material' returns material slots and node inputs; 'all' returns everything. Use this after inspect_project when you need to edit a specific rigged character or animated object.",
		parameters: Type.Object({
			entity_id: Type.String({ pattern: UUID_V4_LOWERCASE }),
			scope: Type.Union([
				Type.Literal("bones"),
				Type.Literal("animation"),
				Type.Literal("material"),
				Type.Literal("all"),
			]),
		}),
		execute: async (_toolCallId, params) => {
			const result = await bridge.inspectEntity(params.entity_id, params.scope);
			return {
				content: [{ type: "text" as const, text: JSON.stringify(result) }],
				details: result,
			};
		},
	});
}
