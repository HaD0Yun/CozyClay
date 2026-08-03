import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExecuteBlenderPythonResponseV1 } from "@cclay/protocol";
import { createExecuteBlenderPythonTool, type ExecuteBlenderPythonBridge } from "../src/execute-blender-python.ts";

const REVISION = "a".repeat(64);
const REQUEST = {
	script: "import bpy",
	deadline_ms: 1,
	capture_stdout: true,
	expected_revision_id: REVISION,
};

const success: ExecuteBlenderPythonResponseV1 = {
	type: "execute_result",
	request_id: "123e4567-e89b-42d3-a456-426614174000",
	outcome: "success",
	new_revision_id: "b".repeat(64),
	stdout: "ok",
	stdout_truncated: false,
	stderr: "",
	stderr_truncated: false,
};

const failedRecovered: ExecuteBlenderPythonResponseV1 = {
	type: "execute_result",
	request_id: "123e4567-e89b-42d3-a456-426614174000",
	outcome: "failed_recovered",
	restored_revision_id: REVISION,
	error: { message: "'Action' object has no attribute 'fcurves'", traceback: "Traceback (most recent call last)" },
	stdout: "",
	stdout_truncated: false,
	stderr: "",
	stderr_truncated: false,
	disclosure:
		"Blender scene state rolled back; external side effects (files, network, processes) are not and cannot be undone.",
};

const preconditionFailed: ExecuteBlenderPythonResponseV1 = {
	type: "precondition_failed",
	request_id: "123e4567-e89b-42d3-a456-426614174000",
	code: "REVISION_STALE",
	message: "Live Blender scene does not match the durable current revision.",
};

const recoveryRequired: ExecuteBlenderPythonResponseV1 = {
	type: "execute_result",
	request_id: "123e4567-e89b-42d3-a456-426614174000",
	outcome: "recovery_required",
	journal_status: "recovery_verification_failed",
};

const outcomeUnknown: ExecuteBlenderPythonResponseV1 = {
	type: "execute_result",
	request_id: "123e4567-e89b-42d3-a456-426614174000",
	outcome: "outcome_unknown",
	reason: "bridge disconnected mid-execution",
};

function toolReturning(response: ExecuteBlenderPythonResponseV1) {
	const bridge: ExecuteBlenderPythonBridge = { executeBlenderPython: async () => response };
	return { bridge, tool: createExecuteBlenderPythonTool(bridge) };
}

test("execute_blender_python surfaces success as a normal tool result", async () => {
	const { tool } = toolReturning(success);
	const output = await tool.execute("call", REQUEST, undefined, undefined, undefined as never);
	assert.equal(output.details, success);
});

test("execute_blender_python surfaces a REVISION_STALE precondition failure as an error", async () => {
	const { tool } = toolReturning(preconditionFailed);
	await assert.rejects(
		tool.execute("call", REQUEST, undefined, undefined, undefined as never),
		/EXECUTE_BLENDER_PYTHON_PRECONDITION_FAILED \(REVISION_STALE\): Live Blender scene does not match/,
	);
});

test("execute_blender_python surfaces a rolled-back execution as an error carrying the restore revision", async () => {
	const { tool } = toolReturning(failedRecovered);
	await assert.rejects(
		tool.execute("call", REQUEST, undefined, undefined, undefined as never),
		(error: unknown) =>
			error instanceof Error &&
			error.message.includes("EXECUTE_BLENDER_PYTHON_FAILED_RECOVERED") &&
			error.message.includes("'Action' object has no attribute 'fcurves'") &&
			error.message.includes(REVISION),
	);
});

test("execute_blender_python surfaces unknown-outcome executions as errors", async () => {
	for (const response of [recoveryRequired, outcomeUnknown]) {
		const { tool } = toolReturning(response);
		await assert.rejects(tool.execute("call", REQUEST, undefined, undefined, undefined as never));
	}
});
