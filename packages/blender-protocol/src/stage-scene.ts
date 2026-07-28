import { type Static, type TSchema, Type } from "typebox";
import { Parse } from "typebox/value";
import { primitiveTypeSchema, SceneManifestV3OrV4Schema } from "./manifest.ts";

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
const characterType = () => Type.Union([Type.Literal("Y_BOT"), Type.Literal("X_BOT")]);

const collectionNameField = () => Type.Optional(stableName());
const AddPrimitiveSchema = exact({
	op: Type.Literal("add_primitive"),
	entity_id: uuid(),
	primitive_type: primitiveTypeSchema(),
	name: stableName(),
	location: vector3(),
	rotation: vector3(),
	scale: positiveVector3(),
	parent_id: Type.Optional(uuid()),
	collection_name: collectionNameField(),
});
const AddPrimitiveRequestSchema = exact({
	op: Type.Literal("add_primitive"),
	primitive_type: primitiveTypeSchema(),
	name: stableName(),
	location: vector3(),
	rotation: vector3(),
	scale: positiveVector3(),
	parent_id: Type.Optional(uuid()),
	collection_name: collectionNameField(),
});
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
const AddCameraSchema = exact({
	op: Type.Literal("add_camera"),
	entity_id: uuid(),
	name: stableName(),
	location: vector3(),
	rotation: vector3(),
	lens: Type.Optional(Type.Number({ exclusiveMinimum: 0, exclusiveMaximum: 1e15 })),
});
const AddCameraRequestSchema = exact({
	op: Type.Literal("add_camera"),
	name: stableName(),
	location: vector3(),
	rotation: vector3(),
	lens: Type.Optional(Type.Number({ exclusiveMinimum: 0, exclusiveMaximum: 1e15 })),
});
// roughness and metallic are optional so a plan that omits them stays
// byte-identical on the wire and in the manifest hash. Absent means the Principled
// defaults the add-on already produced: roughness 0.5, metallic 0.0. Without them
// every surface in a scene was the same mid-roughness dielectric -- a metal
// handrail, matte concrete and a polished floor were indistinguishable no matter
// what colour they were given.
// Written out per schema rather than spread from a helper: the addon/protocol
// key-surface parity test reads these literals, and a spread hides them.
const SetMaterialColorSchema = exact({
	op: Type.Literal("set_material_color"),
	entity_id: uuid(),
	color: rgba(),
	roughness: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
	metallic: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
});
const SetMaterialColorByNameRequestSchema = exact({
	op: Type.Literal("set_material_color"),
	object_name: stableName(),
	color: rgba(),
	roughness: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
	metallic: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
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
	collection_name: collectionNameField(),
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
	collection_name: collectionNameField(),
});
const DeleteEntitySchema = exact({
	op: Type.Literal("delete_entity"),
	entity_id: uuid(),
});
const AdoptEntitySchema = exact({
	op: Type.Literal("adopt_entity"),
	entity_id: uuid(),
});
const CreateAssemblySchema = exact({
	op: Type.Literal("create_assembly"),
	name: stableName(),
});
const SetParentSchema = exact({
	op: Type.Literal("set_parent"),
	entity_id: uuid(),
	parent_id: Type.Union([uuid(), Type.Null()]),
});
const TransformAssemblySchema = Type.Object(
	{
		op: Type.Literal("transform_assembly"),
		assembly_id: uuid(),
		translation: Type.Optional(vector3()),
		rotation_euler: Type.Optional(vector3()),
		scale: Type.Optional(positiveVector3()),
	},
	{ additionalProperties: false, minProperties: 3 },
);
const TransformEntitySchema = Type.Object(
	{
		op: Type.Literal("transform_entity"),
		entity_id: uuid(),
		location: Type.Optional(vector3()),
		rotation_euler: Type.Optional(vector3()),
		scale: Type.Optional(positiveVector3()),
	},
	{ additionalProperties: false, minProperties: 3 },
);
const SetLightPropertySchema = Type.Object(
	{
		op: Type.Literal("set_light_property"),
		entity_id: uuid(),
		energy: Type.Optional(Type.Number({ minimum: 0, exclusiveMaximum: 1e15 })),
		color: Type.Optional(rgb()),
		size: Type.Optional(Type.Number({ exclusiveMinimum: 0, exclusiveMaximum: 1e15 })),
	},
	{ additionalProperties: false, minProperties: 3 },
);
const SetCameraPropertySchema = Type.Object(
	{
		op: Type.Literal("set_camera_property"),
		entity_id: uuid(),
		lens: Type.Optional(Type.Number({ exclusiveMinimum: 0, exclusiveMaximum: 1e15 })),
		clip_start: Type.Optional(Type.Number({ exclusiveMinimum: 0, exclusiveMaximum: 1e15 })),
		clip_end: Type.Optional(Type.Number({ exclusiveMinimum: 0, exclusiveMaximum: 1e15 })),
		sensor_width: Type.Optional(Type.Number({ exclusiveMinimum: 0, exclusiveMaximum: 1e15 })),
		sensor_height: Type.Optional(Type.Number({ exclusiveMinimum: 0, exclusiveMaximum: 1e15 })),
		sensor_fit: Type.Optional(
			Type.Union([
				Type.Literal("AUTO"),
				Type.Literal("HORIZONTAL"),
				Type.Literal("VERTICAL"),
				Type.Literal("SQUARE"),
			]),
		),
	},
	{ additionalProperties: false, minProperties: 3 },
);
const SetRenderSettingsSchema = exact({
	op: Type.Literal("set_render_settings"),
	resolution_x: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535 })),
	resolution_y: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535 })),
	resolution_percentage: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
	fps: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
	frame_start: Type.Optional(Type.Integer({ minimum: -100000, maximum: 100000 })),
	frame_end: Type.Optional(Type.Integer({ minimum: -100000, maximum: 100000 })),
});
const RenameEntitySchema = exact({
	op: Type.Literal("rename_entity"),
	entity_id: uuid(),
	name: stableName(),
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
/**
 * One preset key on a hand track. `frame` is a 0-based CLIP frame — the same
 * space as preflight_motion contact windows and the ARDY constraint targets, so
 * a contact never has to be converted into scene frames twice.
 */
const HandTrackKeySchema = exact({
	frame: Type.Integer({ minimum: 0, maximum: 100000 }),
	preset: handShape(),
});
// Mirrors MAX_HAND_TRACK_KEYS in blender-addon/cclay/hand_shapes.py.
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
	AddPrimitiveSchema,
	AddCharacterSchema,
	AddCameraSchema,
	SetMaterialColorSchema,
	UpsertAreaLightSchema,
	DeleteEntitySchema,
	AdoptEntitySchema,
	CreateAssemblySchema,
	SetParentSchema,
	TransformAssemblySchema,
	TransformEntitySchema,
	SetLightPropertySchema,
	SetCameraPropertySchema,
	SetRenderSettingsSchema,
	RenameEntitySchema,
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
		Type.Union([
			AddPrimitiveRequestSchema,
			AddCharacterRequestSchema,
			AddCameraRequestSchema,
			SetMaterialColorSchema,
			SetMaterialColorByNameRequestSchema,
			UpsertAreaLightRequestSchema,
			DeleteEntitySchema,
			AdoptEntitySchema,
			CreateAssemblySchema,
			SetParentSchema,
			TransformAssemblySchema,
			TransformEntitySchema,
			SetLightPropertySchema,
			SetCameraPropertySchema,
			SetRenderSettingsSchema,
			RenameEntitySchema,
			ApplyMotionSchema,
		]),
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
	/**
	 * Present only when the request carried a hand_track. `left`/`right` above
	 * report the RESTING shape (the track's last key), so QA needs the keys
	 * themselves to verify a side that changes shape mid-clip.
	 */
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
	manifest: SceneManifestV3OrV4Schema,
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
	"STAGE_SCENE_NAME_REFERENCE_UNKNOWN",
	"STAGE_SCENE_SHARED_DATABLOCK",
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
		if (operation.op === "set_parent" && operation.entity_id === operation.parent_id) {
			fail(
				"INVALID_STAGE_SCENE_PLAN_SCHEMA",
				`set_parent entity_id ${operation.entity_id} must differ from parent_id`,
			);
		}
		if (
			operation.op === "add_primitive" &&
			operation.parent_id !== undefined &&
			operation.entity_id === operation.parent_id
		) {
			fail(
				"INVALID_STAGE_SCENE_PLAN_SCHEMA",
				`add_primitive entity_id ${operation.entity_id} must differ from parent_id`,
			);
		}
		if (
			operation.op !== "add_primitive" &&
			operation.op !== "upsert_area_light" &&
			operation.op !== "add_character" &&
			operation.op !== "add_camera"
		)
			continue;
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
		if (operation.op === "add_character") {
			const entityId = allocateEntityId();
			idsByStableName.set(operation.name, entityId);
			return { ...operation, entity_id: entityId };
		}
		if (operation.op === "add_camera") {
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
			const { object_name: _objectName, ...rest } = operation;
			return { ...rest, entity_id: entityId };
		}
		return operation as StageSceneOperationV1;
	});
	return parseStageScenePlan({ ...request, operations });
}
