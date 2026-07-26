"""Recovering the clip start frame on actions applied before it was recorded.

Clips already in someone's .blend do not carry cclay.motion_start_frame, and
every constraint frame is measured relative to it. Guessing 1 would silently
shift every constraint the animator places on those clips, so the recovery has
to be exact and has to refuse when it cannot be.

_apply_motion keys its dense frames as start_frame + offset with no gaps, so
the lowest key IS the start frame. This fixture builds that shape without the
property and checks the recovery, the backfill, and the refusal.
"""

import json
import pathlib
import sys

import bpy

REPOSITORY_ROOT = pathlib.Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPOSITORY_ROOT / "blender-addon"))

from cclay import constraint_capture  # noqa: E402

FIRST_KEY = 5
FRAME_COUNT = 10


def _legacy_armature():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    data = bpy.data.armatures.new("A")
    armature = bpy.data.objects.new("A", data)
    bpy.context.scene.collection.objects.link(armature)
    bpy.context.view_layer.objects.active = armature
    bpy.ops.object.mode_set(mode="EDIT")
    bone = data.edit_bones.new("mixamorig:Hips")
    bone.head, bone.tail = (0, 0, 0), (0, 0, 1)
    bpy.ops.object.mode_set(mode="OBJECT")

    action = bpy.data.actions.new("legacy")
    armature.animation_data_create().action = action
    action["cclay.motion_id"] = "legacy-clip"
    action["cclay.motion_frames"] = FRAME_COUNT
    action["cclay.motion_fps"] = 20
    # No cclay.motion_start_frame: this is exactly the pre-migration shape.
    pose_bone = armature.pose.bones["mixamorig:Hips"]
    for offset in range(FRAME_COUNT):
        pose_bone.location = (0.0, float(offset), 0.0)
        pose_bone.keyframe_insert("location", frame=FIRST_KEY + offset)
    return armature, action


armature, action = _legacy_armature()
report = {"recovered": constraint_capture.base_clip_of(armature)}
report["backfilled"] = action.get("cclay.motion_start_frame")
# The second read must take the recorded path and agree with the first.
report["second"] = constraint_capture.base_clip_of(armature)["start_frame"]

# A clip whose keyed span disagrees with its recorded length is not something
# to recover from -- the assumption the recovery rests on does not hold.
action["cclay.motion_frames"] = 99
del action["cclay.motion_start_frame"]
try:
    constraint_capture.base_clip_of(armature)
    report["mismatch"] = None
except constraint_capture.ConstraintCaptureError as error:
    report["mismatch"] = str(error)

# An action with no keys at all cannot be recovered either.
action["cclay.motion_frames"] = FRAME_COUNT
empty = bpy.data.actions.new("empty")
for key in ("cclay.motion_id", "cclay.motion_frames", "cclay.motion_fps"):
    empty[key] = action[key]
armature.animation_data.action = empty
try:
    constraint_capture.base_clip_of(armature)
    report["unkeyed"] = None
except constraint_capture.ConstraintCaptureError as error:
    report["unkeyed"] = str(error)


# Last on purpose: _legacy_armature() resets the file, which invalidates
# every earlier Action reference.
# The read-only bridge method resolves the same start frame without touching
# the action. inspect_motion_constraints sits in _READ_ONLY_BRIDGE_METHODS,
# which skips task tracking and durable commit handling, so a write on this
# path changes Blender data behind the revision bookkeeping's back.
armature2, action2 = _legacy_armature()
report["readOnlyStartFrame"] = constraint_capture.base_clip_of(
    armature2, backfill=False
)["start_frame"]
report["readOnlyLeftNoTrace"] = "cclay.motion_start_frame" not in action2.keys()

print("CCLAY_LEGACY_CLIP=" + json.dumps(report, default=str))
