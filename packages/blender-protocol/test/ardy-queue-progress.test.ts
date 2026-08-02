import assert from "node:assert/strict";
import { test } from "node:test";
import { ARDY_QUEUE_PROGRESS_RESULT_MAX_BYTES, parseArdyQueueProgress } from "../src/ardy-queue-progress.ts";

const motionId = "walk-forward-01";
// Same 32-hex uuid4 filename grammar as every other ARDY bridge request_id.
const requestId = "0123456789abcdef0123456789abcdef";
const revisionId = "a".repeat(64);
// The capability result is opaque at the protocol layer: any JSON object
// parses here, and the queue validates the closed capability shape with its
// own result parser when the record is read.
const result = {
	schema_version: 1,
	request_id: requestId,
	motion_id: motionId,
	frames: 100,
	nested: { continuity: { mean_jump_m: 0.01 }, tags: ["a", "b"] },
};

test("progress: every status parses with its full recorded result", () => {
	const generated = {
		schema_version: 1,
		request_id: requestId,
		status: "generated",
		motion_id: motionId,
		result,
	};
	assert.deepEqual(parseArdyQueueProgress(generated), generated);

	const committed = {
		schema_version: 1,
		request_id: requestId,
		status: "committed",
		motion_id: motionId,
		result,
	};
	assert.deepEqual(parseArdyQueueProgress(committed), committed);

	const applied = {
		schema_version: 1,
		request_id: requestId,
		status: "applied",
		motion_id: motionId,
		result,
		resulting_revision_id: revisionId,
	};
	assert.deepEqual(parseArdyQueueProgress(applied), applied);
});

test("progress: the pre-run 'generating' status is rejected", () => {
	// The record is only written after the run completes and the motion id
	// exists, so a pre-run status is not a valid write-ahead state.
	assert.throws(
		() =>
			parseArdyQueueProgress({
				schema_version: 1,
				request_id: requestId,
				status: "generating",
				motion_id: motionId,
				result,
			}),
		/INVALID_ARDY_QUEUE_PROGRESS/,
	);
});

test("progress: a fourth status value fails", () => {
	assert.throws(
		() =>
			parseArdyQueueProgress({
				schema_version: 1,
				request_id: requestId,
				status: "failed",
				motion_id: motionId,
				result,
			}),
		/INVALID_ARDY_QUEUE_PROGRESS/,
	);
});

test("progress: a member without its result fails", () => {
	// Every member carries the full capability result; a record without one
	// could never reproduce the request's outcome on replay.
	for (const status of ["generated", "committed", "applied"]) {
		assert.throws(
			() =>
				parseArdyQueueProgress({
					schema_version: 1,
					request_id: requestId,
					status,
					motion_id: motionId,
					...(status === "applied" ? { resulting_revision_id: revisionId } : {}),
				}),
			/INVALID_ARDY_QUEUE_PROGRESS/,
			`${status} without result must fail`,
		);
	}
});

test("progress: the result is bounded to a JSON object", () => {
	// The result must be an object -- never null, a scalar, an array, or a
	// boolean -- so a record cannot smuggle an unbounded or untyped payload
	// past the closed schema.
	for (const bad of [42, "not-an-object", null, [1, 2], true]) {
		assert.throws(
			() =>
				parseArdyQueueProgress({
					schema_version: 1,
					request_id: requestId,
					status: "generated",
					motion_id: motionId,
					result: bad,
				}),
			/INVALID_ARDY_QUEUE_PROGRESS/,
			`result ${JSON.stringify(bad)} must be rejected`,
		);
	}
	// The bound is a property ceiling far above any capability result (the
	// largest closed results have eight top-level properties), so a record
	// cannot grow into an unbounded blob.
	const oversized: Record<string, number> = { seed: 1 };
	for (let index = 0; index < 64; index++) {
		oversized[`key-${index}`] = index;
	}
	assert.throws(
		() =>
			parseArdyQueueProgress({
				schema_version: 1,
				request_id: requestId,
				status: "generated",
				motion_id: motionId,
				result: oversized,
			}),
		/INVALID_ARDY_QUEUE_PROGRESS/,
	);
});
test("progress: the recorded result is bounded by serialized bytes, not by maxProperties", () => {
	// maxProperties only constrains the top level, so a single top-level
	// property holding a long array (a valid dropped_constraints list) or a
	// nested object holding one walks right past it. The serialized byte
	// ceiling is the bound that actually holds, and the rejection names
	// both the byte count and the ceiling.
	const serializedBytes = (payload: unknown) => Buffer.byteLength(JSON.stringify(payload), "utf8");
	const recordWith = (result: unknown) => ({
		schema_version: 1,
		request_id: requestId,
		status: "generated",
		motion_id: motionId,
		result,
	});

	// Two payload builders whose serialized size grows monotonically with
	// the element count, each with exactly one top-level property.
	const shapes: { build: (elements: number) => unknown }[] = [
		// The capability shape the ceiling comment names: a long
		// dropped_constraints list under one top-level property.
		{ build: (n) => ({ dropped_constraints: new Array(n).fill("constraint-a-realistic-name") }) },
		// A nested object under one top-level property: the property
		// ceiling cannot see inside either level.
		{ build: (n) => ({ continuity: { tags: new Array(n).fill("tag-a-realistic-name") } }) },
	];

	for (const shape of shapes) {
		// Find the first element count over the ceiling; one less is the
		// largest count still under it.
		let size = 1;
		while (serializedBytes(shape.build(size)) <= ARDY_QUEUE_PROGRESS_RESULT_MAX_BYTES) {
			size += 1;
		}
		// Just under the ceiling: accepted, and the result round-trips
		// verbatim.
		const under = shape.build(size - 1);
		assert.ok(serializedBytes(under) <= ARDY_QUEUE_PROGRESS_RESULT_MAX_BYTES);
		assert.deepEqual(parseArdyQueueProgress(recordWith(under)), recordWith(under));
		// One more element crosses the ceiling; the rejection names the
		// byte count and the ceiling.
		const over = shape.build(size);
		const overBytes = serializedBytes(over);
		assert.ok(overBytes > ARDY_QUEUE_PROGRESS_RESULT_MAX_BYTES);
		assert.throws(
			() => parseArdyQueueProgress(recordWith(over)),
			new RegExp(
				`recorded result is ${overBytes} bytes, over the ${ARDY_QUEUE_PROGRESS_RESULT_MAX_BYTES} byte ceiling`,
			),
		);
	}
});

test("progress: applied without resulting_revision_id fails", () => {
	assert.throws(
		() =>
			parseArdyQueueProgress({
				schema_version: 1,
				request_id: requestId,
				status: "applied",
				motion_id: motionId,
				result,
			}),
		/INVALID_ARDY_QUEUE_PROGRESS/,
	);
});

test("progress: generated with resulting_revision_id fails", () => {
	// Only the applied member carries resulting_revision_id; a generated
	// record predates any commit, so a revision on it is invalid.
	assert.throws(
		() =>
			parseArdyQueueProgress({
				schema_version: 1,
				request_id: requestId,
				status: "generated",
				motion_id: motionId,
				result,
				resulting_revision_id: revisionId,
			}),
		/INVALID_ARDY_QUEUE_PROGRESS/,
	);
});

test("progress: closed members reject unknown and cross-status fields", () => {
	// Extra fields fail on every member.
	for (const status of ["generated", "committed", "applied"]) {
		const base = {
			schema_version: 1,
			request_id: requestId,
			status,
			motion_id: motionId,
			result,
			...(status === "applied" ? { resulting_revision_id: revisionId } : {}),
		};
		assert.throws(() => parseArdyQueueProgress({ ...base, extra: true }), /INVALID_ARDY_QUEUE_PROGRESS/);
	}
	// resulting_revision_id is applied-only: a committed record carrying it
	// is not a valid write-ahead state.
	assert.throws(
		() =>
			parseArdyQueueProgress({
				schema_version: 1,
				request_id: requestId,
				status: "committed",
				motion_id: motionId,
				result,
				resulting_revision_id: revisionId,
			}),
		/INVALID_ARDY_QUEUE_PROGRESS/,
	);
});

test("progress: malformed motion id, hash, and identifiers fail", () => {
	assert.throws(
		() =>
			parseArdyQueueProgress({
				schema_version: 1,
				request_id: requestId,
				status: "generated",
				motion_id: "Walk",
				result,
			}),
		/INVALID_ARDY_QUEUE_PROGRESS/,
	);
	assert.throws(
		() =>
			parseArdyQueueProgress({
				schema_version: 1,
				request_id: requestId,
				status: "applied",
				motion_id: motionId,
				result,
				resulting_revision_id: "Z".repeat(64),
			}),
		/INVALID_ARDY_QUEUE_PROGRESS/,
	);
	// request_id follows the 32-hex filename grammar: empty, too short, and
	// non-hex ids are all unrepresentable.
	assert.throws(
		() =>
			parseArdyQueueProgress({
				schema_version: 1,
				request_id: "",
				status: "generated",
				motion_id: motionId,
				result,
			}),
		/INVALID_ARDY_QUEUE_PROGRESS/,
	);
	assert.throws(
		() =>
			parseArdyQueueProgress({
				schema_version: 1,
				request_id: "a".repeat(31),
				status: "generated",
				motion_id: motionId,
				result,
			}),
		/INVALID_ARDY_QUEUE_PROGRESS/,
	);
	assert.throws(
		() =>
			parseArdyQueueProgress({
				schema_version: 1,
				request_id: "gen-1742",
				status: "generated",
				motion_id: motionId,
				result,
			}),
		/INVALID_ARDY_QUEUE_PROGRESS/,
	);
	assert.throws(
		() =>
			parseArdyQueueProgress({
				schema_version: 2,
				request_id: requestId,
				status: "generated",
				motion_id: motionId,
				result,
			}),
		/INVALID_ARDY_QUEUE_PROGRESS/,
	);
});
