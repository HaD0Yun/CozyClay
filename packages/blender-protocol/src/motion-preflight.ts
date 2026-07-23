// Read-only preflight_motion bridge surface: analyze a generated ARDY motion
// archive BEFORE apply_motion bakes it. Reports root travel, height profile,
// lowest-extremity track, contact plateaus, and end-pose so the director can
// compare against measured scene relations (inspect_relations) and reject or
// realign mismatched motion instead of applying blindly. Generic joint math
// only — the lowest track is the per-frame min over ALL joints.
import { type Static, type TSchema, Type } from "typebox";
import { Parse } from "typebox/value";

const UUID_V4_LOWERCASE = "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
const HASH_64 = "^[0-9a-f]{64}$";
// Mirrors _MOTION_ID in blender-addon/oh_my_blender/stage_scene.py — the same
// slug apply_motion validates.
const MOTION_ID_PATTERN = "^[a-z0-9][a-z0-9-]{0,63}$";
const exact = <T extends Record<string, TSchema>>(properties: T) =>
	Type.Object(properties, { additionalProperties: false });
const uuid = () => Type.String({ pattern: UUID_V4_LOWERCASE });
const nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);

export const PreflightMotionParamsV1Schema = exact({
	motion_id: Type.String({ pattern: MOTION_ID_PATTERN }),
	entity_id: Type.Optional(uuid()),
});

const MotionPreflightTravelV1Schema = exact({
	vector_horizontal: Type.Tuple([Type.Number(), Type.Number()]),
	distance_horizontal: Type.Number(),
	height_start: Type.Number(),
	height_end: Type.Number(),
	height_min: Type.Number(),
	height_max: Type.Number(),
	height_change: Type.Number(),
});

const MotionPreflightLowestTrackV1Schema = exact({
	min: Type.Number(),
	max: Type.Number(),
	sample_stride: Type.Integer({ minimum: 1 }),
	samples: Type.Array(Type.Number(), { maxItems: 240 }),
});

const MotionPreflightContactWindowV1Schema = exact({
	start_frame: Type.Integer({ minimum: 0 }),
	end_frame: Type.Integer({ minimum: 0 }),
	height: Type.Number(),
});

const MotionPreflightEndPoseV1Schema = exact({
	root_height: Type.Number(),
	lowest_gap: Type.Number(),
	speed: Type.Number(),
	resting: Type.Boolean(),
});

export const MotionPreflightResultV1Schema = exact({
	revision: Type.String({ pattern: HASH_64 }),
	schema_version: Type.Literal(1),
	motion_id: Type.String({ pattern: MOTION_ID_PATTERN }),
	frames: Type.Integer({ minimum: 1 }),
	// fps bounds mirror FPS_BOUNDS in blender-addon/oh_my_blender/motion_retarget.py.
	fps: Type.Integer({ minimum: 1, maximum: 240 }),
	duration_seconds: Type.Number(),
	scale: nullable(Type.Number()),
	units: Type.Union([Type.Literal("meters"), Type.Literal("npz")]),
	travel: MotionPreflightTravelV1Schema,
	lowest_track: MotionPreflightLowestTrackV1Schema,
	contact_windows: Type.Array(MotionPreflightContactWindowV1Schema, { maxItems: 64 }),
	end_pose: MotionPreflightEndPoseV1Schema,
});

export type PreflightMotionParamsV1 = Static<typeof PreflightMotionParamsV1Schema>;
export type MotionPreflightTravelV1 = Static<typeof MotionPreflightTravelV1Schema>;
export type MotionPreflightLowestTrackV1 = Static<typeof MotionPreflightLowestTrackV1Schema>;
export type MotionPreflightContactWindowV1 = Static<typeof MotionPreflightContactWindowV1Schema>;
export type MotionPreflightEndPoseV1 = Static<typeof MotionPreflightEndPoseV1Schema>;
export type MotionPreflightResultV1 = Static<typeof MotionPreflightResultV1Schema>;

export const PREFLIGHT_MOTION_ERROR_CODES = [
	"INVALID_PREFLIGHT_MOTION_PARAMS",
	"ENTITY_NOT_FOUND",
	// Existing apply_motion loader errors pass through unchanged.
	"APPLY_MOTION_PROJECT_DIR_UNKNOWN",
	"APPLY_MOTION_NOT_FOUND",
	"APPLY_MOTION_TOO_LARGE",
	"APPLY_MOTION_MALFORMED",
] as const;
export type PreflightMotionErrorCode = (typeof PREFLIGHT_MOTION_ERROR_CODES)[number];

export function parsePreflightMotionParams(input: unknown): PreflightMotionParamsV1 {
	try {
		return Parse(PreflightMotionParamsV1Schema, input);
	} catch {
		throw new Error("INVALID_PREFLIGHT_MOTION_PARAMS: params must match the closed preflight_motion params schema");
	}
}

export function parseMotionPreflightResult(input: unknown): MotionPreflightResultV1 {
	try {
		return Parse(MotionPreflightResultV1Schema, input);
	} catch {
		throw new Error(
			"INVALID_PREFLIGHT_MOTION_RESULT: add-on result must match the closed motion preflight result schema",
		);
	}
}
