import { defineTool } from "@earendil-works/pi-coding-agent";
import type { SceneSnapshot } from "@oh-my-blender/protocol";
import { Type } from "typebox";
import { summarizeSnapshot } from "./inspect-summary.ts";

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
		description:
			"Read the current Blender scene as a compact summary: object names/types/ids, transforms, camera and light essentials, assembly member counts, and per-rig bone counts. Use inspect_entity to fetch full detail (bones, keyframes, materials) for a single entity when you need to edit it.",
		parameters: Type.Object({}),
		execute: async () => {
			const manifest = await bridge.inspectProject();
			const summary = summarizeSnapshot(manifest.snapshot, manifest.revision);
			return {
				content: [{ type: "text" as const, text: JSON.stringify(summary) }],
				details: manifest,
			};
		},
	});
}
