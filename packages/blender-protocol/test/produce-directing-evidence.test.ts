import assert from "node:assert/strict";
import test from "node:test";
import {
	type ProduceDirectingEvidenceResultV1,
	parseProduceDirectingEvidenceResult,
} from "../src/produce-directing-evidence.ts";

function validResult(): ProduceDirectingEvidenceResultV1 {
	return {
		schema_version: 1,
		evidence_sha256: "a".repeat(64),
		revision_id: "b".repeat(64),
		scene_hash: "c".repeat(64),
		frame_range: { start: 1, end: 250 },
		byte_length: 2048,
	};
}

test("accepts a well-formed produce_directing_evidence result", () => {
	const parsed = parseProduceDirectingEvidenceResult(validResult());
	assert.deepEqual(parsed, validResult());
});

test("accepts a single-frame range where start equals end", () => {
	const result = { ...validResult(), frame_range: { start: 80, end: 80 } };
	assert.deepEqual(parseProduceDirectingEvidenceResult(result).frame_range, { start: 80, end: 80 });
});

test("rejects non-lowerhex and wrong-length digests", () => {
	for (const digest of ["A".repeat(64), "g".repeat(64), "a".repeat(63), "a".repeat(65), ""]) {
		for (const field of ["evidence_sha256", "revision_id", "scene_hash"] as const) {
			assert.throws(
				() => parseProduceDirectingEvidenceResult({ ...validResult(), [field]: digest }),
				/INVALID_PRODUCE_EVIDENCE_RESULT/,
			);
		}
	}
});

test("rejects negative, non-integer, and inverted frame ranges", () => {
	for (const range of [
		{ start: -1, end: 10 },
		{ start: 0, end: -1 },
		{ start: 1.5, end: 10 },
		{ start: 0, end: 10.5 },
	]) {
		assert.throws(
			() => parseProduceDirectingEvidenceResult({ ...validResult(), frame_range: range }),
			/INVALID_PRODUCE_EVIDENCE_RESULT/,
		);
	}
	assert.throws(
		() => parseProduceDirectingEvidenceResult({ ...validResult(), frame_range: { start: 100, end: 99 } }),
		/INVALID_PRODUCE_EVIDENCE_RESULT: frame_range start must not exceed end/,
	);
});

test("rejects a non-positive or non-integer byte_length", () => {
	for (const byteLength of [0, -1, 1.5]) {
		assert.throws(
			() => parseProduceDirectingEvidenceResult({ ...validResult(), byte_length: byteLength }),
			/INVALID_PRODUCE_EVIDENCE_RESULT/,
		);
	}
});

test("rejects unknown extra keys at the top level and inside frame_range", () => {
	assert.throws(
		() => parseProduceDirectingEvidenceResult({ ...validResult(), extra: true }),
		/INVALID_PRODUCE_EVIDENCE_RESULT/,
	);
	assert.throws(
		() =>
			parseProduceDirectingEvidenceResult({
				...validResult(),
				frame_range: { start: 1, end: 250, step: 1 },
			}),
		/INVALID_PRODUCE_EVIDENCE_RESULT/,
	);
});

test("rejects missing keys and a wrong schema_version", () => {
	const { byte_length: _omitted, ...missing } = validResult();
	assert.throws(() => parseProduceDirectingEvidenceResult(missing), /INVALID_PRODUCE_EVIDENCE_RESULT/);
	assert.throws(
		() => parseProduceDirectingEvidenceResult({ ...validResult(), schema_version: 2 }),
		/INVALID_PRODUCE_EVIDENCE_RESULT/,
	);
});
