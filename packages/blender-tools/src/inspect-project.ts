import { defineTool } from "@earendil-works/pi-coding-agent";
import type { SceneSnapshot } from "@oh-my-blender/protocol";
import { Type } from "typebox";

export interface ProjectManifest {
	readonly revision: string;
	readonly snapshot: SceneSnapshot;
}

export interface InspectProjectBridge {
	inspectProject(): Promise<ProjectManifest>;
}

export function createInspectProjectTool(bridge: InspectProjectBridge) {
	return defineTool({
		name: "inspect_project",
		label: "inspect_project",
		description: "Read the current Blender scene manifest without changing the project.",
		parameters: Type.Object({}),
		execute: async () => {
			const manifest = await bridge.inspectProject();
			return {
				content: [{ type: "text" as const, text: JSON.stringify(manifest) }],
				details: manifest,
			};
		},
	});
}
