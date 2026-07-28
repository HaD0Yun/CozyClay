"""Prove the mark/clear guards behave in real Blender 5.2.

The IK layer sits over an ARDY clip, and a constraint only means anything
relative to that clip's frames. The mark operator refuses a frame outside the
clip (so a stranded mark never survives until Regenerate detaches the rig and
publishes a request the conversion will reject) and refuses a handle that was
dragged but never keyed (so an unkeyed drag is never silently replaced by the
old keyed pose). The clear operator stays deliberately unguarded so a stranded
mark stays removable.

The rig itself comes from ``ardy_rig_scaffold``, which both this fixture and
the constraint-lane fixture build on.
"""

from __future__ import annotations

import json
import pathlib
import sys

import bpy

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[3] / "blender-addon"))

from tests.fixtures.ardy_rig_scaffold import (  # noqa: E402
    CLIP_FRAMES,
    CLIP_START,
    SCENE_END,
    _legacy_armature_without_clip_metadata,
    build,
    cclay,
    constraint_capture,
)

KIND = "RightHand"

# --- scene setup -----------------------------------------------------------
armature = build()
scene = bpy.context.scene

# Registered by class rather than through cclay.register() so the fixture does
# not also start the bridge handlers/lifecycle timer; the operators under test
# are the point. Matches the pattern in regenerate_request_fixture.py.
bpy.utils.register_class(cclay.CCLAY_OT_mark_constraint)
bpy.utils.register_class(cclay.CCLAY_OT_clear_constraint)

results = {}
results["clipRange"] = [CLIP_START, CLIP_START + CLIP_FRAMES - 1]
results["sceneFrameEnd"] = scene.frame_end

# --- fact 1: inside the clip still works -----------------------------------
scene.frame_set(2)
results["insideStatus"] = sorted(bpy.ops.cclay.mark_constraint(kind=KIND))
results["insideMarkedFrames"] = constraint_capture.marked_frames(armature, KIND)

# --- fact 2: outside the clip is refused at mark time ----------------------
# Record the list before AND after so the host test asserts on the actual list,
# not just the status. A CANCELLED that left a stray key would pass a status-
# only check and fail in production when Regenerate read it.
# bpy.ops raises RuntimeError (carrying the operator's ERROR report) when an
# operator returns CANCELLED after self.report({"ERROR"}, ...); that is how
# Blender surfaces the refusal at the scripting layer. Blender wraps an
# exception raised inside execute() in that same type, so the two are told
# apart by the interpreter tag the wrapped one carries: without that check a
# crashed operator would be recorded as a clean refusal, which is the exact
# regression these tests exist to catch.
scene.frame_set(20)
before_outside = constraint_capture.marked_frames(armature, KIND)


def _record_refusal(call, status_key, message_key):
    try:
        results[status_key] = sorted(call())
        results[message_key] = None
    except RuntimeError as error:
        text = str(error).removeprefix("Error: ")
        crashed = "Traceback" in text or "Python:" in text
        results[status_key] = ["EXCEPTION"] if crashed else ["CANCELLED"]
        results[message_key] = text


_record_refusal(
    lambda: bpy.ops.cclay.mark_constraint(kind=KIND),
    "outsideStatus",
    "outsideMessage",
)
results["outsideMarkedBefore"] = before_outside
results["outsideMarkedAfter"] = constraint_capture.marked_frames(armature, KIND)

# --- fact 3: the refusal is the clip's bound, not the scene's --------------
# Recorded in the report so the host test can assert frame 20 was inside the
# scene range AND still refused. That is the load-bearing distinction: the
# scene is longer than the clip, and the guard checks the clip.
results["refusedFrame"] = 20
results["refusedFrameInsideScene"] = 20 <= scene.frame_end

# --- fact 4: the escape hatch survives -------------------------------------
# Plant a mark outside the clip by calling the pure function directly -- it is
# deliberately unguarded, because a mark left by an earlier (longer) clip must
# stay removable through the UI. Without this a stranded mark would be
# unremovable: clear_constraint is the only UI path, and if it were range-
# guarded the animator could never drop it.
constraint_capture.mark_constraint(armature, KIND, 20)
results["escapeHatchPlanted"] = constraint_capture.marked_frames(armature, KIND)
scene.frame_set(20)
results["escapeHatchStatus"] = sorted(bpy.ops.cclay.clear_constraint(kind=KIND))
results["escapeHatchAfter"] = constraint_capture.marked_frames(armature, KIND)


# --- fact 6: marking writes the dot and nothing else -----------------------
# Marking used to re-key the anchor's location as well, so placing a dot
# silently rewrote the pose at that frame and clearing the dot could not undo
# it. A dot is now a dot: mark and clear are inverses on the curves.
ANCHOR = constraint_capture.ANCHOR_BY_KIND[KIND]
MARKER_PATH = f'pose.bones["{ANCHOR}"]["{constraint_capture.CONSTRAINT_MARKER}"]'
LOCATION_PATH = f'pose.bones["{ANCHOR}"].location'


def _curve_state():
    curves = list(constraint_capture._fcurves(armature))
    marker = next((c for c in curves if c.data_path == MARKER_PATH), None)
    location = sorted(
        (c for c in curves if c.data_path == LOCATION_PATH),
        key=lambda c: c.array_index,
    )
    return {
        "markerKeys": sorted(round(k.co[0]) for k in marker.keyframe_points)
        if marker
        else [],
        "locationKeyCount": sum(len(c.keyframe_points) for c in location),
        "locationAtFrame": [round(c.evaluate(2), 5) for c in location],
    }


bpy.context.view_layer.objects.active = armature
scene.frame_set(2)
constraint_capture.clear_constraint(armature, KIND, 2)
# The location curve is keyed on every clip frame, so a re-key at frame 2 would
# overwrite an existing key and change neither the count nor the value -- the
# regression would be invisible. Dropping frame 2's location keys first makes a
# re-key have to ADD one, which is measurable.
pose_bone_for_symmetry = armature.pose.bones[ANCHOR]
pose_bone_for_symmetry.keyframe_delete("location", frame=2)
results["symmetryBefore"] = _curve_state()
constraint_capture.mark_constraint(armature, KIND, 2)
results["symmetryAfterMark"] = _curve_state()
constraint_capture.clear_constraint(armature, KIND, 2)
results["symmetryAfterClear"] = _curve_state()

# --- fact 7: a handle moved but never keyed is refused, not papered over ---
# collect_constraints builds the request by scrubbing to the frame and reading
# the pose the curves give back, so an unkeyed drag would be discarded and the
# OLD position committed under a dot that looks correct. The operator refuses
# instead. Auto Keying makes this unreachable, which is exactly why the test
# turns it off.
scene.tool_settings.use_keyframe_insert_auto = False
pose_bone = armature.pose.bones[ANCHOR]
scene.frame_set(2)
results["driftedControlsBeforeMove"] = round(len(constraint_capture.unkeyed_pose(armature, 2, 0.1)), 5)
pose_bone.location = (
    pose_bone.location[0] + 5.0,
    pose_bone.location[1],
    pose_bone.location[2],
)
results["driftedControlsAfterMove"] = round(len(constraint_capture.unkeyed_pose(armature, 2, 0.1)), 5)
_record_refusal(
    lambda: bpy.ops.cclay.mark_constraint(kind=KIND),
    "unkeyedStatus",
    "unkeyedMessage",
)
results["unkeyedMarkedAfter"] = constraint_capture.marked_frames(armature, KIND)

# A POLE drag is exactly as lost as a handle drag, and a Full-Body mark reads
# the whole evaluated pose rather than any one anchor. An earlier revision
# checked only the six marker anchors, so it missed poles entirely and returned
# "nothing to check" for Full-Body -- both reported by review as a live bypass.
from cclay import ik_chains as _ik_chains  # noqa: E402

_pose_bone = armature.pose.bones[constraint_capture.ANCHOR_BY_KIND["RightHand"]]
_pole = armature.pose.bones[_ik_chains.pole_bone_name("RightHand")]
_pole_original = tuple(_pole.location)
_pole.location = (_pole_original[0] + 5.0, _pole_original[1], _pole_original[2])
results["poleDriftedControls"] = len(
    constraint_capture.unkeyed_pose(armature, 2, 0.1)
)
_record_refusal(
    lambda: bpy.ops.cclay.mark_constraint(kind="FullBody"),
    "poleFullBodyStatus",
    "poleFullBodyMessage",
)
results["poleFullBodyMarked"] = constraint_capture.marked_frames(armature, "FullBody")
_pole.location = _pole_original
results["poleDriftedAfterRestore"] = len(
    constraint_capture.unkeyed_pose(armature, 2, 0.1)
)

# Hips is neither a target nor a pole, yet Root2D serialises it and Full-Body
# carries it as the root. A guard that enumerated controls missed it; a guard
# over every animated bone cannot.
_hips = next(
    bone for bone in armature.pose.bones if bone.name.endswith("Hips")
)
_hips_original = tuple(_hips.location)
_hips.location = (_hips_original[0] + 5.0, _hips_original[1], _hips_original[2])
results["hipsDrifted"] = constraint_capture.unkeyed_pose(armature, 2, 0.1)
_record_refusal(
    lambda: bpy.ops.cclay.mark_constraint(kind="Root2D"),
    "hipsRoot2DStatus",
    "hipsRoot2DMessage",
)
results["hipsRoot2DMarked"] = constraint_capture.marked_frames(armature, "Root2D")
_hips.location = _hips_original

# Moving a constraint ANCHOR is not a pose edit at all -- the anchors only
# carry keys -- so it must not be refused. Checking anchors instead of controls
# would fail here, refusing a request for a movement capture never reads.
# Every earlier drift is restored and keyed first, so the expected answer here
# is an EXACT empty list rather than "the same nonzero number as before".
_pose_bone.keyframe_insert("location", frame=2)
results["driftedBeforeAnchorMove"] = constraint_capture.unkeyed_pose(armature, 2, 0.1)

_anchor = armature.pose.bones[constraint_capture.ANCHOR_BY_KIND["Root2D"]]
# The anchor is GIVEN a location curve before being moved. Without one the
# check skips it for having nothing keyed to disagree with, and the test would
# pass without ever exercising the exclusion it names.
_anchor.keyframe_insert("location", frame=2)
_anchor_original = tuple(_anchor.location)
_anchor.location = (_anchor_original[0] + 5.0, _anchor_original[1], _anchor_original[2])
results["anchorHasLocationCurve"] = any(
    curve.data_path == f'pose.bones["{_anchor.name}"].location'
    for curve in constraint_capture._fcurves(armature)
)
results["driftedAfterAnchorMove"] = constraint_capture.unkeyed_pose(armature, 2, 0.1)
_anchor.location = _anchor_original

# Keying the drag makes the same mark succeed: the guard is about the curves
# disagreeing with the pose, not about refusing edited handles.
pose_bone.keyframe_insert("location", frame=2)
results["driftedControlsAfterKeying"] = round(
    len(constraint_capture.unkeyed_pose(armature, 2, 0.1)), 5
)
results["afterKeyingStatus"] = sorted(bpy.ops.cclay.mark_constraint(kind=KIND))
results["afterKeyingMarked"] = constraint_capture.marked_frames(armature, KIND)
constraint_capture.clear_constraint(armature, KIND, 2)
scene.tool_settings.use_keyframe_insert_auto = True


# --- fact 5: a rig with no ARDY clip metadata is reported, not crashed -----
# The mark operator reads base_clip_of before it touches any IK handle, and
# base_clip_of raises ConstraintCaptureError when cclay.motion_id is absent.
# The operator catches that and returns CANCELLED with an ERROR report, which
# bpy.ops surfaces as a RuntimeError -- the same path as fact 2, and told from
# a genuine crash the same way.
legacy = _legacy_armature_without_clip_metadata()
legacy_scene = bpy.context.scene
legacy_scene.frame_set(1)
bpy.context.view_layer.objects.active = legacy
_record_refusal(
    lambda: bpy.ops.cclay.mark_constraint(kind=KIND),
    "noMetadataStatus",
    "noMetadataMessage",
)
results["noMetadataHasMotionId"] = "cclay.motion_id" in (
    legacy.animation_data.action.keys()
)

print("CCLAY_CONSTRAINT_FRAME_GUARD=" + json.dumps(results))
