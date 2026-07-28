"""The constraint-lane facts that need a real Blender window.

Opens the rig ``constraint_lanes_fixture`` prepared in ``--background`` -- an IK
rig cannot be built in a GUI session without contorting product code, and these
facts cannot be measured without one, so the two stages are split.

Covers which editors the lanes can appear in, the channel-search round trip,
and the claim the whole native design rests on: that Blender's own delete
removes a dot exactly as the add-on's clear operator does.
"""

from __future__ import annotations

import json
import pathlib
import sys

import bpy

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[3] / "blender-addon"))

import cclay  # noqa: E402
from cclay import constraint_capture, constraint_timeline  # noqa: E402

results = {}
armature = next(o for o in bpy.data.objects if o.type == "ARMATURE")
scene = bpy.context.scene

for operator in (
    cclay.CCLAY_OT_show_constraint_lanes,
    cclay.CCLAY_OT_hide_constraint_lanes,
    cclay.CCLAY_OT_backfill_constraint_lanes,
):
    try:
        bpy.utils.register_class(operator)
    except ValueError:
        pass

window = bpy.context.window_manager.windows[0]
area = next(a for a in window.screen.areas if a.type == "DOPESHEET_EDITOR")
space = area.spaces.active

# The lanes need a character in context, the way the panel has one.
for obj in bpy.context.view_layer.objects:
    obj.select_set(obj is armature)
bpy.context.view_layer.objects.active = armature


# --- fact 5: an editor that cannot show channels is reported ---------------
# A DOPESHEET_EDITOR in TIMELINE mode draws no channel list, so lanes would be
# invisible there and Blender's delete cancels instead of removing a mark.
# Every dope sheet in the file is put in TIMELINE mode, not just this one.
for screen in bpy.data.screens:
    for candidate in screen.areas:
        if candidate.type == "DOPESHEET_EDITOR":
            candidate.spaces.active.mode = "TIMELINE"
            candidate.spaces.active.dopesheet.filter_text = ""
results["timelineModeStatus"] = sorted(bpy.ops.cclay.show_constraint_lanes())
results["timelineModeFilter"] = space.dopesheet.filter_text

# --- fact 6: in Dope Sheet mode the editor is filtered to the lanes --------
space.mode = "DOPESHEET"
SEARCH = "what the animator was searching for"
space.dopesheet.filter_text = SEARCH
# Only Show Selected is Blender's default and it hides every lane while no
# anchor bone is selected, which is exactly the state right after attach.
# Measured in a real window: the filter applied and only the Summary row drew.
# So Show has to borrow this too -- and borrowing means giving it back.
space.dopesheet.show_only_selected = True
results["filterBefore"] = space.dopesheet.filter_text
results["onlySelectedBefore"] = space.dopesheet.show_only_selected
results["dopesheetModeStatus"] = sorted(bpy.ops.cclay.show_constraint_lanes())
results["filterWhileShowing"] = space.dopesheet.filter_text
results["expectedFilter"] = constraint_timeline.CHANNEL_FILTER
results["onlySelectedWhileShowing"] = space.dopesheet.show_only_selected

# --- fact 7: the animator's own search survives the round trip -------------
# Run twice first: a second run must not remember the filter the first one
# installed, or turning the lanes off would leave the add-on's filter behind.
bpy.ops.cclay.show_constraint_lanes()
results["hideStatus"] = sorted(bpy.ops.cclay.hide_constraint_lanes())
results["filterAfterHide"] = space.dopesheet.filter_text
results["onlySelectedAfterHide"] = space.dopesheet.show_only_selected
results["searchThatMustComeBack"] = SEARCH




# --- fact 8: Blender's own delete removes a dot, exactly as clear does -----
KIND = "LeftHand"
FRAME = 2
MARKER_PATH = constraint_timeline.marker_path(KIND)
LOCATION_PATH = f'pose.bones["{constraint_capture.ANCHOR_BY_KIND[KIND]}"].location'


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
        "locationAtFrame": [round(c.evaluate(FRAME), 5) for c in location],
    }


def _label_of(kind):
    return next(label for label, k in constraint_timeline.TRACKS if k == kind)


def _select_lane_group(label):
    """Select exactly one lane the way clicking its row does.

    A lane is a collapsed channel GROUP, so the row the animator clicks is the
    group row and the curve underneath is not a visible channel at all.
    Selecting only the curve is a state no click can produce, and every
    operator that filters channels ignores it.
    """
    for bag in constraint_capture.action_channelbags(armature.animation_data.action):
        for group in bag.groups:
            group.select = group.name == label


def _select_only_the_dot():
    action = armature.animation_data.action
    for bag in constraint_timeline.channelbags(action):
        for curve in bag.fcurves:
            curve.select = curve.data_path == MARKER_PATH
            for key in curve.keyframe_points:
                key.select_control_point = (
                    curve.data_path == MARKER_PATH and round(key.co[0]) == FRAME
                )


bpy.ops.cclay.show_constraint_lanes()
space.mode = "DOPESHEET"
results["beforeDelete"] = _curve_state()
_select_lane_group(_label_of(KIND))
_select_only_the_dot()
region = next(r for r in area.regions if r.type == "WINDOW")
with bpy.context.temp_override(
    window=window, area=area, region=region, space_data=space
):
    try:
        results["blenderDeleteStatus"] = sorted(bpy.ops.action.delete())
    except RuntimeError as error:
        results["blenderDeleteStatus"] = f"raised: {error}"
results["afterBlenderDelete"] = _curve_state()

# The add-on's own path, from the same starting state.
constraint_capture.mark_constraint(armature, KIND, FRAME)
results["beforeClearOperator"] = _curve_state()
constraint_capture.clear_constraint(armature, KIND, FRAME)
results["afterClearOperator"] = _curve_state()

# --- fact 9: Blender's own I places a mark, on an empty lane too -----------
# The other half of the native loop. X removes a dot (fact 8); I places one.
# The Dope Sheet binds I to action.keyframe_insert, which keys the selected
# channels at the current frame from their current value -- and a marker curve
# IS a channel, so no add-on operator or keymap entry is needed. Run on a lane
# with no keys at all, because that is the case the six-lane change exists for:
# before it, a kind with no marks had no channel to select.
# LeftFoot is one of the two kinds the background stage deliberately leaves
# unmarked, so this really is a lane with no keys on it.
EMPTY_KIND = "LeftFoot"
EMPTY_PATH = constraint_timeline.marker_path(EMPTY_KIND)
INSERT_FRAME = 3

results["emptyLaneFramesBefore"] = constraint_capture.marked_frames(
    armature, EMPTY_KIND
)
# Clearing a lane that holds no key has to be a no-op, not a crash.
try:
    constraint_capture.clear_constraint(armature, EMPTY_KIND, INSERT_FRAME)
    results["clearEmptyLaneRaised"] = None
except Exception as error:  # noqa: BLE001 - the type is the measurement
    results["clearEmptyLaneRaised"] = type(error).__name__
results["emptyLaneFramesAfterEmptyClear"] = constraint_capture.marked_frames(
    armature, EMPTY_KIND
)

# And clearing a kind that carries no marker property at all. That is the state
# of every rig attached BEFORE lanes existed, because the property used to be
# written only by mark_constraint -- so a kind never marked never had one. Such
# a rig is sitting in a saved .blend right now and keeps that shape until it is
# re-attached. Blender answers keyframe_delete on a missing property with
# TypeError, not the RuntimeError it uses for "this frame has no key", and
# clear_constraint caught only the second.
_removed_kind = "RightHand"
_removed_path = constraint_timeline.marker_path(_removed_kind)
for _bag in constraint_timeline.channelbags(armature.animation_data.action):
    for _curve in list(_bag.fcurves):
        if _curve.data_path == _removed_path:
            _bag.fcurves.remove(_curve)
_removed_bone = armature.pose.bones[constraint_capture.ANCHOR_BY_KIND[_removed_kind]]
if constraint_capture.CONSTRAINT_MARKER in _removed_bone.keys():
    del _removed_bone[constraint_capture.CONSTRAINT_MARKER]
results["removedChannelStillPresent"] = any(
    curve.data_path == _removed_path
    for bag in constraint_timeline.channelbags(armature.animation_data.action)
    for curve in bag.fcurves
)
results["removedPropertyStillPresent"] = (
    constraint_capture.CONSTRAINT_MARKER in _removed_bone.keys()
)
try:
    constraint_capture.clear_constraint(armature, _removed_kind, INSERT_FRAME)
    results["clearRemovedChannelRaised"] = None
except Exception as error:  # noqa: BLE001 - the type is the measurement
    results["clearRemovedChannelRaised"] = type(error).__name__
action = armature.animation_data.action
results["emptyLaneHasChannel"] = any(
    curve.data_path == EMPTY_PATH
    for bag in constraint_timeline.channelbags(action)
    for curve in bag.fcurves
)

bpy.ops.cclay.show_constraint_lanes()
space.mode = "DOPESHEET"
for bag in constraint_timeline.channelbags(action):
    for curve in bag.fcurves:
        curve.select = curve.data_path == EMPTY_PATH
_select_lane_group(_label_of(EMPTY_KIND))
scene.frame_set(INSERT_FRAME)
insert_region = next(r for r in area.regions if r.type == "WINDOW")
with bpy.context.temp_override(
    window=window, area=area, region=insert_region, space_data=space
):
    try:
        results["insertStatus"] = sorted(bpy.ops.action.keyframe_insert(type="SEL"))
    except RuntimeError as error:
        results["insertStatus"] = f"raised: {error}"
results["emptyLaneFramesAfterInsert"] = constraint_capture.marked_frames(
    armature, EMPTY_KIND
)

# And it is the same thing the add-on's own operator makes: cleared, then
# re-made through mark_constraint, the frames match.
constraint_capture.clear_constraint(armature, EMPTY_KIND, INSERT_FRAME)
results["emptyLaneFramesAfterClear"] = constraint_capture.marked_frames(
    armature, EMPTY_KIND
)
constraint_capture.mark_constraint(armature, EMPTY_KIND, INSERT_FRAME)
results["emptyLaneFramesAfterMarkOperator"] = constraint_capture.marked_frames(
    armature, EMPTY_KIND
)

# --- fact 10: hiding without ever showing keeps the animator's search ------
# Found by red-teaming: the hide operator blanked filter_text unconditionally,
# so pressing it without having shown the lanes destroyed whatever the animator
# was searching for. It has no business deleting a filter it never borrowed.
bpy.ops.cclay.hide_constraint_lanes()
space.dopesheet.filter_text = "UNICODE-\u9577\u3044\u691c\u7d22-" + "x" * 200
# Read back rather than compared against what was written: filter_text has a
# length limit and truncates, so the contract under test is "hide leaves the
# filter exactly as it found it", not "hide restores this literal".
results["searchThatMustSurvive"] = space.dopesheet.filter_text
results["hideWithoutShowStatus"] = sorted(bpy.ops.cclay.hide_constraint_lanes())
results["filterAfterBareHide"] = space.dopesheet.filter_text
results["searchWasTruncatedByBlender"] = len(results["searchThatMustSurvive"]) < 208

# But a filter that is unmistakably the add-on's own -- left behind by a
# session that ended, or by a reload that dropped the memo -- is cleared.
space.dopesheet.filter_text = constraint_timeline.CHANNEL_FILTER
bpy.ops.cclay.hide_constraint_lanes()
results["filterAfterHidingOurOwn"] = space.dopesheet.filter_text

# --- fact 12: a search typed AFTER Show belongs to the animator ------------
# Red-team round 2: Show borrowed the filter, the animator then typed something
# new over it, and Hide restored the stale memo -- deleting what they had just
# written. A memo is only worth restoring while the filter is still the one the
# operator installed.
bpy.ops.cclay.show_constraint_lanes()
space.dopesheet.filter_text = "typed after showing"
results["typedAfterShow"] = space.dopesheet.filter_text
bpy.ops.cclay.hide_constraint_lanes()
results["filterAfterHidingTypedText"] = space.dopesheet.filter_text

# --- fact 11: a rig attached before lanes existed gets them back -----------
# attach() refuses an armature that already carries an IK layer, so without a
# backfill the animator would have to destroy and rebuild the rig. Simulated by
# stripping five kinds down to the pre-lane shape: no curve, no property.
_survivor = "FullBody"
for _kind, _anchor in constraint_capture.ANCHOR_BY_KIND.items():
    if _kind == _survivor:
        continue
    _path = constraint_timeline.marker_path(_kind)
    for _bag in constraint_timeline.channelbags(armature.animation_data.action):
        for _curve in list(_bag.fcurves):
            if _curve.data_path == _path:
                _bag.fcurves.remove(_curve)
    _bone = armature.pose.bones[_anchor]
    if constraint_capture.CONSTRAINT_MARKER in _bone.keys():
        del _bone[constraint_capture.CONSTRAINT_MARKER]
constraint_capture.mark_constraint(armature, _survivor, 2)
results["legacyLanesBefore"] = constraint_timeline.lane_labels(armature)
results["legacySurvivorBefore"] = constraint_capture.marked_frames(armature, _survivor)
# Show no longer migrates: it only filters the editor, and mixing a data
# change into a view toggle made one Ctrl+Z able to remove the lanes while
# leaving the editor filtered to nothing. Backfilling is its own undoable
# operator, offered by the panel only while a lane is actually missing.
results["legacyLanesAfterShowOnly"] = None
bpy.ops.cclay.show_constraint_lanes()
results["legacyLanesAfterShowOnly"] = constraint_timeline.lane_labels(armature)
results["legacyShowStatus"] = sorted(bpy.ops.cclay.backfill_constraint_lanes())
results["legacyBackfillAgain"] = sorted(bpy.ops.cclay.backfill_constraint_lanes())
results["legacyLanesAfter"] = constraint_timeline.lane_labels(armature)
results["legacySurvivorAfter"] = constraint_capture.marked_frames(armature, _survivor)

# --- fact 12b: keystroke semantics, after every fact that reads marks ------
# Everything here inserts keys, so it runs after every fact that counts them:
# an earlier placement silently added frame 7 to every lane and made fact 8
# read [2, 7]. It cannot go last either -- fact 13 reopens the file and every
# datablock reference taken before it dies with a ReferenceError.
# --- fact 7b: what I does with the selection the animator ACTUALLY has -----
# Every test below forces a single lane selected. Newly created F-curves are
# selected by default -- all six of them -- so the state right after attach is
# one nobody has measured. If I keys all six, the animator marks five
# constraints they never asked for and ARDY is handed a pose it must honour
# everywhere.
_all_paths = [constraint_timeline.marker_path(k) for k in constraint_capture.ANCHOR_BY_KIND]


def _marks_everywhere():
    counts = {}
    for curve in constraint_capture._fcurves(armature):
        if curve.data_path in _all_paths:
            counts[curve.data_path] = len(curve.keyframe_points)
    return counts


results["groupSelection"] = sorted(
    (c.data_path.split('"')[1], c.group.name if c.group else None,
     bool(c.group and c.group.select))
    for c in constraint_capture._fcurves(armature)
    if c.data_path in _all_paths
)
results["selectedRightAfterAttach"] = sorted(
    curve.data_path
    for curve in constraint_capture._fcurves(armature)
    if curve.data_path in _all_paths and curve.select
)
bpy.context.scene.frame_set(7)
results["marksBeforeNaiveI"] = _marks_everywhere()
_naive_region = next(r for r in area.regions if r.type == "WINDOW")
space.mode = "DOPESHEET"
# The lanes must actually be ON SCREEN: keyframe_insert keys the channels the
# editor is showing, and fact 7 above left the filter restored to the
# animator's own search, which hides every lane. Measuring through that filter
# would have reported "I does nothing" and been believed.
bpy.ops.cclay.show_constraint_lanes()
with bpy.context.temp_override(
    window=window, area=area, region=_naive_region, space_data=space
):
    try:
        results["naiveInsertStatus"] = sorted(bpy.ops.action.keyframe_insert())
    except RuntimeError as error:
        results["naiveInsertStatus"] = ["RAISED", str(error)]
results["marksAfterNaiveI"] = _marks_everywhere()

# And the same press with one lane chosen and the SEL variant, which is the
# only insert that honours the choice.
# The lane row the animator clicks is the GROUP row -- the group is collapsed,
# so its curve is not a visible channel at all. Selecting the group is what
# clicking a lane does.
for _bag in constraint_capture.action_channelbags(armature.animation_data.action):
    for _group in _bag.groups:
        _group.select = _group.name == "Left Foot"
for _curve in constraint_capture._fcurves(armature):
    if _curve.data_path in _all_paths:
        _curve.select = _curve.data_path == constraint_timeline.marker_path("LeftFoot")
bpy.context.scene.frame_set(9)
results["selectedRightBeforeSelI"] = sorted(
    c.data_path.split('"')[1]
    for c in constraint_capture._fcurves(armature)
    if c.data_path in _all_paths and c.select
)
results["marksBeforeSelI"] = _marks_everywhere()
with bpy.context.temp_override(
    window=window, area=area, region=_naive_region, space_data=space
):
    try:
        results["selInsertStatus"] = sorted(
            bpy.ops.action.keyframe_insert(type="SEL")
        )
    except RuntimeError as error:
        results["selInsertStatus"] = ["RAISED", str(error)]
results["marksAfterSelI"] = _marks_everywhere()

# What Blender's own I is actually bound to here. The whole "click a lane and
# press I" instruction depends on this, and a background query returns an empty
# keymap, so it has to be asked in a real window.
_bound = []
for _kc_name in ("user",):
    _kc = bpy.context.window_manager.keyconfigs.get(_kc_name)
    if _kc is None:
        continue
    for _km in _kc.keymaps:
        _km_name = _km.name
        for _kmi in _km.keymap_items:
            if _kmi.type == "I" and _kmi.value == "PRESS" and ("action" in _kmi.idname or "anim" in _kmi.idname or _km_name.lower().startswith(("dope", "graph", "anim"))):
                _entry = {"config": _kc_name, "keymap": _km_name, "idname": _kmi.idname}
                _t = getattr(_kmi.properties, "type", None)
                if _t is not None:
                    _entry["type"] = str(_t)
                _bound.append(_entry)
results["whatIIsBoundTo"] = _bound

# --- fact 12c: does Blender's own keyframe jump walk mark to mark? ---------
# The ARDY demo draws a posable ghost at every constrained frame. Blender has
# no equivalent -- armature ghosting was removed in 2.8 and there is no onion
# skinning for armatures -- so the question is what the native substitute is.
# Up/Down arrow is screen.keyframe_jump, which uses the keys the editor is
# SHOWING; with the lanes filter up that should be exactly the marks.
bpy.ops.cclay.show_constraint_lanes()
bpy.context.scene.frame_set(1)
_jumped = []
with bpy.context.temp_override(
    window=window, area=area, region=_naive_region, space_data=space
):
    for _ in range(6):
        try:
            if "FINISHED" not in bpy.ops.screen.keyframe_jump(next=True):
                break
        except RuntimeError:
            break
        _jumped.append(bpy.context.scene.frame_current)
results["framesJumpedTo"] = _jumped
results["marksThatExist"] = sorted(
    {int(round(k.co[0]))
     for c in constraint_capture._fcurves(armature) if c.data_path in _all_paths
     for k in c.keyframe_points}
)

# --- fact 13: the borrowed search survives a real reload -------------------
# The pointer map is memory-only and its keys are area addresses, so reopening
# the file loses it entirely. Without the copy the operator also writes to the
# Screen -- which IS saved in the .blend -- Hide would find no memo, see its
# own filter, clear it, and the animator's search would be gone for good.
RELOAD_SEARCH = "search that must survive a reload"
space.dopesheet.filter_text = RELOAD_SEARCH
bpy.ops.cclay.show_constraint_lanes()
results["reloadFilterWhileShowing"] = space.dopesheet.filter_text
results["reloadSearch"] = RELOAD_SEARCH

_reload_path = str(pathlib.Path(bpy.app.tempdir) / "cclay-lane-reload.blend")
bpy.ops.wm.save_as_mainfile(filepath=_reload_path)
bpy.ops.wm.open_mainfile(filepath=_reload_path)

# Everything above is invalid now; re-acquire from the reopened file.
_window = bpy.context.window_manager.windows[0]
_area = next(a for a in _window.screen.areas if a.type == "DOPESHEET_EDITOR")
_area.spaces.active.mode = "DOPESHEET"
results["reloadFilterAfterReopen"] = _area.spaces.active.dopesheet.filter_text
results["reloadStatus"] = sorted(bpy.ops.cclay.hide_constraint_lanes())
results["reloadFilterAfterHide"] = _area.spaces.active.dopesheet.filter_text


print("CCLAY_CONSTRAINT_LANES_WINDOW=" + json.dumps(results))
