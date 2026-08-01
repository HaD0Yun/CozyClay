import assert from "node:assert/strict";
import { test } from "node:test";
import { parseArdyQueueProgress } from "../src/ardy-queue-progress.ts";

const motionId = "walk-forward-01";
// Same 32-hex uuid4 filename grammar as every other ARDY bridge request_id.
const requestId = "0123456789abcdef0123456789abcdef";
const revisionId = "a".repeat(64);

test("progress: every status parses", () => {
	const generated = {
		schema_version: 1,
		request_id: requestId,
		status: "generated",
		motion_id: motionId,
	};
	assert.deepEqual(parseArdyQueueProgress(generated), generated);

	const committed = {
		schema_version: 1,
		request_id: requestId,
		status: "committed",
		motion_id: motionId,
	};
	assert.deepEqual(parseArdyQueueProgress(committed), committed);

	const applied = {
		schema_version: 1,
		request_id: requestId,
		status: "applied",
		motion_id: motionId,
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
			}),
		/INVALID_ARDY_QUEUE_PROGRESS/,
	);
});

test("progress: applied without resulting_revision_id fails", () => {
	assert.throws(
		() =>
			parseArdyQueueProgress({
				schema_version: 1,
				request_id: requestId,
				status: "applied",
				motion_id: motionId,
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
			}),
		/INVALID_ARDY_QUEUE_PROGRESS/,
	);
});
