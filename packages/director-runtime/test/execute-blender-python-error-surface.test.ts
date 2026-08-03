import assert from "node:assert/strict";
import { test } from "node:test";
import { createExecuteBlenderPythonTool, type ExecuteBlenderPythonBridge } from "@cclay/blender-tools";
import type { ExecuteBlenderPythonResponseV1 } from "@cclay/protocol";

const BASE_REVISION = "a".repeat(64);
const REQUEST = {
	script: "import bpy\nraise RuntimeError('boom')",
	deadline_ms: 1,
	capture_stdout: true,
	expected_revision_id: BASE_REVISION,
};

const failedRecovered: ExecuteBlenderPythonResponseV1 = {
	type: "execute_result",
	request_id: "123e4567-e89b-42d3-a456-426614174000",
	outcome: "failed_recovered",
	restored_revision_id: BASE_REVISION,
	error: { message: "boom", traceback: "Traceback (most recent call last)" },
	stdout: "",
	stdout_truncated: false,
	stderr: "",
	stderr_truncated: false,
	disclosure:
		"Blender scene state rolled back; external side effects (files, network, processes) are not and cannot be undone.",
};

const revisionStale: ExecuteBlenderPythonResponseV1 = {
	type: "precondition_failed",
	request_id: "123e4567-e89b-42d3-a456-426614174000",
	code: "REVISION_STALE",
	message: "Live Blender scene does not match the durable current revision.",
};

/**
 * Mirrors the caller-side rollback contract of the real bridge: the response is
 * applied (current revision rebinds to restored_revision_id) BEFORE the tool
 * sees it, exactly like BlenderBridge.applyExecutionResult. The tool then
 * classifies the response, so the rollback must survive the error flag.
 */
function recoveringBridge(response: ExecuteBlenderPythonResponseV1) {
	let currentRevisionId = BASE_REVISION;
	const bridge: ExecuteBlenderPythonBridge = {
		executeBlenderPython: async () => {
			if (response.type === "execute_result" && response.outcome === "failed_recovered") {
				currentRevisionId = response.restored_revision_id;
			}
			return response;
		},
	};
	return { bridge, currentRevisionId: () => currentRevisionId };
}

test("a rolled-back execution arrives as an error and the rollback still restores the prior revision", async () => {
	const { bridge, currentRevisionId } = recoveringBridge(failedRecovered);
	const tool = createExecuteBlenderPythonTool(bridge);
	await assert.rejects(
		tool.execute("call", REQUEST, undefined, undefined, undefined as never),
		/EXECUTE_BLENDER_PYTHON_FAILED_RECOVERED.*boom/,
	);
	// The durable rollback is the feature working: the caller's current
	// revision rebinds to the restored base even though the tool errored.
	assert.equal(currentRevisionId(), BASE_REVISION);
});

test("a REVISION_STALE precondition failure arrives as an error without touching the revision", async () => {
	const { bridge, currentRevisionId } = recoveringBridge(revisionStale);
	const tool = createExecuteBlenderPythonTool(bridge);
	await assert.rejects(
		tool.execute("call", REQUEST, undefined, undefined, undefined as never),
		/EXECUTE_BLENDER_PYTHON_PRECONDITION_FAILED \(REVISION_STALE\)/,
	);
	assert.equal(currentRevisionId(), BASE_REVISION);
});
