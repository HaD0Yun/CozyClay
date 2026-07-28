import assert from "node:assert/strict";
import { test } from "node:test";
import {
	ARDY_REGENERATE_ERROR_CODES,
	type ArdyRegenerateRequestV1,
	type ArdyRegenerateResultV1,
	parseArdyRegenerateRequest,
	parseArdyRegenerateResult,
} from "../src/ardy-regenerate.ts";

const entityId = "00000000-0000-4000-8000-000000000fff";
const revisionId = "a".repeat(64);
const requestId = "regen-1742";

const baseRequest: ArdyRegenerateRequestV1 = {
	schema_version: 1,
	request_id: requestId,
	entity_id: entityId,
	base_motion_id: "walk-forward-01",
	expected_revision_id: revisionId,
	effectors: [
		{ frame: 24, joint: "LeftFoot", x: 0.15, y: 0.18, z: 0.6 },
		{ frame: 38, joint: "RightFoot", x: 0.15, y: 0.36, z: 0.9 },
	],
	full_body: [{ frame: 0, synthetic_motion_id: "idle-pose-01" }],
	root_2d: [
		{ frame: 0, x: 0.0, z: 0.0, heading: null },
		{ frame: 60, x: 0.8, z: 0.2, heading: 1.5708 },
	],
	requested_at_ms: 1_753_500_000_000,
};

const fullResult: ArdyRegenerateResultV1 = {
	schema_version: 1,
	request_id: requestId,
	motion_id: "climb-steps-01",
	frames: 120,
	achieved_error_m: 0.012,
	residual: {
		max_error_m: 0.018,
		mean_error_m: 0.009,
		worst_frame: 38,
		worst_joint: "RightFoot",
	},
	continuity: { mean_jump_m: 0.042, max_jump_m: 0.121, max_jump_frame: 24 },
	dropped_constraints: [{ frame: 38, reason: "unreachable within iteration budget" }],
};

// Path-only or pose-only runs report no end-effector residual. measure_residuals
// returns None so a null here must not read as a perfect hit (see
// scripts/ardy/cclay_constrained_generate.py and
// blender-addon/tests/test_ardy_constraint_spec.py:ResidualTests).
const nullResidualResult: ArdyRegenerateResultV1 = {
	...fullResult,
	achieved_error_m: null,
	residual: null,
	dropped_constraints: [],
};

test("request: valid payload parses, empty constraint arrays allowed, heading null and number both pass", () => {
	assert.deepEqual(parseArdyRegenerateRequest(baseRequest), baseRequest);
	// All three constraint lists may be empty (a regenerate may pin only a
	// subset of the channels).
	const sparse: ArdyRegenerateRequestV1 = {
		...baseRequest,
		effectors: [],
		full_body: [],
		root_2d: [],
	};
	assert.deepEqual(parseArdyRegenerateRequest(sparse), sparse);
	// heading free (null) and heading pinned (radians) coexist in one array.
	assert.equal(parseArdyRegenerateRequest(baseRequest).root_2d[0]!.heading, null);
	assert.equal(parseArdyRegenerateRequest(baseRequest).root_2d[1]!.heading, 1.5708);
	// frame 0 is a valid (minimum) frame index.
	assert.equal(parseArdyRegenerateRequest(baseRequest).effectors[0]!.frame, 24);
});

test("request: motion_id grammar enforced on base_motion_id and synthetic_motion_id", () => {
	// Source of the grammar: scripts/cclay-ardy-generate:329
	// `# motion_id: addon grammar ^[a-z0-9][a-z0-9-]{0,63}$`.
	assert.throws(
		() => parseArdyRegenerateRequest({ ...baseRequest, base_motion_id: "Walk" }),
		/INVALID_ARDY_REGENERATE_REQUEST/,
	);
	assert.throws(
		() => parseArdyRegenerateRequest({ ...baseRequest, base_motion_id: "-walk" }),
		/INVALID_ARDY_REGENERATE_REQUEST/,
	);
	assert.throws(
		() => parseArdyRegenerateRequest({ ...baseRequest, base_motion_id: `a${"b".repeat(64)}` }),
		/INVALID_ARDY_REGENERATE_REQUEST/,
	);
	assert.throws(
		() =>
			parseArdyRegenerateRequest({
				...baseRequest,
				full_body: [{ frame: 0, synthetic_motion_id: "UPPER" }],
			}),
		/INVALID_ARDY_REGENERATE_REQUEST/,
	);
});

test("request: unknown fields rejected at every level (closed schemas)", () => {
	assert.throws(() => parseArdyRegenerateRequest({ ...baseRequest, extra: true }), /INVALID_ARDY_REGENERATE_REQUEST/);
	assert.throws(
		() =>
			parseArdyRegenerateRequest({
				...baseRequest,
				effectors: [{ ...baseRequest.effectors[0]!, extra: true }],
			}),
		/INVALID_ARDY_REGENERATE_REQUEST/,
	);
	assert.throws(
		() =>
			parseArdyRegenerateRequest({
				...baseRequest,
				full_body: [{ ...baseRequest.full_body[0]!, extra: true }],
			}),
		/INVALID_ARDY_REGENERATE_REQUEST/,
	);
	assert.throws(
		() =>
			parseArdyRegenerateRequest({
				...baseRequest,
				root_2d: [{ ...baseRequest.root_2d[0]!, extra: true }],
			}),
		/INVALID_ARDY_REGENERATE_REQUEST/,
	);
});

test("request: wrong types and out-of-range values rejected", () => {
	assert.throws(
		() => parseArdyRegenerateRequest({ ...baseRequest, schema_version: 2 }),
		/INVALID_ARDY_REGENERATE_REQUEST/,
	);
	assert.throws(
		() => parseArdyRegenerateRequest({ ...baseRequest, entity_id: "not-a-uuid" }),
		/INVALID_ARDY_REGENERATE_REQUEST/,
	);
	assert.throws(
		() => parseArdyRegenerateRequest({ ...baseRequest, entity_id: entityId.toUpperCase() }),
		/INVALID_ARDY_REGENERATE_REQUEST/,
	);
	assert.throws(
		() => parseArdyRegenerateRequest({ ...baseRequest, expected_revision_id: "Z".repeat(64) }),
		/INVALID_ARDY_REGENERATE_REQUEST/,
	);
	// effectors joint is a closed enum, not a free string.
	assert.throws(
		() =>
			parseArdyRegenerateRequest({
				...baseRequest,
				effectors: [{ frame: 24, joint: "LeftKnee", x: 0, y: 0, z: 0 }],
			}),
		/INVALID_ARDY_REGENERATE_REQUEST/,
	);
	// negative frame index is invalid even though the addon clips frames;
	// the bridge rejects before the remote is contacted.
	assert.throws(
		() =>
			parseArdyRegenerateRequest({
				...baseRequest,
				effectors: [{ frame: -1, joint: "LeftFoot", x: 0, y: 0, z: 0 }],
			}),
		/INVALID_ARDY_REGENERATE_REQUEST/,
	);
	// coordinates must be numbers, not strings.
	assert.throws(
		() =>
			parseArdyRegenerateRequest({
				...baseRequest,
				effectors: [{ frame: 24, joint: "LeftFoot", x: "0", y: 0, z: 0 }],
			}),
		/INVALID_ARDY_REGENERATE_REQUEST/,
	);
	assert.throws(
		() => parseArdyRegenerateRequest({ ...baseRequest, requested_at_ms: -1 }),
		/INVALID_ARDY_REGENERATE_REQUEST/,
	);
	assert.throws(
		() => parseArdyRegenerateRequest({ ...baseRequest, requested_at_ms: 1.5 }),
		/INVALID_ARDY_REGENERATE_REQUEST/,
	);
	// heading must be number or null, never a string sentinel.
	assert.throws(
		() =>
			parseArdyRegenerateRequest({
				...baseRequest,
				root_2d: [{ frame: 0, x: 0, z: 0, heading: "none" }],
			}),
		/INVALID_ARDY_REGENERATE_REQUEST/,
	);
});

test("result: full residual parses, null residual parses, dropped_constraints empty allowed", () => {
	assert.deepEqual(parseArdyRegenerateResult(fullResult), fullResult);
	assert.deepEqual(parseArdyRegenerateResult(nullResidualResult), nullResidualResult);
	assert.equal(parseArdyRegenerateResult(nullResidualResult).achieved_error_m, null);
	assert.equal(parseArdyRegenerateResult(nullResidualResult).residual, null);
	assert.deepEqual(parseArdyRegenerateResult(nullResidualResult).dropped_constraints, []);
});

test("result: motion_id grammar enforced on the generated motion_id", () => {
	assert.throws(
		() => parseArdyRegenerateResult({ ...fullResult, motion_id: "Climb" }),
		/INVALID_ARDY_REGENERATE_RESULT/,
	);
	assert.throws(
		() => parseArdyRegenerateResult({ ...fullResult, motion_id: "-climb" }),
		/INVALID_ARDY_REGENERATE_RESULT/,
	);
	assert.throws(
		() => parseArdyRegenerateResult({ ...fullResult, motion_id: `a${"b".repeat(64)}` }),
		/INVALID_ARDY_REGENERATE_RESULT/,
	);
});

test("result: closed schemas reject extra properties anywhere", () => {
	assert.throws(() => parseArdyRegenerateResult({ ...fullResult, extra: true }), /INVALID_ARDY_REGENERATE_RESULT/);
	assert.throws(
		() =>
			parseArdyRegenerateResult({
				...fullResult,
				residual: { ...fullResult.residual!, extra: true },
			}),
		/INVALID_ARDY_REGENERATE_RESULT/,
	);
	assert.throws(
		() =>
			parseArdyRegenerateResult({
				...fullResult,
				continuity: { ...fullResult.continuity, extra: true },
			}),
		/INVALID_ARDY_REGENERATE_RESULT/,
	);
	assert.throws(
		() =>
			parseArdyRegenerateResult({
				...fullResult,
				dropped_constraints: [{ ...fullResult.dropped_constraints[0]!, extra: true }],
			}),
		/INVALID_ARDY_REGENERATE_RESULT/,
	);
});

test("result: wrong types, bad version, bad integers, residual-vs-null coupling rejected", () => {
	assert.throws(
		() => parseArdyRegenerateResult({ ...fullResult, schema_version: 2 }),
		/INVALID_ARDY_REGENERATE_RESULT/,
	);
	assert.throws(() => parseArdyRegenerateResult({ ...fullResult, frames: 0 }), /INVALID_ARDY_REGENERATE_RESULT/);
	assert.throws(() => parseArdyRegenerateResult({ ...fullResult, frames: -1 }), /INVALID_ARDY_REGENERATE_RESULT/);
	// worst_joint is the closed effector vocabulary, not a free string.
	assert.throws(
		() =>
			parseArdyRegenerateResult({
				...fullResult,
				residual: { ...fullResult.residual!, worst_joint: "LeftKnee" },
			}),
		/INVALID_ARDY_REGENERATE_RESULT/,
	);
	assert.throws(
		() =>
			parseArdyRegenerateResult({
				...fullResult,
				residual: { ...fullResult.residual!, worst_frame: -1 },
			}),
		/INVALID_ARDY_REGENERATE_RESULT/,
	);
	// continuity is always required, even on a path-only run.
	// continuity is always required, even on a path-only run.
	assert.throws(() => {
		const { continuity: _dropped, ...withoutContinuity } = nullResidualResult;
		parseArdyRegenerateResult(withoutContinuity);
	}, /INVALID_ARDY_REGENERATE_RESULT/);
	// dropped_constraints reason must be non-empty.
	assert.throws(
		() =>
			parseArdyRegenerateResult({
				...fullResult,
				dropped_constraints: [{ frame: 38, reason: "" }],
			}),
		/INVALID_ARDY_REGENERATE_RESULT/,
	);
});

test("error codes: ardy_regenerate contract codes are stable", () => {
	assert.deepEqual(ARDY_REGENERATE_ERROR_CODES, [
		"INVALID_ARDY_REGENERATE_REQUEST",
		"BASE_MOTION_NOT_FOUND",
		"ENTITY_NOT_FOUND",
		"REVISION_MISMATCH",
		"GENERATION_FAILED",
	]);
});
