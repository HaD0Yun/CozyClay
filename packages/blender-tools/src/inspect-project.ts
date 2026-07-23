import { defineTool } from "@earendil-works/pi-coding-agent";
import type { SceneSnapshot } from "@oh-my-blender/protocol";
import { Type } from "typebox";
import { diffSummaryObjects, type InspectSummary, summarizeSnapshot } from "./inspect-summary.ts";

export interface ProjectManifest {
	readonly revision: string;
	readonly snapshot: SceneSnapshot;
}

export interface InspectProjectBridge {
	inspectProject(): Promise<ProjectManifest>;
}

export function createInspectProjectTool(bridge: InspectProjectBridge) {
	// Last summary this tool instance returned. The tool lives for the whole
	// extension session, so repeat inspects (the common verify-after-stage
	// loop) can return an object diff instead of re-listing every object.
	let lastInspected: { readonly revision: string; readonly summary: InspectSummary } | undefined;
	return defineTool({
		name: "inspect_project",
		label: "inspect_project",
		description:
			"Read the current Blender scene as a compact summary: object names/types/ids, transforms, camera and light essentials, assembly member counts, and per-rig bone counts. The first call returns the full object list; repeat calls return `objectsDiff` (added/changed/removedNames since your last inspect, plus unchangedCount) instead of re-listing unchanged objects. Pass full=true to force the complete object list. Use inspect_entity to fetch full detail (bones, keyframes, materials) for a single entity when you need to edit it.",
		parameters: Type.Object(
			{
				full: Type.Optional(Type.Boolean({ description: "Force the complete object list instead of a diff" })),
			},
			{ additionalProperties: false },
		),
		execute: async (_toolCallId, params: { readonly full?: boolean }) => {
			const manifest = await bridge.inspectProject();
			const summary = summarizeSnapshot(manifest.snapshot, manifest.revision);
			const previous = lastInspected;
			lastInspected = { revision: manifest.revision, summary };
			if (params?.full === true || previous === undefined) {
				return {
					content: [{ type: "text" as const, text: JSON.stringify(summary) }],
					details: manifest,
				};
			}
			const { objects, ...rest } = summary;
			const payload = {
				...rest,
				objectCount: objects.length,
				objectsDiff: {
					baseRevision: previous.revision,
					...diffSummaryObjects(previous.summary.objects, objects),
				},
			};
			return {
				content: [{ type: "text" as const, text: JSON.stringify(payload) }],
				details: manifest,
			};
		},
	});
}
