// Read-only frame-specific deformed-sole/support-contact inspection (issue #2
// item D). Distinct from inspect_relations on purpose: this measures actual
// per-frame deformed-mesh sole geometry against declared support geometry, not
// static scene layout, and it must never let a skeleton joint position stand
// in for a measured surface contact.
import {
	type InspectPoseContactsParamsV1,
	InspectPoseContactsParamsV1Schema,
	type PoseContactsResultV1,
} from "@cclay/protocol";
import { defineTool } from "@earendil-works/pi-coding-agent";

export interface InspectPoseContactsBridge {
	inspectPoseContacts(params: InspectPoseContactsParamsV1): Promise<PoseContactsResultV1>;
}

export function createInspectPoseContactsTool(bridge: InspectPoseContactsBridge) {
	return defineTool({
		name: "inspect_pose_contacts",
		label: "inspect_pose_contacts",
		description:
			"Measure, per requested SCENE frame, whether a character's deformed-mesh foot sole actually touches declared support geometry. `frames` are SCENE frames (scene = apply_motion start_frame + clip frame), not clip-relative frames. All positions and gaps are Blender world-space meters, Z-up. For each frame and side (left/right) this reports the raw skeleton foot/toe joint position alongside the DEFORMED sole/heel/toe mesh samples, then compares the deformed sole against each declared support entity's measured top surface: `support_gap_m` (positive = gap above the surface, negative = penetration) and `inside_support_footprint` (an AABB-XY footprint test, reported as such). `surface_contact_verified` is derived ONLY from that deformed-sole-vs-support-geometry comparison against the echoed gate (default max absolute gap 0.03 m, minimum edge margin 0.0 m) — it is never inferred from skeleton joint residual or IK/constraint error, because the joint-to-sole offset is not constant and changes with foot rotation. Joint positions in the result are raw evidence only, not proof of contact.",
		parameters: InspectPoseContactsParamsV1Schema,
		execute: async (_toolCallId, params) => {
			const result = await bridge.inspectPoseContacts(params);
			return {
				content: [{ type: "text" as const, text: JSON.stringify(result) }],
				details: result,
			};
		},
	});
}
