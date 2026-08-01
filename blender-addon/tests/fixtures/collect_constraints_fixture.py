"""Round-trip collect_constraints against a real ARDY clip.

The check that matters is external: bake a real npz onto the rig, commit
constraints WITHOUT touching the pose, and collect them. Because nothing was
edited, every collected target must equal that npz's own posed_joints. Any
error in the FK, the rotation inverse, the offsets or the root identity shows
up as a distance here, and none of it can be satisfied by the collector
agreeing with itself.

Then the pose IS edited and the same wrist is collected again: the target must
move. A collector that ignored the edit would pass the first check and fail
this one.
"""

import json
import pathlib
import sys

import bpy
import numpy

REPOSITORY_ROOT = pathlib.Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPOSITORY_ROOT / "blender-addon"))

from cclay import constraint_capture, ik_chains, ik_rig  # noqa: E402
from cclay import motion_constraints, motion_retarget  # noqa: E402
from cclay.character_rig import CharacterRigAdapter  # noqa: E402

CHARACTER = REPOSITORY_ROOT / "blender-addon/cclay/assets/characters/x-bot-tpose.fbx"
START_FRAME = 1
CLIP_FRAMES = 12
NPZ = pathlib.Path(sys.argv[sys.argv.index("--") + 1])


def _bake_real_clip():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.fbx(filepath=str(CHARACTER))
    armature = next(o for o in bpy.data.objects if o.type == "ARMATURE")
    bpy.context.view_layer.objects.active = armature

    data = numpy.load(NPZ)
    local_rot_mats = data["local_rot_mats"][:CLIP_FRAMES]
    posed_joints = data["posed_joints"][:CLIP_FRAMES]

    rig = CharacterRigAdapter(armature.data.bones)
    prefix = rig.prefix
    scale = motion_retarget.derive_scale(posed_joints[0], rig.rig_thigh)
    tracks = motion_retarget.build_pose_tracks(
        local_rot_mats, posed_joints, rig.rest_rotations(),
        rig.hips_head(), scale,
    )

    scene = bpy.context.scene
    scene.frame_start = START_FRAME
    scene.frame_end = START_FRAME + CLIP_FRAMES - 1
    for offset in range(CLIP_FRAMES):
        frame = START_FRAME + offset
        scene.frame_set(frame)
        for cskel, quaternions in tracks["rotations"].items():
            target = motion_retarget.MIXAMO_TARGETS[cskel]
            if target is None:
                continue
            pose_bone = armature.pose.bones[f"{prefix}{target}"]
            pose_bone.rotation_mode = "QUATERNION"
            pose_bone.rotation_quaternion = quaternions[offset]
            pose_bone.keyframe_insert("rotation_quaternion", frame=frame)
        hips = armature.pose.bones[f"{prefix}Hips"]
        hips.location = tracks["hips_locations"][offset]
        hips.keyframe_insert("location", frame=frame)
    return armature, scale, local_rot_mats, posed_joints


armature, scale, local_rot_mats, posed_joints = _bake_real_clip()
scene = bpy.context.scene
ik_rig.attach(armature, START_FRAME, START_FRAME + CLIP_FRAMES - 1)

bone_offsets = motion_constraints.derive_bone_offsets(
    [[list(row) for row in joint] for joint in local_rot_mats[0]],
    [list(position) for position in posed_joints[0]],
)

MARKED = {"RightHand": 4, "LeftFoot": 7, "Root2D": 5, "FullBody": 9}
for kind, frame in MARKED.items():
    scene.frame_set(frame)
    constraint_capture.mark_constraint(armature, kind, frame)

collected = constraint_capture.collect_constraints(
    armature, scene,
    bone_offsets=bone_offsets, scale=scale,
    base_rotations=[[[list(r) for r in j] for j in frame] for frame in local_rot_mats],
    start_frame=START_FRAME, frame_count=CLIP_FRAMES,
)

report = {"restoredFrame": scene.frame_current, "collected": collected, "errors": []}
for entry in collected["effectors"]:
    index = motion_retarget.JOINT_INDEX[entry["joint"]]
    expected = posed_joints[entry["frame"]][index]
    report["errors"].append({
        "joint": entry["joint"],
        "clipFrame": entry["frame"],
        "distance": float(
            sum((entry[axis] - float(expected[i])) ** 2
                for i, axis in enumerate("xyz")) ** 0.5
        ),
    })
for entry in collected["root_2d"]:
    expected = posed_joints[entry["frame"]][motion_retarget.JOINT_INDEX["Hips"]]
    report["errors"].append({
        "joint": "Root2D",
        "clipFrame": entry["frame"],
        "distance": float(
            ((entry["x"] - float(expected[0])) ** 2
             + (entry["z"] - float(expected[2])) ** 2) ** 0.5
        ),
    })

# Now move the wrist and re-collect: an edit the collector ignored would leave
# the target where the unedited clip put it.
before = next(e for e in collected["effectors"] if e["joint"] == "RightHand")
scene.frame_set(4)
target = armature.pose.bones[ik_chains.target_bone_name("RightHand")]
target.location = (target.location[0] + 8.0, target.location[1], target.location[2])
target.keyframe_insert("location", frame=4)
edited = constraint_capture.collect_constraints(
    armature, scene,
    bone_offsets=bone_offsets, scale=scale,
    base_rotations=[[[list(r) for r in j] for j in frame] for frame in local_rot_mats],
    start_frame=START_FRAME, frame_count=CLIP_FRAMES,
)
after = next(e for e in edited["effectors"] if e["joint"] == "RightHand")
report["editMovedTargetBy"] = float(
    sum((after[axis] - before[axis]) ** 2 for axis in "xyz") ** 0.5
)

print("CCLAY_COLLECT_CONSTRAINTS=" + json.dumps(report, default=float))
