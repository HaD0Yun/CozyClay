import {
	type ExecuteBlenderPythonRequestV1,
	ExecuteBlenderPythonRequestV1Schema,
	type ExecuteBlenderPythonResponseV1,
} from "@cclay/protocol";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const ExecuteBlenderPythonToolRequestSchema = Type.Omit(ExecuteBlenderPythonRequestV1Schema, ["type", "request_id"]);

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
			return {
				content: [{ type: "text" as const, text: JSON.stringify(result) }],
				details: result,
			};
		},
	});
}
