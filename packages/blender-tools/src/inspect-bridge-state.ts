import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export interface InspectBridgeStateBridge {
	inspectBridgeState(): Record<string, unknown>;
}

export function createInspectBridgeStateTool(bridge: InspectBridgeStateBridge) {
	return defineTool({
		name: "inspect_bridge_state",
		label: "inspect_bridge_state",
		description:
			"Inspect the extension-side Blender bridge without mutating anything: attachment state, project and current revision, the in-flight bridge method, the extension-held prepared transaction, the add-on version, and the last refused attach. Use this before claiming the bridge is broken, before repair_bridge, and when a stale transaction or stale Blender process is suspected. This tool cannot clear state by itself.",
		parameters: Type.Object({}, { additionalProperties: false }),
		execute: async () => {
			const result = bridge.inspectBridgeState();
			return {
				content: [{ type: "text" as const, text: JSON.stringify(result) }],
				details: result,
			};
		},
	});
}
