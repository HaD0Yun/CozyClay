import assert from "node:assert/strict";
import { test } from "node:test";
import {
	ARDY_GENERATE_ERROR_CODES,
	type ArdyGenerateRequestV1,
	type ArdyGenerateResultV1,
	parseArdyGenerateQueueOutcome,
	parseArdyGenerateRequest,
	parseArdyGenerateResult,
} from "../src/ardy-generate.ts";
import { REQUEST_ID_PATTERN } from "../src/schema-grammar.ts";

const entityId = "00000000-0000-4000-8000-000000000fff";
const revisionId = "a".repeat(64);
// The add-on mints request ids as uuid4 hex and uses them verbatim as
// filenames (constraint_capture.py new_request_id), so the fixture is a real
// 32-hex id.
const requestId = "0123456789abcdef0123456789abcdef";

const baseRequest: ArdyGenerateRequestV1 = {
	schema_version: 1,
	request_id: requestId,
	entity_id: entityId,
	expected_revision_id: revisionId,
	prompt: "a person waves both hands",
	duration_seconds: 5,
	seed: 7,
	requested_at_ms: 1_753_500_000_000,
};

const baseResult: ArdyGenerateResultV1 = {
	schema_version: 1,
	request_id: requestId,
	motion_id: "wave-hands-01",
	frames: 100,
	duration_seconds: 5,
	seed: 7,
};

test("request: valid payload parses, seed null and number both pass", () => {
	assert.deepEqual(parseArdyGenerateRequest(baseRequest), baseRequest);
	// A run may be seeded or not; null is the unseeded form.
	const unseeded: ArdyGenerateRequestV1 = { ...baseRequest, seed: null };
	assert.deepEqual(parseArdyGenerateRequest(unseeded), unseeded);
});

test("request: request_id is the 32-hex uuid4 filename grammar (_REQUEST_ID)", () => {
	// Shared grammar, not a generate-local copy: the add-on's _REQUEST_ID
	// ([0-9a-f]{32}) and new_request_id() (uuid4 hex) in
	// constraint_capture.py are the source.
	assert.equal(REQUEST_ID_PATTERN, "^[0-9a-f]{32}$");
	// A real 32-hex id parses (the fixture above is one).
	assert.deepEqual(parseArdyGenerateRequest(baseRequest), baseRequest);
	// Just outside on length: 31 and 33 hex chars.
	assert.throws(
		() => parseArdyGenerateRequest({ ...baseRequest, request_id: "a".repeat(31) }),
		/INVALID_ARDY_GENERATE_REQUEST/,
	);
	assert.throws(
		() => parseArdyGenerateRequest({ ...baseRequest, request_id: "a".repeat(33) }),
		/INVALID_ARDY_GENERATE_REQUEST/,
	);
	// Wrong alphabet: uppercase hex and a non-hex character.
	assert.throws(
		() => parseArdyGenerateRequest({ ...baseRequest, request_id: "A".repeat(32) }),
		/INVALID_ARDY_GENERATE_REQUEST/,
	);
	assert.throws(
		() => parseArdyGenerateRequest({ ...baseRequest, request_id: `a${"g".repeat(31)}` }),
		/INVALID_ARDY_GENERATE_REQUEST/,
	);
	// Empty string.
	assert.throws(() => parseArdyGenerateRequest({ ...baseRequest, request_id: "" }), /INVALID_ARDY_GENERATE_REQUEST/);
	// The id is joined into a filename verbatim, so path separators,
	// traversal, and control characters must be unrepresentable even at
	// exactly 32 characters.
	assert.throws(
		() => parseArdyGenerateRequest({ ...baseRequest, request_id: `${"a".repeat(16)}/${"a".repeat(15)}` }),
		/INVALID_ARDY_GENERATE_REQUEST/,
	);
	assert.throws(
		() => parseArdyGenerateRequest({ ...baseRequest, request_id: `${"a".repeat(16)}..${"a".repeat(14)}` }),
		/INVALID_ARDY_GENERATE_REQUEST/,
	);
	assert.throws(
		() => parseArdyGenerateRequest({ ...baseRequest, request_id: `${"a".repeat(16)}\u0000${"a".repeat(15)}` }),
		/INVALID_ARDY_GENERATE_REQUEST/,
	);
	assert.throws(
		() => parseArdyGenerateRequest({ ...baseRequest, request_id: `${"a".repeat(16)}\n${"a".repeat(15)}` }),
		/INVALID_ARDY_GENERATE_REQUEST/,
	);
	// A line terminator appended past the 32 hex chars must not sneak in via
	// JS `$`-before-final-newline semantics either.
	assert.throws(
		() => parseArdyGenerateRequest({ ...baseRequest, request_id: `${"a".repeat(32)}\n` }),
		/INVALID_ARDY_GENERATE_REQUEST/,
	);
});

test("request: closed schema rejects unknown fields and wrong types", () => {
	assert.throws(() => parseArdyGenerateRequest({ ...baseRequest, extra: true }), /INVALID_ARDY_GENERATE_REQUEST/);
	assert.throws(
		() => parseArdyGenerateRequest({ ...baseRequest, schema_version: 2 }),
		/INVALID_ARDY_GENERATE_REQUEST/,
	);
	assert.throws(() => parseArdyGenerateRequest({ ...baseRequest, prompt: 42 }), /INVALID_ARDY_GENERATE_REQUEST/);
});

test("request: malformed uuid and malformed 64-hex hash rejected", () => {
	assert.throws(
		() => parseArdyGenerateRequest({ ...baseRequest, entity_id: "not-a-uuid" }),
		/INVALID_ARDY_GENERATE_REQUEST/,
	);
	assert.throws(
		() => parseArdyGenerateRequest({ ...baseRequest, entity_id: entityId.toUpperCase() }),
		/INVALID_ARDY_GENERATE_REQUEST/,
	);
	assert.throws(
		() => parseArdyGenerateRequest({ ...baseRequest, expected_revision_id: "Z".repeat(64) }),
		/INVALID_ARDY_GENERATE_REQUEST/,
	);
	assert.throws(
		() => parseArdyGenerateRequest({ ...baseRequest, expected_revision_id: "a".repeat(63) }),
		/INVALID_ARDY_GENERATE_REQUEST/,
	);
});

test("request: duration_seconds bound is > 0 and <= 1200 (wrapper cap)", () => {
	// 0 is rejected (exclusiveMinimum); just inside the low end is any
	// positive value.
	assert.throws(
		() => parseArdyGenerateRequest({ ...baseRequest, duration_seconds: 0 }),
		/INVALID_ARDY_GENERATE_REQUEST/,
	);
	assert.throws(
		() => parseArdyGenerateRequest({ ...baseRequest, duration_seconds: -1 }),
		/INVALID_ARDY_GENERATE_REQUEST/,
	);
	assert.equal(parseArdyGenerateRequest({ ...baseRequest, duration_seconds: 0.0001 }).duration_seconds, 0.0001);
	// 1200 is the inclusive maximum: the add-on caps a motion at MAX_FRAMES
	// 24000 = 20 minutes at 20 fps, so nothing longer could ever be applied.
	assert.deepEqual(parseArdyGenerateRequest({ ...baseRequest, duration_seconds: 1200 }).duration_seconds, 1200);
	assert.throws(
		() => parseArdyGenerateRequest({ ...baseRequest, duration_seconds: 1200.0001 }),
		/INVALID_ARDY_GENERATE_REQUEST/,
	);
});

test("request: prompt must be 1..512 characters (single prompt, no --segment)", () => {
	assert.throws(() => parseArdyGenerateRequest({ ...baseRequest, prompt: "" }), /INVALID_ARDY_GENERATE_REQUEST/);
	assert.equal(parseArdyGenerateRequest({ ...baseRequest, prompt: "p" }).prompt, "p");
	const at512 = "p".repeat(512);
	assert.equal(parseArdyGenerateRequest({ ...baseRequest, prompt: at512 }).prompt.length, 512);
	assert.throws(
		() => parseArdyGenerateRequest({ ...baseRequest, prompt: "p".repeat(513) }),
		/INVALID_ARDY_GENERATE_REQUEST/,
	);
});

test("request: seed must be an integer in 0..4294967295 or null", () => {
	assert.throws(() => parseArdyGenerateRequest({ ...baseRequest, seed: -1 }), /INVALID_ARDY_GENERATE_REQUEST/);
	assert.equal(parseArdyGenerateRequest({ ...baseRequest, seed: 0 }).seed, 0);
	assert.equal(parseArdyGenerateRequest({ ...baseRequest, seed: 4_294_967_295 }).seed, 4_294_967_295);
	assert.throws(
		() => parseArdyGenerateRequest({ ...baseRequest, seed: 4_294_967_296 }),
		/INVALID_ARDY_GENERATE_REQUEST/,
	);
	assert.throws(() => parseArdyGenerateRequest({ ...baseRequest, seed: 1.5 }), /INVALID_ARDY_GENERATE_REQUEST/);
});

test("request: requested_at_ms must be an integer >= 0", () => {
	assert.equal(parseArdyGenerateRequest({ ...baseRequest, requested_at_ms: 0 }).requested_at_ms, 0);
	assert.throws(
		() => parseArdyGenerateRequest({ ...baseRequest, requested_at_ms: -1 }),
		/INVALID_ARDY_GENERATE_REQUEST/,
	);
	assert.throws(
		() => parseArdyGenerateRequest({ ...baseRequest, requested_at_ms: 1.5 }),
		/INVALID_ARDY_GENERATE_REQUEST/,
	);
});

test("result: valid payload parses, seed null and number both pass", () => {
	assert.deepEqual(parseArdyGenerateResult(baseResult), baseResult);
	assert.deepEqual(parseArdyGenerateResult({ ...baseResult, seed: null }), { ...baseResult, seed: null });
});

test("result: malformed motion id rejected", () => {
	assert.throws(() => parseArdyGenerateResult({ ...baseResult, motion_id: "Wave" }), /INVALID_ARDY_GENERATE_RESULT/);
	assert.throws(() => parseArdyGenerateResult({ ...baseResult, motion_id: "-wave" }), /INVALID_ARDY_GENERATE_RESULT/);
	assert.throws(
		() => parseArdyGenerateResult({ ...baseResult, motion_id: `a${"b".repeat(64)}` }),
		/INVALID_ARDY_GENERATE_RESULT/,
	);
});

test("result: closed schema rejects unknown fields and out-of-range values", () => {
	assert.throws(() => parseArdyGenerateResult({ ...baseResult, extra: true }), /INVALID_ARDY_GENERATE_RESULT/);
	assert.throws(() => parseArdyGenerateResult({ ...baseResult, schema_version: 2 }), /INVALID_ARDY_GENERATE_RESULT/);
	// frames: just inside is 1 (a motion of a single frame is still a motion).
	assert.equal(parseArdyGenerateResult({ ...baseResult, frames: 1 }).frames, 1);
	assert.throws(() => parseArdyGenerateResult({ ...baseResult, frames: 0 }), /INVALID_ARDY_GENERATE_RESULT/);
	assert.throws(() => parseArdyGenerateResult({ ...baseResult, frames: -1 }), /INVALID_ARDY_GENERATE_RESULT/);
	assert.throws(
		() => parseArdyGenerateResult({ ...baseResult, duration_seconds: "5" }),
		/INVALID_ARDY_GENERATE_RESULT/,
	);
	assert.throws(
		() => parseArdyGenerateResult({ ...baseResult, expected_revision_id: revisionId }),
		/INVALID_ARDY_GENERATE_RESULT/,
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
	assert.deepEqual(parseArdyGenerateQueueOutcome(outcome), outcome);
});

test("outcome: every closed error code parses, codes outside the union fail", () => {
	for (const errorCode of ARDY_GENERATE_ERROR_CODES) {
		const outcome = {
			schema_version: 1,
			request_id: requestId,
			status: "failed",
			error_code: errorCode,
			message: "generation could not complete",
		};
		assert.deepEqual(parseArdyGenerateQueueOutcome(outcome), outcome);
	}
	assert.throws(
		() =>
			parseArdyGenerateQueueOutcome({
				schema_version: 1,
				request_id: requestId,
				status: "failed",
				error_code: "UNKNOWN_CODE",
				message: "boom",
			}),
		/INVALID_ARDY_GENERATE_OUTCOME/,
	);
});

test("outcome: unconstrained generate rejects base-motion and pose-capture codes", () => {
	// The first pass has no base motion and captures no poses, so the codes
	// the in-between surface keeps must NOT parse here.
	for (const errorCode of ["BASE_MOTION_NOT_FOUND", "POSE_CAPTURE_FAILED"]) {
		assert.throws(
			() =>
				parseArdyGenerateQueueOutcome({
					schema_version: 1,
					request_id: requestId,
					status: "failed",
					error_code: errorCode,
					message: "boom",
				}),
			/INVALID_ARDY_GENERATE_OUTCOME/,
		);
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
	const shortest = parseArdyGenerateQueueOutcome(failed("x"));
	assert.equal(shortest.status, "failed");
	if (shortest.status === "failed") assert.equal(shortest.message, "x");
	const longest = parseArdyGenerateQueueOutcome(failed("m".repeat(4096)));
	assert.equal(longest.status, "failed");
	if (longest.status === "failed") assert.equal(longest.message.length, 4096);
	assert.throws(() => parseArdyGenerateQueueOutcome(failed("")), /INVALID_ARDY_GENERATE_OUTCOME/);
	assert.throws(() => parseArdyGenerateQueueOutcome(failed("m".repeat(4097))), /INVALID_ARDY_GENERATE_OUTCOME/);
});

test("outcome: malformed outcomes fail", () => {
	// A third status value is not part of the closed outcome union.
	assert.throws(
		() =>
			parseArdyGenerateQueueOutcome({
				schema_version: 1,
				request_id: requestId,
				status: "pending",
			}),
		/INVALID_ARDY_GENERATE_OUTCOME/,
	);
	// succeeded without a result, and without the committed revision.
	assert.throws(
		() =>
			parseArdyGenerateQueueOutcome({
				schema_version: 1,
				request_id: requestId,
				status: "succeeded",
				resulting_revision_id: revisionId,
			}),
		/INVALID_ARDY_GENERATE_OUTCOME/,
	);
	assert.throws(
		() =>
			parseArdyGenerateQueueOutcome({
				schema_version: 1,
				request_id: requestId,
				status: "succeeded",
				result: baseResult,
			}),
		/INVALID_ARDY_GENERATE_OUTCOME/,
	);
	// succeeded with a malformed inner result (bad motion id).
	assert.throws(
		() =>
			parseArdyGenerateQueueOutcome({
				schema_version: 1,
				request_id: requestId,
				status: "succeeded",
				result: { ...baseResult, motion_id: "Bad" },
				resulting_revision_id: revisionId,
			}),
		/INVALID_ARDY_GENERATE_OUTCOME/,
	);
	// failed with an empty message.
	assert.throws(
		() =>
			parseArdyGenerateQueueOutcome({
				schema_version: 1,
				request_id: requestId,
				status: "failed",
				error_code: "GENERATION_FAILED",
				message: "",
			}),
		/INVALID_ARDY_GENERATE_OUTCOME/,
	);
	// unknown fields are rejected at the outcome level.
	assert.throws(
		() =>
			parseArdyGenerateQueueOutcome({
				schema_version: 1,
				request_id: requestId,
				status: "succeeded",
				result: baseResult,
				resulting_revision_id: revisionId,
				extra: true,
			}),
		/INVALID_ARDY_GENERATE_OUTCOME/,
	);
});

test("error codes: ardy_generate contract codes are stable and in order", () => {
	// The unconstrained first pass has no base motion and captures no poses,
	// so BASE_MOTION_NOT_FOUND and POSE_CAPTURE_FAILED are absent here.
	assert.deepEqual(ARDY_GENERATE_ERROR_CODES, [
		"INVALID_ARDY_GENERATE_REQUEST",
		"ENTITY_NOT_FOUND",
		"REVISION_MISMATCH",
		"ARDY_HOST_UNAVAILABLE",
		"GENERATION_FAILED",
		"GENERATION_INTERRUPTED",
		"APPLY_FAILED",
	]);
});
