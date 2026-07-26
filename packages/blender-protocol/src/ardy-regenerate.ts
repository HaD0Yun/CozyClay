// ARDY constraint regeneration bridge surface: re-run the constrained
// generator against a base motion with measured end-effector targets, full
// synthetic poses, and a 2D root path, then return the generated motion id
// plus its measured residual, continuity, and any constraints the sampler
// had to drop. This is a mutating director surface (it produces a new motion
// archive and a revision the director commits), so the request carries
// expected_revision_id for optimistic-concurrency parity with the other
// mutating bridges (stage_scene, camera_plan).
//
// Every distance reported here (achieved_error_m, residual.*,
// continuity.*) is a skeleton joint-center Euclidean gap in npz space,
// mirroring the target_space semantics documented at the top of
// scripts/ardy/cclay_constrained_generate.py: a zero or near-zero residual
// proves joint-center placement only, NOT sole/surface contact. Do not treat
// achieved_error_m == 0 as ground-contact verification without an
// independent mesh/surface check.
import { type Static, type TSchema, Type } from "typebox";
import { Parse } from "typebox/value";

const UUID_V4_LOWERCASE = "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
const HASH_64 = "^[0-9a-f]{64}$";
// Mirrors the addon grammar documented inline in scripts/cclay-ardy-generate
// (line 329: `# motion_id: addon grammar ^[a-z0-9][a-z0-9-]{0,63}$`) and
// _MOTION_ID in blender-addon/cclay/stage_scene.py — the same slug the addon
// and the generate wrapper validate, so the bridge cannot admit a motion id
// that apply_motion would later reject.
const MOTION_ID_PATTERN = "^[a-z0-9][a-z0-9-]{0,63}$";
const exact = <T extends Record<string, TSchema>>(properties: T) =>
	Type.Object(properties, { additionalProperties: false });
const uuid = () => Type.String({ pattern: UUID_V4_LOWERCASE });
const hash = () => Type.String({ pattern: HASH_64 });
const nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
const motionId = () => Type.String({ pattern: MOTION_ID_PATTERN });

// ARDY end-effector joints that --constrain targets. The closed literal
// union keeps the request from naming a joint the generator cannot act on;
// it matches the vocabulary parse_target accepts (LeftHand/RightHand/
// LeftFoot/RightFoot) and the worst_joint the result reports back.
const EffectorJointSchema = Type.Union([
	Type.Literal("LeftHand"),
	Type.Literal("RightHand"),
	Type.Literal("LeftFoot"),
	Type.Literal("RightFoot"),
]);

const ArdyRegenerateEffectorTargetV1Schema = exact({
	frame: Type.Integer({ minimum: 0 }),
	joint: EffectorJointSchema,
	x: Type.Number(),
	y: Type.Number(),
	z: Type.Number(),
});

const ArdyRegenerateFullBodyTargetV1Schema = exact({
	frame: Type.Integer({ minimum: 0 }),
	synthetic_motion_id: motionId(),
});

const ArdyRegenerateRoot2DTargetV1Schema = exact({
	frame: Type.Integer({ minimum: 0 }),
	x: Type.Number(),
	z: Type.Number(),
	// null means heading is left free ("none"); a real number is a heading
	// in radians. The two must not collapse to a sentinel value, because the
	// remote generator treats an absent heading differently from a pinned
	// one (see cclay_heading_free in the addon-side pose key contract).
	heading: nullable(Type.Number()),
});

export const ArdyRegenerateRequestV1Schema = exact({
	schema_version: Type.Literal(1),
	request_id: Type.String({ minLength: 1, maxLength: 256 }),
	entity_id: uuid(),
	base_motion_id: motionId(),
	// Mutation guard: identical role to stage_scene/camera_plan
	// expected_revision_id — the director must commit against the revision it
	// read, so a stale regenerate request fails fast instead of clobbering a
	// newer scene.
	expected_revision_id: hash(),
	effectors: Type.Array(ArdyRegenerateEffectorTargetV1Schema),
	full_body: Type.Array(ArdyRegenerateFullBodyTargetV1Schema),
	root_2d: Type.Array(ArdyRegenerateRoot2DTargetV1Schema),
	requested_at_ms: Type.Integer({ minimum: 0 }),
});

const ArdyRegenerateResidualV1Schema = exact({
	max_error_m: Type.Number(),
	mean_error_m: Type.Number(),
	worst_frame: Type.Integer({ minimum: 0 }),
	worst_joint: EffectorJointSchema,
});

const ArdyRegenerateContinuityV1Schema = exact({
	mean_jump_m: Type.Number(),
	max_jump_m: Type.Number(),
	max_jump_frame: Type.Integer({ minimum: 0 }),
});

const ArdyRegenerateDroppedConstraintV1Schema = exact({
	frame: Type.Integer({ minimum: 0 }),
	reason: Type.String({ minLength: 1, maxLength: 512 }),
});

export const ArdyRegenerateResultV1Schema = exact({
	schema_version: Type.Literal(1),
	request_id: Type.String({ minLength: 1, maxLength: 256 }),
	motion_id: motionId(),
	frames: Type.Integer({ minimum: 1 }),
	// residual/achieved_error_m are null when the run constrained only a
	// path or only a full-body pose, so no end-effector target exists to
	// summarize. measure_residuals returns None in that case rather than a
	// zero that would read as a perfect hit on a measurement never taken
	// (scripts/ardy/cclay_constrained_generate.py:measure_residuals, and
	// ResidualTests.test_no_target_reports_null_not_zero in
	// blender-addon/tests/test_ardy_constraint_spec.py). The bridge
	// preserves that null through to the caller.
	achieved_error_m: nullable(Type.Number()),
	residual: nullable(ArdyRegenerateResidualV1Schema),
	continuity: ArdyRegenerateContinuityV1Schema,
	dropped_constraints: Type.Array(ArdyRegenerateDroppedConstraintV1Schema),
});

export type ArdyRegenerateEffectorTargetV1 = Static<typeof ArdyRegenerateEffectorTargetV1Schema>;
export type ArdyRegenerateFullBodyTargetV1 = Static<typeof ArdyRegenerateFullBodyTargetV1Schema>;
export type ArdyRegenerateRoot2DTargetV1 = Static<typeof ArdyRegenerateRoot2DTargetV1Schema>;
export type ArdyRegenerateResidualV1 = Static<typeof ArdyRegenerateResidualV1Schema>;
export type ArdyRegenerateContinuityV1 = Static<typeof ArdyRegenerateContinuityV1Schema>;
export type ArdyRegenerateDroppedConstraintV1 = Static<typeof ArdyRegenerateDroppedConstraintV1Schema>;
export type ArdyRegenerateRequestV1 = Static<typeof ArdyRegenerateRequestV1Schema>;
export type ArdyRegenerateResultV1 = Static<typeof ArdyRegenerateResultV1Schema>;

export const ARDY_REGENERATE_ERROR_CODES = [
	"INVALID_ARDY_REGENERATE_REQUEST",
	"BASE_MOTION_NOT_FOUND",
	"ENTITY_NOT_FOUND",
	"REVISION_MISMATCH",
	"GENERATION_FAILED",
] as const;
export type ArdyRegenerateErrorCode = (typeof ARDY_REGENERATE_ERROR_CODES)[number];

// What the host writes back beside the queue so the add-on can find out how
// its request ended. A request that produced no file at all is still pending;
// a request that failed says so explicitly, because the add-on has already
// detached its IK layer by then and silence would be indistinguishable from a
// host that never started.
const ArdyRegenerateQueueSuccessV1Schema = exact({
	schema_version: Type.Literal(1),
	request_id: Type.String({ minLength: 1, maxLength: 256 }),
	status: Type.Literal("succeeded"),
	result: ArdyRegenerateResultV1Schema,
	resulting_revision_id: hash(),
});

const ArdyRegenerateQueueFailureV1Schema = exact({
	schema_version: Type.Literal(1),
	request_id: Type.String({ minLength: 1, maxLength: 256 }),
	status: Type.Literal("failed"),
	error_code: Type.Union(ARDY_REGENERATE_ERROR_CODES.map((code) => Type.Literal(code))),
	message: Type.String({ minLength: 1, maxLength: 4096 }),
});

export const ArdyRegenerateQueueOutcomeV1Schema = Type.Union([
	ArdyRegenerateQueueSuccessV1Schema,
	ArdyRegenerateQueueFailureV1Schema,
]);
export type ArdyRegenerateQueueOutcomeV1 = Static<typeof ArdyRegenerateQueueOutcomeV1Schema>;

export function parseArdyRegenerateQueueOutcome(input: unknown): ArdyRegenerateQueueOutcomeV1 {
	try {
		return Parse(ArdyRegenerateQueueOutcomeV1Schema, input);
	} catch {
		throw new Error("INVALID_ARDY_REGENERATE_OUTCOME: outcome must match the closed ardy_regenerate outcome schema");
	}
}

export function parseArdyRegenerateRequest(input: unknown): ArdyRegenerateRequestV1 {
	try {
		return Parse(ArdyRegenerateRequestV1Schema, input);
	} catch {
		throw new Error("INVALID_ARDY_REGENERATE_REQUEST: request must match the closed ardy_regenerate request schema");
	}
}

export function parseArdyRegenerateResult(input: unknown): ArdyRegenerateResultV1 {
	try {
		return Parse(ArdyRegenerateResultV1Schema, input);
	} catch {
		throw new Error("INVALID_ARDY_REGENERATE_RESULT: result must match the closed ardy_regenerate result schema");
	}
}
