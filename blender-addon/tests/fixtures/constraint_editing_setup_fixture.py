"""Exercise the one-click constraint editing setup in real Blender."""

from __future__ import annotations

import json
import pathlib
import sys

import bpy

REPOSITORY_ROOT = pathlib.Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPOSITORY_ROOT / "blender-addon"))
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

import ardy_rig_scaffold as scaffold  # noqa: E402
import cclay  # noqa: E402
from cclay import constraint_capture, constraint_timeline, ik_rig  # noqa: E402

bpy.ops.wm.read_factory_settings(use_empty=True)
armature = scaffold.import_rig()
scaffold.bake_ardy_fk(armature)
scaffold._stamp_clip_metadata(armature)
bpy.context.scene.frame_end = scaffold.CLIP_START + scaffold.CLIP_FRAMES - 1
bpy.context.view_layer.objects.active = armature
bpy.ops.object.mode_set(mode="POSE")

bpy.utils.register_class(cclay.CCLAY_OT_attach_ik_rig)
status = sorted(bpy.ops.cclay.attach_ik_rig())

action = armature.animation_data.action
bags = constraint_capture.action_channelbags(action)
marker_paths = {
    constraint_timeline.marker_path(kind)
    for _label, kind in constraint_timeline.TRACKS
}
all_curves = [curve for bag in bags for curve in bag.fcurves]
editors = []
for screen in bpy.data.screens:
    for area in screen.areas:
        if area.type != "DOPESHEET_EDITOR":
            continue
        space = area.spaces.active
        if getattr(space, "mode", None) != "DOPESHEET":
            continue
        editors.append(
            {
                "filter": space.dopesheet.filter_text,
                "only_selected": bool(space.dopesheet.show_only_selected),
            }
        )

report = {
    "status": status,
    "has_ik_layer": ik_rig.has_ik_layer(armature),
    "lanes": constraint_timeline.lane_labels(armature),
    "expected_lanes": [label for label, _kind in constraint_timeline.TRACKS],
    "marker_curve_count": sum(curve.data_path in marker_paths for curve in all_curves),
    "non_marker_curve_count": sum(curve.data_path not in marker_paths for curve in all_curves),
    "editors": editors,
    "expected_filter": constraint_timeline.CHANNEL_FILTER,
    "auto_key": bool(bpy.context.scene.tool_settings.use_keyframe_insert_auto),
}
print("CCLAY_CONSTRAINT_EDITING_SETUP=" + json.dumps(report, sort_keys=True))
