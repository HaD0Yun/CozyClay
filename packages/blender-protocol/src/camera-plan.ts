import { type Static, type TSchema, Type } from "typebox";
import { Parse } from "typebox/value";
import { SceneManifestV2Schema, SceneManifestV3Schema, SceneManifestV4Schema } from "./manifest.ts";

const HASH_64 = "^[0-9a-f]{64}$";
const exact = <T extends Record<string, TSchema>>(properties: T) =>
	Type.Object(properties, { additionalProperties: false });
const finiteNumber = () => Type.Number({ exclusiveMinimum: -1e15, exclusiveMaximum: 1e15 });
const vector3 = () => Type.Tuple([finiteNumber(), finiteNumber(), finiteNumber()]);

export const CameraPlanV1Schema = exact({
	schema_version: Type.Literal(1),
	expected_revision_id: Type.String({ pattern: HASH_64 }),
	evidence_sha256: Type.String({ pattern: HASH_64 }),
	output_format: exact({
		width: Type.Integer({ minimum: 1 }),
		height: Type.Integer({ minimum: 1 }),
	}),
	keyframes: Type.Array(
		exact({
			frame: Type.Number({ minimum: 0, exclusiveMaximum: 1e15 }),
			pose: exact({
				position: vector3(),
				look_at: vector3(),
				up: vector3(),
				vertical_fov_radians: Type.Number({ exclusiveMinimum: 0, exclusiveMaximum: Math.PI }),
			}),
			transition: Type.Union([Type.Literal("smooth"), Type.Literal("cut")]),
		}),
		{ minItems: 1 },
	),
});

export type CameraPlanV1 = Static<typeof CameraPlanV1Schema>;
export const CameraPlanMutationCandidateSchema = exact({
	expected_revision_id: Type.String({ pattern: HASH_64 }),
	scene_hash: Type.String({ pattern: HASH_64 }),
	manifest: Type.Union([SceneManifestV2Schema, SceneManifestV3Schema, SceneManifestV4Schema]),
});
export type CameraPlanMutationCandidate = Static<typeof CameraPlanMutationCandidateSchema>;
export type Vector3 = [number, number, number];

export interface DirectingAnalysisEvidenceV1 {
	schema_version: 1;
	revision_id: string;
	scene_hash: string;
	frame_range: { start: number; end: number };
	producer: { id: string; version: string; digest: string };
	analysis: {
		motion_valley_frames: number[];
		action_peak_ranges: Array<{ start: number; end: number }>;
		action_axis: { a: Vector3; b: Vector3; up: Vector3 };
		subject_samples: Array<{ frame: number; center: Vector3; height_m: number }>;
	};
}

export const CAMERA_PLAN_ERROR_CODES = [
	"INVALID_CAMERA_PLAN_SCHEMA",
	"UNTRUSTED_EVIDENCE_DIGEST",
	"TRUSTED_FIXTURE_NOT_FOUND",
	"TRUSTED_FIXTURE_PATH_UNSAFE",
	"EVIDENCE_DIGEST_MISMATCH",
	"EVIDENCE_DOCUMENT_MALFORMED",
	"EVIDENCE_DOCUMENT_SCHEMA_INVALID",
	"EVIDENCE_RANGE_INVALID",
	"EVIDENCE_REVISION_MISMATCH",
	"EVIDENCE_SCENE_HASH_MISMATCH",
	"PLAN_FRAME_OUT_OF_EVIDENCE_RANGE",
	"EVIDENCE_SUBJECT_SAMPLE_MISSING",
	"EVIDENCE_ACTION_AXIS_ZERO_LENGTH",
	"EVIDENCE_ACTION_AXIS_PARALLEL_TO_UP",
	"PLAN_FRAME_NOT_INTEGER",
	"PLAN_MINIMUM_TWO_KEYFRAMES",
	"PLAN_FRAME_ORDER_INVALID",
	"PLAN_FIRST_TRANSITION_NOT_SMOOTH",
	// Row 19 is retained in the closed union but has no triggering branch:
	// a cut placed exactly at the evidence range start would need an N-1
	// subject sample at frame_range.start - 1, which lies outside any valid
	// evidence document's representable range and can therefore never be
	// present (row 12, EVIDENCE_SUBJECT_SAMPLE_MISSING, always fires first).
	"PLAN_CUT_AT_RANGE_START",
	"UNSUPPORTED_PLAN_UP",
	"PLAN_ZERO_VIEW_DISTANCE",
	"PLAN_POSE_COLLINEAR_UP",
	"SMOOTH_HANDLE_TYPE_INVALID",
	"SMOOTH_HANDLE_TOLERANCE_EXCEEDED",
	"SMOOTH_VALUE_NOT_FINITE",
	"SMOOTH_HANDLE_OUT_OF_RANGE",
	"SMOOTH_TANGENT_SIGN_INVALID",
	"FRAMING_BAND_VIOLATION",
	"CUT_NOT_AT_MOTION_VALLEY",
	"CUT_SPLITS_ACTION_PEAK",
	"CUT_SCALE_UNDEFINED",
	"CUT_SCALE_DISCONTINUITY",
	"CAMERA_ON_ACTION_AXIS",
	"ACTION_AXIS_CROSSING",
	"STALE_BASE",
] as const;

export type CameraPlanErrorCode = (typeof CAMERA_PLAN_ERROR_CODES)[number];

export class CameraPlanValidationError extends Error {
	readonly code: CameraPlanErrorCode;

	constructor(code: CameraPlanErrorCode, message: string) {
		super(`${code}: ${message}`);
		this.name = "CameraPlanValidationError";
		this.code = code;
	}
}

const fail = (code: CameraPlanErrorCode, message: string): never => {
	throw new CameraPlanValidationError(code, message);
};

export function parseCameraPlan(input: unknown): CameraPlanV1 {
	try {
		return Parse(CameraPlanV1Schema, input);
	} catch {
		return fail("INVALID_CAMERA_PLAN_SCHEMA", "plan must match the closed CameraPlanV1 schema");
	}
}
export function parseCameraPlanMutationCandidate(input: unknown): CameraPlanMutationCandidate {
	try {
		return Parse(CameraPlanMutationCandidateSchema, input);
	} catch {
		throw new Error("INVALID_MUTATION_RESULT: add-on result must match the closed mutation candidate schema");
	}
}

const subtract = (a: Vector3, b: Vector3): Vector3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vector3, b: Vector3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vector3, b: Vector3): Vector3 => [
	a[1] * b[2] - a[2] * b[1],
	a[2] * b[0] - a[0] * b[2],
	a[0] * b[1] - a[1] * b[0],
];
const magnitude = (value: Vector3): number => Math.hypot(...value);
const scale = (value: Vector3, factor: number): Vector3 => [value[0] * factor, value[1] * factor, value[2] * factor];
const ardyToBlender = (value: Vector3): Vector3 => [value[0], -value[2], value[1]];

/**
 * Validate the pure-math G010 predicates after the add-on has established the
 * row 2–10 fixture trust chain. Checks are deliberately kept in table order.
 */
export function validateCameraPlan(input: unknown, evidence: DirectingAnalysisEvidenceV1): CameraPlanV1 {
	const plan = parseCameraPlan(input);
	const { start, end } = evidence.frame_range;

	if (plan.keyframes.some((keyframe) => keyframe.frame < start || keyframe.frame > end)) {
		fail("PLAN_FRAME_OUT_OF_EVIDENCE_RANGE", "plan keyframe lies outside the valid evidence range");
	}

	const samplesByFrame = new Map(evidence.analysis.subject_samples.map((sample) => [sample.frame, sample]));
	for (const keyframe of plan.keyframes) {
		if (
			keyframe.transition === "cut" &&
			(!samplesByFrame.has(keyframe.frame - 1) || !samplesByFrame.has(keyframe.frame))
		) {
			fail("EVIDENCE_SUBJECT_SAMPLE_MISSING", `cut ${keyframe.frame} requires exact subject samples N-1 and N`);
		}
	}

	const axis = subtract(evidence.analysis.action_axis.b, evidence.analysis.action_axis.a);
	const axisLength = magnitude(axis);
	if (axisLength < 1e-9) fail("EVIDENCE_ACTION_AXIS_ZERO_LENGTH", "action axis length is below 1e-9");
	const axisCrossUp = cross(axis, evidence.analysis.action_axis.up);
	if (magnitude(axisCrossUp) < 1e-9) {
		fail("EVIDENCE_ACTION_AXIS_PARALLEL_TO_UP", "action axis is parallel to evidence up");
	}

	if (plan.keyframes.some((keyframe) => !Number.isInteger(keyframe.frame))) {
		fail("PLAN_FRAME_NOT_INTEGER", "keyframe frames must be integers");
	}
	if (plan.keyframes.length < 2) fail("PLAN_MINIMUM_TWO_KEYFRAMES", "camera plan requires at least two keyframes");
	for (let index = 1; index < plan.keyframes.length; index += 1) {
		if (plan.keyframes[index]!.frame <= plan.keyframes[index - 1]!.frame) {
			fail("PLAN_FRAME_ORDER_INVALID", "keyframe frames must be strictly increasing");
		}
	}
	if (plan.keyframes[0]!.transition !== "smooth") {
		fail("PLAN_FIRST_TRANSITION_NOT_SMOOTH", "first transition must be literal smooth");
	}

	for (const keyframe of plan.keyframes) {
		if (keyframe.pose.up.some((component, index) => Math.abs(component - [0, 1, 0][index]!) > 1e-9)) {
			fail("UNSUPPORTED_PLAN_UP", "plan up must equal [0,1,0] within 1e-9 per component");
		}
		const direction = subtract(keyframe.pose.look_at, keyframe.pose.position);
		const distance = magnitude(direction);
		if (distance < 1e-9) fail("PLAN_ZERO_VIEW_DISTANCE", "camera view distance is below 1e-9");
		const upLength = magnitude(keyframe.pose.up);
		const sine = magnitude(cross(keyframe.pose.up, direction)) / (upLength * distance);
		if (sine < 1e-9) fail("PLAN_POSE_COLLINEAR_UP", "camera direction is collinear with up");
	}

	for (const keyframe of plan.keyframes) {
		const framingDistance = 12 / Math.tan(keyframe.pose.vertical_fov_radians / 2);
		if (framingDistance < 45 - 1e-6 || framingDistance > 52 + 1e-6) {
			fail("FRAMING_BAND_VIOLATION", "vertical field of view lies outside the 45..52 framing band");
		}
	}

	const cuts = plan.keyframes
		.map((keyframe, index) => ({ keyframe, index }))
		.filter(({ keyframe }) => keyframe.transition === "cut");
	for (const { keyframe } of cuts) {
		if (!evidence.analysis.motion_valley_frames.some((frame) => Math.abs(frame - keyframe.frame) <= 1)) {
			fail("CUT_NOT_AT_MOTION_VALLEY", `cut ${keyframe.frame} has no motion valley within one frame`);
		}
	}
	for (const { keyframe } of cuts) {
		if (
			evidence.analysis.action_peak_ranges.some(
				(range) => keyframe.frame >= range.start - 1 && keyframe.frame <= range.end + 1,
			)
		) {
			fail("CUT_SPLITS_ACTION_PEAK", `cut ${keyframe.frame} intersects an expanded action peak`);
		}
	}

	for (const { keyframe, index } of cuts) {
		const previousPose = plan.keyframes[index - 1]?.pose;
		if (previousPose === undefined) continue;
		const before = samplesByFrame.get(keyframe.frame - 1)!;
		const after = samplesByFrame.get(keyframe.frame)!;
		const projected = [
			before.height_m /
				(magnitude(subtract(ardyToBlender(previousPose.position), before.center)) *
					2 *
					Math.tan(previousPose.vertical_fov_radians / 2)),
			after.height_m /
				(magnitude(subtract(ardyToBlender(keyframe.pose.position), after.center)) *
					2 *
					Math.tan(keyframe.pose.vertical_fov_radians / 2)),
		];
		if (projected.some((value) => !Number.isFinite(value) || value <= 0)) {
			fail("CUT_SCALE_UNDEFINED", `cut ${keyframe.frame} has undefined projected subject scale`);
		}
		if (Math.max(...projected) / Math.min(...projected) > 1.35 + 1e-6) {
			fail("CUT_SCALE_DISCONTINUITY", `cut ${keyframe.frame} exceeds the subject-scale continuity ratio`);
		}
	}

	const side = scale(axisCrossUp, 1 / magnitude(axisCrossUp));
	const sideScores = plan.keyframes.map((keyframe) =>
		dot(subtract(ardyToBlender(keyframe.pose.position), evidence.analysis.action_axis.a), side),
	);
	if (sideScores.some((score) => Math.abs(score) < 1e-6)) {
		fail("CAMERA_ON_ACTION_AXIS", "camera lies on the action axis");
	}
	const initialSign = Math.sign(sideScores[0]!);
	if (sideScores.some((score) => Math.sign(score) !== initialSign)) {
		fail("ACTION_AXIS_CROSSING", "camera changes side across the action axis");
	}
	return plan;
}
