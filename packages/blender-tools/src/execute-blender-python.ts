import {
	type ExecuteBlenderPythonRequestV1,
	ExecuteBlenderPythonRequestV1Schema,
	type ExecuteBlenderPythonResponseV1,
} from "@cclay/protocol";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const ExecuteBlenderPythonToolRequestSchema = Type.Omit(ExecuteBlenderPythonRequestV1Schema, ["type", "request_id"]);

/**
 * Classify a bridge response for the caller. Every non-success outcome is a
 * failure even when Blender rolled the scene back cleanly: `failed_recovered`
 * means the script raised, `precondition_failed` means the request was never
 * executed, and the two unknown-outcome states mean the mutation result is not
 * safely known. Returning those as ordinary tool results taught the model that
 * a rolled-back run was fine and halved the error count in telemetry, so the
 * tool throws instead and the agent loop surfaces them with `isError: true`.
 * The bridge still returns the typed response and updates its own revision
 * tracking before this classification runs, so the durable rollback semantics
 * are unchanged.
 */
function executionFailure(result: ExecuteBlenderPythonResponseV1): Error | undefined {
	if (result.type === "precondition_failed") {
		return new Error(`EXECUTE_BLENDER_PYTHON_PRECONDITION_FAILED (${result.code}): ${result.message}`);
	}
	switch (result.outcome) {
		case "success":
			return undefined;
		case "failed_recovered":
			return new Error(
				`EXECUTE_BLENDER_PYTHON_FAILED_RECOVERED: ${result.error.message} — Blender restored revision ` +
					`${result.restored_revision_id}. External side effects (files, network, processes) are not undone.`,
			);
		case "recovery_required":
			return new Error("EXECUTE_BLENDER_PYTHON_RECOVERY_REQUIRED: execution outcome requires recovery");
		case "outcome_unknown":
			return new Error(`EXECUTE_BLENDER_PYTHON_OUTCOME_UNKNOWN: ${result.reason}`);
	}
}

export interface ExecuteBlenderPythonBridge {
	executeBlenderPython(
		request: Omit<ExecuteBlenderPythonRequestV1, "type" | "request_id">,
	): Promise<ExecuteBlenderPythonResponseV1>;
}

export function createExecuteBlenderPythonTool(bridge: ExecuteBlenderPythonBridge) {
	return defineTool({
		name: "execute_blender_python",
		label: "execute_blender_python",
		description:
			"Execute arbitrary Python in Blender against expected_revision_id. Blender rolls back scene state after Python errors, but external side effects such as files, network, and processes cannot be undone.",
		parameters: ExecuteBlenderPythonToolRequestSchema,
		executionMode: "sequential",
		execute: async (_toolCallId, request) => {
			const result = await bridge.executeBlenderPython(request);
			const failure = executionFailure(result);
			if (failure !== undefined) throw failure;
			return {
				content: [{ type: "text" as const, text: JSON.stringify(result) }],
				details: result,
			};
		},
	});
}
