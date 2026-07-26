"""What happens to the rig when the host's answer is bad or is a failure.

Both cases used to strand the animator. The IK layer is already detached by
the time an outcome exists, so anything that returns without reattaching it
leaves a rig with no handles and a panel that offers only the button that just
failed. And a malformed success was trusted far enough to reattach, re-key and
clear the pending record BEFORE the missing field was noticed, which tore the
rig down and then raised.

This drives the real operator against a real armature for three answers:
malformed, failed, and a success addressed to a different request.
"""

import json
import pathlib
import sys

import bpy

REPOSITORY_ROOT = pathlib.Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPOSITORY_ROOT / "blender-addon"))

import cclay  # noqa: E402
from cclay import constraint_capture, ik_rig  # noqa: E402

CHARACTER = REPOSITORY_ROOT / "blender-addon/cclay/assets/characters/x-bot-tpose.fbx"
PROJECT = pathlib.Path(sys.argv[sys.argv.index("--") + 1])
PROJECT_ID = "9f8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d"
ENTITY_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301"
REQUEST_ID = "aaaabbbbccccdddd0000111122223333"
MARKS = {"RightHand": [4], "Root2D": [5]}
CLIP_FRAMES = 12


def _valid_result(request_id=REQUEST_ID):
    return {
        "schema_version": 1,
        "request_id": request_id,
        "motion_id": "regenerated-clip",
        "frames": 7,
        "achieved_error_m": 0.004,
        "residual": None,
        "continuity": {"mean_jump_m": 0.0, "max_jump_m": 0.01, "max_jump_frame": 0},
        "dropped_constraints": [],
    }


def _write_outcome(body):
    directory = PROJECT / ".cclay" / "regenerate-outcomes"
    directory.mkdir(parents=True, exist_ok=True)
    (directory / f"{REQUEST_ID}.json").write_text(json.dumps(body), encoding="utf-8")


def _fresh_rig():
    """A detached rig with a pending request, exactly as publishing leaves it."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.fbx(filepath=str(CHARACTER))
    armature = next(o for o in bpy.data.objects if o.type == "ARMATURE")
    bpy.context.view_layer.objects.active = armature
    armature["cclay.entity_id"] = ENTITY_ID

    scene = bpy.context.scene
    scene.frame_start = 1
    scene.frame_end = CLIP_FRAMES
    action = bpy.data.actions.new("CCLAY Motion regenerated-clip")
    armature.animation_data_create().action = action
    action["cclay.motion_id"] = "regenerated-clip"
    action["cclay.motion_fps"] = 20
    action["cclay.motion_frames"] = CLIP_FRAMES
    action["cclay.motion_start_frame"] = 1
    prefix = "mixamorig:"
    hips = armature.pose.bones[f"{prefix}Hips"]
    for frame in range(1, CLIP_FRAMES + 1):
        hips.location = (0.0, 0.0, 0.0)
        hips.keyframe_insert("location", frame=frame)
    constraint_capture.record_pending_request(armature, REQUEST_ID, MARKS)
    return armature, scene


def _apply(label, outcome_body, report):
    armature, scene = _fresh_rig()
    # Saved after the factory reset, not before it: the reset clears the file
    # path, and the operator resolves its project directory from "//".
    bpy.ops.wm.save_as_mainfile(filepath=str(PROJECT / "scene.blend"))
    _write_outcome(outcome_body)
    # bpy.ops turns a reported ERROR into RuntimeError when called from a
    # script, so a refusal arrives as an exception rather than a status.
    try:
        status = sorted(bpy.ops.cclay.apply_regeneration_outcome())
        message = None
    except RuntimeError as error:
        status = ["CANCELLED"]
        message = str(error)
    report[label] = {
        "status": status,
        "message": message,
        "ikLayer": ik_rig.has_ik_layer(armature),
        "pending": constraint_capture.read_pending_request(armature) is not None,
        "marks": {
            kind: constraint_capture.marked_frames(armature, kind)
            for kind in ("RightHand", "Root2D")
        }
        if ik_rig.has_ik_layer(armature)
        else {},
    }


(PROJECT / ".cclay").mkdir(parents=True, exist_ok=True)
(PROJECT / ".cclay" / "project.json").write_text(
    json.dumps({
        "schema_version": 1,
        "project_id": PROJECT_ID,
        "current_revision_id": "b" * 64,
    }),
    encoding="utf-8",
)
bpy.utils.register_class(cclay.CCLAY_OT_apply_regeneration_outcome)

report = {}

# A success whose result was never filled in. The old reader accepted this and
# only tripped on the missing field after the rig had been rebuilt.
_apply(
    "malformed",
    {"schema_version": 1, "request_id": REQUEST_ID, "status": "succeeded"},
    report,
)

# A genuine failure. The animator must get their handles and marks back.
_apply(
    "failed",
    {
        "schema_version": 1,
        "request_id": REQUEST_ID,
        "status": "failed",
        "error_code": "GENERATION_FAILED",
        "message": "wrapper exited 1",
    },
    report,
)

# A well-formed success addressed to a different request: applying it would put
# a clip on this armature that nobody asked for here.
_apply(
    "misaddressed",
    {
        "schema_version": 1,
        "request_id": REQUEST_ID,
        "status": "succeeded",
        "result": _valid_result("some-other-request"),
        "resulting_revision_id": "c" * 64,
    },
    report,
)

print("CCLAY_OUTCOME_RECOVERY=" + json.dumps(report, default=str))
