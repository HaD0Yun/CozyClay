"""A real ARDY-clip rig, built on demand.

Two fixtures need the same thing: an imported skeleton, an ARDY clip baked onto
it as FK, the clip metadata the add-on reads, and the IK layer attached. That
setup used to be copied between them because ``ik_rig_fixture`` runs its whole
probe at module scope -- importing it wipes the importing fixture's scene -- so
there was no importable source for it.

This module is that source. Nothing here runs at import time; a caller gets a
rig by calling ``build``.
"""

from __future__ import annotations

import json
import pathlib
import sys

import bpy
import numpy

REPOSITORY_ROOT = pathlib.Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPOSITORY_ROOT / "blender-addon"))
for module in (
    "cclay",
    "cclay.ik_chains",
    "cclay.ik_rig",
    "cclay.motion_retarget",
    "cclay.constraint_capture",
    "cclay.constraint_timeline",
    "cclay.motion_constraints",
    "cclay.character_target",
):
    sys.modules.pop(module, None)

import cclay  # noqa: E402,F401
from cclay import constraint_capture, ik_chains, ik_rig, motion_retarget  # noqa: E402,F401

MOTION = json.loads(
    (REPOSITORY_ROOT / "blender-addon/tests/fixtures/ardy_motion_3frames.json").read_text()
)
PREFIX = ik_chains.BONE_PREFIX

# The baked clip is 3 frames starting at scene frame 1, so frames 1-3 are
# inside the clip and frame 4 onward is outside it. The scene is left much
# longer than that on purpose: apply_motion only ever EXTENDS the scene range,
# never shrinks it, so a scrubbable frame past the clip end is the normal case
# an animator hits, not a contrived one.
CLIP_START = 1
CLIP_FRAMES = 3
SCENE_END = 40


def import_rig():
    asset = REPOSITORY_ROOT / "blender-addon/cclay/assets/characters/y-bot-tpose.fbx"
    before = set(bpy.data.objects)
    if hasattr(bpy.ops.wm, "fbx_import"):
        bpy.ops.wm.fbx_import(filepath=str(asset))
    else:
        bpy.ops.import_scene.fbx(filepath=str(asset))
    imported = [o for o in bpy.data.objects if o not in before]
    return next(o for o in imported if o.type == "ARMATURE")


def bake_ardy_fk(armature):
    """Reproduce apply_motion's FK bake: basis = Rb^T @ L @ Rb per driven bone."""
    local_rot_mats = numpy.asarray(MOTION["local_rot_mats"], dtype=numpy.float64)
    posed_joints = numpy.asarray(MOTION["posed_joints"], dtype=numpy.float64)
    bones = armature.data.bones
    rest_rotations = {}
    for cskel, target in motion_retarget.MIXAMO_TARGETS.items():
        if target is None:
            continue
        bone = bones.get(PREFIX + target)
        if bone is not None:
            rest_rotations[cskel] = [list(row) for row in bone.matrix_local.to_3x3()]
    thigh = (
        bones[PREFIX + "RightLeg"].head_local - bones[PREFIX + "RightUpLeg"].head_local
    ).length
    scale = motion_retarget.derive_scale(posed_joints[0], thigh)
    builder = motion_retarget.PoseTrackBuilder(
        local_rot_mats,
        posed_joints,
        rest_rotations,
        list(bones[PREFIX + "Hips"].head_local),
        scale,
    )
    while not builder.step(max_frames=64):
        pass
    tracks = builder.tracks

    armature.animation_data_create()
    action = bpy.data.actions.new(name="CCLAY Motion constraint-frame-guard")
    armature.animation_data.action = action
    frames = len(local_rot_mats)
    for cskel, quaternions in tracks["rotations"].items():
        target = motion_retarget.MIXAMO_TARGETS[cskel]
        if target is None or bones.get(PREFIX + target) is None:
            continue
        pose_bone = armature.pose.bones[PREFIX + target]
        pose_bone.rotation_mode = "QUATERNION"
        for frame in range(frames):
            pose_bone.rotation_quaternion = quaternions[frame]
            pose_bone.keyframe_insert("rotation_quaternion", frame=frame + 1)
    hips = armature.pose.bones[PREFIX + "Hips"]
    for frame in range(frames):
        hips.location = tracks["hips_locations"][frame]
        hips.keyframe_insert("location", frame=frame + 1)
    scene = bpy.context.scene
    scene.frame_start = CLIP_START
    scene.frame_end = CLIP_START + CLIP_FRAMES - 1
    return frames


def _stamp_clip_metadata(armature):
    # bake_ardy_fk builds the action and the dense keyframes but does NOT stamp
    # the cclay.motion_* properties apply_motion records. Without them
    # base_clip_of raises before it ever reaches the range check, so the mark
    # operator would CANCEL for the wrong reason (no clip at all) instead of the
    # reason under test (a frame past the clip end). Stamp them here to match a
    # real applied clip's shape, and record the start frame explicitly so the
    # recovery path is not exercised -- it is covered by its own test.
    action = armature.animation_data.action
    action["cclay.motion_id"] = "constraint-frame-guard-base"
    action["cclay.motion_frames"] = CLIP_FRAMES
    action["cclay.motion_fps"] = 20
    action["cclay.motion_start_frame"] = CLIP_START


def _legacy_armature_without_clip_metadata():
    # A minimal armature with an action that carries keyframes but no
    # cclay.motion_id -- the shape of a rig the add-on never applied a clip to.
    # Reaching the mark operator's guard needs no full character: the operator
    # resolves the armature, reads base_clip_of, and bails before any IK handle
    # is touched. Built the cheap way the legacy_clip_fixture builds one.
    bpy.ops.wm.read_factory_settings(use_empty=True)
    data = bpy.data.armatures.new("Legacy")
    armature = bpy.data.objects.new("Legacy", data)
    bpy.context.scene.collection.objects.link(armature)
    bpy.context.view_layer.objects.active = armature
    bpy.ops.object.mode_set(mode="EDIT")
    bone = data.edit_bones.new("mixamorig:Hips")
    bone.head, bone.tail = (0, 0, 0), (0, 0, 1)
    bpy.ops.object.mode_set(mode="OBJECT")

    action = bpy.data.actions.new("legacy-no-metadata")
    armature.animation_data_create().action = action
    # Deliberately NOT setting cclay.motion_id: base_clip_of must raise
    # ConstraintCaptureError on this, which the mark operator catches and turns
    # into CANCELLED. A keyframe is still added so the action is not empty,
    # isolating the failure to the missing metadata rather than a missing clip.
    pose_bone = armature.pose.bones["mixamorig:Hips"]
    pose_bone.location = (0.0, 1.0, 0.0)
    pose_bone.keyframe_insert("location", frame=1)
    return armature




def build():
    """A fresh scene holding an IK-attached character over an ARDY clip.

    Runs in ``--background``. ``ik_rig.attach`` drives ``object.mode_set``,
    whose poll reads the window's own context, so building this in a GUI
    session would mean contorting product code to suit a fixture. A fixture
    that needs a window opens a .blend this one saved instead.
    """
    bpy.ops.wm.read_factory_settings(use_empty=True)
    armature = import_rig()
    bake_ardy_fk(armature)
    _stamp_clip_metadata(armature)
    scene = bpy.context.scene
    scene.frame_end = SCENE_END
    bpy.context.view_layer.objects.active = armature
    bpy.ops.object.mode_set(mode="POSE")
    ik_rig.attach(armature, CLIP_START, CLIP_START + CLIP_FRAMES - 1)
    return armature
