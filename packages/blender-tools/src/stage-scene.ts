import { defineTool } from "@earendil-works/pi-coding-agent";
import {
	type StageSceneEntityIdentity,
	type StageSceneRequestV1,
	StageSceneRequestV1Schema,
} from "@oh-my-blender/protocol";

export interface StageSceneProgress {
	readonly phase: string;
	readonly completed: number;
	readonly total: number;
}

export interface StageSceneResult {
	readonly resulting_revision_id: string;
	readonly scene_hash?: string;
	readonly entity_identities: readonly StageSceneEntityIdentity[];
	readonly [key: string]: unknown;
}

export interface StageSceneBridge {
	stageScene(
		request: StageSceneRequestV1,
		context: {
			readonly signal: AbortSignal | undefined;
			readonly reportProgress: (progress: StageSceneProgress) => void;
		},
	): Promise<StageSceneResult>;
}

export function createStageSceneTool(bridge: StageSceneBridge) {
	return defineTool({
		name: "stage_scene",
		label: "stage_scene",
		description:
			"Stage a closed scene-building transaction using primitives, bundled rigged human characters (add_character with character_type Y_BOT or X_BOT - use these whenever a person, human, character, or actor is requested), one generated material per object, area lights, and deletion of OMB-owned entities only.",
		parameters: StageSceneRequestV1Schema,
		executionMode: "sequential",
		execute: async (_toolCallId, request, signal, onUpdate) => {
			const result = await bridge.stageScene(request, {
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
