export * from "./apply-camera-plan.ts";
export * from "./apply-performance-mode.ts";
export * from "./ardy-regenerate.ts";
export * from "./capture-viewport.ts";
export * from "./create-fall-motion.ts";
export * from "./execute-blender-python.ts";
export * from "./folded-result.ts";
export * from "./inspect-bridge-state.ts";
export * from "./inspect-entity.ts";
export * from "./inspect-performance.ts";
export * from "./inspect-pose-contacts.ts";
export * from "./inspect-project.ts";
export * from "./inspect-relations.ts";
export * from "./inspect-summary.ts";
export * from "./inspect-visual-qa-metrics.ts";
export * from "./preflight-motion.ts";
export * from "./produce-directing-evidence.ts";
export * from "./read-image.ts";
export * from "./render-qa-frames.ts";
export * from "./repair-bridge.ts";
export * from "./replace-camera-action.ts";
export * from "./stage-scene.ts";
// This is the single curated source shared by the embedded director session and
// extension registration so they cannot drift.
export const EMBEDDED_DIRECTOR_ELIGIBLE_TOOLS = [
	{ name: "inspect_project", embeddedEligible: true },
	{ name: "inspect_bridge_state", embeddedEligible: true },
	{ name: "inspect_performance", embeddedEligible: true },
	{ name: "inspect_entity", embeddedEligible: true },
	{ name: "inspect_pose_contacts", embeddedEligible: true },
	{ name: "inspect_relations", embeddedEligible: true },
	{ name: "inspect_visual_qa_metrics", embeddedEligible: true },
	{ name: "preflight_motion", embeddedEligible: true },
	{ name: "capture_viewport", embeddedEligible: true },
	{ name: "read_image", embeddedEligible: true },
	{ name: "produce_directing_evidence", embeddedEligible: true },
	{ name: "stage_scene", embeddedEligible: true },
	{ name: "apply_camera_plan", embeddedEligible: true },
	{ name: "render_qa_frames", embeddedEligible: true },
	{ name: "repair_bridge", embeddedEligible: true },
	{ name: "apply_performance_mode", embeddedEligible: true },
	{ name: "create_fall_motion", embeddedEligible: true },
	{ name: "replace_camera_action", embeddedEligible: true },
	{ name: "ardy_regenerate", embeddedEligible: true },
	{ name: "execute_blender_python", embeddedEligible: true },
] as const;

export type EmbeddedDirectorToolName = Extract<
	(typeof EMBEDDED_DIRECTOR_ELIGIBLE_TOOLS)[number],
	{ readonly embeddedEligible: true }
>["name"];

export const EMBEDDED_DIRECTOR_ELIGIBLE_TOOL_NAMES: readonly EmbeddedDirectorToolName[] =
	EMBEDDED_DIRECTOR_ELIGIBLE_TOOLS.filter(
		(tool): tool is Extract<(typeof EMBEDDED_DIRECTOR_ELIGIBLE_TOOLS)[number], { readonly embeddedEligible: true }> =>
			tool.embeddedEligible,
	).map(({ name }) => name);
