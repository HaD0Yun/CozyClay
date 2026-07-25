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
			"Analyze a generated ARDY motion archive BEFORE stage_scene apply_motion bakes it: root travel vector and horizontal distance, root height profile, lowest-extremity track (min over all joints), contact plateaus, ARDY's own per-foot contact channels, and end-pose (height, gap, speed, resting). Run this AFTER generating a motion and BEFORE apply_motion, then compare the reported travel/height/contact numbers against the scene measurements from inspect_relations. Pass entity_id of the target armature to get all lengths in meters; without it values are raw npz units. contact_windows is the geometric scan and cannot name a limb; foot_contacts is what the model itself predicted, named left_heel/left_toe/right_heel/right_toe, so use it to pick the joint and frame for a --constrain target. foot_contacts is null when the archive carries no channel and [] when the model predicted no contact — these are not the same. Compare a foot_contacts channel against ITSELF across windows, not against a surface height: the heel and toe joints sit about 0.058 m apart on a planted foot, so reading a heel window against the floor invents a float. On a climb one channel's window heights must step by the riser; if they are all equal the character never left the floor. If the numbers mismatch the scene (wrong travel distance, wrong climb height, contacts at the wrong levels), regenerate the motion with a corrected dimensioned prompt or a constrained regeneration — do not apply blind. Every height this tool reports (travel, lowest_track, contact_windows, foot_contacts) is a skeleton joint-center position (e.g. LeftFoot/RightFoot), not the deformed mesh's sole/heel/toe surface — a joint sitting at the expected height, and likewise a zero-residual --constrain target, proves joint placement only, not sole-to-support contact, foot orientation, or tread penetration. foot_contacts is the model's own predicted opinion on contact timing/limb, not a measured surface fit. This tool is a pre-bake numeric sanity check, not proof of final visible mesh contact — confirm actual sole/support fit separately (e.g. rendered QA) before treating a shot as done.",
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
