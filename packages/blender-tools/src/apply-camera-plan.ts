import { type CameraPlanV1, CameraPlanV1Schema } from "@cclay/protocol";
import { defineTool } from "@earendil-works/pi-coding-agent";

export interface ApplyCameraPlanProgress {
	readonly phase: string;
	readonly completed: number;
	readonly total: number;
}

export interface ApplyCameraPlanResult {
	readonly resulting_revision_id: string;
	readonly scene_hash?: string;
	readonly [key: string]: unknown;
}

export interface ApplyCameraPlanBridge {
	applyCameraPlan(
		plan: CameraPlanV1,
		context: {
			readonly signal: AbortSignal | undefined;
			readonly reportProgress: (progress: ApplyCameraPlanProgress) => void;
		},
	): Promise<ApplyCameraPlanResult>;
}

export function createApplyCameraPlanTool(bridge: ApplyCameraPlanBridge) {
	return defineTool({
		name: "apply_camera_plan",
		label: "apply_camera_plan",
		description:
			"Apply a digest-authorized CameraPlanV1 transaction to the current Blender revision. expected_revision_id is required.",
		parameters: CameraPlanV1Schema,
		executionMode: "sequential",
		execute: async (_toolCallId, plan, signal, onUpdate) => {
			const result = await bridge.applyCameraPlan(plan, {
				signal,
				reportProgress: (progress) => {
					onUpdate?.({
						content: [{ type: "text" as const, text: JSON.stringify(progress) }],
						details: progress,
					});
				},
			});
			return {
				content: [{ type: "text" as const, text: JSON.stringify(result) }],
				details: result,
			};
		},
	});
}
