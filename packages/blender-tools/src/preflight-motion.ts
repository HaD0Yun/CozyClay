import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const UUID_V4_LOWERCASE = "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
// Mirrors _MOTION_ID in blender-addon/cclay/stage_scene.py.
const MOTION_ID_PATTERN = "^[a-z0-9][a-z0-9-]{0,63}$";

export interface PreflightMotionBridge {
	preflightMotion(params: { motion_id: string; entity_id?: string }): Promise<Record<string, unknown>>;
}

export function createPreflightMotionTool(bridge: PreflightMotionBridge) {
	return defineTool({
		name: "preflight_motion",
		label: "preflight_motion",
		description:
			"Analyze a generated ARDY motion archive BEFORE stage_scene apply_motion bakes it: root travel vector and horizontal distance, root height profile, lowest-extremity track (min over all joints), contact plateaus, and end-pose (height, gap, speed, resting). Run this AFTER generating a motion and BEFORE apply_motion, then compare the reported travel/height/contact numbers against the scene measurements from inspect_relations. Pass entity_id of the target armature to get all lengths in meters; without it values are raw npz units. If the numbers mismatch the scene (wrong travel distance, wrong climb height, contacts at the wrong levels), regenerate the motion with a corrected dimensioned prompt or adjust the prop layout — do not apply blind.",
		parameters: Type.Object({
			motion_id: Type.String({ pattern: MOTION_ID_PATTERN }),
			entity_id: Type.Optional(Type.String({ pattern: UUID_V4_LOWERCASE })),
		}),
		execute: async (_toolCallId, params) => {
			const result = await bridge.preflightMotion(params);
			return {
				content: [{ type: "text" as const, text: JSON.stringify(result) }],
				details: result,
			};
		},
	});
}
