import { type Static, type TSchema, Type } from "typebox";
import { Parse } from "typebox/value";
import { SceneManifestV3Schema } from "./manifest.ts";

const UUID_V4_LOWERCASE = "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
const HASH_64 = "^[0-9a-f]{64}$";
const exact = <T extends Record<string, TSchema>>(properties: T) =>
	Type.Object(properties, { additionalProperties: false });
const uuid = () => Type.String({ pattern: UUID_V4_LOWERCASE });
const finiteNumber = () => Type.Number({ exclusiveMinimum: -1e15, exclusiveMaximum: 1e15 });
const vector3 = () => Type.Tuple([finiteNumber(), finiteNumber(), finiteNumber()]);
const positiveVector3 = () =>
	Type.Tuple([
		Type.Number({ exclusiveMinimum: 0, exclusiveMaximum: 1e15 }),
		Type.Number({ exclusiveMinimum: 0, exclusiveMaximum: 1e15 }),
		Type.Number({ exclusiveMinimum: 0, exclusiveMaximum: 1e15 }),
	]);
const rgb = () =>
	Type.Tuple([
		Type.Number({ minimum: 0, maximum: 1 }),
		Type.Number({ minimum: 0, maximum: 1 }),
		Type.Number({ minimum: 0, maximum: 1 }),
	]);
const rgba = () =>
	Type.Tuple([
		Type.Number({ minimum: 0, maximum: 1 }),
		Type.Number({ minimum: 0, maximum: 1 }),
		Type.Number({ minimum: 0, maximum: 1 }),
		Type.Number({ minimum: 0, maximum: 1 }),
	]);
const stableName = () => Type.String({ minLength: 1, maxLength: 256 });
const primitiveType = () => Type.Union([Type.Literal("PLANE"), Type.Literal("CUBE"), Type.Literal("UV_SPHERE")]);

const AddPrimitiveSchema = exact({
	op: Type.Literal("add_primitive"),
	entity_id: uuid(),
	primitive_type: primitiveType(),
	name: stableName(),
	location: vector3(),
	rotation: vector3(),
	scale: positiveVector3(),
});
const AddPrimitiveRequestSchema = exact({
	op: Type.Literal("add_primitive"),
	primitive_type: primitiveType(),
	name: stableName(),
	location: vector3(),
	rotation: vector3(),
	scale: positiveVector3(),
});
const SetMaterialColorSchema = exact({
	op: Type.Literal("set_material_color"),
	entity_id: uuid(),
	color: rgba(),
});
const SetMaterialColorByNameRequestSchema = exact({
	op: Type.Literal("set_material_color"),
	object_name: stableName(),
	color: rgba(),
});
const UpsertAreaLightSchema = exact({
	op: Type.Literal("upsert_area_light"),
	entity_id: uuid(),
	name: stableName(),
	location: vector3(),
	rotation: vector3(),
	scale: positiveVector3(),
	energy: Type.Number({ minimum: 0, exclusiveMaximum: 1e15 }),
	color: rgb(),
	size: Type.Number({ exclusiveMinimum: 0, exclusiveMaximum: 1e15 }),
});
const UpsertAreaLightRequestSchema = exact({
	op: Type.Literal("upsert_area_light"),
	entity_id: Type.Optional(uuid()),
	name: stableName(),
	location: vector3(),
	rotation: vector3(),
	scale: positiveVector3(),
	energy: Type.Number({ minimum: 0, exclusiveMaximum: 1e15 }),
	color: rgb(),
	size: Type.Number({ exclusiveMinimum: 0, exclusiveMaximum: 1e15 }),
});
const DeleteEntitySchema = exact({
	op: Type.Literal("delete_entity"),
	entity_id: uuid(),
});

export const StageSceneOperationV1Schema = Type.Union([
	AddPrimitiveSchema,
	SetMaterialColorSchema,
	UpsertAreaLightSchema,
	DeleteEntitySchema,
]);
export const StageScenePlanV1Schema = exact({
	schema_version: Type.Literal(1),
	expected_revision_id: Type.String({ pattern: HASH_64 }),
	operations: Type.Array(StageSceneOperationV1Schema, { minItems: 1, maxItems: 256 }),
});
export const StageSceneRequestV1Schema = exact({
	schema_version: Type.Literal(1),
	expected_revision_id: Type.String({ pattern: HASH_64 }),
	operations: Type.Array(
		Type.Union([
			AddPrimitiveRequestSchema,
			SetMaterialColorSchema,
			SetMaterialColorByNameRequestSchema,
			UpsertAreaLightRequestSchema,
			DeleteEntitySchema,
		]),
		{ minItems: 1, maxItems: 256 },
	),
});
export const StageSceneMutationCandidateSchema = exact({
	expected_revision_id: Type.String({ pattern: HASH_64 }),
	scene_hash: Type.String({ pattern: HASH_64 }),
	manifest: SceneManifestV3Schema,
});

export type StageSceneOperationV1 = Static<typeof StageSceneOperationV1Schema>;
export type StageScenePlanV1 = Static<typeof StageScenePlanV1Schema>;
export type StageSceneRequestV1 = Static<typeof StageSceneRequestV1Schema>;
export type StageSceneMutationCandidate = Static<typeof StageSceneMutationCandidateSchema>;

export const STAGE_SCENE_ERROR_CODES = [
	"INVALID_STAGE_SCENE_REQUEST_SCHEMA",
	"INVALID_STAGE_SCENE_PLAN_SCHEMA",
	"STAGE_SCENE_ENTITY_ID_DUPLICATE",
	"STAGE_SCENE_STABLE_NAME_DUPLICATE",
	"STAGE_SCENE_NAME_REFERENCE_UNKNOWN",
] as const;
export type StageSceneErrorCode = (typeof STAGE_SCENE_ERROR_CODES)[number];

export class StageSceneValidationError extends Error {
	readonly code: StageSceneErrorCode;

	constructor(code: StageSceneErrorCode, message: string) {
		super(`${code}: ${message}`);
		this.name = "StageSceneValidationError";
		this.code = code;
	}
}

const fail = (code: StageSceneErrorCode, message: string): never => {
	throw new StageSceneValidationError(code, message);
};

function validatePlanSemantics(plan: StageScenePlanV1): StageScenePlanV1 {
	const createdIds = new Set<string>();
	const stableNames = new Set<string>();
	for (const operation of plan.operations) {
		if (operation.op !== "add_primitive" && operation.op !== "upsert_area_light") continue;
		if (createdIds.has(operation.entity_id)) {
			fail("STAGE_SCENE_ENTITY_ID_DUPLICATE", `entity_id ${operation.entity_id} is created more than once`);
		}
		createdIds.add(operation.entity_id);
		const normalizedName = operation.name.normalize("NFC");
		if (normalizedName !== operation.name) {
			fail("INVALID_STAGE_SCENE_PLAN_SCHEMA", "stable names must be NFC-normalized");
		}
		if (stableNames.has(operation.name)) {
			fail("STAGE_SCENE_STABLE_NAME_DUPLICATE", `stable name ${JSON.stringify(operation.name)} is repeated`);
		}
		stableNames.add(operation.name);
	}
	return plan;
}

export function parseStageScenePlan(input: unknown): StageScenePlanV1 {
	let plan: StageScenePlanV1;
	try {
		plan = Parse(StageScenePlanV1Schema, input);
	} catch {
		return fail("INVALID_STAGE_SCENE_PLAN_SCHEMA", "plan must match the closed StageScenePlanV1 schema");
	}
	return validatePlanSemantics(plan);
}
export function parseStageSceneMutationCandidate(input: unknown): StageSceneMutationCandidate {
	try {
		return Parse(StageSceneMutationCandidateSchema, input);
	} catch {
		throw new Error("INVALID_MUTATION_RESULT: add-on result must match the closed stage mutation candidate schema");
	}
}

export function canonicalizeStageScenePlan(input: unknown, allocateEntityId: () => string): StageScenePlanV1 {
	let request: StageSceneRequestV1;
	try {
		request = Parse(StageSceneRequestV1Schema, input);
	} catch {
		return fail("INVALID_STAGE_SCENE_REQUEST_SCHEMA", "request must match the closed StageSceneRequestV1 schema");
	}
	const idsByStableName = new Map<string, string>();
	const allocatedOperations = request.operations.map((operation) => {
		if (operation.op === "add_primitive") {
			const entityId = allocateEntityId();
			idsByStableName.set(operation.name, entityId);
			return { ...operation, entity_id: entityId };
		}
		if (operation.op === "upsert_area_light") {
			const entityId = operation.entity_id ?? allocateEntityId();
			idsByStableName.set(operation.name, entityId);
			return { ...operation, entity_id: entityId };
		}
		return operation;
	});
	const operations: StageSceneOperationV1[] = allocatedOperations.map((operation) => {
		if (operation.op === "set_material_color" && "object_name" in operation) {
			const entityId = idsByStableName.get(operation.object_name);
			if (entityId === undefined) {
				return fail(
					"STAGE_SCENE_NAME_REFERENCE_UNKNOWN",
					`set_material_color references unknown staged object ${JSON.stringify(operation.object_name)}`,
				);
			}
			return { op: operation.op, entity_id: entityId, color: operation.color };
		}
		return operation as StageSceneOperationV1;
	});
	return parseStageScenePlan({ ...request, operations });
}
