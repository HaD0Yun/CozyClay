// ARDY first-pass generation bridge surface: run the UNCONSTRAINED generator
// against a single prompt and return the generated motion id. This is a
// mutating director surface (it produces a new motion archive and a revision
// the director commits), so the request carries expected_revision_id for
// optimistic-concurrency parity with the other mutating bridges
// (stage_scene, camera_plan, ardy_regenerate).
//
// The first pass MUST NOT carry --base-motion or any constraint flag: the
// wrapper rejects --base-motion when no constraint flag is present and
// rejects constraint flags without --base-motion
// (scripts/cclay-ardy-generate:228-235), so an unconstrained generate is
// prompt-only. The --segment multi-prompt form is out of scope for the v1
// bridge; prompt is a single prompt string.
//
// request_id doubles as the queue idempotency key and outcome file name, so
// it follows the add-on's filename grammar: exactly 32 lowercase hex chars,
// the shape new_request_id() mints (see schema-grammar.ts REQUEST_ID_PATTERN).
import { type Static, Type } from "typebox";
import { Parse } from "typebox/value";
import { exact, hash, motionId, nullable, requestId, uuid } from "./schema-grammar.ts";

export const ArdyGenerateRequestV1Schema = exact({
	schema_version: Type.Literal(1),
	request_id: requestId(),
	entity_id: uuid(),
	// Mutation guard: identical role to stage_scene/camera_plan/ardy_regenerate
	// expected_revision_id — the director must commit against the revision it
	// read, so a stale generate request fails fast instead of clobbering a
	// newer scene.
	expected_revision_id: hash(),
	prompt: Type.String({ minLength: 1, maxLength: 512 }),
	// Mirrors the wrapper cap: cclay-ardy-generate requires
	// 0 < duration <= 1200 seconds because the add-on refuses a motion longer
	// than motion_retarget.MAX_FRAMES (24000 frames, 20 minutes at 20 fps) —
	// nothing past that could ever be applied even if the box generated it
	// (scripts/cclay-ardy-generate:255-264).
	duration_seconds: Type.Number({ exclusiveMinimum: 0, maximum: 1200 }),
	seed: nullable(Type.Integer({ minimum: 0, maximum: 4294967295 })),
	requested_at_ms: Type.Integer({ minimum: 0 }),
});

export const ArdyGenerateResultV1Schema = exact({
	schema_version: Type.Literal(1),
	request_id: requestId(),
	motion_id: motionId(),
	frames: Type.Integer({ minimum: 1 }),
	duration_seconds: Type.Number(),
	seed: nullable(Type.Integer()),
});

export type ArdyGenerateRequestV1 = Static<typeof ArdyGenerateRequestV1Schema>;
export type ArdyGenerateResultV1 = Static<typeof ArdyGenerateResultV1Schema>;

// Deliberately a SUBSET of the in-between union: generate is the
// UNCONSTRAINED first pass — it runs without --base-motion and captures no
// poses, so BASE_MOTION_NOT_FOUND and POSE_CAPTURE_FAILED are unreachable
// failure modes here. ardy_inbetween is the constrained pose-capture surface
// and keeps them.
export const ARDY_GENERATE_ERROR_CODES = [
	"INVALID_ARDY_GENERATE_REQUEST",
	"ENTITY_NOT_FOUND",
	"REVISION_MISMATCH",
	"ARDY_HOST_UNAVAILABLE",
	"GENERATION_FAILED",
	"GENERATION_INTERRUPTED",
	"APPLY_FAILED",
] as const;
export type ArdyGenerateErrorCode = (typeof ARDY_GENERATE_ERROR_CODES)[number];

// What the host writes back beside the queue so the add-on can find out how
// its request ended (same contract as ardy_regenerate's outcome). A request
// that produced no file at all is still pending; a request that failed says
// so explicitly, because the add-on has already detached its IK layer by
// then and silence would be indistinguishable from a host that never started.
//
// GENERATION_INTERRUPTED is terminal for an archive commit that was
// interrupted and whose bytes could not be recovered: the queue must never
// retry it (the request_id may already have consumed a generator run), and
// its message must tell the operator to resubmit under a NEW request_id.
const ArdyGenerateQueueSuccessV1Schema = exact({
	schema_version: Type.Literal(1),
	request_id: requestId(),
	status: Type.Literal("succeeded"),
	result: ArdyGenerateResultV1Schema,
	resulting_revision_id: hash(),
});

const ArdyGenerateQueueFailureV1Schema = exact({
	schema_version: Type.Literal(1),
	request_id: requestId(),
	status: Type.Literal("failed"),
	error_code: Type.Union([
		Type.Literal("INVALID_ARDY_GENERATE_REQUEST"),
		Type.Literal("ENTITY_NOT_FOUND"),
		Type.Literal("REVISION_MISMATCH"),
		Type.Literal("ARDY_HOST_UNAVAILABLE"),
		Type.Literal("GENERATION_FAILED"),
		Type.Literal("GENERATION_INTERRUPTED"),
		Type.Literal("APPLY_FAILED"),
	]),
	message: Type.String({ minLength: 1, maxLength: 4096 }),
});

export const ArdyGenerateQueueOutcomeV1Schema = Type.Union([
	ArdyGenerateQueueSuccessV1Schema,
	ArdyGenerateQueueFailureV1Schema,
]);
export type ArdyGenerateQueueOutcomeV1 = Static<typeof ArdyGenerateQueueOutcomeV1Schema>;

export function parseArdyGenerateRequest(input: unknown): ArdyGenerateRequestV1 {
	try {
		return Parse(ArdyGenerateRequestV1Schema, input);
	} catch {
		throw new Error("INVALID_ARDY_GENERATE_REQUEST: request must match the closed ardy_generate request schema");
	}
}

export function parseArdyGenerateResult(input: unknown): ArdyGenerateResultV1 {
	try {
		return Parse(ArdyGenerateResultV1Schema, input);
	} catch {
		throw new Error("INVALID_ARDY_GENERATE_RESULT: result must match the closed ardy_generate result schema");
	}
}

export function parseArdyGenerateQueueOutcome(input: unknown): ArdyGenerateQueueOutcomeV1 {
	try {
		return Parse(ArdyGenerateQueueOutcomeV1Schema, input);
	} catch {
		throw new Error("INVALID_ARDY_GENERATE_OUTCOME: outcome must match the closed ardy_generate outcome schema");
	}
}
