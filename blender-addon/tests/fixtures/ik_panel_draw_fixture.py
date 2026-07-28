"""Draw the IK and ARDY panels in every state they can be asked to draw in.

A Blender panel that raises inside ``draw()`` does not fail loudly: it vanishes
from the sidebar and prints a traceback on every redraw, which reads to the
animator as the add-on being gone. Both panels now reach into
``constraint_capture`` -- pending record, clip metadata, marker curves -- so
every one of those reads is a way for the panel to disappear if it can raise
something the draw does not handle.

The layout is a recording stand-in rather than Blender's, because a real
sidebar region does not exist in ``--background``. The panel classes only ever
call ``label``, ``operator``, ``row``, ``column``, ``grid_flow`` and
``separator``, so the stand-in implements exactly those and records what was
drawn -- which doubles as the assertion surface for what each state says.
"""

import json
import pathlib
import sys
import types

import bpy

REPOSITORY_ROOT = pathlib.Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPOSITORY_ROOT / "blender-addon"))
sys.path.insert(0, str(REPOSITORY_ROOT / "blender-addon" / "tests" / "fixtures"))

import cclay  # noqa: E402
from cclay import constraint_capture, ik_rig  # noqa: E402
from ik_rig_fixture import bake_ardy_fk, import_rig  # noqa: E402

MOTION_ID = "panel-draw-fixture"
CLIP_FPS = 20


class _Layout:
    """Records what a panel drew; every method a panel calls returns a layout."""

    def __init__(self, sink):
        self.sink = sink
        self.enabled = True

    def label(self, *, text="", **_kwargs):
        self.sink["labels"].append(text)

    def operator(self, operator, **_kwargs):
        self.sink["operators"].append(operator)
        return types.SimpleNamespace()

    def row(self, **_kwargs):
        return _Layout(self.sink)

    def column(self, **_kwargs):
        return _Layout(self.sink)

    def grid_flow(self, **_kwargs):
        return _Layout(self.sink)

    def separator(self, **_kwargs):
        return None


def _draw(panel_class, context):
    """Run one panel's draw and report what it drew, or how it blew up."""
    sink = {"labels": [], "operators": [], "error": None}
    # The unbound function with a stand-in self: a Panel subclass is a
    # bpy_struct and cannot be instantiated outside Blender's registration,
    # and draw() reads nothing off self except the layout.
    panel = types.SimpleNamespace(layout=_Layout(sink))
    try:
        panel_class.draw(panel, context)
    except BaseException as error:  # noqa: BLE001 -- a raising draw is the bug
        sink["error"] = f"{type(error).__name__}: {error}"
    return sink


def _stamp_clip(armature, frames):
    action = armature.animation_data.action
    action["cclay.motion_id"] = MOTION_ID
    action["cclay.motion_frames"] = frames
    action["cclay.motion_fps"] = CLIP_FPS
    action["cclay.motion_start_frame"] = 1
    return action


bpy.ops.wm.read_factory_settings(use_empty=True)
armature = import_rig()
clip_frames = bake_ardy_fk(armature)
action = _stamp_clip(armature, clip_frames)
mesh = next(child for child in armature.children if child.type == "MESH")

scene = bpy.context.scene
# The scene deliberately outlives the clip, which is the normal state:
# apply_motion only ever extends the scene range.
scene.frame_end = 40
context = bpy.context

report = {}

# Nothing selected at all. Both panels must say what to click, not vanish.
bpy.context.view_layer.objects.active = None
report["emptyIk"] = _draw(cclay.CCLAY_PT_ik_rig, context)
report["emptyArdy"] = _draw(cclay.CCLAY_PT_ardy_constraints, context)

# A mesh whose parent and deform rig disagree: the resolver refuses, and the
# panel has to render that refusal rather than raise on a None armature.
other = import_rig()
other.name = "OtherRig"
conflicted = next(child for child in armature.children if child.type == "MESH")
original_parent = conflicted.parent
conflicted.parent = other
report["conflictedIk"] = _draw(cclay.CCLAY_PT_ik_rig, context)
report["conflictedArdy"] = _draw(cclay.CCLAY_PT_ardy_constraints, context)
bpy.context.view_layer.objects.active = conflicted
report["conflictedActiveIk"] = _draw(cclay.CCLAY_PT_ik_rig, context)
report["conflictedActiveArdy"] = _draw(cclay.CCLAY_PT_ardy_constraints, context)
conflicted.parent = original_parent

# The ordinary case, reached through the mesh: the panels answer for the
# character even though the active object is not the armature.
bpy.context.view_layer.objects.active = mesh
report["meshIk"] = _draw(cclay.CCLAY_PT_ik_rig, context)
report["meshArdy"] = _draw(cclay.CCLAY_PT_ardy_constraints, context)

ik_rig.attach(armature)
bpy.context.view_layer.objects.active = mesh
scene.frame_set(2)
report["attachedIk"] = _draw(cclay.CCLAY_PT_ik_rig, context)
report["attachedArdy"] = _draw(cclay.CCLAY_PT_ardy_constraints, context)

# Off-clip: the panel must say so and must still draw every row.
scene.frame_set(30)
report["offClipArdy"] = _draw(cclay.CCLAY_PT_ardy_constraints, context)
scene.frame_set(2)
# A recorded Auto Keying lapse. This row is conditional, so it is the one that
# never draws in an ordinary test run and would ship broken: an exception in
# draw takes the entire sidebar with it, not just this row.
# Ghost rows: the offer to stand one up, and the rows once they exist. Both
# are conditional, so both are states that would otherwise ship undrawn.
from cclay import constraint_ghost  # noqa: E402

report["noGhostsArdy"] = _draw(cclay.CCLAY_PT_ardy_constraints, context)
# Marked here rather than relying on whatever the rig already carries: a
# ghost only exists for a marked frame, so the mark is part of this setup.
_ghost_kind = "RightHand"
_ghost_frame = 2
constraint_capture.mark_constraint(armature, _ghost_kind, _ghost_frame)
constraint_ghost.create_ghost(armature, _ghost_kind, _ghost_frame)
report["ghostShownArdy"] = _draw(cclay.CCLAY_PT_ardy_constraints, context)
report["ghostKind"] = _ghost_kind
report["ghostFrame"] = _ghost_frame
constraint_ghost.remove_all_ghosts(armature)

scene[cclay.AUTOKEY_LAPSED] = True
report["lapsedArdy"] = _draw(cclay.CCLAY_PT_ardy_constraints, context)
del scene[cclay.AUTOKEY_LAPSED]
report["unlapsedArdy"] = _draw(cclay.CCLAY_PT_ardy_constraints, context)

# A corrupted pending record. read_pending_request raises for this, and the
# ARDY panel is the only thing standing between that and a vanished sidebar.
armature[constraint_capture.PENDING_PROPERTY] = "{not json"
report["corruptPendingArdy"] = _draw(cclay.CCLAY_PT_ardy_constraints, context)
del armature[constraint_capture.PENDING_PROPERTY]

# A well-formed pending record: the panel collapses to the recovery button.
constraint_capture.record_pending_request(
    armature, "0123456789abcdef0123456789abcdef", {"RightHand": [2]}
)
report["pendingArdy"] = _draw(cclay.CCLAY_PT_ardy_constraints, context)
constraint_capture.clear_pending_request(armature)

# Clip metadata stripped: base_clip_of raises, and the panel must render the
# reason instead of disappearing.
del action["cclay.motion_id"]
report["noClipMetadataArdy"] = _draw(cclay.CCLAY_PT_ardy_constraints, context)
_stamp_clip(armature, clip_frames)

# A zero-length clip is a degenerate but reachable metadata state; the panel
# must not divide, index or raise its way out of it.
action["cclay.motion_frames"] = 0
report["zeroFrameArdy"] = _draw(cclay.CCLAY_PT_ardy_constraints, context)
action["cclay.motion_frames"] = clip_frames

# The empty-timeline row is drawn only while the filter is really hiding keys,
# so both sides of that transition are pinned here rather than left to whatever
# Blender's default happens to be. ik_rig.attach above is the plain function,
# not the operator, so nothing so far has cleared the filter.
# Screens, not windows: a window shows one screen at a time, and the panel now
# answers for every animation editor in the file, including the ones on
# workspaces the animator has not opened.
_filters = [
    area.spaces.active.dopesheet
    for screen in bpy.data.screens
    for area in screen.areas
    if getattr(area.spaces.active, "dopesheet", None) is not None
]
for _filter in _filters:
    _filter.show_only_selected = True
report["keysHiddenIk"] = _draw(cclay.CCLAY_PT_ik_rig, context)
for _filter in _filters:
    _filter.show_only_selected = False
report["keysShownIk"] = _draw(cclay.CCLAY_PT_ik_rig, context)

# The Auto Keying row is drawn only while the drag would actually be lost, so
# both sides of that transition are pinned. ik_rig.attach above is the plain
# function, not the operator, so nothing so far has turned Auto Keying on.
scene.tool_settings.use_keyframe_insert_auto = False
report["autoKeyOffIk"] = _draw(cclay.CCLAY_PT_ik_rig, context)
scene.tool_settings.use_keyframe_insert_auto = True
report["autoKeyOnIk"] = _draw(cclay.CCLAY_PT_ik_rig, context)
scene.tool_settings.use_keyframe_insert_auto = False

print("CCLAY_IK_PANEL_DRAW=" + json.dumps(report))
