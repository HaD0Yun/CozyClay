import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { formatVector, renderFoldedResult, shortRevision } from "./folded-result.ts";

const UUID_V4_LOWERCASE = "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
const SUMMARY_ROW_LIMIT = 8;
const SUMMARY_PATTERN_LIMIT = 4;

function meters(value: unknown): string {
	return typeof value === "number" ? `${value}m` : String(value ?? "?");
}

/**
 * Fold an inspect_relations payload into the measurements a director actually
 * scans for: who the reference is, each entity's size/top/supports, and any
 * repetition pitch. Defensive by construction: an unexpected shape folds to
 * nothing instead of throwing inside a renderer.
 */
export function summarizeInspectRelations(payload: unknown): string[] {
	if (typeof payload !== "object" || payload === null) return [];
	const result = payload as Record<string, unknown>;
	const entities = Array.isArray(result.entities) ? (result.entities as readonly Record<string, unknown>[]) : [];
	const patterns = Array.isArray(result.patterns) ? (result.patterns as readonly Record<string, unknown>[]) : [];
	const reference = result.reference as Record<string, unknown> | null | undefined;
	if (!reference && !entities.length && !patterns.length) return [];

	const lines: string[] = [];
	lines.push(
		`${entities.length} entities${patterns.length ? `, ${patterns.length} patterns` : ""}  rev ${shortRevision(
			result.revision,
		)}`,
	);
	if (reference) {
		const character = reference.character as Record<string, unknown> | null | undefined;
		lines.push(
			`reference ${String(reference.name ?? "?")}  ${String(reference.type ?? "?")}${
				character?.standing_height !== undefined ? `  height ${meters(character.standing_height)}` : ""
			}${character?.bone_count !== undefined ? `  ${String(character.bone_count)} bones` : ""}`,
		);
	}
	for (const entity of entities.slice(0, SUMMARY_ROW_LIMIT)) {
		const relative = entity.relative as Record<string, unknown> | null | undefined;
		lines.push(
			`  ${String(entity.name ?? "?")}  ${String(entity.type ?? "?")}  size ${formatVector(entity.size)}  top ${meters(
				entity.top_height,
			)}  supports ${formatVector(entity.support_planes)}${
				relative?.horizontal_distance !== undefined ? `  rel ${meters(relative.horizontal_distance)}` : ""
			}`,
		);
	}
	const entityRest = entities.length - SUMMARY_ROW_LIMIT;
	if (entityRest > 0) lines.push(`  ... ${entityRest} more entities`);
	for (const pattern of patterns.slice(0, SUMMARY_PATTERN_LIMIT)) {
		lines.push(
			`  pattern x${String(pattern.count ?? "?")}  pitch ${formatVector(pattern.pitch)}  dev ${meters(
				pattern.max_deviation,
			)}`,
		);
	}
	const patternRest = patterns.length - SUMMARY_PATTERN_LIMIT;
	if (patternRest > 0) lines.push(`  ... ${patternRest} more patterns`);
	return lines;
}

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
		renderResult(result, options, theme, context) {
			return renderFoldedResult(result, options, theme, context, summarizeInspectRelations(result.details));
		},
	});
}
