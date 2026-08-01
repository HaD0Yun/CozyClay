// ARDY in-between pose bridge surface: capture full-body synthetic poses at
// scene frames (pose_frames) and re-run the CONSTRAINED generator against a
// base motion to synthesize the frames between captured ones. This is a
// mutating director surface (it produces a new motion archive and a revision
// the director commits), so the request carries expected_revision_id for
// optimistic-concurrency parity with the other mutating bridges.
//
// The constrained pass is ardy_regenerate's invocation, so the request
// carries NO prompt and NO duration — the runtime service builds the argv
// from ARDY_CONSTRAINED_PROMPT and ARDY_CONSTRAINED_DURATION_SECONDS (the
// same constants packages/director-runtime/src/ardy-regenerate-service.ts
// currently keeps private; it will import these instead). The duration and
// fps constants below pin the clip-space frame ceiling: clip_frame indexes
// an ARDY_CONSTRAINED_DURATION_SECONDS_VALUE * ARDY_CLIP_FPS frame clip, so
// the last valid index is ARDY_CONSTRAINED_CLIP_FRAME_MAX.
//
// pose_frames pairs a scene-timeline frame with the clip frame the captured
// pose is bound to. The add-on maps them by an EXACT AFFINE rule,
// clip_frame = scene_frame - start_frame
// (blender-addon/cclay/motion_constraints.py:291), so every entry must share
// one constant offset scene_frame - clip_frame; the parser enforces that
// plus the uniqueness the constant offset implies.
import { type Static, Type } from "typebox";
import { Parse } from "typebox/value";
import { ArdyRegenerateContinuityV1Schema, ArdyRegenerateDroppedConstraintV1Schema } from "./ardy-regenerate.ts";
import { exact, hash, motionId, requestId, uuid } from "./schema-grammar.ts";

// Shared by the regenerate and in-between runtime services; the argv for the
// constrained pass is [prompt, "--duration", seconds, "--base-motion", id].
export const ARDY_CONSTRAINED_PROMPT = "regenerate";
// Numeric constants are the source of truth; the argv string and the schema
// ceiling are derived from them so the three cannot drift.
export const ARDY_CONSTRAINED_DURATION_SECONDS_VALUE = 600;
export const ARDY_CLIP_FPS = 20;
export const ARDY_CONSTRAINED_CLIP_FRAME_MAX = ARDY_CONSTRAINED_DURATION_SECONDS_VALUE * ARDY_CLIP_FPS - 1;
export const ARDY_CONSTRAINED_DURATION_SECONDS = String(ARDY_CONSTRAINED_DURATION_SECONDS_VALUE);

export const ArdyInbetweenRequestV1Schema = exact({
	schema_version: Type.Literal(1),
	// Queue idempotency key / outcome file name: the add-on's 32-hex
	// filename grammar (see schema-grammar.ts REQUEST_ID_PATTERN).
	request_id: requestId(),
	entity_id: uuid(),
	// Mutation guard: identical role to stage_scene/camera_plan/ardy_regenerate.
	expected_revision_id: hash(),
	base_motion_id: motionId(),
	pose_frames: Type.Array(
		exact({
			// Scene-timeline frame the pose was captured at. The bound is the
			// product's timeline ceiling, not Blender's raw MAXFRAME: the
			// director can only place frames in the scene range it sets
			// (frame_start/frame_end, stage-scene.ts:48-49), so a pose keyed
			// outside -100000..100000 could never sit on a timeline the
			// product can produce.
			scene_frame: Type.Integer({ minimum: -100000, maximum: 100000 }),
			// Frame of the constrained clip the captured pose is bound to;
			// see ARDY_CONSTRAINED_CLIP_FRAME_MAX above.
			clip_frame: Type.Integer({ minimum: 0, maximum: ARDY_CONSTRAINED_CLIP_FRAME_MAX }),
		}),
		{ minItems: 1, maxItems: 32 },
	),
	requested_at_ms: Type.Integer({ minimum: 0 }),
});

export const ArdyInbetweenResultV1Schema = exact({
	schema_version: Type.Literal(1),
	request_id: requestId(),
	motion_id: motionId(),
	frames: Type.Integer({ minimum: 1 }),
	captured_frames: Type.Integer({ minimum: 1 }),
	base_motion_id: motionId(),
	// Same measured continuity and dropped-constraint vocabulary the
	// regenerate result reports; the in-between run measures the same
	// inter-frame continuity on the same constrained clip.
	continuity: ArdyRegenerateContinuityV1Schema,
	dropped_constraints: Type.Array(ArdyRegenerateDroppedConstraintV1Schema),
});

export type ArdyInbetweenRequestV1 = Static<typeof ArdyInbetweenRequestV1Schema>;
export type ArdyInbetweenResultV1 = Static<typeof ArdyInbetweenResultV1Schema>;

export const ARDY_INBETWEEN_ERROR_CODES = [
	"INVALID_ARDY_INBETWEEN_REQUEST",
	"ENTITY_NOT_FOUND",
	"BASE_MOTION_NOT_FOUND",
	"REVISION_MISMATCH",
	"POSE_CAPTURE_FAILED",
	"ARDY_HOST_UNAVAILABLE",
	"GENERATION_FAILED",
	"GENERATION_INTERRUPTED",
	"APPLY_FAILED",
] as const;
export type ArdyInbetweenErrorCode = (typeof ARDY_INBETWEEN_ERROR_CODES)[number];

// Host-written queue outcome, same contract as ardy_generate's (and
// ardy_regenerate's): a success member carrying the result and the revision
// the director committed, or a failure member carrying one of the closed
// error codes above.
//
// GENERATION_INTERRUPTED is terminal for an archive commit that was
// interrupted and whose bytes could not be recovered: the queue must never
// retry it (the request_id may already have consumed a generator run), and
// its message must tell the operator to resubmit under a NEW request_id.
const ArdyInbetweenQueueSuccessV1Schema = exact({
	schema_version: Type.Literal(1),
	request_id: requestId(),
	status: Type.Literal("succeeded"),
	result: ArdyInbetweenResultV1Schema,
	resulting_revision_id: hash(),
});

const ArdyInbetweenQueueFailureV1Schema = exact({
	schema_version: Type.Literal(1),
	request_id: requestId(),
	status: Type.Literal("failed"),
	error_code: Type.Union([
		Type.Literal("INVALID_ARDY_INBETWEEN_REQUEST"),
		Type.Literal("ENTITY_NOT_FOUND"),
		Type.Literal("BASE_MOTION_NOT_FOUND"),
		Type.Literal("REVISION_MISMATCH"),
		Type.Literal("POSE_CAPTURE_FAILED"),
		Type.Literal("ARDY_HOST_UNAVAILABLE"),
		Type.Literal("GENERATION_FAILED"),
		Type.Literal("GENERATION_INTERRUPTED"),
		Type.Literal("APPLY_FAILED"),
	]),
	message: Type.String({ minLength: 1, maxLength: 4096 }),
});

export const ArdyInbetweenQueueOutcomeV1Schema = Type.Union([
	ArdyInbetweenQueueSuccessV1Schema,
	ArdyInbetweenQueueFailureV1Schema,
]);
export type ArdyInbetweenQueueOutcomeV1 = Static<typeof ArdyInbetweenQueueOutcomeV1Schema>;

export function parseArdyInbetweenRequest(input: unknown): ArdyInbetweenRequestV1 {
	let parsed: ArdyInbetweenRequestV1;
	try {
		parsed = Parse(ArdyInbetweenRequestV1Schema, input);
	} catch {
		throw new Error("INVALID_ARDY_INBETWEEN_REQUEST: request must match the closed ardy_inbetween request schema");
	}
	// Cross-field invariants (enforced here, not just documented): the
	// add-on maps scene -> clip by the exact affine rule clip_frame =
	// scene_frame - start_frame (motion_constraints.py:291), so every entry
	// must share ONE constant offset scene_frame - clip_frame. Uniqueness is
	// checked FIRST: the constant offset already implies unique columns, but
	// separate checks give a human a specific diagnosis instead of a bare
	// offset mismatch.
	const sceneFrames = new Set<number>();
	const clipFrames = new Set<number>();
	let setOffset: number | undefined;
	for (const pose of parsed.pose_frames) {
		if (sceneFrames.has(pose.scene_frame)) {
			throw new Error(
				`INVALID_ARDY_INBETWEEN_REQUEST: pose_frames scene_frame ${pose.scene_frame} is duplicated; scene_frame values must be unique`,
			);
		}
		sceneFrames.add(pose.scene_frame);
		if (clipFrames.has(pose.clip_frame)) {
			throw new Error(
				`INVALID_ARDY_INBETWEEN_REQUEST: pose_frames clip_frame ${pose.clip_frame} is duplicated; clip_frame values must be unique`,
			);
		}
		clipFrames.add(pose.clip_frame);
		const poseOffset = pose.scene_frame - pose.clip_frame;
		if (setOffset === undefined) {
			setOffset = poseOffset;
		} else if (poseOffset !== setOffset) {
			throw new Error(
				`INVALID_ARDY_INBETWEEN_REQUEST: pose_frames offset (scene_frame - clip_frame) ${poseOffset} at entry (${pose.scene_frame}, ${pose.clip_frame}) differs from the set's constant offset ${setOffset}; every entry must share one offset`,
			);
		}
	}
	return parsed;
}

export function parseArdyInbetweenResult(input: unknown): ArdyInbetweenResultV1 {
	try {
		return Parse(ArdyInbetweenResultV1Schema, input);
	} catch {
		throw new Error("INVALID_ARDY_INBETWEEN_RESULT: result must match the closed ardy_inbetween result schema");
	}
}

export function parseArdyInbetweenQueueOutcome(input: unknown): ArdyInbetweenQueueOutcomeV1 {
	try {
		return Parse(ArdyInbetweenQueueOutcomeV1Schema, input);
	} catch {
		throw new Error("INVALID_ARDY_INBETWEEN_OUTCOME: outcome must match the closed ardy_inbetween outcome schema");
	}
}
