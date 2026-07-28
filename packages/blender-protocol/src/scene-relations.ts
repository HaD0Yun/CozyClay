// Read-only inspect_relations bridge surface: measured world-space geometry
// relations (AABBs, top surfaces, sibling repetition patterns, offsets from a
// reference entity) so a director can plan motion prompts from real scene
// dimensions instead of guesses. Action-agnostic by design: pure geometry only.
import { type Static, type TSchema, Type } from "typebox";
import { Parse } from "typebox/value";

const UUID_V4_LOWERCASE = "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
const HASH_64 = "^[0-9a-f]{64}$";
const exact = <T extends Record<string, TSchema>>(properties: T) =>
	Type.Object(properties, { additionalProperties: false });
const uuid = () => Type.String({ pattern: UUID_V4_LOWERCASE });
const nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
const vector2 = () => Type.Tuple([Type.Number(), Type.Number()]);
const vector3 = () => Type.Tuple([Type.Number(), Type.Number(), Type.Number()]);

export const InspectRelationsParamsV1Schema = exact({
	entity_ids: Type.Optional(Type.Array(uuid(), { minItems: 1, maxItems: 64, uniqueItems: true })),
	reference_entity_id: Type.Optional(uuid()),
});

const SceneRelationsRestHeightsV1Schema = exact({
	lowest: Type.Number(),
	pelvis: nullable(Type.Number()),
	hand: nullable(Type.Number()),
	head: nullable(Type.Number()),
});

const SceneRelationsCharacterV1Schema = exact({
	world_scale: vector3(),
	standing_height: Type.Number(),
	bone_count: Type.Integer({ minimum: 0 }),
	rest_heights: SceneRelationsRestHeightsV1Schema,
});

const SceneRelationsReferenceV1Schema = exact({
	entity_id: uuid(),
	name: Type.String(),
	type: Type.String(),
	origin: vector3(),
	aabb_min: vector3(),
	aabb_max: vector3(),
	character: nullable(SceneRelationsCharacterV1Schema),
});

const SceneRelationsRelativeV1Schema = exact({
	offset: vector3(),
	horizontal_distance: Type.Number(),
	direction: nullable(vector2()),
	top_above_reference_base: Type.Number(),
});

const SceneRelationsEntityV1Schema = exact({
	entity_id: uuid(),
	name: Type.String(),
	type: Type.String(),
	aabb_min: vector3(),
	aabb_max: vector3(),
	size: vector3(),
	top_height: Type.Number(),
	support_planes: Type.Array(Type.Number(), { maxItems: 8 }),
	footprint: vector2(),
	relative: nullable(SceneRelationsRelativeV1Schema),
});

const SceneRelationsPatternV1Schema = exact({
	entity_ids: Type.Array(uuid(), { minItems: 3 }),
	count: Type.Integer({ minimum: 3 }),
	pitch: vector3(),
	max_deviation: Type.Number(),
	footprint: vector2(),
});

export const SceneRelationsResultV1Schema = exact({
	revision: Type.String({ pattern: HASH_64 }),
	schema_version: Type.Literal(1),
	reference: nullable(SceneRelationsReferenceV1Schema),
	entities: Type.Array(SceneRelationsEntityV1Schema),
	patterns: Type.Array(SceneRelationsPatternV1Schema),
});

export type InspectRelationsParamsV1 = Static<typeof InspectRelationsParamsV1Schema>;
export type SceneRelationsReferenceV1 = Static<typeof SceneRelationsReferenceV1Schema>;
export type SceneRelationsEntityV1 = Static<typeof SceneRelationsEntityV1Schema>;
export type SceneRelationsPatternV1 = Static<typeof SceneRelationsPatternV1Schema>;
export type SceneRelationsResultV1 = Static<typeof SceneRelationsResultV1Schema>;

export const INSPECT_RELATIONS_ERROR_CODES = [
	"INVALID_INSPECT_RELATIONS_PARAMS",
	"ENTITY_NOT_FOUND",
	// Measured geometry produced a NaN/inf numeric (degenerate transforms).
	"NON_FINITE_GEOMETRY",
] as const;
export type InspectRelationsErrorCode = (typeof INSPECT_RELATIONS_ERROR_CODES)[number];

export function parseInspectRelationsParams(input: unknown): InspectRelationsParamsV1 {
	try {
		return Parse(InspectRelationsParamsV1Schema, input);
	} catch {
		throw new Error("INVALID_INSPECT_RELATIONS_PARAMS: params must match the closed inspect_relations params schema");
	}
}

export function parseSceneRelationsResult(input: unknown): SceneRelationsResultV1 {
	try {
		return Parse(SceneRelationsResultV1Schema, input);
	} catch {
		throw new Error(
			"INVALID_INSPECT_RELATIONS_RESULT: add-on result must match the closed scene relations result schema",
		);
	}
}
