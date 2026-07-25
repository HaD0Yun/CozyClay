// Read-only inspect_pose_contacts bridge surface: frame-specific deformed-sole
// vs declared-support-geometry measurement (CozyClay issue #2, item D). This
// exists because `LeftFoot`/`RightFoot` are skeleton joint centers, not sole
// contact points — the joint-to-sole offset is not constant (it changes with
// foot rotation), so a zero-residual joint constraint proves nothing about
// whether the deformed sole mesh actually touches a support surface.
// `surface_contact_verified` MUST be derived only from the deformed sole vs
// the declared support geometry; joint positions are evidence only, never the
// gate input. Coordinates are Blender world space, Z-up, meters. `frames` are
// SCENE frames, not clip/NPZ frames.
import { type Static, type TSchema, Type } from "typebox";
import { Parse } from "typebox/value";

const UUID_V4_LOWERCASE = "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
const HASH_64 = "^[0-9a-f]{64}$";
const exact = <T extends Record<string, TSchema>>(properties: T) =>
	Type.Object(properties, { additionalProperties: false });
const uuid = () => Type.String({ pattern: UUID_V4_LOWERCASE });
const nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
const vector3 = () => Type.Tuple([Type.Number(), Type.Number(), Type.Number()]);

export const InspectPoseContactsParamsV1Schema = exact({
	character_entity_id: uuid(),
	frames: Type.Array(Type.Integer({ minimum: 0 }), { minItems: 1, maxItems: 32, uniqueItems: true }),
	support_entity_ids: Type.Array(uuid(), { minItems: 1, maxItems: 16, uniqueItems: true }),
});

const PoseContactGateV1Schema = exact({
	max_gap_m: Type.Number(),
	min_edge_margin_m: Type.Number(),
});

// footprint_basis is a literal: the containment/edge-margin check is defined
// against an axis-aligned XY bounding-box footprint of the declared support,
// not an exact mesh silhouette. That basis must always be reported explicitly
// alongside the numbers it qualifies, never implied.
const PoseContactSupportFitV1Schema = exact({
	support_entity_id: uuid(),
	support_height_m: Type.Number(),
	support_gap_m: Type.Number(),
	inside_support_footprint: Type.Boolean(),
	edge_margin_m: Type.Number(),
	footprint_basis: Type.Literal("aabb_xy"),
	surface_contact_verified: Type.Boolean(),
});

// A side record's `foot_joint_position`/`toe_joint_position` are the raw
// skeleton joint centers (evidence only). `heel_point`/`toe_point`/
// `sole_point` are the deformed-mesh surface samples that actually decide
// contact; they -- and `sole_source` -- are null when the deformed surface
// could not be resolved, never a guessed constant offset from the joint.
// `contact_basis` is always the literal "deformed_mesh" when a side is
// present: this method never falls back to a joint-derived contact claim.
const PoseContactSideV1Schema = exact({
	foot_joint_position: vector3(),
	toe_joint_position: vector3(),
	heel_point: nullable(vector3()),
	toe_point: nullable(vector3()),
	sole_point: nullable(vector3()),
	sole_source: nullable(Type.String()),
	heel_to_toe_m: nullable(vector3()),
	joint_to_sole_offset_m: nullable(vector3()),
	contact_basis: Type.Literal("deformed_mesh"),
	support: nullable(PoseContactSupportFitV1Schema),
});

const PoseContactFrameV1Schema = exact({
	frame: Type.Integer(),
	sides: exact({
		left: nullable(PoseContactSideV1Schema),
		right: nullable(PoseContactSideV1Schema),
	}),
});

export const PoseContactsResultV1Schema = exact({
	revision: Type.String({ pattern: HASH_64 }),
	schema_version: Type.Literal(1),
	character_entity_id: uuid(),
	gate: PoseContactGateV1Schema,
	frames: Type.Array(PoseContactFrameV1Schema, { minItems: 1, maxItems: 32 }),
});

export type InspectPoseContactsParamsV1 = Static<typeof InspectPoseContactsParamsV1Schema>;
export type PoseContactGateV1 = Static<typeof PoseContactGateV1Schema>;
export type PoseContactSupportFitV1 = Static<typeof PoseContactSupportFitV1Schema>;
export type PoseContactSideV1 = Static<typeof PoseContactSideV1Schema>;
export type PoseContactFrameV1 = Static<typeof PoseContactFrameV1Schema>;
export type PoseContactsResultV1 = Static<typeof PoseContactsResultV1Schema>;

export const INSPECT_POSE_CONTACTS_ERROR_CODES = [
	"INVALID_INSPECT_POSE_CONTACTS_PARAMS",
	"ENTITY_NOT_FOUND",
	"NOT_AN_ARMATURE",
	// A requested SCENE frame (character or, transitively, any measured
	// sample) falls outside the live scene's frame_start..frame_end range.
	// frame_set silently clamps/holds on an out-of-range frame instead of
	// rejecting it, so this must be checked -- and reported -- explicitly
	// rather than ever letting a clamped frame's geometry pass as measured.
	"SCENE_FRAME_OUT_OF_RANGE",
	// Measured geometry produced a NaN/inf numeric (degenerate transforms).
	"NON_FINITE_GEOMETRY",
] as const;
export type InspectPoseContactsErrorCode = (typeof INSPECT_POSE_CONTACTS_ERROR_CODES)[number];

export function parseInspectPoseContactsParams(input: unknown): InspectPoseContactsParamsV1 {
	try {
		return Parse(InspectPoseContactsParamsV1Schema, input);
	} catch {
		throw new Error(
			"INVALID_INSPECT_POSE_CONTACTS_PARAMS: params must match the closed inspect_pose_contacts params schema",
		);
	}
}

export function parsePoseContactsResult(input: unknown): PoseContactsResultV1 {
	try {
		return Parse(PoseContactsResultV1Schema, input);
	} catch {
		throw new Error(
			"INVALID_INSPECT_POSE_CONTACTS_RESULT: add-on result must match the closed pose contacts result schema",
		);
	}
}
