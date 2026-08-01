"""Drive the real IK layer over a real ARDY-retargeted rig inside Blender.

Builds the same FK animation ``apply_motion`` builds — bundled Y-Bot FBX plus the
recorded ARDY payload run through ``motion_retarget`` — then attaches the IK
layer, edits a hand, and detaches it both ways. The host test reads the printed
measurements. Nothing here is mocked: the deviations come from Blender's own IK
evaluation.
"""

from __future__ import annotations

import json
import pathlib
import sys

import bpy
import numpy

REPOSITORY_ROOT = pathlib.Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPOSITORY_ROOT / "blender-addon"))
for module in ("cclay.ik_chains", "cclay.ik_rig", "cclay.motion_retarget"):
    sys.modules.pop(module, None)

from cclay import ik_chains, ik_rig, motion_retarget  # noqa: E402

MOTION = json.loads(
    (REPOSITORY_ROOT / "blender-addon/tests/fixtures/ardy_motion_3frames.json").read_text()
)
PREFIX = ik_chains.BONE_PREFIX


def import_rig():
    asset = REPOSITORY_ROOT / "blender-addon/cclay/assets/characters/y-bot-tpose.fbx"
    before = set(bpy.data.objects)
    if hasattr(bpy.ops.wm, "fbx_import"):
        bpy.ops.wm.fbx_import(filepath=str(asset))
    else:
        bpy.ops.import_scene.fbx(filepath=str(asset))
    imported = [o for o in bpy.data.objects if o not in before]
    armature = next(o for o in imported if o.type == "ARMATURE")
    return armature


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
    action = bpy.data.actions.new(name="CCLAY Motion ik-fixture")
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
    scene.frame_start = 1
    scene.frame_end = frames
    return frames


def sample_fk(armature, frames):
    scene = bpy.context.scene
    out = {}
    for frame in range(1, frames + 1):
        scene.frame_set(frame)
        out[frame] = {
            chain.effector: tuple(
                (armature.matrix_world @ armature.pose.bones[PREFIX + bone].head).copy()
                for bone in (chain.chain_root, chain.constrained, chain.effector)
            )
            for chain in ik_chains.IK_CHAINS
        }
    return out


def action_fcurves(armature):
    """Blender 5.2 keeps f-curves on per-slot channelbags, not Action.fcurves."""
    return [curve for _, curve in ik_rig._control_fcurve_owners(armature.animation_data)]


def world_head(armature, bone):
    return (armature.matrix_world @ armature.pose.bones[PREFIX + bone].head).copy()


results = {}
bpy.ops.wm.read_factory_settings(use_empty=True)
armature = import_rig()
frames = bake_ardy_fk(armature)
results["frames"] = frames
bpy.context.view_layer.objects.active = armature
bpy.ops.object.mode_set(mode="POSE")

def bone_signature(rig):
    """Every bone plus its rest matrix, in export order.

    ``manifest._manifest_bones`` puts each bone of a tracked armature into the
    hashed scene manifest, so attaching the layer necessarily changes the scene
    hash. What must hold is that detaching restores this signature exactly,
    leaving no trace of the layer in the hashed representation.
    """
    return [
        (bone.name, [round(component, 9) for row in bone.matrix_local for component in row])
        for bone in rig.data.bones
    ]


results["boneSignatureBeforeAttach"] = bone_signature(armature)
fk = sample_fk(armature, frames)
results["fkBeforeAttach"] = {
    effector: [round(v, 6) for v in fk[1][effector][2]] for effector in fk[1]
}

# --- attach ---------------------------------------------------------------
report = ik_rig.attach(armature)
results["attachReport"] = report
results["fidelityAfterAttach"] = ik_rig.measure_fidelity(armature, fk)
results["boneCountWhileAttached"] = len(armature.data.bones)
results["controlBones"] = sorted(
    bone.name for bone in armature.data.bones if ik_chains.is_control_bone(bone.name)
)
results["ikConstraints"] = {
    chain.effector: [
        {
            "chainCount": c.chain_count,
            "useTail": bool(c.use_tail),
            "poleAngle": round(c.pole_angle, 9),
            "subtarget": c.subtarget,
            "poleSubtarget": c.pole_subtarget,
        }
        for c in armature.pose.bones[PREFIX + chain.constrained].constraints
        if c.type == "IK"
    ]
    for chain in ik_chains.IK_CHAINS
}
# No control bone may deform the mesh.
results["controlBonesDeform"] = [
    bone.name
    for bone in armature.data.bones
    if ik_chains.is_control_bone(bone.name) and bone.use_deform
]

# --- attaching twice is refused ------------------------------------------
try:
    ik_rig.attach(armature)
except ik_rig.IkRigError as error:
    results["doubleAttach"] = str(error)
else:
    results["doubleAttach"] = "<accepted>"

# --- edit one hand -------------------------------------------------------
from mathutils import Vector  # noqa: E402

EDIT_FRAME = 2
# The recorded ARDY clip starts near a T-pose, so the arm is already close to
# full extension and any outward delta is clipped by reach. Pulling the hand
# TOWARD the shoulder is unconditionally inside the envelope and bends the elbow,
# which is the edit an animator actually makes.
EDIT_TOWARD_SHOULDER_M = 0.12
# Far outside it, to pin the behaviour at the reach boundary.
OUT_OF_REACH_M = 3.0
scene = bpy.context.scene
scene.frame_set(EDIT_FRAME)
before_hand = world_head(armature, "LeftHand")
before_other = world_head(armature, "RightHand")
before_foot = world_head(armature, "LeftFoot")
shoulder_at_edit = world_head(armature, "LeftArm")
toward_shoulder = (shoulder_at_edit - before_hand).normalized()
EDIT_DELTA = toward_shoulder * EDIT_TOWARD_SHOULDER_M
OUT_OF_REACH_DELTA = -toward_shoulder * OUT_OF_REACH_M
target = armature.pose.bones[ik_chains.target_bone_name("LeftHand")]
matrix = target.matrix.copy()
matrix.translation += armature.matrix_world.inverted().to_3x3() @ EDIT_DELTA
target.matrix = matrix
target.keyframe_insert("location", frame=EDIT_FRAME)
bpy.context.view_layer.update()
scene.frame_set(EDIT_FRAME)
results["edit"] = {
    "requestedMm": round(EDIT_DELTA.length * 1000, 3),
    "handMovedMm": round((world_head(armature, "LeftHand") - before_hand).length * 1000, 3),
    "otherHandMovedMm": round(
        (world_head(armature, "RightHand") - before_other).length * 1000, 3
    ),
    "footMovedMm": round((world_head(armature, "LeftFoot") - before_foot).length * 1000, 3),
}
edited_hand = world_head(armature, "LeftHand")

# An unreachable target must extend the limb toward it and stop, never snap or
# produce a non-finite pose.
scene.frame_set(EDIT_FRAME)
reach_before = world_head(armature, "LeftHand")
shoulder = world_head(armature, "LeftArm")
far = target.matrix.copy()
far.translation += armature.matrix_world.inverted().to_3x3() @ OUT_OF_REACH_DELTA
target.matrix = far
target.keyframe_insert("location", frame=EDIT_FRAME)
bpy.context.view_layer.update()
scene.frame_set(EDIT_FRAME)
stretched = world_head(armature, "LeftHand")
rest_reach = (
    (armature.matrix_world @ armature.pose.bones[PREFIX + "LeftForeArm"].head)
    - (armature.matrix_world @ armature.pose.bones[PREFIX + "LeftArm"].head)
).length + (
    (armature.matrix_world @ armature.pose.bones[PREFIX + "LeftHand"].head)
    - (armature.matrix_world @ armature.pose.bones[PREFIX + "LeftForeArm"].head)
).length
results["outOfReach"] = {
    "finite": all(abs(component) < 1e6 for component in stretched),
    "shoulderToHandMm": round((stretched - shoulder).length * 1000, 3),
    "movedFartherMm": round(
        ((stretched - shoulder).length - (reach_before - shoulder).length) * 1000, 3
    ),
    "restReachMm": round(rest_reach * 1000, 3),
}
# Put the reachable edit back so the detach path is measured against it.
back = target.matrix.copy()
back.translation -= armature.matrix_world.inverted().to_3x3() @ OUT_OF_REACH_DELTA
target.matrix = back
target.keyframe_insert("location", frame=EDIT_FRAME)
bpy.context.view_layer.update()
scene.frame_set(EDIT_FRAME)
results["editRestoredMm"] = round((world_head(armature, "LeftHand") - edited_hand).length * 1000, 4)

# A bone the IK layer cannot touch must come out of the bake untouched.
def untouched_bone_keys(rig):
    """Keyframes on a driven bone the IK layer cannot reach.

    Spine1 is rotated by the ARDY clip and by no IK chain, so its curve must
    come out of the bake byte-for-byte identical. A finger would be a weaker
    witness: this clip never poses the fingers, so its count is zero either way.
    """
    return [
        (curve.data_path, curve.array_index, [
            (round(k.co[0], 6), round(k.co[1], 9)) for k in curve.keyframe_points
        ])
        for curve in action_fcurves(rig)
        if 'pose.bones["' in curve.data_path
        and curve.data_path.split('"')[1] == PREFIX + "Spine1"
    ]

results["untouchedBoneBeforeDetach"] = untouched_bone_keys(armature)

# --- custom-property f-curves on a control bone must be torn down too -----
# The next slice keys a "cclay_constraint" custom property on the anchors; this
# probe proves _remove_control_fcurves catches a curve whose data_path is
# pose.bones["<name>"]["<prop>"], not just location/rotation. The check runs
# before detach so we can assert the curve existed, then assert it is gone
# afterwards.
CUSTOM_PROP = "cclay_constraint"
CUSTOM_PROP_PATH = f'["{CUSTOM_PROP}"]'
anchor_pose = armature.pose.bones[ik_chains.FULLBODY_ANCHOR]
anchor_pose[CUSTOM_PROP] = 1.0
anchor_pose.keyframe_insert(CUSTOM_PROP_PATH, frame=1)
anchor_pose.keyframe_insert(CUSTOM_PROP_PATH, frame=2)
results["customPropCurveBeforeDetach"] = sorted(
    curve.data_path
    for curve in action_fcurves(armature)
    if 'pose.bones["' in curve.data_path
    and ik_chains.is_control_bone(curve.data_path.split('"')[1])
    and CUSTOM_PROP in curve.data_path
)

# --- detach keeping the edit --------------------------------------------
detach_report = ik_rig.detach(armature, keep_edits=True)
results["detachReport"] = detach_report
after_keys = untouched_bone_keys(armature)
results["untouchedBoneUnchanged"] = after_keys == results["untouchedBoneBeforeDetach"]
results["untouchedBoneCurveCount"] = len(after_keys)
scene.frame_set(EDIT_FRAME)
results["editSurvivedDetachMm"] = round(
    (world_head(armature, "LeftHand") - edited_hand).length * 1000, 4
)
results["boneSignatureRestoredAfterKeep"] = (
    bone_signature(armature) == results["boneSignatureBeforeAttach"]
)
results["boneCountAfterDetach"] = len(armature.data.bones)
results["controlBonesAfterDetach"] = [
    bone.name for bone in armature.data.bones if ik_chains.is_control_bone(bone.name)
]
results["ikConstraintsAfterDetach"] = [
    chain.effector
    for chain in ik_chains.IK_CHAINS
    if any(
        c.type == "IK"
        for c in armature.pose.bones[PREFIX + chain.constrained].constraints
    )
]
results["controlFcurvesAfterDetach"] = [
    curve.data_path
    for curve in action_fcurves(armature)
    if 'pose.bones["' in curve.data_path
    and ik_chains.is_control_bone(curve.data_path.split('"')[1])
]
# Confirm the custom-property f-curve from the probe above is gone: this is the
# contract the next slice depends on, that teardown deletes control-bone curves
# whose data_path is pose.bones["<name>"]["<prop>"], not just location/rotation.
results["customPropCurveAfterDetach"] = sorted(
    curve.data_path
    for curve in action_fcurves(armature)
    if 'pose.bones["' in curve.data_path
    and ik_chains.is_control_bone(curve.data_path.split('"')[1])
    and CUSTOM_PROP in curve.data_path
)
# The baked result must be rotations on bones ARDY drives, which is the only
# representation a motion clip can carry back.
driven = {name for name in motion_retarget.MIXAMO_TARGETS.values() if name}
results["bakedRotationBonesOutsideArdy"] = sorted(
    {
        curve.data_path.split('"')[1].removeprefix(PREFIX)
        for curve in action_fcurves(armature)
        if 'pose.bones["' in curve.data_path
        and "rotation" in curve.data_path
        and curve.data_path.split('"')[1].removeprefix(PREFIX) not in driven
    }
)
results["detachOnCleanRigRefused"] = ""
try:
    ik_rig.detach(armature, keep_edits=True)
except ik_rig.IkRigError as error:
    results["detachOnCleanRigRefused"] = str(error)

# --- discard path on a fresh rig ---------------------------------------
bpy.ops.wm.read_factory_settings(use_empty=True)
armature2 = import_rig()
frames2 = bake_ardy_fk(armature2)
bpy.context.view_layer.objects.active = armature2
bpy.ops.object.mode_set(mode="POSE")
fk2 = sample_fk(armature2, frames2)
signature_before_discard = bone_signature(armature2)
ik_rig.attach(armature2)
scene = bpy.context.scene
scene.frame_set(EDIT_FRAME)
target2 = armature2.pose.bones[ik_chains.target_bone_name("LeftHand")]
matrix2 = target2.matrix.copy()
matrix2.translation += armature2.matrix_world.inverted().to_3x3() @ EDIT_DELTA
target2.matrix = matrix2
target2.keyframe_insert("location", frame=EDIT_FRAME)
ik_rig.detach(armature2, keep_edits=False)
results["fidelityAfterDiscard"] = ik_rig.measure_fidelity(armature2, fk2)
results["boneSignatureRestoredAfterDiscard"] = (
    bone_signature(armature2) == signature_before_discard
)
results["controlBonesAfterDiscard"] = [
    bone.name for bone in armature2.data.bones if ik_chains.is_control_bone(bone.name)
]

# --- a rig that is not a mixamo skeleton is refused --------------------
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.object.armature_add()
plain = bpy.context.active_object
try:
    ik_rig.attach(plain)
except ik_rig.IkRigError as error:
    results["nonMixamoRefused"] = str(error)
else:
    results["nonMixamoRefused"] = "<accepted>"

# --- the hashed scene manifest must not notice the layer at all -----------
# manifest._manifest_bones requires an entity id on the ARMATURE *and* on each
# bone, and control bones are created with edit_bones.new() and never stamped.
# So a project with an attached layer still verifies against its stored
# revision. If anyone ever routes control bones through stage_scene and stamps
# them, every stored revision of every project holding a layer breaks.
from cclay import manifest as manifest_module  # noqa: E402

bpy.ops.wm.read_factory_settings(use_empty=True)
armature3 = import_rig()
bake_ardy_fk(armature3)
scene = bpy.context.scene
scene["cclay.project_id"] = "00000000-0000-4000-8000-00000000000a"
armature3["cclay.entity_id"] = "11111111-1111-4111-8111-111111111111"
for index, bone in enumerate(armature3.data.bones):
    bone["cclay.entity_id"] = f"{index:08d}-0000-4000-8000-000000000001"
before_manifest = manifest_module.extract_scene_manifest_v4()
bpy.context.view_layer.objects.active = armature3
bpy.ops.object.mode_set(mode="POSE")
ik_rig.attach(armature3)
after_manifest = manifest_module.extract_scene_manifest_v4()
results["hash"] = {
    "trackedBonesBefore": len(before_manifest.get("bones", [])),
    "trackedBonesAfterAttach": len(after_manifest.get("bones", [])),
    "controlBonesInScene": sum(
        1 for b in armature3.data.bones if ik_chains.is_control_bone(b.name)
    ),
    "controlBonesTracked": sum(
        1
        for b in armature3.data.bones
        if ik_chains.is_control_bone(b.name)
        and manifest_module._tracked_entity_id(b) is not None
    ),
    "sceneHashUnchanged": before_manifest["sceneHash"] == after_manifest["sceneHash"],
}

print("CCLAY_IK_RIG=" + json.dumps(results))
