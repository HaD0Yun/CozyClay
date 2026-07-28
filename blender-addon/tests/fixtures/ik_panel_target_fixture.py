"""Drive the IK/constraint operators from a character's mesh, not its armature.

The UX fix under test is that every IK/ARDY-constraint operator resolves the
character armature through ``character_target.resolve_character`` on
``context.active_object`` instead of reading the active object directly. The
most natural selection a character has is one of its skinned meshes (a viewport
click lands there), so the operators must work when the active object is a mesh
parented to the armature, and must report -- not crash -- when nothing resolves.

This fixture builds the same FK-baked Y-Bot rig ``ik_rig_fixture`` builds, then
drives the real operators through ``bpy.ops`` with a mesh set active, and prints
one JSON report the host test parses. Nothing here is mocked.

``import_rig`` and ``bake_ardy_fk`` are COPIED from ``ik_rig_fixture.py`` rather
than imported, because that module executes its whole probe at import time
(``bpy.ops.wm.read_factory_settings`` and ``import_rig()`` run at module scope),
so importing it would wipe this fixture's scene. Copying keeps the two helpers
duplicated but the fixture self-contained and readable; the FK bake is
non-trivial logic that already has one source of truth in the other fixture, and
keeping a second copy is cheaper than refactoring that module's side effects.
"""

from __future__ import annotations

import json
import pathlib
import sys

import bpy
import numpy

REPOSITORY_ROOT = pathlib.Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPOSITORY_ROOT / "blender-addon"))
for module in (
    "cclay.ik_chains",
    "cclay.ik_rig",
    "cclay.motion_retarget",
    "cclay.character_target",
    "cclay.constraint_timeline",
):
    sys.modules.pop(module, None)

import cclay  # noqa: E402
from cclay import (  # noqa: E402
    character_target,
    constraint_timeline,
    ik_chains,
    ik_rig,
    motion_retarget,
)
from cclay.manifest import animation_fcurves  # noqa: E402

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
    action = bpy.data.actions.new(name="CCLAY Motion ik-panel-target-fixture")
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


def _first_child_mesh(armature):
    """A MESH object parented directly to the armature.

    The FBX import parents every skinned mesh to the armature root, so this is
    the object a viewport click on the character selects. Picking the first such
    child is enough; the resolver walks ``.parent`` regardless of which mesh.
    """
    for obj in bpy.data.objects:
        if obj.type == "MESH" and obj.parent is armature:
            return obj
    return None


def _run_operator(call, results, status_key, exception_key=None):
    """Run a bpy.ops call and record its status without crashing the fixture.

    bpy.ops turns an operator's reported ERROR + CANCELLED into RuntimeError
    when called from a script, so a refusal arrives as that exception rather
    than a return value. Catching RuntimeError and recording CANCELLED is the
    honest translation of what the operator returned.

    Not every RuntimeError is a refusal, though: Blender wraps an exception
    raised inside execute() in the same type, tagged with the interpreter
    traceback. Translating that into CANCELLED as well would make a crashed
    operator indistinguishable from a refused one, and these tests exist
    precisely to hold that line, so a tagged message is recorded as a crash.
    """
    try:
        results[status_key] = sorted(call())
        if exception_key is not None:
            results[exception_key] = None
    except RuntimeError as error:
        text = str(error)
        crashed = "Traceback" in text or "Python:" in text
        results[status_key] = ["EXCEPTION"] if crashed else ["CANCELLED"]
        if exception_key is not None:
            results[exception_key] = f"RuntimeError: {text}" if crashed else None
    except Exception as error:  # pragma: no cover - recorded, not swallowed
        results[status_key] = ["EXCEPTION"]
        if exception_key is not None:
            results[exception_key] = f"{type(error).__name__}: {error}"


# --- scene setup -----------------------------------------------------------
bpy.ops.wm.read_factory_settings(use_empty=True)
armature = import_rig()
bake_ardy_fk(armature)
mesh = _first_child_mesh(armature)

results = {}
results["armatureName"] = armature.name
results["meshName"] = mesh.name
results["meshType"] = mesh.type
results["meshParentIsArmature"] = mesh.parent is armature

# Registered by class rather than through cclay.register() so the fixture does
# not also start the bridge handlers/lifecycle timer; the operators under test
# are the point. Matches the pattern in regenerate_request_fixture.py.
bpy.utils.register_class(cclay.CCLAY_OT_attach_ik_rig)
bpy.utils.register_class(cclay.CCLAY_OT_detach_ik_rig)
bpy.utils.register_class(cclay.CCLAY_OT_select_ik_handle)
bpy.utils.register_class(cclay.CCLAY_OT_show_character_keys)


def _key_filters():
    """Every animation-editor channel filter in the file, on any screen.

    Screens, not windows: a window shows one screen at a time, so walking
    windows only ever sees the workspace currently open and silently ignores
    the Animation tab an animator switches to.
    """
    return [
        area.spaces.active.dopesheet
        for screen in bpy.data.screens
        for area in screen.areas
        if getattr(area.spaces.active, "dopesheet", None) is not None
    ]


def _visible_key_filters():
    """Only the filters on the screen a window is actually showing."""
    return [
        area.spaces.active.dopesheet
        for window_manager in bpy.data.window_managers
        for window in window_manager.windows
        for area in window.screen.areas
        if getattr(area.spaces.active, "dopesheet", None) is not None
    ]


def _constraint_lane_filters():
    """Filters on editors that actually draw the constraint channel rows."""
    return [
        area.spaces.active.dopesheet
        for screen in bpy.data.screens
        for area in screen.areas
        if area.type == "DOPESHEET_EDITOR"
        and getattr(area.spaces.active, "mode", None) == "DOPESHEET"
        and getattr(area.spaces.active, "dopesheet", None) is not None
    ]


# Recorded, not assumed: the whole fix exists because Blender ships this filter
# enabled. If a future Blender changed that default the tests below would pass
# for the wrong reason, so the precondition is an asserted fact of its own.
results["timelineEditorCount"] = len(_key_filters())
results["timelineFilterAtStartup"] = [f.show_only_selected for f in _key_filters()]

# --- fact 1: attach works with the mesh active, not the armature -----------
# The headline fix. Setting a child MESH active is the selection a viewport
# click produces; before the fix the operator read active_object directly and
# refused because the active object was not an armature.
# Blender's shipped default, and the state that made a handle drag evaporate.
results["autoKeyBeforeAttach"] = bpy.context.scene.tool_settings.use_keyframe_insert_auto
bpy.context.view_layer.objects.active = mesh
_run_operator(
    lambda: bpy.ops.cclay.attach_ik_rig(), results, "attachStatus"
)
results["hasIkLayerAfterAttach"] = ik_rig.has_ik_layer(armature)
results["timelineFilterAfterAttach"] = [f.show_only_selected for f in _key_filters()]
results["constraintEditorFilterAfterAttach"] = [
    f.show_only_selected for f in _constraint_lane_filters()
]
results["constraintEditorSearchAfterAttach"] = [
    f.filter_text for f in _constraint_lane_filters()
]
results["expectedConstraintFilter"] = constraint_timeline.CHANNEL_FILTER
results["autoKeyAfterAttach"] = bpy.context.scene.tool_settings.use_keyframe_insert_auto

# --- fact 1b: a handle drag survives a scrub ------------------------------
# The behaviour the whole Auto Keying change exists for. Before it, moving a
# handle keyed nothing, so the next frame evaluation restored the baked pose
# and the animator's drag was gone with no message. This drags a handle through
# Blender's own transform operator, scrubs away and back, and reads the handle
# again: identical to what an animator does, and the assertion is that the drag
# is still there.
_scrub_handle_name = ik_chains.target_bone_name("LeftHand")
bpy.ops.cclay.select_ik_handle(bone=_scrub_handle_name)
_scrub_handle = armature.pose.bones[_scrub_handle_name]
_scrub_frame = bpy.context.scene.frame_current
_before_drag = list(_scrub_handle.location)
# transform.translate is the operator G runs, so this is the animator's drag
# rather than a direct property write that would key regardless.
bpy.ops.transform.translate(value=(0.0, 0.0, 5.0))
results["scrubDragApplied"] = [
    round(a - b, 4) for a, b in zip(_scrub_handle.location, _before_drag)
]
bpy.context.scene.frame_set(_scrub_frame + 7)
bpy.context.scene.frame_set(_scrub_frame)
results["scrubHandleAfterReturn"] = [
    round(a - b, 4) for a, b in zip(_scrub_handle.location, _before_drag)
]
results["scrubKeyedTheHandle"] = any(
    fcurve.data_path == f'pose.bones["{_scrub_handle_name}"].location'
    for fcurve in animation_fcurves(armature.animation_data)
)

# --- fact 2: the resolver turns the mesh into the armature ----------------
# This is the regression that matters: resolve_character(mesh) must be
# the armature. If _character_armature were reverted to context.active_object
# the operator in fact 1 would get the mesh and refuse, but this direct call to
# the pure function would still return the armature -- so fact 1 is the load-
# bearing assertion for the revert and this is the proof the resolver itself
# works on the real imported mesh.
results["resolvedArmatureName"] = character_target.resolve_character(mesh)[0].name

# --- fact 3: handle selection from the mesh -------------------------------
# The IK layer is attached, so the handle bones exist. Seed a different handle
# first so the 'exactly one selected' claim proves deselection happened rather
# than starting from an empty selection.
bpy.context.view_layer.objects.active = mesh
_run_operator(
    lambda: bpy.ops.cclay.select_ik_handle(
        bone=ik_chains.target_bone_name("LeftFoot")
    ),
    results,
    "seedStatus",
)
seed_active = armature.data.bones.active.name
results["seedActiveBeforeRightHand"] = seed_active

bpy.context.view_layer.objects.active = mesh
_run_operator(
    lambda: bpy.ops.cclay.select_ik_handle(
        bone=ik_chains.target_bone_name("RightHand")
    ),
    results,
    "selectRightHandStatus",
)
results["activeObjectAfterSelect"] = bpy.context.view_layer.objects.active.name
results["armatureModeAfterSelect"] = armature.mode
selected_after = [b.name for b in armature.pose.bones if b.select]
results["selectedPoseBonesAfterSelect"] = selected_after
results["activeBoneAfterSelect"] = armature.data.bones.active.name

# --- fact 4: a missing handle is refused, not a crash ---------------------
# CCLAY-IK-TGT-Nose is not a chain effector, so no such bone exists after
# attach. The operator must report and return CANCELLED, leaving the prior
# active bone untouched. _run_operator translates the RuntimeError bpy.ops
# raises for a reported ERROR into CANCELLED, and records a genuine crash as
# EXCEPTION so the host test can tell 'refused' from 'blew up'.
bpy.context.view_layer.objects.active = mesh
_run_operator(
    lambda: bpy.ops.cclay.select_ik_handle(bone="CCLAY-IK-TGT-Nose"),
    results,
    "selectMissingStatus",
    "selectMissingException",
)
results["activeBoneAfterMissing"] = armature.data.bones.active.name

# --- fact 4b: a character outside the view layer is refused, not a crash ---
# Resolving through a mesh is what makes this reachable: the armature can sit
# on an excluded collection while its mesh does not, so the animator can now
# aim an operator at a rig Blender will not let anyone select. select_set
# RAISES for such an object rather than returning False, so without the view
# layer gate the operator dies as a traceback in front of the animator. Marking
# is deliberately not gated -- it touches pose data only and keeps working.
excluded = bpy.data.collections.new("ExcludedRig")
bpy.context.scene.collection.children.link(excluded)
_previous_collections = list(armature.users_collection)
for collection in _previous_collections:
    collection.objects.unlink(armature)
excluded.objects.link(armature)
bpy.context.view_layer.layer_collection.children["ExcludedRig"].exclude = True
bpy.context.view_layer.objects.active = mesh
results["excludedInViewLayer"] = (
    bpy.context.view_layer.objects.get(armature.name) is armature
)
_run_operator(
    lambda: bpy.ops.cclay.select_ik_handle(
        bone=ik_chains.target_bone_name("RightHand")
    ),
    results,
    "excludedSelectStatus",
    "excludedSelectException",
)
_run_operator(
    lambda: bpy.ops.cclay.detach_ik_rig(),
    results,
    "excludedDetachStatus",
    "excludedDetachException",
)
results["excludedIkLayerRemains"] = ik_rig.has_ik_layer(armature)
bpy.context.view_layer.layer_collection.children["ExcludedRig"].exclude = False
excluded.objects.unlink(armature)
for collection in _previous_collections:
    collection.objects.link(armature)
bpy.data.collections.remove(excluded)

# --- fact 5: detach also works from the mesh ------------------------------
# The detach operator must resolve the armature through the mesh the same way
# attach did, or the animator is stranded with handles they can attach from a
# click but cannot remove from one.
bpy.context.view_layer.objects.active = mesh
_run_operator(
    lambda: bpy.ops.cclay.detach_ik_rig(), results, "detachStatus"
)
results["hasIkLayerAfterDetach"] = ik_rig.has_ik_layer(armature)

# --- fact 6: nothing resolvable is reported, not crashed ------------------
# A lone unparented EMPTY resolves to no armature. The operator's own report
# string ("Select the character...") is not observable from bpy.ops, which is
# why the return status is what gets asserted: CANCELLED vs FINISHED is the
# observable boundary between 'refused with a message' and 'did something'.
# detach leaves the armature active in POSE mode, so step back to OBJECT mode
# and drop the selection before adding the empty -- object.empty_add polls
# against the 3D context and refuses in POSE mode with an armature active.
if armature.mode != "OBJECT":
    bpy.ops.object.mode_set(mode="OBJECT")
for obj in bpy.context.view_layer.objects:
    obj.select_set(False)
bpy.ops.object.empty_add(type="PLAIN_AXES")
lonely = bpy.context.active_object
lonely.name = "LonelyEmpty"
lonely.parent = None
bpy.context.view_layer.objects.active = lonely
results["lonelyType"] = lonely.type
results["lonelyParent"] = lonely.parent
# The operator reports ERROR and returns CANCELLED; _run_operator translates
# the RuntimeError bpy.ops raises into CANCELLED, same as fact 4.
_run_operator(
    lambda: bpy.ops.cclay.attach_ik_rig(),
    results,
    "attachLonelyStatus",
    "attachLonelyException",
)

# --- calibration: the crash classifier is not taken on trust ---------------
# Every refusal above is asserted through _run_operator's RuntimeError-to-
# CANCELLED translation, and that translation only holds if Blender really
# does tag a wrapped interpreter exception differently from a reported ERROR.
# Two throwaway operators pin both halves on this Blender build: without this
# the whole file could be asserting a heuristic that silently stopped working.


class CCLAY_OT_fixture_cancels(bpy.types.Operator):
    bl_idname = "cclay.fixture_cancels"
    bl_label = "Fixture Cancels"

    def execute(self, context):
        self.report({"ERROR"}, "fixture refusal")
        return {"CANCELLED"}


class CCLAY_OT_fixture_crashes(bpy.types.Operator):
    bl_idname = "cclay.fixture_crashes"
    bl_label = "Fixture Crashes"

    def execute(self, context):
        raise ValueError("fixture sentinel crash")


bpy.utils.register_class(CCLAY_OT_fixture_cancels)
bpy.utils.register_class(CCLAY_OT_fixture_crashes)
_run_operator(
    lambda: bpy.ops.cclay.fixture_cancels(),
    results,
    "calibrationCancelStatus",
    "calibrationCancelException",
)
_run_operator(
    lambda: bpy.ops.cclay.fixture_crashes(),
    results,
    "calibrationCrashStatus",
    "calibrationCrashException",
)

# --- fact 8: the filter is cleared on every animation editor ---------------
# A second editor is opened by retyping an existing area. A fix that reached
# only for the Timeline, or only for the first match, leaves this one filtered.
_other = next(
    area
    for window_manager in bpy.data.window_managers
    for window in window_manager.windows
    for area in window.screen.areas
    if getattr(area.spaces.active, "dopesheet", None) is None
)
_other.type = "DOPESHEET_EDITOR"
for _filter in _key_filters():
    _filter.show_only_selected = True
results["timelineEditorCountWithSecond"] = len(_key_filters())
results["timelineFilterBeforeShow"] = [f.show_only_selected for f in _key_filters()]
_run_operator(
    lambda: bpy.ops.cclay.show_character_keys(), results, "showKeysStatus"
)
results["timelineFilterAfterShow"] = [f.show_only_selected for f in _key_filters()]

# --- fact 9: nothing left to clear is a refusal, not a crash ---------------
# The panel only offers the button while keys are hidden, so this is a race the
# animator can lose by clearing the filter by hand first. It must report and
# cancel, not raise.
_run_operator(
    lambda: bpy.ops.cclay.show_character_keys(),
    results,
    "showKeysAgainStatus",
    "showKeysAgainException",
)
results["timelineFilterAfterSecondShow"] = [
    f.show_only_selected for f in _key_filters()
]


# --- fact 10: the Graph Editor is not a blind spot -------------------------
# The Graph Editor carries the same show_only_selected filter and is where an
# animator tunes the curves an IK edit produced. An editor-type allowlist that
# named only the dope sheet left the identical blank-editor symptom one tab
# over, which is what this records.
_graph = next(
    area
    for window_manager in bpy.data.window_managers
    for window in window_manager.windows
    for area in window.screen.areas
    if getattr(area.spaces.active, "dopesheet", None) is None
)
_graph.type = "GRAPH_EDITOR"
_graph_filter = getattr(_graph.spaces.active, "dopesheet", None)
results["graphEditorCarriesTheFilter"] = _graph_filter is not None and hasattr(
    _graph_filter, "show_only_selected"
)
_graph_filter.show_only_selected = True
results["graphEditorFilterBefore"] = _graph_filter.show_only_selected
_run_operator(
    lambda: bpy.ops.cclay.show_character_keys(), results, "graphSweepStatus"
)
results["graphEditorFilterAfter"] = _graph_filter.show_only_selected


# --- fact 11: a workspace the animator has not opened is cleared too -------
# The defect this exists for. A window shows one screen at a time, so a walk
# over open windows reaches only the current workspace. A stock .blend carries
# five animation editors across Animation, Compositing, Geometry Nodes, Layout
# and Rendering, and the Animation tab -- the one an animator switches to for
# keys -- was left filtered while Layout looked fixed.
_visible = {id(f) for f in _visible_key_filters()}
_offscreen = [f for f in _key_filters() if id(f) not in _visible]
results["offscreenEditorCount"] = len(_offscreen)
results["screenCount"] = len(bpy.data.screens)
for _filter in _key_filters():
    _filter.show_only_selected = True
results["offscreenFilterBefore"] = [f.show_only_selected for f in _offscreen]
_run_operator(
    lambda: bpy.ops.cclay.show_character_keys(), results, "offscreenSweepStatus"
)
results["offscreenFilterAfter"] = [f.show_only_selected for f in _offscreen]
results["everyFilterAfter"] = [f.show_only_selected for f in _key_filters()]

print("CCLAY_IK_PANEL_TARGET=" + json.dumps(results))
