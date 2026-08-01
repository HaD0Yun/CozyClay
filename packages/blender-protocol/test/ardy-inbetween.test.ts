import assert from "node:assert/strict";
import { test } from "node:test";
import {
	ARDY_CLIP_FPS,
	ARDY_CONSTRAINED_CLIP_FRAME_MAX,
	ARDY_CONSTRAINED_DURATION_SECONDS,
	ARDY_CONSTRAINED_DURATION_SECONDS_VALUE,
	ARDY_CONSTRAINED_PROMPT,
	ARDY_INBETWEEN_ERROR_CODES,
	type ArdyInbetweenRequestV1,
	type ArdyInbetweenResultV1,
	parseArdyInbetweenQueueOutcome,
	parseArdyInbetweenRequest,
	parseArdyInbetweenResult,
} from "../src/ardy-inbetween.ts";

const entityId = "00000000-0000-4000-8000-000000000fff";
const revisionId = "a".repeat(64);
// Same 32-hex uuid4 filename grammar as every other ARDY bridge request_id.
const requestId = "0123456789abcdef0123456789abcdef";

// Every pose_frames entry shares the constant offset
// scene_frame - clip_frame = 100, exactly what the add-on's affine mapping
// (clip_frame = scene_frame - start_frame) produces.
const baseRequest: ArdyInbetweenRequestV1 = {
	schema_version: 1,
	request_id: requestId,
	entity_id: entityId,
	expected_revision_id: revisionId,
	base_motion_id: "walk-forward-01",
	pose_frames: [
		{ scene_frame: 100, clip_frame: 0 },
		{ scene_frame: 160, clip_frame: 60 },
		{ scene_frame: 220, clip_frame: 120 },
	],
	requested_at_ms: 1_753_500_000_000,
};

const baseResult: ArdyInbetweenResultV1 = {
	schema_version: 1,
	request_id: requestId,
	motion_id: "climb-steps-01",
	frames: 120,
	captured_frames: 3,
	base_motion_id: "walk-forward-01",
	continuity: { mean_jump_m: 0.042, max_jump_m: 0.121, max_jump_frame: 24 },
	dropped_constraints: [{ frame: 38, reason: "unreachable within iteration budget" }],
};

test("request: valid payload parses, single pose frame allowed", () => {
	assert.deepEqual(parseArdyInbetweenRequest(baseRequest), baseRequest);
	// A single entry has a trivially constant offset.
	const single = { ...baseRequest, pose_frames: [{ scene_frame: 100, clip_frame: 0 }] };
	assert.deepEqual(parseArdyInbetweenRequest(single), single);
});

test("request: request_id is the 32-hex uuid4 filename grammar", () => {
	assert.deepEqual(parseArdyInbetweenRequest(baseRequest), baseRequest);
	assert.throws(
		() => parseArdyInbetweenRequest({ ...baseRequest, request_id: "inbetween-1742" }),
		/INVALID_ARDY_INBETWEEN_REQUEST/,
	);
	assert.throws(
		() => parseArdyInbetweenRequest({ ...baseRequest, request_id: "A".repeat(32) }),
		/INVALID_ARDY_INBETWEEN_REQUEST/,
	);
});

test("request: closed schema rejects unknown fields at every level", () => {
	assert.throws(() => parseArdyInbetweenRequest({ ...baseRequest, extra: true }), /INVALID_ARDY_INBETWEEN_REQUEST/);
	assert.throws(
		() =>
			parseArdyInbetweenRequest({
				...baseRequest,
				pose_frames: [{ ...baseRequest.pose_frames[0]!, extra: true }],
			}),
		/INVALID_ARDY_INBETWEEN_REQUEST/,
	);
	assert.throws(
		() => parseArdyInbetweenRequest({ ...baseRequest, schema_version: 2 }),
		/INVALID_ARDY_INBETWEEN_REQUEST/,
	);
});

test("request: malformed uuid, malformed 64-hex hash, and malformed motion id rejected", () => {
	assert.throws(
		() => parseArdyInbetweenRequest({ ...baseRequest, entity_id: "not-a-uuid" }),
		/INVALID_ARDY_INBETWEEN_REQUEST/,
	);
	assert.throws(
		() => parseArdyInbetweenRequest({ ...baseRequest, entity_id: entityId.toUpperCase() }),
		/INVALID_ARDY_INBETWEEN_REQUEST/,
	);
	assert.throws(
		() => parseArdyInbetweenRequest({ ...baseRequest, expected_revision_id: "Z".repeat(64) }),
		/INVALID_ARDY_INBETWEEN_REQUEST/,
	);
	assert.throws(
		() => parseArdyInbetweenRequest({ ...baseRequest, base_motion_id: "Walk" }),
		/INVALID_ARDY_INBETWEEN_REQUEST/,
	);
	assert.throws(
		() => parseArdyInbetweenRequest({ ...baseRequest, base_motion_id: "-walk" }),
		/INVALID_ARDY_INBETWEEN_REQUEST/,
	);
	assert.throws(
		() => parseArdyInbetweenRequest({ ...baseRequest, base_motion_id: `a${"b".repeat(64)}` }),
		/INVALID_ARDY_INBETWEEN_REQUEST/,
	);
});

test("request: pose_frames must have 1..32 entries", () => {
	assert.throws(
		() => parseArdyInbetweenRequest({ ...baseRequest, pose_frames: [] }),
		/INVALID_ARDY_INBETWEEN_REQUEST/,
	);
	// Entries keep the constant offset scene_frame - clip_frame = 100.
	const at32 = Array.from({ length: 32 }, (_, i) => ({ scene_frame: 100 + i * 4, clip_frame: i * 4 }));
	assert.deepEqual(parseArdyInbetweenRequest({ ...baseRequest, pose_frames: at32 }).pose_frames, at32);
	const at33 = Array.from({ length: 33 }, (_, i) => ({ scene_frame: 100 + i * 4, clip_frame: i * 4 }));
	assert.throws(
		() => parseArdyInbetweenRequest({ ...baseRequest, pose_frames: at33 }),
		/INVALID_ARDY_INBETWEEN_REQUEST/,
	);
});

test("request: clip_frame bound is 0..ARDY_CONSTRAINED_CLIP_FRAME_MAX", () => {
	// The ceiling derives from the constrained pass: 600s * 20 fps - 1.
	assert.equal(ARDY_CONSTRAINED_CLIP_FRAME_MAX, 600 * 20 - 1);
	assert.deepEqual(
		parseArdyInbetweenRequest({ ...baseRequest, pose_frames: [{ scene_frame: 100, clip_frame: 0 }] }).pose_frames[0]!
			.clip_frame,
		0,
	);
	assert.deepEqual(
		parseArdyInbetweenRequest({
			...baseRequest,
			pose_frames: [{ scene_frame: 100, clip_frame: ARDY_CONSTRAINED_CLIP_FRAME_MAX }],
		}).pose_frames[0]!.clip_frame,
		ARDY_CONSTRAINED_CLIP_FRAME_MAX,
	);
	assert.throws(
		() => parseArdyInbetweenRequest({ ...baseRequest, pose_frames: [{ scene_frame: 100, clip_frame: -1 }] }),
		/INVALID_ARDY_INBETWEEN_REQUEST/,
	);
	assert.throws(
		() =>
			parseArdyInbetweenRequest({
				...baseRequest,
				pose_frames: [{ scene_frame: 100, clip_frame: ARDY_CONSTRAINED_CLIP_FRAME_MAX + 1 }],
			}),
		/INVALID_ARDY_INBETWEEN_REQUEST/,
	);
	assert.throws(
		() => parseArdyInbetweenRequest({ ...baseRequest, pose_frames: [{ scene_frame: 100, clip_frame: 1.5 }] }),
		/INVALID_ARDY_INBETWEEN_REQUEST/,
	);
});

test("request: scene_frame bound is -100000..100000 (product timeline range)", () => {
	// Negative scene frames are legitimate: the director can set
	// frame_start/frame_end within the product bound (stage-scene.ts:48-49),
	// so the ceiling is the product's, not Blender's raw MAXFRAME.
	assert.deepEqual(
		parseArdyInbetweenRequest({ ...baseRequest, pose_frames: [{ scene_frame: -100000, clip_frame: 0 }] })
			.pose_frames[0]!.scene_frame,
		-100000,
	);
	assert.deepEqual(
		parseArdyInbetweenRequest({ ...baseRequest, pose_frames: [{ scene_frame: 100000, clip_frame: 0 }] })
			.pose_frames[0]!.scene_frame,
		100000,
	);
	assert.throws(
		() => parseArdyInbetweenRequest({ ...baseRequest, pose_frames: [{ scene_frame: -100001, clip_frame: 0 }] }),
		/INVALID_ARDY_INBETWEEN_REQUEST/,
	);
	assert.throws(
		() => parseArdyInbetweenRequest({ ...baseRequest, pose_frames: [{ scene_frame: 100001, clip_frame: 0 }] }),
		/INVALID_ARDY_INBETWEEN_REQUEST/,
	);
	assert.throws(
		() => parseArdyInbetweenRequest({ ...baseRequest, pose_frames: [{ scene_frame: 1.5, clip_frame: 0 }] }),
		/INVALID_ARDY_INBETWEEN_REQUEST/,
	);
});

test("request: duplicate scene_frame fails with its own message", () => {
	assert.throws(
		() =>
			parseArdyInbetweenRequest({
				...baseRequest,
				pose_frames: [
					{ scene_frame: 100, clip_frame: 0 },
					{ scene_frame: 100, clip_frame: 60 },
				],
			}),
		/pose_frames scene_frame 100 is duplicated/,
	);
});

test("request: duplicate clip_frame fails with its own message", () => {
	assert.throws(
		() =>
			parseArdyInbetweenRequest({
				...baseRequest,
				pose_frames: [
					{ scene_frame: 100, clip_frame: 60 },
					{ scene_frame: 160, clip_frame: 60 },
				],
			}),
		/pose_frames clip_frame 60 is duplicated/,
	);
});

test("request: pose_frames must share one constant scene_frame - clip_frame offset", () => {
	// Strictly ascending in BOTH columns is not enough: the add-on maps by
	// the exact affine rule clip_frame = scene_frame - start_frame
	// (motion_constraints.py:291), so the whole set has ONE offset.
	// (100,0),(160,30),(220,60) has offsets 100/130/160 and must fail.
	assert.throws(
		() =>
			parseArdyInbetweenRequest({
				...baseRequest,
				pose_frames: [
					{ scene_frame: 100, clip_frame: 0 },
					{ scene_frame: 160, clip_frame: 30 },
					{ scene_frame: 220, clip_frame: 60 },
				],
			}),
		/pose_frames offset .* differs from the set's constant offset/,
	);
	// Array order is irrelevant; only the constant offset matters.
	const shuffled = {
		...baseRequest,
		pose_frames: [
			{ scene_frame: 220, clip_frame: 120 },
			{ scene_frame: 100, clip_frame: 0 },
			{ scene_frame: 160, clip_frame: 60 },
		],
	};
	assert.deepEqual(parseArdyInbetweenRequest(shuffled).pose_frames, shuffled.pose_frames);
	// A negative scene frame with a valid offset is legitimate (a negative
	// start_frame puts the clip after the scene frame).
	const negative = { ...baseRequest, pose_frames: [{ scene_frame: -50, clip_frame: 0 }] };
	assert.deepEqual(parseArdyInbetweenRequest(negative).pose_frames, negative.pose_frames);
});

test("request: requested_at_ms must be an integer >= 0", () => {
	assert.equal(parseArdyInbetweenRequest({ ...baseRequest, requested_at_ms: 0 }).requested_at_ms, 0);
	assert.throws(
		() => parseArdyInbetweenRequest({ ...baseRequest, requested_at_ms: -1 }),
		/INVALID_ARDY_INBETWEEN_REQUEST/,
	);
	assert.throws(
		() => parseArdyInbetweenRequest({ ...baseRequest, requested_at_ms: 1.5 }),
		/INVALID_ARDY_INBETWEEN_REQUEST/,
	);
});

test("result: valid payload parses, empty dropped_constraints allowed", () => {
	assert.deepEqual(parseArdyInbetweenResult(baseResult), baseResult);
	const noDrops = { ...baseResult, dropped_constraints: [] };
	assert.deepEqual(parseArdyInbetweenResult(noDrops), noDrops);
});

test("result: malformed motion id rejected", () => {
	assert.throws(
		() => parseArdyInbetweenResult({ ...baseResult, motion_id: "Climb" }),
		/INVALID_ARDY_INBETWEEN_RESULT/,
	);
	assert.throws(
		() => parseArdyInbetweenResult({ ...baseResult, base_motion_id: "Walk" }),
		/INVALID_ARDY_INBETWEEN_RESULT/,
	);
	assert.throws(
		() => parseArdyInbetweenResult({ ...baseResult, motion_id: `a${"b".repeat(64)}` }),
		/INVALID_ARDY_INBETWEEN_RESULT/,
	);
});

test("result: closed schema rejects unknown fields and out-of-range values", () => {
	assert.throws(() => parseArdyInbetweenResult({ ...baseResult, extra: true }), /INVALID_ARDY_INBETWEEN_RESULT/);
	assert.throws(() => parseArdyInbetweenResult({ ...baseResult, schema_version: 2 }), /INVALID_ARDY_INBETWEEN_RESULT/);
	// frames and captured_frames: just inside is 1 (one frame, one capture).
	assert.equal(parseArdyInbetweenResult({ ...baseResult, frames: 1 }).frames, 1);
	assert.equal(parseArdyInbetweenResult({ ...baseResult, captured_frames: 1 }).captured_frames, 1);
	assert.throws(() => parseArdyInbetweenResult({ ...baseResult, frames: 0 }), /INVALID_ARDY_INBETWEEN_RESULT/);
	assert.throws(
		() => parseArdyInbetweenResult({ ...baseResult, captured_frames: 0 }),
		/INVALID_ARDY_INBETWEEN_RESULT/,
	);
	assert.throws(
		() =>
			parseArdyInbetweenResult({
				...baseResult,
				continuity: { ...baseResult.continuity, extra: true },
			}),
		/INVALID_ARDY_INBETWEEN_RESULT/,
	);
	assert.throws(
		() =>
			parseArdyInbetweenResult({
				...baseResult,
				dropped_constraints: [{ ...baseResult.dropped_constraints[0]!, extra: true }],
			}),
		/INVALID_ARDY_INBETWEEN_RESULT/,
	);
	assert.throws(
		() =>
			parseArdyInbetweenResult({
				...baseResult,
				dropped_constraints: [{ frame: 38, reason: "" }],
			}),
		/INVALID_ARDY_INBETWEEN_RESULT/,
	);
});

test("outcome: succeeded outcome parses with the result and committed revision", () => {
	const outcome = {
		schema_version: 1,
		request_id: requestId,
		status: "succeeded",
		result: baseResult,
		resulting_revision_id: revisionId,
	};
	assert.deepEqual(parseArdyInbetweenQueueOutcome(outcome), outcome);
});

test("outcome: every closed error code parses, codes outside the union fail", () => {
	for (const errorCode of ARDY_INBETWEEN_ERROR_CODES) {
		const outcome = {
			schema_version: 1,
			request_id: requestId,
			status: "failed",
			error_code: errorCode,
			message: "in-between pass could not complete",
		};
		assert.deepEqual(parseArdyInbetweenQueueOutcome(outcome), outcome);
	}
	assert.throws(
		() =>
			parseArdyInbetweenQueueOutcome({
				schema_version: 1,
				request_id: requestId,
				status: "failed",
				error_code: "UNKNOWN_CODE",
				message: "boom",
			}),
		/INVALID_ARDY_INBETWEEN_OUTCOME/,
	);
});

test("outcome: base-motion and pose-capture codes stay valid for the in-between surface", () => {
	// ardy_inbetween IS the constrained pose-capture surface, so the codes
	// the unconstrained generate union dropped are still reachable here.
	for (const errorCode of ["BASE_MOTION_NOT_FOUND", "POSE_CAPTURE_FAILED"]) {
		const outcome = {
			schema_version: 1,
			request_id: requestId,
			status: "failed",
			error_code: errorCode,
			message: "in-between pass could not complete",
		};
		assert.deepEqual(parseArdyInbetweenQueueOutcome(outcome), outcome);
	}
});

test("outcome: failure message must be 1..4096 characters", () => {
	const failed = (message: string) => ({
		schema_version: 1,
		request_id: requestId,
		status: "failed",
		error_code: "GENERATION_FAILED",
		message,
	});
	// Narrow the closed union before reading the failure-only field.
	const shortest = parseArdyInbetweenQueueOutcome(failed("x"));
	assert.equal(shortest.status, "failed");
	if (shortest.status === "failed") assert.equal(shortest.message, "x");
	const longest = parseArdyInbetweenQueueOutcome(failed("m".repeat(4096)));
	assert.equal(longest.status, "failed");
	if (longest.status === "failed") assert.equal(longest.message.length, 4096);
	assert.throws(() => parseArdyInbetweenQueueOutcome(failed("")), /INVALID_ARDY_INBETWEEN_OUTCOME/);
	assert.throws(() => parseArdyInbetweenQueueOutcome(failed("m".repeat(4097))), /INVALID_ARDY_INBETWEEN_OUTCOME/);
});

test("outcome: malformed outcomes fail", () => {
	// A third status value is not part of the closed outcome union.
	assert.throws(
		() =>
			parseArdyInbetweenQueueOutcome({
				schema_version: 1,
				request_id: requestId,
				status: "pending",
			}),
		/INVALID_ARDY_INBETWEEN_OUTCOME/,
	);
	// succeeded with a malformed inner result (bad captured_frames).
	assert.throws(
		() =>
			parseArdyInbetweenQueueOutcome({
				schema_version: 1,
				request_id: requestId,
				status: "succeeded",
				result: { ...baseResult, captured_frames: 0 },
				resulting_revision_id: revisionId,
			}),
		/INVALID_ARDY_INBETWEEN_OUTCOME/,
	);
	// failed with an empty message.
	assert.throws(
		() =>
			parseArdyInbetweenQueueOutcome({
				schema_version: 1,
				request_id: requestId,
				status: "failed",
				error_code: "GENERATION_FAILED",
				message: "",
			}),
		/INVALID_ARDY_INBETWEEN_OUTCOME/,
	);
});

test("constants: constrained-pass prompt, duration, and fps derive the clip ceiling", () => {
	// packages/director-runtime/src/ardy-regenerate-service.ts builds the
	// constrained argv from these exact values; the in-between request
	// carries no prompt/duration of its own.
	assert.equal(ARDY_CONSTRAINED_PROMPT, "regenerate");
	assert.equal(ARDY_CONSTRAINED_DURATION_SECONDS_VALUE, 600);
	assert.equal(ARDY_CLIP_FPS, 20);
	// The ceiling is DERIVED from the numeric constants, so assert the
	// relationship rather than restating a literal.
	assert.equal(ARDY_CONSTRAINED_CLIP_FRAME_MAX, ARDY_CONSTRAINED_DURATION_SECONDS_VALUE * ARDY_CLIP_FPS - 1);
	assert.equal(ARDY_CONSTRAINED_CLIP_FRAME_MAX, 600 * 20 - 1);
	// The argv string is derived from the same numeric constant, so the two
	// cannot drift.
	assert.equal(ARDY_CONSTRAINED_DURATION_SECONDS, String(ARDY_CONSTRAINED_DURATION_SECONDS_VALUE));
	assert.equal(ARDY_CONSTRAINED_DURATION_SECONDS, "600");
});

test("error codes: ardy_inbetween contract codes are stable and in order", () => {
	// The constrained pose-capture surface keeps BASE_MOTION_NOT_FOUND and
	// POSE_CAPTURE_FAILED that the unconstrained generate union dropped.
	assert.deepEqual(ARDY_INBETWEEN_ERROR_CODES, [
		"INVALID_ARDY_INBETWEEN_REQUEST",
		"ENTITY_NOT_FOUND",
		"BASE_MOTION_NOT_FOUND",
		"REVISION_MISMATCH",
		"POSE_CAPTURE_FAILED",
		"ARDY_HOST_UNAVAILABLE",
		"GENERATION_FAILED",
		"GENERATION_INTERRUPTED",
		"APPLY_FAILED",
	]);
});
