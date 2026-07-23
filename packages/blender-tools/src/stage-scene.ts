import { defineTool } from "@earendil-works/pi-coding-agent";
import {
	type StageSceneAppliedHandShape,
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
	readonly applied_hand_shapes: readonly StageSceneAppliedHandShape[];
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
			"Stage a closed scene-building transaction using primitives, bundled rigged human characters (add_character with character_type Y_BOT or X_BOT - use these whenever a person, human, character, or actor is requested), cameras (add_camera creates and activates a render camera), one generated material per object, area lights, and deletion of OMB-owned entities only. adopt_entity takes ownership of a pre-existing non-OMB object (e.g. the startup cube) by its inspected entity_id so later ops can transform or delete it. apply_motion bakes an ARDY-generated motion onto an OMB character and follows the motion's native fps. Its hand_shapes field assigns any of 11 visually calibrated presets from library version 1.1.0 independently to left and right for the entire clip: relaxed, open, fist, soft_fist, point, two_finger, cup, grasp, thumb_extended, three_finger, and hook. Omitted sides default to relaxed. The legacy hand_pose relaxed/open field remains supported as a bilateral assignment. Hand shapes are request-time, clip-wide settings and cannot transition within a clip.",
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
