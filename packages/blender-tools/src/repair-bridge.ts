import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export interface RepairBridgeBridge {
	repairBridge(): Record<string, unknown>;
}

export function createRepairBridgeTool(bridge: RepairBridgeBridge) {
	return defineTool({
		name: "repair_bridge",
		label: "repair_bridge",
		description:
			"Clear only extension-side Blender bridge state that is already stale: reject this process's stale in-flight bridge promise, remove its extension-held prepared-transaction reference, and close the stale socket so a new Blender add-on attach can be accepted. It does not mutate the Blender scene, project journal, rendered output, or add-on recovery state. Use inspect_bridge_state first, then call this when the old Blender process or a dead transport is the known blocker. If the add-on itself is in RECOVERY_REQUIRED, the user must restart Blender or run cclay again after this repair.",
		parameters: Type.Object({}, { additionalProperties: false }),
		execute: async () => {
			const result = bridge.repairBridge();
			return {
				content: [{ type: "text" as const, text: JSON.stringify(result) }],
				details: result,
			};
		},
	});
}
