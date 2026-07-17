import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ProjectManifest } from "./manifest.ts";

export function createInspectProjectTool(manifest: ProjectManifest) {
	return defineTool({
		name: "inspect_project",
		label: "Inspect Blender Project",
		description: "Read the current Blender scene manifest without changing the project.",
		parameters: Type.Object({}),
		execute: async () => ({
			content: [{ type: "text" as const, text: JSON.stringify(manifest) }],
			details: manifest,
		}),
	});
}
