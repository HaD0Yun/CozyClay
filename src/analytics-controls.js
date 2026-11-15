// The closed list of primary Studio controls that carry `data-fid`, for
// ui:rage_click and ui:dead_click. A click on any other control reports its area (AREA_IDS) or "other".
// Ids name a control, never a scene object, a name or any text.
export const CONTROL_IDS = Object.freeze([
	"dock_tab_animation", "dock_tab_assets",
	"mode_scene", "mode_pose", "mode_camera", "mode_motion", "mode_sculpt",
	"tool_move", "tool_rotate", "tool_scale", "tool_ik", "tool_pin", "tool_front", "tool_side", "tool_back",
	"tl_play", "shot_add", "shot_delete", "camera_key_add",
	"export_keyframe_pack", "export_video", "export_video_shot",
	"export_render_passes", "export_depth_video", "export_storyboard", "export_otio",
	"menu_undo", "menu_redo",
	"agent_send", "agent_stop", "agent_steer", "agent_retry", "agent_connect", "agent_panel",
]);

// A control with no listed `data-fid` reports the Studio area it sits in, by
// the area's own class; the first match wins, so nested areas come first.
const AREAS = [
	["other_guide", ".first-success-guide"],
	["other_agent", ".agent-panel"],
	["other_menu", ".menubar, [role='menu']"],
	["other_sculpt", ".sculpt-panel"],
	["other_assets", ".content-browser"],
	["other_timeline", ".bottom-timeline, .studio-dock-slot"],
	["other_inspector", ".inspector-pane, .studio-right-column"],
	["other_viewport", ".studio-left-column"],
];
export const AREA_IDS = Object.freeze(AREAS.map(([id]) => id));

/** The closed control id of a `data-fid` value; else the area of `element`, else "other". */
export function controlOf(fid, element = null) {
	if (CONTROL_IDS.includes(fid)) return fid;
	for (const [id, selector] of AREAS) if (element?.closest?.(selector)) return id;
	return "other";
}

/** An area id or "other": a control the Studio does not name. */
export const isUnnamedControl = (control) => control === "other" || AREA_IDS.includes(control);
