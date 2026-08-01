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

# Platform fact, recorded so the next reader does not "fix" the cancel
# assertions back to checking a returned status: in Blender 5.2 --background,
# bpy.ops converts an operator's {"ERROR"} report into a RAISED RuntimeError
# and discards the set the operator returned. An operator that reports ERROR
# and returns {"CANCELLED"} therefore surfaces to the caller as a raised
# RuntimeError, never as {"CANCELLED"}. (INFO reports return normally; that is
# why the successful-request phase below can read its {"FINISHED"} status.)
# The only observable difference between "operator caught the error, reported
# it, and cancelled" and "the error escaped execute() as an unhandled
# traceback" is the exception MESSAGE: a caught cancel is a clean
# RuntimeError("Error: <original message>") with no traceback, while an
# uncaught escape is RuntimeError("Error: Python: Traceback ...") with the
# traceback embedded. Both raise RuntimeError; the message content is the
# signal, and that is what the out-of-range phase below records and asserts.
import json
import pathlib
import sys

import bpy
import numpy

REPOSITORY_ROOT = pathlib.Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPOSITORY_ROOT / "blender-addon"))

import cclay  # noqa: E402
from cclay import constraint_capture, ik_rig  # noqa: E402
from cclay import motion_archive, motion_constraints, motion_retarget  # noqa: E402
from cclay.character_rig import CharacterRigAdapter  # noqa: E402

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
    # Both stamps, because that is what _create_character leaves on a staged
    # character and what regeneration checks: an entity id travels with a rig
    # appended from another .blend, so the project id is the part that says
    # this rig belongs to THIS project.
    armature["cclay.entity_id"] = ENTITY_ID
    armature["cclay.owned_project_id"] = PROJECT_ID

    local_rot_mats, posed_joints, fps, _carried = motion_archive.load_motion_payload(
        PROJECT, MOTION_ID
    )
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
# attach() is called directly here rather than through CCLAY_OT_attach_ik_rig,
# which is what normally turns Auto Keying on. Every request below would
# otherwise hit the "Auto Keying is off" refusal before reaching what it means
# to test.
bpy.context.scene.tool_settings.use_keyframe_insert_auto = True

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
# The acknowledgement that clears a recorded Auto Keying lapse.
bpy.utils.register_class(cclay.CCLAY_OT_marks_checked)
# A mark placed while a longer clip was applied is out of range for the
# current clip. mark_constraint is unguarded on purpose -- the panel guards
# before it -- so planting one directly exercises the operator's own guard.
# This runs before the rig is detached, so a cancelled attempt leaves the IK
# layer exactly as it was: the whole point is that cancellation is safe.
#
# The frame is derived from the clip constants rather than hardcoded so the
# test stays correct if the clip length changes: anything past the last valid
# scene frame (START_FRAME + CLIP_FRAMES - 1) is out of range.
OUT_OF_RANGE_FRAME = START_FRAME + CLIP_FRAMES
constraint_capture.mark_constraint(armature, "RightHand", OUT_OF_RANGE_FRAME)
report["plantedMarkKind"] = "RightHand"
report["plantedMarkFrame"] = OUT_OF_RANGE_FRAME
report["plantedMarkPresentBefore"] = OUT_OF_RANGE_FRAME in constraint_capture.marked_frames(
    armature, "RightHand"
)

# Record BOTH the returned status and any raised exception (type AND message).
# Per the platform fact at the top of this file, an operator that reports
# {"ERROR"} and returns {"CANCELLED"} surfaces through bpy.ops in --background
# as a RAISED RuntimeError, not as a returned set, so outOfRangeStatus stays
# None even though the operator internally cancelled. That None is not a
# missing signal -- it is the platform behaviour -- and recording it keeps the
# next reader from mistaking it for a crash.
#
# The message is what separates a clean cancel from an uncaught crash:
#   caught  -> RuntimeError("Error: scene frame N is outside clip range [...]")
#   crashed -> RuntimeError("Error: Python: Traceback ... <ExcType>: ...")
# Both raise RuntimeError; only the message content differs. The host test
# asserts the positive (the converter's own range text) and the negative (no
# Traceback / Python: prefix) together, so an unrelated clean failure or a
# traceback that happens to quote the same text each fail one half.
report["outOfRangeStatus"] = None
report["outOfRangeException"] = None
report["outOfRangeExceptionMessage"] = None
try:
    report["outOfRangeStatus"] = sorted(
        bpy.ops.cclay.request_constraint_regeneration()
    )
except BaseException as error:  # noqa: BLE001 -- record, do not re-raise
    report["outOfRangeException"] = type(error).__name__
    report["outOfRangeExceptionMessage"] = str(error)

# Cancellation must be safe: the IK layer is still attached and no request
# file was published, so the animator's rig is not left detached with nothing
# queued for the host.
report["outOfRangeIkLayerRemains"] = ik_rig.has_ik_layer(armature)
report["outOfRangeRequestsWritten"] = sorted(
    path.name
    for path in (PROJECT / ".cclay" / "regenerate-requests").glob("*.json")
)

# Clear the planted mark so the successful-request phase below sees the same
# state it always did: only the four legitimate constraints, none out of
# range. clear_constraint is deliberately unguarded by the clip range, which
# is exactly what makes a stranded mark removable.
constraint_capture.clear_constraint(armature, "RightHand", OUT_OF_RANGE_FRAME)
report["plantedMarkCleared"] = OUT_OF_RANGE_FRAME not in constraint_capture.marked_frames(
    armature, "RightHand"
)

# A handle dragged but never keyed must stop the request BEFORE anything is
# captured, detached or published. The capture calls scene.frame_set and reads
# back whatever the curves say, so an unkeyed drag is discarded and the OLD
# pose is committed under a mark that looks perfectly correct. The mark
# operator refuses this too, but Blender's own I places a mark without going
# near that operator -- and the Dope Sheet lanes exist so that I is the normal
# way to work -- so the check has to live at the boundary both paths share.
# Auto Keying stays ON: a direct assignment is not a transform operator, so
# Blender does not key it, and the drift check is what has to catch this. That
# keeps this phase testing the drift check rather than the Auto Keying refusal
# added for the sequence below.
_drag_bone = armature.pose.bones[constraint_capture.ANCHOR_BY_KIND["RightHand"]]
_drag_frame = bpy.context.scene.frame_current
_drag_original = tuple(_drag_bone.location)
_drag_bone.location = (
    _drag_original[0] + 5.0,
    _drag_original[1],
    _drag_original[2],
)
report["unkeyedDriftedControls"] = round(
    len(constraint_capture.unkeyed_pose(armature, _drag_frame, 0.1)), 4
)
report["unkeyedStatus"] = None
report["unkeyedMessage"] = None
try:
    report["unkeyedStatus"] = sorted(
        bpy.ops.cclay.request_constraint_regeneration()
    )
except RuntimeError as error:
    report["unkeyedStatus"] = ["CANCELLED"]
    report["unkeyedMessage"] = str(error)
report["unkeyedIkLayerRemains"] = ik_rig.has_ik_layer(armature)
report["unkeyedRequestsWritten"] = sorted(
    path.name
    for path in (PROJECT / ".cclay" / "regenerate-requests").glob("*.json")
)
# Put the pose back so the successful-request phase below sees the state it
# always did.
_drag_bone.location = _drag_original
report["unkeyedDriftedAfterRestore"] = round(
    len(constraint_capture.unkeyed_pose(armature, _drag_frame, 0.1)), 4
)
bpy.context.scene.tool_settings.use_keyframe_insert_auto = False
# The sequence review named, which no drift check at request time can catch:
# with Auto Keying off, drag a handle, place a mark with Blender's own I --
# which never touches the mark operator or its guard -- then CHANGE FRAME. The
# drag is discarded by that frame change, so the scene is clean by the time
# regeneration looks, and capture would scrub back and serialise the old pose
# under a mark that looks perfectly correct. Nothing survives to detect it, so
# regeneration refuses outright while Auto Keying is off.
_stale_frame = bpy.context.scene.frame_current
_drag_bone.location = (
    _drag_original[0] + 5.0,
    _drag_original[1],
    _drag_original[2],
)
constraint_capture.mark_constraint(armature, "RightHand", _stale_frame)
bpy.context.scene.frame_set(_stale_frame + 1)
report["staleDriftAtRequestTime"] = constraint_capture.unkeyed_pose(
    armature, bpy.context.scene.frame_current, 0.1
)
report["staleStatus"] = None
report["staleMessage"] = None
try:
    report["staleStatus"] = sorted(bpy.ops.cclay.request_constraint_regeneration())
except RuntimeError as error:
    report["staleStatus"] = ["CANCELLED"]
    report["staleMessage"] = str(error)
report["staleIkLayerRemains"] = ik_rig.has_ik_layer(armature)
report["staleRequestsWritten"] = sorted(
    path.name
    for path in (PROJECT / ".cclay" / "regenerate-requests").glob("*.json")
)
# And the bypass review found: turning Auto Keying back ON before requesting
# makes the setting look clean while the lost edit is still undetectable. The
# lapse is recorded when it happens rather than inferred from the current
# setting, so the refusal survives the re-enable.
# The lifecycle timer is what records the lapse in a running session; in
# background there is no timer, so the same function is called directly, while
# Auto Keying is still off -- which is the whole point: the record is made when
# the lapse happens, not inferred later from a setting that has since changed.
cclay._note_autokey_lapse()
report["lapseRecordedWhileOff"] = bool(bpy.context.scene.get(cclay.AUTOKEY_LAPSED))
bpy.context.scene.tool_settings.use_keyframe_insert_auto = True
report["autoKeyOnAtRequest"] = bpy.context.scene.tool_settings.use_keyframe_insert_auto
report["reEnabledStatus"] = None
report["reEnabledMessage"] = None
try:
    report["reEnabledStatus"] = sorted(bpy.ops.cclay.request_constraint_regeneration())
except RuntimeError as error:
    report["reEnabledStatus"] = ["CANCELLED"]
    report["reEnabledMessage"] = str(error)
report["reEnabledRequestsWritten"] = sorted(
    path.name
    for path in (PROJECT / ".cclay" / "regenerate-requests").glob("*.json")
)

# Acknowledging clears it, and only then does the request proceed. The
# acknowledgement is a separate deliberate action because nothing in the file
# can tell a mark made during the lapse from one made before it.
# The lifecycle timer is what records the lapse in a real session, so the
# wiring is measured, not assumed: clear the flag, run the timer callback with
# Auto Keying off, and the flag must come back. Calling the recorder directly
# elsewhere proves the recorder works and nothing about who calls it.
if cclay.AUTOKEY_LAPSED in bpy.context.scene.keys():
    del bpy.context.scene[cclay.AUTOKEY_LAPSED]
bpy.context.scene.tool_settings.use_keyframe_insert_auto = False
report["lapseClearedBeforePump"] = bool(bpy.context.scene.get(cclay.AUTOKEY_LAPSED))
try:
    cclay._pump_lifecycle()
except Exception as error:  # noqa: BLE001 - the bridge is absent in a fixture
    report["pumpRaised"] = type(error).__name__
else:
    report["pumpRaised"] = None
report["lapseAfterPump"] = bool(bpy.context.scene.get(cclay.AUTOKEY_LAPSED))
bpy.context.scene.tool_settings.use_keyframe_insert_auto = True

report["marksCheckedStatus"] = sorted(bpy.ops.cclay.marks_checked())
report["lapseAfterAcknowledgement"] = bool(
    bpy.context.scene.get(cclay.AUTOKEY_LAPSED)
)

# A ghost holding an edit nobody applied must stop the request, for the same
# reason the lapse does: what would be published is not what is on screen.
#
# After the acknowledgement above, deliberately: the lapse guard runs first, so
# placing this before it measured the lapse refusing and said nothing about
# ghosts at all.
from cclay import constraint_ghost, ik_chains  # noqa: E402

_ghost_frame = sorted(constraint_capture.marked_frames(armature, "RightHand"))[0]
_ghost = constraint_ghost.create_ghost(armature, "RightHand", _ghost_frame)
_ghost_target = ik_chains.target_bone_name("RightHand")
_ghost.pose.bones[_ghost_target].location = [
    v + d for v, d in zip(_ghost.pose.bones[_ghost_target].location, (0.0, 0.0, 0.4))
]
report["unappliedGhosts"] = constraint_ghost.uncommitted_ghosts(armature)
try:
    report["unappliedStatus"] = sorted(bpy.ops.cclay.request_constraint_regeneration())
    report["unappliedMessage"] = None
except RuntimeError as error:
    report["unappliedStatus"] = ["CANCELLED"]
    report["unappliedMessage"] = str(error)
report["unappliedRequestsWritten"] = sorted(
    path.name
    for path in (PROJECT / ".cclay" / "regenerate-requests").glob("*.json")
)
report["unappliedIkLayerRemains"] = ik_rig.has_ik_layer(armature)
constraint_ghost.remove_all_ghosts(armature)



constraint_capture.clear_constraint(armature, "RightHand", _stale_frame)
_drag_bone.location = _drag_original
bpy.context.scene.frame_set(_stale_frame)

# A rig this project does not own must be refused before anything is captured,
# detached or published. Dropping the ownership stamp is exactly the shape of a
# rig appended from another .blend: it still carries an entity id, so a check
# that only looked for one would sail past this.
del armature["cclay.owned_project_id"]
report["foreignStatus"] = None
report["foreignException"] = None
report["foreignExceptionMessage"] = None
try:
    report["foreignStatus"] = sorted(bpy.ops.cclay.request_constraint_regeneration())
except BaseException as error:  # noqa: BLE001 -- record, do not re-raise
    report["foreignException"] = type(error).__name__
    report["foreignExceptionMessage"] = str(error)
report["foreignIkLayerRemains"] = ik_rig.has_ik_layer(armature)
report["foreignRequestsWritten"] = sorted(
    path.name
    for path in (PROJECT / ".cclay" / "regenerate-requests").glob("*.json")
)
armature["cclay.owned_project_id"] = PROJECT_ID
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
pose_rotations, pose_joints, pose_fps, _carried = motion_archive.load_motion_payload(
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
