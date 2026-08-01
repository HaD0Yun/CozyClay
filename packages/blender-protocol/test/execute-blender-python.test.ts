import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	EXECUTE_BLENDER_PYTHON_EXTERNAL_SIDE_EFFECT_DISCLOSURE,
	EXECUTE_BLENDER_PYTHON_MAX_DEADLINE_MS,
	EXECUTE_BLENDER_PYTHON_MAX_ERROR_MESSAGE_BYTES,
	EXECUTE_BLENDER_PYTHON_MAX_OUTPUT_BYTES,
	EXECUTE_BLENDER_PYTHON_MAX_REASON_BYTES,
	EXECUTE_BLENDER_PYTHON_MAX_SCRIPT_BYTES,
	EXECUTE_BLENDER_PYTHON_MAX_TRACEBACK_BYTES,
	parseBlenderBridgeDiscovery,
	parseBlenderBridgeHello,
	parseBlenderBridgeHelloAck,
	parseBlenderBridgeHelloReject,
	parseExecuteBlenderPythonRequest,
	parseExecuteBlenderPythonResponse,
	parseExecuteBlenderPythonResult,
	parseGetExecutionOutcomeRequest,
	parseGetExecutionOutcomeResponse,
} from "../src/execute-blender-python.ts";

const requestId = "123e4567-e89b-42d3-a456-426614174000";
const revisionId = "a".repeat(64);
const childRevisionId = "b".repeat(64);
const token = "A".repeat(43);
const exceedsUtf8ByteCeiling = (maximum: number) => "😀".repeat(Math.floor(maximum / 4) + 1);

const request = {
	type: "execute_blender_python",
	request_id: requestId,
	script: "print('hello')",
	deadline_ms: 30_000,
	capture_stdout: true,
	expected_revision_id: revisionId,
} as const;

const success = {
	type: "execute_result",
	request_id: requestId,
	outcome: "success",
	new_revision_id: childRevisionId,
	stdout: "hello\n",
	stdout_truncated: false,
	stderr: "",
	stderr_truncated: false,
} as const;

const failedRecovered = {
	type: "execute_result",
	request_id: requestId,
	outcome: "failed_recovered",
	restored_revision_id: revisionId,
	error: { message: "script failed", traceback: "Traceback" },
	stdout: "",
	stdout_truncated: false,
	stderr: "error\n",
	stderr_truncated: false,
	disclosure: EXECUTE_BLENDER_PYTHON_EXTERNAL_SIDE_EFFECT_DISCLOSURE,
} as const;

const recoveryRequired = {
	type: "execute_result",
	request_id: requestId,
	outcome: "recovery_required",
	journal_status: "recovery_verification_failed",
} as const;

const outcomeUnknown = {
	type: "execute_result",
	request_id: requestId,
	outcome: "outcome_unknown",
	reason: "journal_missing",
} as const;

const preconditionFailed = {
	type: "precondition_failed",
	request_id: requestId,
	code: "BACKUP_UNAVAILABLE",
	message: "backup fsync failed",
} as const;

describe("execute_blender_python protocol", () => {
	it("round trips its closed request and all five response shapes", () => {
		assert.deepEqual(parseExecuteBlenderPythonRequest(request), request);
		for (const response of [success, failedRecovered, recoveryRequired, outcomeUnknown, preconditionFailed]) {
			assert.deepEqual(parseExecuteBlenderPythonResponse(response), response);
		}
	});

	it("rejects malformed request IDs, revisions, bounds, and unknown fields", () => {
		assert.throws(() => parseExecuteBlenderPythonRequest({ ...request, request_id: requestId.toUpperCase() }), {
			message: /^INVALID_EXECUTE_BLENDER_PYTHON_REQUEST:/,
		});
		assert.throws(() => parseExecuteBlenderPythonRequest({ ...request, expected_revision_id: "A".repeat(64) }));
		assert.throws(() =>
			parseExecuteBlenderPythonRequest({ ...request, deadline_ms: EXECUTE_BLENDER_PYTHON_MAX_DEADLINE_MS + 1 }),
		);
		assert.throws(() => parseExecuteBlenderPythonRequest({ ...request, script: "x".repeat(8193) }));
		assert.throws(() => parseExecuteBlenderPythonRequest({ ...request, ignored: true }));
	});

	it("keeps execution outcomes disjoint from precondition failures", () => {
		assert.throws(() => parseExecuteBlenderPythonResult(preconditionFailed), {
			message: /^INVALID_EXECUTE_BLENDER_PYTHON_RESULT:/,
		});
		assert.throws(() => parseExecuteBlenderPythonResponse({ ...preconditionFailed, outcome: "success" }));
	});

	it("does not permit failed_recovered to mint a child revision", () => {
		assert.throws(() => parseExecuteBlenderPythonResult({ ...failedRecovered, new_revision_id: childRevisionId }));
		assert.throws(() => parseExecuteBlenderPythonResult({ ...failedRecovered, disclosure: "rollback happened" }));
	});

	it("enforces UTF-8 byte ceilings after closed-schema parsing", () => {
		assert.deepEqual(
			parseExecuteBlenderPythonRequest({
				...request,
				script: "😀".repeat(EXECUTE_BLENDER_PYTHON_MAX_SCRIPT_BYTES / 4),
			}),
			{ ...request, script: "😀".repeat(EXECUTE_BLENDER_PYTHON_MAX_SCRIPT_BYTES / 4) },
		);
		assert.deepEqual(
			parseExecuteBlenderPythonResponse({
				...success,
				stdout: "😀".repeat(EXECUTE_BLENDER_PYTHON_MAX_OUTPUT_BYTES / 4),
				stderr: "😀".repeat(EXECUTE_BLENDER_PYTHON_MAX_OUTPUT_BYTES / 4),
			}),
			{
				...success,
				stdout: "😀".repeat(EXECUTE_BLENDER_PYTHON_MAX_OUTPUT_BYTES / 4),
				stderr: "😀".repeat(EXECUTE_BLENDER_PYTHON_MAX_OUTPUT_BYTES / 4),
			},
		);
		assert.throws(
			() =>
				parseExecuteBlenderPythonRequest({
					...request,
					script: exceedsUtf8ByteCeiling(EXECUTE_BLENDER_PYTHON_MAX_SCRIPT_BYTES),
				}),
			{ message: /^INVALID_EXECUTE_BLENDER_PYTHON_REQUEST:/ },
		);
		assert.throws(
			() =>
				parseExecuteBlenderPythonResponse({
					...success,
					stdout: exceedsUtf8ByteCeiling(EXECUTE_BLENDER_PYTHON_MAX_OUTPUT_BYTES),
				}),
			{ message: /^INVALID_EXECUTE_BLENDER_PYTHON_RESPONSE:/ },
		);
		assert.throws(
			() =>
				parseGetExecutionOutcomeResponse({
					...success,
					stderr: exceedsUtf8ByteCeiling(EXECUTE_BLENDER_PYTHON_MAX_OUTPUT_BYTES),
				}),
			{ message: /^INVALID_EXECUTE_BLENDER_PYTHON_OUTCOME_RESPONSE:/ },
		);
		assert.throws(
			() =>
				parseExecuteBlenderPythonResult({
					...failedRecovered,
					error: {
						...failedRecovered.error,
						message: exceedsUtf8ByteCeiling(EXECUTE_BLENDER_PYTHON_MAX_ERROR_MESSAGE_BYTES),
					},
				}),
			{ message: /^INVALID_EXECUTE_BLENDER_PYTHON_RESULT:/ },
		);
		assert.throws(
			() =>
				parseExecuteBlenderPythonResult({
					...failedRecovered,
					error: {
						...failedRecovered.error,
						traceback: exceedsUtf8ByteCeiling(EXECUTE_BLENDER_PYTHON_MAX_TRACEBACK_BYTES),
					},
				}),
			{ message: /^INVALID_EXECUTE_BLENDER_PYTHON_RESULT:/ },
		);
		assert.throws(
			() =>
				parseExecuteBlenderPythonResult({
					...outcomeUnknown,
					reason: exceedsUtf8ByteCeiling(EXECUTE_BLENDER_PYTHON_MAX_REASON_BYTES),
				}),
			{ message: /^INVALID_EXECUTE_BLENDER_PYTHON_RESULT:/ },
		);
		assert.throws(
			() =>
				parseExecuteBlenderPythonResponse({
					...preconditionFailed,
					message: exceedsUtf8ByteCeiling(EXECUTE_BLENDER_PYTHON_MAX_ERROR_MESSAGE_BYTES),
				}),
			{ message: /^INVALID_EXECUTE_BLENDER_PYTHON_RESPONSE:/ },
		);
	});
	it("bounds captured output and requires truncation metadata", () => {
		assert.throws(() =>
			parseExecuteBlenderPythonResult({
				...success,
				stdout: "x".repeat(EXECUTE_BLENDER_PYTHON_MAX_OUTPUT_BYTES + 1),
			}),
		);
		const { stderr_truncated: _stderrTruncated, ...missingMetadata } = success;
		assert.throws(() => parseExecuteBlenderPythonResult(missingMetadata));
	});

	it("round trips outcome queries and distinguishes an absent journal entry", () => {
		const query = { type: "get_execution_outcome", request_id: requestId } as const;
		const notFound = { type: "execution_outcome_not_found", request_id: requestId } as const;
		assert.deepEqual(parseGetExecutionOutcomeRequest(query), query);
		assert.deepEqual(parseGetExecutionOutcomeResponse(success), success);
		assert.deepEqual(parseGetExecutionOutcomeResponse(notFound), notFound);
		assert.throws(() => parseGetExecutionOutcomeResponse(preconditionFailed));
	});

	it("requires exact discovery and hello authentication/version records", () => {
		const discovery = {
			schema_version: 1,
			host: "127.0.0.1",
			port: 43123,
			pid: 1234,
			token,
			token_generation: 2,
			addon_version: "1.2.3",
			protocol_version: 1,
		} as const;
		const hello = {
			type: "hello",
			token,
			client: "cclay-extension",
			protocol_version: 1,
			capabilities: ["execute_blender_python", "get_execution_outcome"],
		} as const;
		const ack = {
			type: "hello_ack",
			addon_version: "1.2.3",
			protocol_version: 1,
			capabilities: ["execute_blender_python"],
		} as const;
		assert.deepEqual(parseBlenderBridgeDiscovery(discovery), discovery);
		assert.deepEqual(parseBlenderBridgeHello(hello), hello);
		assert.deepEqual(parseBlenderBridgeHelloAck(ack), ack);
		for (const reason of ["BAD_TOKEN", "VERSION_MISMATCH", "QUEUE_FULL", "PROJECT_ALREADY_ATTACHED"] as const) {
			assert.deepEqual(parseBlenderBridgeHelloReject({ type: "hello_reject", reason }), {
				type: "hello_reject",
				reason,
			});
		}
		assert.throws(() => parseBlenderBridgeDiscovery({ ...discovery, token: `${token}=` }));
		assert.throws(() => parseBlenderBridgeHello({ ...hello, protocol_version: 2 }));
		assert.throws(() => parseBlenderBridgeHelloAck({ ...ack, unknown: true }));
	});
});
