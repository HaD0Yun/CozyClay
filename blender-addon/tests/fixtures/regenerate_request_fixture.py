"""Drive cclay.request_constraint_regeneration end to end in real Blender.

Everything up to now proved pieces. This proves the operator: a real project
directory, a real clip baked from a real npz, real IK handles, constraints
marked through the same functions the panel calls, and then the operator run
by name through bpy.ops. What lands on disk is the artifact the host will
consume, so the test can check the file rather than the function's return
value.

The synthetic full-body archive is checked the hard way -- reloaded and put
through forward kinematics again -- because a pose npz whose posed_joints do
not match its own rotations is exactly the corruption already present in this
project's hand-made pose files, and nothing downstream detects it.
"""

import json
import pathlib
import sys

import bpy
import numpy

REPOSITORY_ROOT = pathlib.Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPOSITORY_ROOT / "blender-addon"))

import cclay  # noqa: E402
from cclay import constraint_capture, ik_rig  # noqa: E402
from cclay import motion_constraints, motion_retarget, stage_scene  # noqa: E402

CHARACTER = REPOSITORY_ROOT / "blender-addon/cclay/assets/characters/x-bot-tpose.fbx"
ENTITY_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301"
REVISION_ID = "b" * 64
PROJECT_ID = "9f8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d"
START_FRAME = 1
CLIP_FRAMES = 12

arguments = sys.argv[sys.argv.index("--") + 1 :]
SOURCE_NPZ = pathlib.Path(arguments[0])
PROJECT = pathlib.Path(arguments[1])
MOTION_ID = "regen-fixture-base"


def _prepare_project():
    motions = PROJECT / ".cclay" / "motions"
    motions.mkdir(parents=True, exist_ok=True)
    data = numpy.load(SOURCE_NPZ)
    numpy.savez(
        motions / f"{MOTION_ID}.npz",
        local_rot_mats=numpy.asarray(data["local_rot_mats"][:CLIP_FRAMES], numpy.float32),
        posed_joints=numpy.asarray(data["posed_joints"][:CLIP_FRAMES], numpy.float32),
        fps=numpy.asarray(int(data["fps"]) if "fps" in data else 30, numpy.int64),
    )
    (PROJECT / ".cclay" / "project.json").write_text(
        json.dumps({
            "schema_version": 1,
            "project_id": PROJECT_ID,
            "current_revision_id": REVISION_ID,
        }),
        encoding="utf-8",
    )


def _bake():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.fbx(filepath=str(CHARACTER))
    armature = next(o for o in bpy.data.objects if o.type == "ARMATURE")
    bpy.context.view_layer.objects.active = armature
    armature["cclay.entity_id"] = ENTITY_ID

    local_rot_mats, posed_joints, fps, _carried = stage_scene._load_motion_payload(
        PROJECT, MOTION_ID
    )
    bones = armature.data.bones
    prefix, rig_thigh = stage_scene._rig_scale_inputs(bones)
    rest_rotations = {}
    for cskel, target in motion_retarget.MIXAMO_TARGETS.items():
        if target is None:
            continue
        bone = bones.get(f"{prefix}{target}")
        if bone is not None:
            rest_rotations[cskel] = [list(row) for row in bone.matrix_local.to_3x3()]
    scale = motion_retarget.derive_scale(posed_joints[0], rig_thigh)
    tracks = motion_retarget.build_pose_tracks(
        local_rot_mats, posed_joints, rest_rotations,
        list(bones[f"{prefix}Hips"].head_local), scale,
    )

    scene = bpy.context.scene
    scene.frame_start = START_FRAME
    scene.frame_end = START_FRAME + CLIP_FRAMES - 1
    action = bpy.data.actions.new(name=f"CCLAY Motion {MOTION_ID}")
    armature.animation_data_create().action = action
    action["cclay.motion_id"] = MOTION_ID
    action["cclay.motion_fps"] = int(fps)
    action["cclay.motion_frames"] = CLIP_FRAMES
    action["cclay.motion_start_frame"] = START_FRAME
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


_prepare_project()
armature, scale, local_rot_mats, posed_joints = _bake()
scene = bpy.context.scene
ik_rig.attach(armature, START_FRAME, START_FRAME + CLIP_FRAMES - 1)

for kind, frame in {"RightHand": 4, "LeftFoot": 7, "Root2D": 5, "FullBody": 9}.items():
    scene.frame_set(frame)
    constraint_capture.mark_constraint(armature, kind, frame)

report = {}

# No project directory is bound in --background, so the operator's own
# bpy.path.abspath("//") would resolve to "". Saving the file makes "//"
# resolve to the fixture project, which is what the operator reads.
bpy.ops.wm.save_as_mainfile(filepath=str(PROJECT / "scene.blend"))
# Registered by class rather than through cclay.register() so the fixture does
# not also start the bridge handlers; the operator under test is the point.
bpy.utils.register_class(cclay.CCLAY_OT_request_constraint_regeneration)
report["status"] = sorted(bpy.ops.cclay.request_constraint_regeneration())

requests = sorted((PROJECT / ".cclay" / "regenerate-requests").glob("*.json"))
report["requestCount"] = len(requests)
payload = json.loads(requests[0].read_text())
report["payload"] = payload
report["requestFileMode"] = oct(requests[0].stat().st_mode & 0o777)
report["requestFilenameMatchesId"] = requests[0].stem == payload["request_id"]
report["partialsLeft"] = [
    path.name
    for path in (PROJECT / ".cclay").rglob("*.partial")
]

# Detach must have happened, and it must have happened after the capture:
# a request with constraints in it proves the read came first.
report["ikLayerRemains"] = ik_rig.has_ik_layer(armature)

# The synthetic pose archive has to be internally consistent, loadable by the
# same loader apply_motion uses, and actually be the frame that was marked.
synthetic_id = payload["full_body"][0]["synthetic_motion_id"]
pose_rotations, pose_joints, pose_fps, _carried = stage_scene._load_motion_payload(
    PROJECT, synthetic_id
)
report["syntheticShape"] = [list(pose_rotations.shape), list(pose_joints.shape)]
report["syntheticFps"] = int(pose_fps)
offsets = motion_constraints.derive_bone_offsets(
    [[list(r) for r in j] for j in local_rot_mats[0]],
    [list(p) for p in posed_joints[0]],
)
recomputed = motion_constraints.forward_kinematics(
    [[list(r) for r in j] for j in pose_rotations[0]],
    offsets,
    list(pose_joints[0][motion_retarget.JOINT_INDEX["Hips"]]),
)
report["syntheticSelfConsistency"] = max(
    float(sum((a - float(b)) ** 2 for a, b in zip(actual, expected)) ** 0.5)
    for actual, expected in zip(recomputed, pose_joints[0])
)
# ...and it must equal the pose that was on screen at the marked frame, which
# is clip frame 8 of the base clip since nothing was edited.
#
# Split by whether the solver can reach the joint at all. A joint is "carried"
# only if neither it nor any ancestor is IK-driven: a finger keeps its own
# rotation verbatim but still hangs off a solved wrist, so its world position
# inherits the residual and cannot be exact. Merging the two groups would let a
# real transform bug in the carried half hide under the solver's tolerance.
def _solver_reaches(index: int) -> bool:
    while index is not None:
        if motion_retarget.CSKEL27_JOINTS[index] in constraint_capture.IK_DRIVEN_JOINTS:
            return True
        index = motion_constraints.CSKEL27_PARENTS[index]
    return False


_deviation = [
    (
        index,
        float(sum((float(a) - float(b)) ** 2 for a, b in zip(actual, expected)) ** 0.5),
    )
    for index, (actual, expected) in enumerate(zip(pose_joints[0], posed_joints[8]))
]
report["syntheticCarriedJointError"] = max(
    value for index, value in _deviation if not _solver_reaches(index)
)
report["syntheticSolvedJointError"] = max(
    value for index, value in _deviation if _solver_reaches(index)
)
report["sourceClip"] = SOURCE_NPZ.name
# The pending record is what survives regeneration. Without it the constraints
# vanish with the replaced action, so it is checked here rather than trusted.
_pending = constraint_capture.read_pending_request(armature)
report["pending"] = _pending

# Stand in for the host: write the outcome the sweep would have written, and
# put a regenerated clip on the rig. The generator is not run here -- what is
# under test is whether the add-on picks the answer back up and restores the
# constraints onto whatever clip landed.
#
# The new clip is SHORTER than the original (7 frames against 12) so a marker
# past its end has somewhere to go wrong, and the scene is left much LONGER
# than either. Those two must disagree: checking the scene range instead of the
# clip's own range looks correct whenever they happen to match, and a scene
# outliving its clip is the normal case, not a corner one.
REGENERATED_FRAMES = 7
armature.animation_data.action["cclay.motion_frames"] = REGENERATED_FRAMES
scene.frame_start = 1
scene.frame_end = 250
outcomes = PROJECT / ".cclay" / "regenerate-outcomes"
outcomes.mkdir(parents=True, exist_ok=True)
(outcomes / f"{_pending['request_id']}.json").write_text(
    json.dumps({
        "schema_version": 1,
        "request_id": _pending["request_id"],
        "status": "succeeded",
        "result": {
            "schema_version": 1,
            "request_id": _pending["request_id"],
            "motion_id": "regenerated-clip",
            "frames": REGENERATED_FRAMES,
            "achieved_error_m": 0.004,
            "residual": {
                "max_error_m": 0.004,
                "mean_error_m": 0.002,
                "worst_frame": 3,
                "worst_joint": "RightHand",
            },
            "continuity": {
                "mean_jump_m": 0.0,
                "max_jump_m": 0.30,
                "max_jump_frame": 0,
            },
            "dropped_constraints": [],
        },
        "resulting_revision_id": "c" * 64,
    }),
    encoding="utf-8",
)

# Seeded so the outcome's 0.30m jump is a real worsening against 0.10m rather
# than a first measurement with nothing to compare to.
constraint_capture.record_continuity(armature, 0.10)
bpy.utils.register_class(cclay.CCLAY_OT_apply_regeneration_outcome)
report["applyStatus"] = sorted(bpy.ops.cclay.apply_regeneration_outcome())
report["ikLayerRestored"] = ik_rig.has_ik_layer(armature)
report["frameRange"] = [scene.frame_start, scene.frame_end]
report["clipRange"] = [
    constraint_capture.base_clip_of(armature)["start_frame"],
    constraint_capture.base_clip_of(armature)["frame_count"],
]
report["outcomeDiscarded"] = not (
    outcomes / f"{_pending['request_id']}.json"
).exists()
report["controlBones"] = sorted(b.name for b in armature.data.bones if b.name.startswith("CCLAY-"))
report["continuityAfter"] = constraint_capture.previous_continuity(armature)
report["continuityWarning"] = constraint_capture.continuity_warning(0.10, 0.30)
report["pendingCleared"] = constraint_capture.read_pending_request(armature) is None
report["restoredMarks"] = {
    kind: constraint_capture.marked_frames(armature, kind)
    for kind in constraint_capture.ANCHOR_BY_KIND
}

print("CCLAY_REGENERATE_REQUEST=" + json.dumps(report, default=float))
