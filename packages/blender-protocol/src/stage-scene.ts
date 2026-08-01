import { type Static, type TSchema, Type } from "typebox";
import { Parse } from "typebox/value";
import { SceneManifestV4Schema } from "./manifest.ts";

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
const stableName = () => Type.String({ minLength: 1, maxLength: 256 });
const characterType = () => Type.Union([Type.Literal("Y_BOT"), Type.Literal("X_BOT")]);

const AddCharacterSchema = exact({
	op: Type.Literal("add_character"),
	entity_id: uuid(),
	character_type: characterType(),
	name: stableName(),
	location: vector3(),
	rotation: vector3(),
	scale: positiveVector3(),
});
const AddCharacterRequestSchema = exact({
	op: Type.Literal("add_character"),
	character_type: characterType(),
	name: stableName(),
	location: vector3(),
	rotation: vector3(),
	scale: positiveVector3(),
});
const AdoptEntitySchema = exact({
	op: Type.Literal("adopt_entity"),
	entity_id: uuid(),
});
const SetRenderSettingsSchema = exact({
	op: Type.Literal("set_render_settings"),
	resolution_x: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535 })),
	resolution_y: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535 })),
	resolution_percentage: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
	fps: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
	frame_start: Type.Optional(Type.Integer({ minimum: -100000, maximum: 100000 })),
	frame_end: Type.Optional(Type.Integer({ minimum: -100000, maximum: 100000 })),
});

export const HAND_SHAPE_NAMES = [
	"relaxed",
	"open",
	"fist",
	"soft_fist",
	"point",
	"two_finger",
	"cup",
	"grasp",
	"thumb_extended",
	"three_finger",
	"hook",
] as const;
const handShape = () =>
	Type.Union([
		Type.Literal("relaxed"),
		Type.Literal("open"),
		Type.Literal("fist"),
		Type.Literal("soft_fist"),
		Type.Literal("point"),
		Type.Literal("two_finger"),
		Type.Literal("cup"),
		Type.Literal("grasp"),
		Type.Literal("thumb_extended"),
		Type.Literal("three_finger"),
		Type.Literal("hook"),
	]);
const applyMotionFields = {
	op: Type.Literal("apply_motion"),
	entity_id: uuid(),
	motion_id: Type.String({ pattern: "^[a-z0-9][a-z0-9-]{0,63}$" }),
	start_frame: Type.Optional(Type.Integer({ minimum: -100000, maximum: 100000 })),
};
const HandTrackKeySchema = exact({
	frame: Type.Integer({ minimum: 0, maximum: 100000 }),
	preset: handShape(),
});
const handTrack = () => Type.Array(HandTrackKeySchema, { minItems: 1, maxItems: 32 });
const ApplyMotionSchema = Type.Union([
	exact(applyMotionFields),
	exact({
		...applyMotionFields,
		hand_pose: Type.Union([Type.Literal("relaxed"), Type.Literal("open")]),
	}),
	exact({
		...applyMotionFields,
		hand_shapes: exact({ left: handShape() }),
	}),
	exact({
		...applyMotionFields,
		hand_shapes: exact({ right: handShape() }),
	}),
	exact({
		...applyMotionFields,
		hand_shapes: exact({ left: handShape(), right: handShape() }),
	}),
	exact({
		...applyMotionFields,
		hand_track: exact({ left: handTrack() }),
	}),
	exact({
		...applyMotionFields,
		hand_track: exact({ right: handTrack() }),
	}),
	exact({
		...applyMotionFields,
		hand_track: exact({ left: handTrack(), right: handTrack() }),
	}),
]);

export const StageSceneOperationV1Schema = Type.Union([
	AddCharacterSchema,
	AdoptEntitySchema,
	SetRenderSettingsSchema,
	ApplyMotionSchema,
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
		Type.Union([AddCharacterRequestSchema, AdoptEntitySchema, SetRenderSettingsSchema, ApplyMotionSchema]),
		{ minItems: 1, maxItems: 256 },
	),
});
export const StageSceneEntityIdentitySchema = exact({
	entity_id: uuid(),
	requested_name: stableName(),
	actual_name: stableName(),
});
export const StageSceneAppliedHandShapeSchema = exact({
	operation_index: Type.Integer({ minimum: 0, maximum: 255 }),
	entity_id: uuid(),
	motion_id: Type.String({ pattern: "^[a-z0-9][a-z0-9-]{0,63}$" }),
	left: handShape(),
	right: handShape(),
	library_version: Type.Literal("1.1.0"),
	track: Type.Optional(
		exact({
			left: Type.Optional(handTrack()),
			right: Type.Optional(handTrack()),
		}),
	),
});
export const StageSceneMutationCandidateSchema = exact({
	expected_revision_id: Type.String({ pattern: HASH_64 }),
	scene_hash: Type.String({ pattern: HASH_64 }),
	manifest: SceneManifestV4Schema,
	entity_identities: Type.Array(StageSceneEntityIdentitySchema, { maxItems: 256 }),
	applied_hand_shapes: Type.Array(StageSceneAppliedHandShapeSchema, { maxItems: 256 }),
});

export type StageSceneOperationV1 = Static<typeof StageSceneOperationV1Schema>;
export type StageScenePlanV1 = Static<typeof StageScenePlanV1Schema>;
export type StageSceneRequestV1 = Static<typeof StageSceneRequestV1Schema>;
export type StageSceneEntityIdentity = Static<typeof StageSceneEntityIdentitySchema>;
export type StageSceneAppliedHandShape = Static<typeof StageSceneAppliedHandShapeSchema>;
export type StageSceneMutationCandidate = Static<typeof StageSceneMutationCandidateSchema>;

export const STAGE_SCENE_ERROR_CODES = [
	"INVALID_STAGE_SCENE_REQUEST_SCHEMA",
	"INVALID_STAGE_SCENE_PLAN_SCHEMA",
	"STAGE_SCENE_ENTITY_ID_DUPLICATE",
	"STAGE_SCENE_STABLE_NAME_DUPLICATE",
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
		if (operation.op !== "add_character") continue;
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
	const operations: StageSceneOperationV1[] = request.operations.map((operation) =>
		operation.op === "add_character" ? { ...operation, entity_id: allocateEntityId() } : operation,
	);
	return parseStageScenePlan({ ...request, operations });
}
