import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const UUID_V4_LOWERCASE = "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";

export interface InspectEntityAnimationOptions {
	readonly data_path_filter?: string;
	readonly frame_start?: number;
	readonly frame_end?: number;
}

export interface InspectEntityOptions extends InspectEntityAnimationOptions {
	readonly scope: "bones" | "animation" | "material" | "all";
}

export interface InspectEntityBridge {
	inspectEntity(entityId: string, options: InspectEntityOptions): Promise<Record<string, unknown>>;
}

export function createInspectEntityTool(bridge: InspectEntityBridge) {
	return defineTool({
		name: "inspect_entity",
		label: "inspect_entity",
		description:
			"Fetch full detail for one entity on demand. scope 'bones' returns the bone hierarchy and transforms for an armature; 'animation' returns f-curve summaries (per-curve source, dataPath, arrayIndex, keyframeCount, frame range, value range, interpolations) and includes the exact keyframes list per curve only while the whole response fits a keyframe budget; 'material' returns material slots and node inputs; 'all' returns everything. When scope animation/all exceeds the budget, the per-curve keyframes lists are dropped, the returned animationSummary.truncated names what was omitted, and you narrow with data_path_filter (a bone name or data-path substring, case-sensitive), frame_start, and frame_end. A narrowed selection is still subject to the same budgets: it returns exact keyframes only once the narrowed selection itself fits, so if animationSummary.truncated is still set, narrow further by channel or frame range. The serialized detail payload is hard-capped at 64 KiB (the animation section at 32 KiB) by deterministic truncation, so a wide call may omit rows; narrow with data_path_filter/frame_start/frame_end to fetch what was dropped. Use this after inspect_project when you need to edit a specific rigged character or animated object.",
		parameters: Type.Object(
			{
				entity_id: Type.String({ pattern: UUID_V4_LOWERCASE }),
				scope: Type.Union([
					Type.Literal("bones"),
					Type.Literal("animation"),
					Type.Literal("material"),
					Type.Literal("all"),
				]),
				data_path_filter: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
				frame_start: Type.Optional(Type.Integer({ minimum: -1000000, maximum: 1000000 })),
				frame_end: Type.Optional(Type.Integer({ minimum: -1000000, maximum: 1000000 })),
			},
			{ additionalProperties: false },
		),
		execute: async (_toolCallId, params) => {
			// Forward only the keys the model actually supplied: the add-on
			// rejects unknown params, and an explicit undefined would serialize
			// as a present key.
			const { entity_id: entityId, scope, data_path_filter, frame_start, frame_end } = params;
			// TypeBox validates each field independently but cannot express the
			// cross-field rule that frame_start <= frame_end when both are
			// present. Reject it before dispatch so the bridge is never called
			// for an inverted range (the bridge mirrors the same refusal).
			if (frame_start !== undefined && frame_end !== undefined && frame_start > frame_end) {
				throw new Error(
					`INVALID_INSPECT_ENTITY_REQUEST: frame_start (${frame_start}) must be <= frame_end (${frame_end})`,
				);
			}
			const options: InspectEntityOptions = {
				scope,
				...(data_path_filter !== undefined ? { data_path_filter } : {}),
				...(frame_start !== undefined ? { frame_start } : {}),
				...(frame_end !== undefined ? { frame_end } : {}),
			};
			const result = await bridge.inspectEntity(entityId, options);
			return {
				content: [{ type: "text" as const, text: JSON.stringify(result) }],
				details: result,
			};
		},
	});
}
