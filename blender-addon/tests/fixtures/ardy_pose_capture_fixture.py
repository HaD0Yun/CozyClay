"""Drive capture_evaluated_pose end to end in real Blender.

Builds a project directory with a real base npz, bakes that motion onto a
character as FK (the same bake apply_motion produces), attaches the IK layer,
and exercises the closed capture contract: a successful capture at declared
scene frames, evaluated-pose verification against a keyed handle edit, the
entered-frame restore on both paths, and every fail-closed mode (wrong
armature, missing base archive, bad frame mapping, a pre-existing archive
collision) with no file written. The capture is atomic: a mid-loop write
failure, a success-path restoration failure, or a restoration failure riding
on an error path all leave zero archives behind, with the primary error
surviving and secondary failures attached as context.

The report is printed as one CCLAY_POSE_CAPTURE= line the host test parses.
"""
from __future__ import annotations

import json
import os
import pathlib
import sys

import numpy
REPOSITORY_ROOT = pathlib.Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPOSITORY_ROOT / "blender-addon"))
for module in (
    "cclay",
    "cclay.character_rig",
    "cclay.ik_chains",
    "cclay.ik_rig",
    "cclay.motion_archive",
    "cclay.motion_constraints",
    "cclay.motion_retarget",
    "cclay.constraint_capture",
    "cclay.project_store",
):
    sys.modules.pop(module, None)

import bpy  # noqa: E402
from tests.fixtures import ardy_rig_scaffold as scaffold  # noqa: E402
from cclay import (  # noqa: E402
    constraint_capture,
    ik_chains,
    ik_rig,
    motion_archive,
    motion_constraints,
    motion_retarget,
)

ENTITY_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301"
FOREIGN_ENTITY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
REVISION_ID = "b" * 64
PROJECT_ID = "9f8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d"
FPS = 20
BASE_MOTION_ID = "pose-capture-base"
# One request id per capture run: synthetic ids embed the request id, so a
# second run under the same id would (correctly) fail on "already exists".
SUCCESS_REQUEST_ID = "0123456789abcdef0123456789abcdef"
EDIT_REQUEST_ID = "11111111111111111111111111111111"
MID_CAPTURE_REQUEST_ID = "22222222222222222222222222222222"
FAIL_REQUEST_ID = "33333333333333333333333333333333"
UNOWNED_REQUEST_ID = "44444444444444444444444444444444"
COLLISION_REQUEST_ID = "55555555555555555555555555555555"
RESTORE_FAIL_REQUEST_ID = "66666666666666666666666666666666"
COMBINED_REQUEST_ID = "77777777777777777777777777777777"
POST_PUBLISH_REQUEST_ID = "88888888888888888888888888888888"
FOREIGN_COLLISION_REQUEST_ID = "99999999999999999999999999999999"
STAGED_UNLINK_REQUEST_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
# The scene frame the test enters before each capture; outside the clip on
# purpose, so a restored frame proves the finally ran and was not a side
# effect of ending up on a clip frame.
ENTERED_FRAME = 37

arguments = sys.argv[sys.argv.index("--") + 1 :]
PROJECT = pathlib.Path(arguments[0])

report = {}


def _synthetic_paths(request_id):
    return sorted(
        (PROJECT / ".cclay" / "motions").glob(f"cclay-pose-{request_id}-*.npz")
    )


def _prepare_project():
    motions = PROJECT / ".cclay" / "motions"
    motions.mkdir(parents=True, exist_ok=True)
    local_rot_mats = numpy.asarray(
        scaffold.MOTION["local_rot_mats"], dtype=numpy.float32
    )
    posed_joints = numpy.asarray(scaffold.MOTION["posed_joints"], dtype=numpy.float32)
    numpy.savez(
        motions / f"{BASE_MOTION_ID}.npz",
        local_rot_mats=local_rot_mats,
        posed_joints=posed_joints,
        fps=numpy.asarray(FPS, dtype=numpy.int64),
    )
    (PROJECT / ".cclay" / "project.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "project_id": PROJECT_ID,
                "current_revision_id": REVISION_ID,
            }
        ),
        encoding="utf-8",
    )


def _build_rig():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    armature = scaffold.import_rig()
    scaffold.bake_ardy_fk(armature)
    action = armature.animation_data.action
    action["cclay.motion_id"] = BASE_MOTION_ID
    action["cclay.motion_frames"] = scaffold.CLIP_FRAMES
    action["cclay.motion_fps"] = FPS
    action["cclay.motion_start_frame"] = scaffold.CLIP_START
    armature["cclay.entity_id"] = ENTITY_ID
    armature["cclay.owned_project_id"] = PROJECT_ID
    scene = bpy.context.scene
    scene.frame_start = scaffold.CLIP_START
    scene.frame_end = scaffold.SCENE_END
    bpy.context.view_layer.objects.active = armature
    bpy.ops.object.mode_set(mode="POSE")
    ik_rig.attach(
        armature, scaffold.CLIP_START, scaffold.CLIP_START + scaffold.CLIP_FRAMES - 1
    )
    return armature, scene


def _request(pose_frames, *, request_id=SUCCESS_REQUEST_ID, entity_id=ENTITY_ID):
    return {
        "entity_id": entity_id,
        "expected_revision_id": REVISION_ID,
        "base_motion_id": BASE_MOTION_ID,
        "request_id": request_id,
        "pose_frames": pose_frames,
    }


def _record_failure(label, error):
    report[f"{label}Code"] = getattr(error, "code", type(error).__name__)
    report[f"{label}Message"] = str(error)
    notes = getattr(error, "__notes__", None)
    if notes:
        report[f"{label}Notes"] = list(notes)


_prepare_project()
armature, scene = _build_rig()

# --- Success path: capture every declared scene frame. -----------------------
# scene frames 1..3 map to clip frames 0..2 under the affine rule with
# CLIP_START = 1, i.e. one constant offset of 1.
success_frames = [
    {"scene_frame": 1, "clip_frame": 0},
    {"scene_frame": 2, "clip_frame": 1},
    {"scene_frame": 3, "clip_frame": 2},
]
scene.frame_set(ENTERED_FRAME)
report["enteredBeforeSuccess"] = scene.frame_current
try:
    result = constraint_capture.capture_evaluated_pose(
        _request(success_frames),
        project_directory=str(PROJECT),
        expected_revision_id=REVISION_ID,
    )
    report["successCode"] = None
except BaseException as error:  # noqa: BLE001 - record, do not re-raise
    _record_failure("success", error)
    report["successCode"] = "RAISED"
report["successResult"] = result
report["restoredAfterSuccess"] = scene.frame_current
report["successIds"] = [
    entry["synthetic_motion_id"] for entry in result["pose_frames"]
]
report["successFiles"] = [path.name for path in _synthetic_paths(SUCCESS_REQUEST_ID)]
report["successFileModes"] = [
    oct(path.stat().st_mode & 0o777)
    for path in _synthetic_paths(SUCCESS_REQUEST_ID)
]
report["successPartials"] = [
    path.name for path in (PROJECT / ".cclay" / "motions").glob("*.partial")
]

# The synthetic archives must pass the same validator apply_motion uses and
# carry the cskel27 / Y-up / FPS invariants of the base clip's npz space.
base_rotations, base_joints, base_fps, _ = motion_archive.load_motion_payload(
    PROJECT, BASE_MOTION_ID
)
report["baseFrames"] = int(base_rotations.shape[0])
report["baseFps"] = int(base_fps)
report["baseRoot"] = [round(float(v), 6) for v in base_joints[0][0]]
archive_checks = []
for entry in result["pose_frames"]:
    path = PROJECT / ".cclay" / "motions" / f"{entry['synthetic_motion_id']}.npz"
    inspect_fps = motion_archive.inspect_motion_archive(
        path, entry["synthetic_motion_id"]
    )
    rotations, joints, fps, _carried = motion_archive.load_motion_payload(
        PROJECT, entry["synthetic_motion_id"]
    )
    archive_checks.append(
        {
            "id": entry["synthetic_motion_id"],
            "clip_frame": entry["clip_frame"],
            "inspect_fps": inspect_fps,
            "shape": [list(rotations.shape), list(joints.shape)],
            "fps": int(fps),
            "root": [round(float(v), 6) for v in joints[0][0]],
        }
    )
report["archiveChecks"] = archive_checks

# Joint-fidelity measurement against the base clip, split by whether the
# solver can reach the joint (same split test_regenerate_request uses, so a
# transform bug in the carried half cannot hide under the IK residual).


def _solver_reaches(index):
    while index is not None:
        if (
            motion_retarget.CSKEL27_JOINTS[index]
            in constraint_capture.IK_DRIVEN_JOINTS
        ):
            return True
        index = motion_constraints.CSKEL27_PARENTS[index]
    return False


fidelity = []
for entry in result["pose_frames"]:
    rotations, joints, fps, _carried = motion_archive.load_motion_payload(
        PROJECT, entry["synthetic_motion_id"]
    )
    clip_frame = entry["clip_frame"]
    carried = 0.0
    solved = 0.0
    for index in range(27):
        delta = max(
            abs(
                float(joints[0][index][axis])
                - float(base_joints[clip_frame][index][axis])
            )
            for axis in range(3)
        )
        if _solver_reaches(index):
            solved = max(solved, delta)
        else:
            carried = max(carried, delta)
    fidelity.append({"clip_frame": clip_frame, "carried": carried, "solved": solved})
report["fidelity"] = fidelity

# --- Evaluated pose: an edited handle must change the captured archive. ------
# Attach keys every handle densely, so before the edit the captured pose at
# scene frame 2 equals the base clip frame 1 within the IK residual. Drag the
# LeftHand handle at frame 2, key it, and the captured rotations for the
# left-arm chain must move by orders of magnitude more -- proof the pose is
# read off the EVALUATED rig, not copied from the base archive.
edit_frame = scaffold.CLIP_START + 1
scene.frame_set(edit_frame)
handle = armature.pose.bones[ik_chains.target_bone_name("LeftHand")]
original = tuple(handle.location)
handle.location = (original[0] + 0.5, original[1], original[2])
handle.keyframe_insert("location", frame=edit_frame)
scene.frame_set(ENTERED_FRAME)
edited = constraint_capture.capture_evaluated_pose(
    _request([{"scene_frame": edit_frame, "clip_frame": 1}], request_id=EDIT_REQUEST_ID),
    project_directory=str(PROJECT),
    expected_revision_id=REVISION_ID,
)
edited_rotations, _edited_joints, _fps, _ = motion_archive.load_motion_payload(
    PROJECT, edited["pose_frames"][0]["synthetic_motion_id"]
)
unedited_rotations, _j, _f, _ = motion_archive.load_motion_payload(
    PROJECT, result["pose_frames"][1]["synthetic_motion_id"]
)
left_arm_joints = [
    index
    for index in range(27)
    if motion_retarget.CSKEL27_JOINTS[index] in ("LeftArm", "LeftForeArm", "LeftHand")
]
report["editedHandleDelta"] = round(
    max(
        abs(
            float(edited_rotations[0][index][row][col])
            - float(unedited_rotations[0][index][row][col])
        )
        for index in left_arm_joints
        for row in range(3)
        for col in range(3)
    ),
    6,
)
handle.location = original
handle.keyframe_insert("location", frame=edit_frame)
scene.frame_set(ENTERED_FRAME)

# --- Failure path A: wrong armature, fails closed with no file written. ------
wrong_frames = [{"scene_frame": 1, "clip_frame": 0}]
scene.frame_set(ENTERED_FRAME)
report["enteredBeforeWrongEntity"] = scene.frame_current
try:
    constraint_capture.capture_evaluated_pose(
        _request(wrong_frames, request_id=FAIL_REQUEST_ID, entity_id=FOREIGN_ENTITY_ID),
        project_directory=str(PROJECT),
        expected_revision_id=REVISION_ID,
    )
    report["wrongEntityCode"] = None
except BaseException as error:  # noqa: BLE001
    _record_failure("wrongEntity", error)
report["restoredAfterWrongEntity"] = scene.frame_current
report["wrongEntityFiles"] = [
    path.name for path in _synthetic_paths(FAIL_REQUEST_ID)
]

# --- Failure path B: revision mismatch, fails closed before any frame. -------
try:
    constraint_capture.capture_evaluated_pose(
        _request(wrong_frames, request_id=FAIL_REQUEST_ID),
        project_directory=str(PROJECT),
        expected_revision_id="c" * 64,
    )
    report["revisionCode"] = None
except BaseException as error:  # noqa: BLE001
    _record_failure("revision", error)
report["revisionFiles"] = [
    path.name for path in _synthetic_paths(FAIL_REQUEST_ID)
]

# --- Failure path C: base clip mismatch, fails closed with no file. ----------
missing_request = _request(wrong_frames, request_id=FAIL_REQUEST_ID)
missing_request["base_motion_id"] = "missing-base-motion"
try:
    constraint_capture.capture_evaluated_pose(
        missing_request,
        project_directory=str(PROJECT),
        expected_revision_id=REVISION_ID,
    )
    report["baseMismatchCode"] = None
except BaseException as error:  # noqa: BLE001
    _record_failure("baseMismatch", error)
report["baseMismatchFiles"] = [
    path.name for path in _synthetic_paths(FAIL_REQUEST_ID)
]

# --- Failure path C2: archive missing under the clip's own motion id. --------
base_npz = PROJECT / ".cclay" / "motions" / f"{BASE_MOTION_ID}.npz"
base_npz.unlink()
try:
    constraint_capture.capture_evaluated_pose(
        _request(wrong_frames, request_id=FAIL_REQUEST_ID),
        project_directory=str(PROJECT),
        expected_revision_id=REVISION_ID,
    )
    report["missingBaseCode"] = None
except BaseException as error:  # noqa: BLE001
    _record_failure("missingBase", error)
numpy.savez(
    base_npz,
    local_rot_mats=numpy.asarray(scaffold.MOTION["local_rot_mats"], numpy.float32),
    posed_joints=numpy.asarray(scaffold.MOTION["posed_joints"], numpy.float32),
    fps=numpy.asarray(FPS, dtype=numpy.int64),
)
report["missingBaseFiles"] = [
    path.name for path in _synthetic_paths(FAIL_REQUEST_ID)
]

# --- Failure path D: bad frame mapping, fails closed with no file. -----------
scene.frame_set(ENTERED_FRAME)
report["enteredBeforeBadMapping"] = scene.frame_current
try:
    constraint_capture.capture_evaluated_pose(
        _request([{"scene_frame": 2, "clip_frame": 0}], request_id=FAIL_REQUEST_ID),
        project_directory=str(PROJECT),
        expected_revision_id=REVISION_ID,
    )
    report["badMappingCode"] = None
except BaseException as error:  # noqa: BLE001
    _record_failure("badMapping", error)
report["restoredAfterBadMapping"] = scene.frame_current
report["badMappingFiles"] = [
    path.name for path in _synthetic_paths(FAIL_REQUEST_ID)
]

# --- Failure path E: a mid-capture write failure rolls the capture back. -----
# The second write is forced to fail after the first archive is on disk, so
# the invocation has something to roll back; atomicity demands the failure
# leave ZERO archives behind, and the finally must still restore the entered
# scene frame.
original_write = constraint_capture.write_pose_source_npz
write_calls = {"count": 0}


def _failing_write(project_directory, motion_id, **kwargs):
    write_calls["count"] += 1
    if write_calls["count"] == 2:
        raise constraint_capture.ConstraintCaptureError(
            "simulated write failure on the second pose"
        )
    return original_write(project_directory, motion_id, **kwargs)


constraint_capture.write_pose_source_npz = _failing_write
scene.frame_set(ENTERED_FRAME)
report["enteredBeforeMidCapture"] = scene.frame_current
try:
    constraint_capture.capture_evaluated_pose(
        _request(success_frames, request_id=MID_CAPTURE_REQUEST_ID),
        project_directory=str(PROJECT),
        expected_revision_id=REVISION_ID,
    )
    report["midCaptureCode"] = None
except BaseException as error:  # noqa: BLE001
    _record_failure("midCapture", error)
constraint_capture.write_pose_source_npz = original_write
report["restoredAfterMidCapture"] = scene.frame_current
report["midCaptureFiles"] = [
    path.name for path in _synthetic_paths(MID_CAPTURE_REQUEST_ID)
]

# --- Failure path G: a pre-existing archive refuses the whole request. -------
# The preflight must fail before any frame is evaluated, and rollback must
# never delete a file this invocation did not create.
pre_existing = (
    PROJECT / ".cclay" / "motions" / f"cclay-pose-{COLLISION_REQUEST_ID}-1.npz"
)
pre_existing.write_bytes(b"stale")
scene.frame_set(ENTERED_FRAME)
report["enteredBeforeCollision"] = scene.frame_current
try:
    constraint_capture.capture_evaluated_pose(
        _request(success_frames, request_id=COLLISION_REQUEST_ID),
        project_directory=str(PROJECT),
        expected_revision_id=REVISION_ID,
    )
    report["collisionCode"] = None
except BaseException as error:  # noqa: BLE001
    _record_failure("collision", error)
report["restoredAfterCollision"] = scene.frame_current
report["collisionFiles"] = [
    path.name for path in _synthetic_paths(COLLISION_REQUEST_ID)
]
report["collisionStaleIntact"] = pre_existing.read_bytes() == b"stale"
pre_existing.unlink()

# --- Failure path F: unowned armature, fails closed with no file. ------------
owner = armature.get("cclay.owned_project_id")
del armature["cclay.owned_project_id"]
try:
    constraint_capture.capture_evaluated_pose(
        _request(wrong_frames, request_id=UNOWNED_REQUEST_ID),
        project_directory=str(PROJECT),
        expected_revision_id=REVISION_ID,
    )
    report["unownedCode"] = None
except BaseException as error:  # noqa: BLE001
    _record_failure("unowned", error)
armature["cclay.owned_project_id"] = owner
report["unownedFiles"] = [path.name for path in _synthetic_paths(UNOWNED_REQUEST_ID)]
# --- Failure path H: a restoration failure on success rolls the capture back. --
# The capture itself succeeds; only restoring the entered frame fails. The
# caller must see that failure, and every archive the capture created must be
# rolled back: the scene was left in a state the caller did not ask for.
scene.frame_set(ENTERED_FRAME)
report["enteredBeforeRestoreFail"] = scene.frame_current
original_restore = constraint_capture._restore_scene_frame


def _failing_restore(scene, frame):
    if frame == ENTERED_FRAME:
        raise RuntimeError("simulated frame restore failure")
    return original_restore(scene, frame)


constraint_capture._restore_scene_frame = _failing_restore
try:
    constraint_capture.capture_evaluated_pose(
        _request(success_frames, request_id=RESTORE_FAIL_REQUEST_ID),
        project_directory=str(PROJECT),
        expected_revision_id=REVISION_ID,
    )
    report["restoreFailCode"] = None
except BaseException as error:  # noqa: BLE001
    _record_failure("restoreFail", error)
constraint_capture._restore_scene_frame = original_restore
report["restoreFailFiles"] = [
    path.name for path in _synthetic_paths(RESTORE_FAIL_REQUEST_ID)
]
# --- Failure path I: a restore failure on the error path never masks it. -----
# Both the mid-loop write and the entered-frame restore fail; the caller must
# see the ORIGINAL write failure with the restore failure attached as context,
# never the restore error replacing it.
scene.frame_set(ENTERED_FRAME)
report["enteredBeforeCombined"] = scene.frame_current
original_write = constraint_capture.write_pose_source_npz
original_restore = constraint_capture._restore_scene_frame
write_calls = {"count": 0}


def _failing_write(project_directory, motion_id, **kwargs):
    write_calls["count"] += 1
    if write_calls["count"] == 2:
        raise constraint_capture.ConstraintCaptureError(
            "simulated write failure on the second pose"
        )
    return original_write(project_directory, motion_id, **kwargs)


def _failing_restore(scene, frame):
    if frame == ENTERED_FRAME:
        raise RuntimeError("simulated frame restore failure")
    return original_restore(scene, frame)


constraint_capture.write_pose_source_npz = _failing_write
constraint_capture._restore_scene_frame = _failing_restore
try:
    constraint_capture.capture_evaluated_pose(
        _request(success_frames, request_id=COMBINED_REQUEST_ID),
        project_directory=str(PROJECT),
        expected_revision_id=REVISION_ID,
    )
    report["combinedCode"] = None
except BaseException as error:  # noqa: BLE001
    _record_failure("combined", error)
constraint_capture.write_pose_source_npz = original_write
constraint_capture._restore_scene_frame = original_restore
report["combinedFiles"] = [
    path.name for path in _synthetic_paths(COMBINED_REQUEST_ID)
]

# --- Failure path J: an exception right after a successful publish. ---------
# The first archive is fully published, then the seam raises immediately
# afterwards -- before any post-hoc bookkeeping could run. Rollback must still
# find the archive, because the rollback set was populated BEFORE the publish,
# and leave ZERO archives behind.
original_write = constraint_capture.write_pose_source_npz
write_calls = {"count": 0}


def _post_publish_failure(project_directory, motion_id, **kwargs):
    write_calls["count"] += 1
    result = original_write(project_directory, motion_id, **kwargs)
    if write_calls["count"] == 1:
        raise RuntimeError("simulated failure immediately after publish")
    return result


constraint_capture.write_pose_source_npz = _post_publish_failure
scene.frame_set(ENTERED_FRAME)
report["enteredBeforePostPublish"] = scene.frame_current
try:
    constraint_capture.capture_evaluated_pose(
        _request(success_frames, request_id=POST_PUBLISH_REQUEST_ID),
        project_directory=str(PROJECT),
        expected_revision_id=REVISION_ID,
    )
    report["postPublishCode"] = None
except BaseException as error:  # noqa: BLE001 - record, do not re-raise
    _record_failure("postPublish", error)
constraint_capture.write_pose_source_npz = original_write
report["restoredAfterPostPublish"] = scene.frame_current
report["postPublishFiles"] = [
    path.name for path in _synthetic_paths(POST_PUBLISH_REQUEST_ID)
]

# --- Failure path K: a foreign file lands between preflight and publish. ----
# The preflight has already passed; a foreign actor drops an archive at the
# first destination before its publish. Create-only publication must refuse
# with the collision error, and rollback must leave the foreign file
# byte-identical: a file this invocation did not create is never its to
# delete.
original_write = constraint_capture.write_pose_source_npz
sneak = {"done": False}


def _sneak_foreign_archive(project_directory, motion_id, **kwargs):
    if not sneak["done"]:
        sneak["done"] = True
        foreign = constraint_capture._motion_archive_path(
            project_directory, motion_id
        )
        foreign.write_bytes(b"foreign archive")
    return original_write(project_directory, motion_id, **kwargs)


constraint_capture.write_pose_source_npz = _sneak_foreign_archive
scene.frame_set(ENTERED_FRAME)
report["enteredBeforeForeignCollision"] = scene.frame_current
try:
    constraint_capture.capture_evaluated_pose(
        _request(success_frames, request_id=FOREIGN_COLLISION_REQUEST_ID),
        project_directory=str(PROJECT),
        expected_revision_id=REVISION_ID,
    )
    report["foreignCollisionCode"] = None
except BaseException as error:  # noqa: BLE001 - record, do not re-raise
    _record_failure("foreignCollision", error)
constraint_capture.write_pose_source_npz = original_write
report["restoredAfterForeignCollision"] = scene.frame_current
report["foreignCollisionFiles"] = [
    path.name for path in _synthetic_paths(FOREIGN_COLLISION_REQUEST_ID)
]
report["foreignCollisionForeignIntact"] = (
    (
        PROJECT
        / ".cclay"
        / "motions"
        / f"cclay-pose-{FOREIGN_COLLISION_REQUEST_ID}-1.npz"
    ).read_bytes()
    == b"foreign archive"
)

# --- Failure path L: a staged-file unlink failure is context, never a mask. -
# Write #2 stages and then fails validation; removing the staged file also
# fails. The caller must see the validation error with the unlink failure
# attached as context, and the rollback must still attempt every path -- the
# surviving staged file gets its own rollback note.
original_write = constraint_capture.write_pose_source_npz
original_inspect = constraint_capture.motion_archive.inspect_motion_archive
original_unlink = os.unlink
write_calls = {"count": 0}
unlink_fail = {"armed": False}


def _failing_staged_unlink(path, *args, **kwargs):
    if unlink_fail["armed"] and str(path).endswith(".npz.partial"):
        raise OSError("simulated staged-file unlink failure")
    return original_unlink(path, *args, **kwargs)


def _failing_inspect(staged, motion_id=None):
    # Only the writer's staged validations count: motion_basis and motion_fps
    # also inspect the base .npz before the loop, and those must pass.
    if str(staged).endswith(".npz.partial"):
        write_calls["count"] += 1
        if write_calls["count"] == 2:
            unlink_fail["armed"] = True
            raise motion_archive.MotionArchiveError(
                "INVALID_MOTION_ARCHIVE", "simulated validation failure"
            )
    return original_inspect(staged, motion_id)


constraint_capture.motion_archive.inspect_motion_archive = _failing_inspect
os.unlink = _failing_staged_unlink
scene.frame_set(ENTERED_FRAME)
report["enteredBeforeStagedUnlinkFail"] = scene.frame_current
try:
    constraint_capture.capture_evaluated_pose(
        _request(success_frames, request_id=STAGED_UNLINK_REQUEST_ID),
        project_directory=str(PROJECT),
        expected_revision_id=REVISION_ID,
    )
    report["stagedUnlinkCode"] = None
except BaseException as error:  # noqa: BLE001 - record, do not re-raise
    _record_failure("stagedUnlink", error)
constraint_capture.motion_archive.inspect_motion_archive = original_inspect
os.unlink = original_unlink
report["restoredAfterStagedUnlinkFail"] = scene.frame_current
report["stagedUnlinkFiles"] = [
    path.name for path in _synthetic_paths(STAGED_UNLINK_REQUEST_ID)
]
report["stagedUnlinkPartials"] = [
    path.name for path in (PROJECT / ".cclay" / "motions").glob("*.partial")
]

print(f"CCLAY_POSE_CAPTURE={json.dumps(report, default=str, sort_keys=True)}")
