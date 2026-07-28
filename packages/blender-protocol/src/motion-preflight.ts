// Read-only preflight_motion bridge surface: analyze a generated ARDY motion
// archive BEFORE apply_motion bakes it. Reports root travel, height profile,
// lowest-extremity track, contact plateaus, and end-pose so the director can
// compare against measured scene relations (inspect_relations) and reject or
// realign mismatched motion instead of applying blindly. Generic joint math
// only — the lowest track is the per-frame min over ALL joints.
//
// Semantics note (CozyClay issue #2): every height in this contract —
// travel.*, lowest_track.*, contact_windows[].height, and
// foot_contacts[].height / .height_max — is a skeleton joint-center position
// (LeftFoot/RightFoot/LeftToeBase/RightToeBase etc, cskel27), scaled but
// otherwise raw. It is NOT the deformed mesh's sole/heel/toe surface. A joint
// reaching a target height, including an "achieved_error_m: 0.0" constraint
// residual reported elsewhere in the pipeline, proves joint-center placement
// only — it does not by itself verify sole-to-support contact, foot
// orientation, or tread penetration. foot_contacts is the model's own
// learned prediction (a plausible opinion, not measured ground truth); it
// names timing/limb, not surface fit. Treat every preflight_motion pass as a
// numeric sanity check to run before apply_motion, not as proof of final
// visible mesh contact.
import { type Static, type TSchema, Type } from "typebox";
import { Parse } from "typebox/value";

const UUID_V4_LOWERCASE = "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
const HASH_64 = "^[0-9a-f]{64}$";
// Mirrors _MOTION_ID in blender-addon/cclay/stage_scene.py — the same
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

// ARDY's own contact channels, mirroring FOOT_CONTACT_CHANNELS in
// blender-addon/cclay/motion_preflight.py. Distinct from contact_windows:
// those scan the minimum over ALL joints and cannot name the limb, these are
// feet only and named, so a caller can map one straight to a --constrain
// target. height is the window mean and height_max its worst frame, so a
// declared contact that never reaches the surface is measurable. channel
// names are ARDY's own vocabulary (left_heel/left_toe/right_heel/right_toe)
// and are preserved verbatim for compatibility. height/height_max are the
// named joint's own scaled skeleton-joint-center height at that frame — NOT
// the deformed mesh sole/heel/toe surface — so a window matching an expected
// support height is model-predicted contact TIMING, not verified
// sole-to-support contact.
const MotionPreflightFootContactWindowV1Schema = exact({
	channel: Type.Union([
		Type.Literal("left_heel"),
		Type.Literal("left_toe"),
		Type.Literal("right_heel"),
		Type.Literal("right_toe"),
	]),
	start_frame: Type.Integer({ minimum: 0 }),
	end_frame: Type.Integer({ minimum: 0 }),
	height: Type.Number(),
	height_max: Type.Number(),
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
	// fps bounds mirror FPS_BOUNDS in blender-addon/cclay/motion_retarget.py.
	fps: Type.Integer({ minimum: 1, maximum: 240 }),
	duration_seconds: Type.Number(),
	scale: nullable(Type.Number()),
	units: Type.Union([Type.Literal("meters"), Type.Literal("npz")]),
	travel: MotionPreflightTravelV1Schema,
	lowest_track: MotionPreflightLowestTrackV1Schema,
	contact_windows: Type.Array(MotionPreflightContactWindowV1Schema, { maxItems: 64 }),
	// null when the npz carries no foot_contacts array at all; [] when the
	// model predicted no contact. The two must not collapse.
	foot_contacts: nullable(Type.Array(MotionPreflightFootContactWindowV1Schema, { maxItems: 64 })),
	end_pose: MotionPreflightEndPoseV1Schema,
});

export type PreflightMotionParamsV1 = Static<typeof PreflightMotionParamsV1Schema>;
export type MotionPreflightTravelV1 = Static<typeof MotionPreflightTravelV1Schema>;
export type MotionPreflightLowestTrackV1 = Static<typeof MotionPreflightLowestTrackV1Schema>;
export type MotionPreflightContactWindowV1 = Static<typeof MotionPreflightContactWindowV1Schema>;
export type MotionPreflightFootContactWindowV1 = Static<typeof MotionPreflightFootContactWindowV1Schema>;
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
