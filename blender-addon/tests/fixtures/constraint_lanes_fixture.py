"""Prove the constraint lanes are Blender's own channels, in real Blender 5.2.

ARDY shows one named lane per constraint kind. So does the Dope Sheet once the
marker F-curves sit in groups carrying those names -- and because the dots are
real keyframes, Blender's own delete removes one exactly as the add-on's clear
operator does. This stage runs in ``--background`` and covers the grouping, the ordering and
the collapse. It then saves the prepared rig, because the remaining facts --
which editors the lanes appear in, the channel-search round trip, and Blender's
own delete removing a dot -- all need a real window, and building an IK rig
needs a context that only ``--background`` provides. The windowed stage is
``constraint_lanes_window_fixture.py``.
"""

from __future__ import annotations

import json
import pathlib
import sys

import bpy

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[3] / "blender-addon"))

from tests.fixtures.ardy_rig_scaffold import (  # noqa: E402
    build,
    cclay,
    constraint_capture,
)
from cclay import constraint_timeline  # noqa: E402

results = {}
armature = build()
scene = bpy.context.scene

bpy.utils.register_class(cclay.CCLAY_OT_mark_constraint)
bpy.utils.register_class(cclay.CCLAY_OT_clear_constraint)
bpy.utils.register_class(cclay.CCLAY_OT_show_constraint_lanes)
bpy.utils.register_class(cclay.CCLAY_OT_hide_constraint_lanes)


def _groups():
    action = armature.animation_data.action
    return [
        group.name
        for bag in constraint_timeline.channelbags(action)
        for group in bag.groups
    ]


def _lane_groups():
    wanted = {label for label, _kind in constraint_timeline.TRACKS}
    return [name for name in _groups() if name in wanted]


def _collapsed():
    action = armature.animation_data.action
    wanted = {label for label, _kind in constraint_timeline.TRACKS}
    return {
        group.name: group.show_expanded
        for bag in constraint_timeline.channelbags(action)
        for group in bag.groups
        if group.name in wanted
    }


def _dopesheet_area():
    for screen in bpy.data.screens:
        for area in screen.areas:
            if area.type == "DOPESHEET_EDITOR":
                return screen, area
    return None, None


# --- fact 1: all six lanes exist before a single mark ----------------------
# The Dope Sheet draws a channel for an F-curve whether or not it holds keys,
# so attach() creates the six empty marker curves and the animator has six rows
# to click from the start. That is what lets Blender's own I place a mark: a
# lane has to exist to be selected. An earlier revision created a curve only
# when a mark arrived, which meant the first mark of every kind could only come
# from a panel button.
results["lanesBeforeAnyMark"] = constraint_timeline.lane_labels(armature)
# Read BEFORE anything in this fixture calls ensure_lanes: attach is supposed
# to leave the lanes already named and ordered, so that Show only has to
# filter. Measuring after an ensure_lanes call would prove nothing about
# attach.
results["groupsAfterAttachAlone"] = [
    group.name
    for bag in constraint_timeline.channelbags(armature.animation_data.action)
    for group in bag.groups
    if group.name in {label for label, _kind in constraint_timeline.TRACKS}
]
results["createdByAttach"] = sorted(
    constraint_capture.ANCHOR_BY_KIND
)
results["markedBeforeAnyMark"] = {
    kind: frames
    for kind, frames in constraint_capture.marked_frames_by_anchor(armature).items()
}
# Idempotent: running it again creates nothing and disturbs nothing.
try:
    results["secondEnsureCreated"] = constraint_capture.ensure_marker_curves(armature)
    results["secondEnsureRaised"] = None
except Exception as error:  # noqa: BLE001 - a non-idempotent pass raises here
    results["secondEnsureCreated"] = None
    results["secondEnsureRaised"] = type(error).__name__
results["lanesAfterSecondEnsure"] = constraint_timeline.lane_labels(armature)

# --- fact 2: lanes appear in ARDY's order, not in marking order ------------
# Blender draws channel groups in creation order, so grouping as marks arrive
# would give a different lane order in every scene. They are marked here in
# deliberately scrambled order.
for kind, frame in (("RightFoot", 3), ("FullBody", 1), ("LeftHand", 2), ("Root2D", 2)):
    constraint_capture.mark_constraint(armature, kind, frame)
results["markedInThisOrder"] = ["RightFoot", "FullBody", "LeftHand", "Root2D"]
results["shownLanes"] = constraint_timeline.ensure_lanes(armature)
results["laneGroupsInAction"] = _lane_groups()
results["ardyOrder"] = [label for label, _kind in constraint_timeline.TRACKS]

# --- fact 3: each lane is one collapsed row --------------------------------
# Expanded, a group draws a header plus a child channel: two rows per kind.
results["collapsed"] = _collapsed()

# --- fact 4: marking changes the dots, never the set of lanes --------------
results["lanesAfterMarking"] = constraint_timeline.lane_labels(armature)
results["unmarkedKinds"] = ["LeftFoot", "RightHand"]
results["markedAfterMarking"] = {
    kind: frames
    for kind, frames in constraint_capture.marked_frames_by_anchor(armature).items()
}

# --- hand the prepared rig to the windowed stage ---------------------------
# argv after "--" is the path to save to; the host test supplies a temp file.
saved_to = sys.argv[sys.argv.index("--") + 1] if "--" in sys.argv else None
if saved_to is not None:
    bpy.ops.wm.save_as_mainfile(filepath=saved_to)
    results["savedTo"] = saved_to

# Runs LAST because build() starts from an empty file: anything it does
# would otherwise replace the rig the windowed stage is about to open.
# --- fact 14: a lane failure degrades, it never strands an attached rig ----
# The rig is fully attached by the time lanes are built, so a failure there
# must leave a usable rig and a reason rather than a traceback and a mutated
# armature. Injected by making ensure_lanes raise, which is the failure the
# preflight cannot rule out. This contract was written once and silently lost
# to a bad restore because nothing exercised it.
_second = build()
_original_ensure = constraint_timeline.ensure_lanes


def _explode(_armature):
    raise constraint_timeline.ConstraintTimelineError("injected lane failure")


from cclay import ik_rig as _ik_rig  # noqa: E402

_ik_rig.detach(_second, keep_edits=True)
constraint_timeline.ensure_lanes = _explode
try:
    _degraded = _ik_rig.attach(_second, 1, 3)
    results["degradedError"] = _degraded.get("constraintLaneError")
    results["degradedRaised"] = None
except Exception as error:  # noqa: BLE001 - the type is the measurement
    results["degradedError"] = None
    results["degradedRaised"] = type(error).__name__
finally:
    constraint_timeline.ensure_lanes = _original_ensure
results["degradedRigStillAttached"] = _ik_rig.has_ik_layer(_second)

print("CCLAY_CONSTRAINT_LANES=" + json.dumps(results))
