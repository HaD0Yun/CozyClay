"""Exercise constraint capture inside real Blender and report JSON on stdout.

Runs the animator's actual path: attach the IK layer over a baked clip, drag a
handle, commit constraints of all three kinds on different frames, then read
them back. The assertions live in test_constraint_capture.py; this only
observes, so a failure there names the observation rather than a Blender API.
"""

import json
import pathlib
import sys

import bpy

REPOSITORY_ROOT = pathlib.Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPOSITORY_ROOT / "blender-addon"))

from cclay import constraint_capture, ik_chains, ik_rig  # noqa: E402
from cclay import motion_retarget  # noqa: E402

CHARACTER = REPOSITORY_ROOT / "blender-addon/cclay/assets/characters/x-bot-tpose.fbx"
FRAME_START, FRAME_END = 1, 6


def _build_clip():
    """A short baked FK clip, the shape apply_motion leaves behind."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.fbx(filepath=str(CHARACTER))
    armature = next(o for o in bpy.data.objects if o.type == "ARMATURE")
    bpy.context.view_layer.objects.active = armature
    scene = bpy.context.scene
    scene.frame_start, scene.frame_end = FRAME_START, FRAME_END
    prefix = "mixamorig:"
    driven = [
        f"{prefix}{target}"
        for target in motion_retarget.MIXAMO_TARGETS.values()
        if target is not None
    ]
    for frame in range(FRAME_START, FRAME_END + 1):
        scene.frame_set(frame)
        for name in driven:
            pose_bone = armature.pose.bones[name]
            pose_bone.rotation_mode = "QUATERNION"
            pose_bone.keyframe_insert("rotation_quaternion", frame=frame)
        armature.pose.bones[f"{prefix}Hips"].keyframe_insert("location", frame=frame)
    return armature


armature = _build_clip()
ik_rig.attach(armature, FRAME_START, FRAME_END)

report = {}
scene = bpy.context.scene

# Commit three kinds on three different frames, the mixed case that must not
# collapse into a single track.
scene.frame_set(3)
target = armature.pose.bones[ik_chains.target_bone_name("RightHand")]
target.location = (target.location[0] + 0.05, target.location[1], target.location[2])
target.keyframe_insert("location", frame=3)
report["markedRightHand"] = constraint_capture.mark_constraint(armature, "RightHand", 3)

scene.frame_set(5)
report["markedFullBody"] = constraint_capture.mark_constraint(armature, "FullBody", 5)

scene.frame_set(2)
report["markedRoot2D"] = constraint_capture.mark_constraint(armature, "Root2D", 2)

report["framesRightHand"] = constraint_capture.marked_frames(armature, "RightHand")
report["framesFullBody"] = constraint_capture.marked_frames(armature, "FullBody")
report["framesRoot2D"] = constraint_capture.marked_frames(armature, "Root2D")
report["framesLeftHand"] = constraint_capture.marked_frames(armature, "LeftHand")

rotations = constraint_capture.pose_local_rotations(armature)
report["rotationCount"] = len(rotations)
report["rotationShape"] = [len(rotations[0]), len(rotations[0][0])]

# Committing the same frame twice must not double it.
constraint_capture.mark_constraint(armature, "RightHand", 3)
report["framesRightHandAfterRepeat"] = constraint_capture.marked_frames(armature, "RightHand")

constraint_capture.clear_constraint(armature, "Root2D", 2)
report["framesRoot2DAfterClear"] = constraint_capture.marked_frames(armature, "Root2D")

# The marker curves must not survive a detach; the next clip gets fresh ones.
ik_rig.detach(armature, keep_edits=True)
report["framesAfterDetach"] = constraint_capture.marked_frames(armature, "RightHand")
report["controlBonesAfterDetach"] = sorted(
    bone.name for bone in armature.data.bones if ik_chains.is_control_bone(bone.name)
)

print("CCLAY_CONSTRAINT_CAPTURE=" + json.dumps(report))
