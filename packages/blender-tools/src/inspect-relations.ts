import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const UUID_V4_LOWERCASE = "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";

export interface InspectRelationsBridge {
	inspectRelations(params: {
		entity_ids?: readonly string[];
		reference_entity_id?: string;
	}): Promise<Record<string, unknown>>;
}

export function createInspectRelationsTool(bridge: InspectRelationsBridge) {
	return defineTool({
		name: "inspect_relations",
		label: "inspect_relations",
		description:
			"Measure world-space geometry relations between scene entities: axis-aligned bounding boxes, sizes, top-surface heights (support planes), sibling repetition pitch, and offsets/direction/horizontal distance from a reference entity. Use this BEFORE generating character motion or placing objects, so prompts and placements use measured dimensions instead of guessed ones. Pass the character armature as reference_entity_id to also get its standing height and rest-pose bone heights. Omit entity_ids to survey all visible top-level meshes; the default survey lists parentless meshes only, so parented-layout props require explicit entity_ids. Modifier-generated geometry (e.g. an Array modifier) is measured from the base mesh only, not the generated copies. Entity ids pair with the ids returned by inspect_project.",
		parameters: Type.Object(
			{
				entity_ids: Type.Optional(
					Type.Array(Type.String({ pattern: UUID_V4_LOWERCASE }), {
						minItems: 1,
						maxItems: 64,
						uniqueItems: true,
					}),
				),
				reference_entity_id: Type.Optional(Type.String({ pattern: UUID_V4_LOWERCASE })),
			},
			{ additionalProperties: false },
		),
		execute: async (_toolCallId, params) => {
			const result = await bridge.inspectRelations(params);
			return {
				content: [{ type: "text" as const, text: JSON.stringify(result) }],
				details: result,
			};
		},
	});
}
