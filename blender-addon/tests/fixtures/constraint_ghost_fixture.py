"""Facts about editable ghosts of constrained frames, measured inside Blender.

Run headless:

    blender --background --factory-startup --python \
        tests/fixtures/constraint_ghost_fixture.py

Prints one ``CCLAY_CONSTRAINT_GHOST=<json>`` line. Every value here is a
measurement, not an expectation: the assertions live in
``tests/test_constraint_ghost.py``.
"""

import json
import pathlib
import sys

import bpy

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))

from cclay import (  # noqa: E402
    _drop_ghosts_before_save,
    _keep_ghosts_still as _keep_still,
    _restore_ghosts_after_save as _restore_after_save,
)
from cclay import (  # noqa: E402
    character_target,
    constraint_capture,
    constraint_ghost,
    ik_chains,
    ik_rig,
)
from tests.fixtures import ardy_rig_scaffold  # noqa: E402

results = {}

KIND = "RightHand"
GHOST_FRAME = 3
OTHER_FRAME = 1

# The scaffold already attaches the IK rig, which is what a ghost needs: the
# control bones it borrows live on the armature data that attach created.
armature = ardy_rig_scaffold.build()
bpy.context.view_layer.objects.active = armature
constraint_capture.mark_constraint(armature, KIND, GHOST_FRAME)

TARGET = ik_chains.target_bone_name(KIND)
CHAIN = next(c for c in ik_chains.IK_CHAINS if c.effector == KIND)
CONSTRAINED = ik_chains.prefixed(CHAIN.constrained)
LOCATION_PATH = f'pose.bones["{TARGET}"].location'


def _handle_on(frame):
    curves = {
        curve.array_index: curve
        for curve in constraint_capture._fcurves(armature)
        if curve.data_path == LOCATION_PATH
    }
    return [round(curves[i].evaluate(frame), 4) for i in sorted(curves)]


# The animator is standing somewhere else. Everything below has to hold from
# here, because that is the whole point of a ghost.
bpy.context.scene.frame_set(OTHER_FRAME)

# --- fact 1: the ghost shows another frame's pose, cheaply and in place ----
results["sceneFrameBefore"] = bpy.context.scene.frame_current
ghost = constraint_ghost.create_ghost(armature, KIND, GHOST_FRAME)
results["sceneFrameAfter"] = bpy.context.scene.frame_current
# Shares the armature datablock rather than copying it. This is what makes a
# ghost cheap AND what gives it the control bones without rebuilding them.
results["sharesArmatureData"] = ghost.data is armature.data
results["ghostName"] = ghost.name
# No animation data: a ghost holds one frame and must not follow the playhead.
results["ghostHasAnimationData"] = ghost.animation_data is not None
bpy.context.view_layer.update()
results["ghostHandle"] = [round(v, 4) for v in ghost.pose.bones[TARGET].location]
results["liveHandle"] = [round(v, 4) for v in armature.pose.bones[TARGET].location]
results["handleExpectedOnGhostFrame"] = _handle_on(GHOST_FRAME)
results["handleExpectedOnSceneFrame"] = _handle_on(OTHER_FRAME)

# Asking twice refreshes rather than stacking a second copy.
again = constraint_ghost.create_ghost(armature, KIND, GHOST_FRAME)
results["secondAskReturnedSameObject"] = again is ghost
results["ghostCountAfterSecondAsk"] = len(constraint_ghost.ghosts_of(armature))

# Scaffolding must not reach a render.
results["collectionHidesRender"] = bpy.data.collections[
    constraint_ghost.GHOST_COLLECTION
].hide_render

# --- fact 2: the ghost's joints are driven by its own IK ------------------
ik_constraints = [
    c for c in ghost.pose.bones[CONSTRAINED].constraints if c.type == "IK"
]
results["ghostIkCount"] = len(ik_constraints)
results["ghostIkTargetsItself"] = bool(ik_constraints) and ik_constraints[0].target is ghost
results["liveIkStillTargetsLive"] = [
    c.target is armature
    for c in armature.pose.bones[CONSTRAINED].constraints
    if c.type == "IK"
]

ghost_joint_before = (ghost.matrix_world @ ghost.pose.bones[CONSTRAINED].tail).copy()
live_joint_before = (armature.matrix_world @ armature.pose.bones[CONSTRAINED].tail).copy()
DRAG = 0.25
ghost.pose.bones[TARGET].location = [
    value + delta
    for value, delta in zip(ghost.pose.bones[TARGET].location, (0.0, 0.0, DRAG))
]
bpy.context.view_layer.update()
results["ghostJointMovedMm"] = round(
    ((ghost.matrix_world @ ghost.pose.bones[CONSTRAINED].tail) - ghost_joint_before).length
    * 1000.0,
    2,
)
results["liveJointMovedMm"] = round(
    ((armature.matrix_world @ armature.pose.bones[CONSTRAINED].tail) - live_joint_before).length
    * 1000.0,
    2,
)

# --- fact 3: committing writes the ghost's frame and only that frame ------
results["liveGhostFrameBeforeCommit"] = _handle_on(GHOST_FRAME)
results["liveOtherFrameBeforeCommit"] = _handle_on(OTHER_FRAME)
results["sceneFrameBeforeCommit"] = bpy.context.scene.frame_current
committed = constraint_ghost.commit_ghost(ghost)
results["committedFrame"] = committed["frame"]
results["committedKind"] = committed["kind"]
results["sceneFrameAfterCommit"] = bpy.context.scene.frame_current
results["liveGhostFrameAfterCommit"] = _handle_on(GHOST_FRAME)
results["liveOtherFrameAfterCommit"] = _handle_on(OTHER_FRAME)
results["ghostHandleAtCommit"] = [round(v, 4) for v in ghost.pose.bones[TARGET].location]

# --- fact 3b: Auto Keying is on for this workflow, and it keys the GHOST ---
# Marking requires Auto Keying, so the animator drags ghost handles with it on
# and Blender dutifully keys the ghost. A ghost carrying an action starts
# following the playhead, which destroys the one thing it is for: holding still
# at its own frame while the rig moves.
#
# After the commit above, deliberately: this phase drags the ghost and then
# refreshes it, and a refresh restores the pose from the curves -- running it
# first silently undid the drag fact 3 was about to commit.
bpy.context.scene.tool_settings.use_keyframe_insert_auto = True
bpy.context.view_layer.objects.active = ghost
for obj in bpy.context.view_layer.objects:
    obj.select_set(obj is ghost)
bpy.ops.object.mode_set(mode="POSE")
for pose_bone in ghost.pose.bones:
    pose_bone.select = pose_bone.name == TARGET
bpy.ops.transform.translate(value=(0.0, 0.0, 0.1))
results["ghostGainedAnimationData"] = ghost.animation_data is not None
# The lifecycle timer is what undoes this in a live session; background has no
# timer, so the same function is called directly. The wiring is asserted by
# test_the_lifecycle_timer_is_what_records_the_lapse on the same callback.
# Driven by changing the frame, not by calling the helper, so the WIRING is
# measured: calling the helper directly proves the helper works and nothing
# about whether anything ever calls it. A frame change is also exactly when an
# animated ghost would start drifting, which is why the handler lives there.
import cclay as _cclay  # noqa: E402

if _keep_still not in bpy.app.handlers.frame_change_pre:
    bpy.app.handlers.frame_change_pre.append(_keep_still)
_pose_before_timer = [round(v, 4) for v in ghost.pose.bones[TARGET].location]
bpy.context.scene.frame_set(OTHER_FRAME + 1)
bpy.context.scene.frame_set(OTHER_FRAME)
results["ghostAnimationDataAfterFrameChange"] = ghost.animation_data is not None
results["ghostPoseSurvivedFrameChange"] = (
    [round(v, 4) for v in ghost.pose.bones[TARGET].location] == _pose_before_timer
)

# Dirty it again before testing the refresh path. Without this the timer above
# has already cleaned up and the refresh would have nothing left to do, so
# breaking it would go unnoticed.
bpy.ops.transform.translate(value=(0.0, 0.0, 0.1))
results["ghostDirtyAgain"] = ghost.animation_data is not None
refreshed = constraint_ghost.create_ghost(armature, KIND, GHOST_FRAME)
results["ghostAnimationDataAfterRefresh"] = refreshed.animation_data is not None
bpy.context.view_layer.objects.active = armature
bpy.ops.object.mode_set(mode="POSE")

# --- fact 3c: Apply does not disturb the frame the animator is looking at --
# Keying another frame means routing the value through the live pose bone,
# because that is what keyframe_insert reads. Leaving it there would jerk the
# live rig at the CURRENT frame -- a real defect review found, invisible to a
# test that only reads F-curves.
constraint_capture.mark_constraint(armature, KIND, GHOST_FRAME)
_apply_ghost = constraint_ghost.create_ghost(armature, KIND, GHOST_FRAME)
_apply_ghost.pose.bones[TARGET].location = [
    v + d for v, d in zip(_apply_ghost.pose.bones[TARGET].location, (0.0, 0.0, 0.3))
]
bpy.context.view_layer.update()
results["livePoseBeforeApply"] = [
    round(v, 4) for v in armature.pose.bones[TARGET].location
]
constraint_ghost.commit_ghost(_apply_ghost)
results["livePoseRightAfterApply"] = [
    round(v, 4) for v in armature.pose.bones[TARGET].location
]

# --- fact 3d: renaming the rig does not strand its ghosts -----------------
# Red-team reproduction: with the owner stored as a NAME, renaming the live rig
# made ghosts_of return [], commit fail with "the rig this ghost belongs to is
# gone", and detach report removing nothing while leaving twelve ghosts holding
# constraints on bones it had just deleted.
armature.name = "animator-renamed-this"
results["ghostsFoundAfterRename"] = [g.name for g in constraint_ghost.ghosts_of(armature)]
try:
    constraint_ghost.commit_ghost(_apply_ghost)
    results["commitAfterRenameRaised"] = None
except constraint_ghost.ConstraintGhostError as error:
    results["commitAfterRenameRaised"] = str(error)

# --- fact 3d2: a full copy of a ghost is not a ghost of this rig ----------
# Ctrl+D on a ghost copies the custom properties AND gives the copy its own
# armature datablock. The tag alone would make it look like a ghost of this
# rig, and posing or committing it would push a pose derived from a different
# skeleton onto the live one. Ownership therefore requires the SHARED data,
# not just a matching id.
bpy.ops.object.mode_set(mode="OBJECT")
bpy.context.view_layer.objects.active = _apply_ghost
for _obj in bpy.context.view_layer.objects:
    _obj.select_set(_obj is _apply_ghost)
bpy.ops.object.duplicate(linked=False)
_copy = bpy.context.view_layer.objects.active
results["copyIsADifferentObject"] = _copy is not _apply_ghost
results["copyKeptTheTag"] = _copy.get(constraint_ghost.GHOST_OF) is not None
results["copyHasItsOwnData"] = _copy.data is not armature.data
results["copyCountedAsGhost"] = _copy.name in [
    g.name for g in constraint_ghost.ghosts_of(armature)
]
bpy.data.objects.remove(_copy, do_unlink=True)
bpy.context.view_layer.objects.active = armature
for _obj in bpy.context.view_layer.objects:
    _obj.select_set(_obj is armature)
bpy.ops.object.mode_set(mode="POSE")

# --- fact 3e: saving the file does not save the scaffolding ---------------
# Measured before the fix: saving with a ghost on screen wrote it into the
# .blend, and it was still there on reopen.
results["ghostsBeforeSaveHandler"] = len(constraint_ghost.ghosts_of(armature))
_drop_ghosts_before_save()
results["ghostsAfterSaveHandler"] = len(constraint_ghost.ghosts_of(armature))
results["ghostObjectsAfterSaveHandler"] = sorted(
    obj.name
    for obj in bpy.data.objects
    if obj.name.startswith(constraint_ghost.GHOST_PREFIX)
)

# --- fact 3f: a LINKED duplicate of the rig does not steal its ghosts ------
# Alt+D copies custom properties AND shares the datablock, so an id stamped on
# the rig satisfied both halves of the ownership test on both objects and the
# owner resolved to whichever came first. A direct reference cannot be
# confused that way.
bpy.ops.object.mode_set(mode="OBJECT")
bpy.context.view_layer.objects.active = armature
for _obj in bpy.context.view_layer.objects:
    _obj.select_set(_obj is armature)
bpy.ops.object.duplicate(linked=True)
_linked = bpy.context.view_layer.objects.active
results["linkedIsADifferentObject"] = _linked is not armature
results["linkedSharesData"] = _linked.data is armature.data
constraint_capture.mark_constraint(armature, KIND, GHOST_FRAME)
_owned = constraint_ghost.create_ghost(armature, KIND, GHOST_FRAME)
results["ghostsOfOriginal"] = [g.name for g in constraint_ghost.ghosts_of(armature)]
results["ghostsOfLinkedCopy"] = [g.name for g in constraint_ghost.ghosts_of(_linked)]
bpy.data.objects.remove(_linked, do_unlink=True)
bpy.context.view_layer.objects.active = armature
for _obj in bpy.context.view_layer.objects:
    _obj.select_set(_obj is armature)
bpy.ops.object.mode_set(mode="POSE")

# --- fact 3g: saving does not throw away an uncommitted ghost edit ---------
# Removing ghosts at save time kept them out of the document and destroyed
# whatever the animator had not committed yet, which is worse than the leak it
# fixed. What is on screen is recorded and put back.
_UNCOMMITTED = (0.0, 0.0, 0.77)
_owned.pose.bones[TARGET].location = _UNCOMMITTED
results["uncommittedBeforeSave"] = [round(v, 4) for v in _owned.pose.bones[TARGET].location]
_drop_ghosts_before_save()
results["ghostsDuringSave"] = len(constraint_ghost.ghosts_of(armature))
_restore_after_save()
_back = constraint_ghost.ghosts_of(armature)
results["ghostsRestoredAfterSave"] = [g.name for g in _back]
results["uncommittedAfterSave"] = (
    [round(v, 4) for v in _back[0].pose.bones[TARGET].location] if _back else None
)

# --- fact 3h: the guarantees survive opening another file -----------------
# Handlers registered without bpy.app.handlers.persistent are cleared on file
# load while the add-on stays enabled, so both would silently stop holding.
# Blender marks a persistent handler by ATTACHING _bpy_persistent, whose value
# is None. Testing it for truth reports every handler as non-persistent, which
# is what the first version of this measurement did.
results["saveHandlerIsPersistent"] = hasattr(_drop_ghosts_before_save, "_bpy_persistent")
results["stillHandlerIsPersistent"] = hasattr(_keep_still, "_bpy_persistent")
results["restoreHandlerIsPersistent"] = hasattr(_restore_after_save, "_bpy_persistent")

# --- fact 3i: an unapplied ghost edit is visible as such ------------------
# Regeneration reads the rig's curves and nothing else, so a pose dragged on a
# ghost and never applied would be silently dropped: the request carries the
# OLD pose at that frame and the animator gets back a clip ignoring the edit in
# front of them.
constraint_capture.mark_constraint(armature, KIND, GHOST_FRAME)
_dirty = constraint_ghost.create_ghost(armature, KIND, GHOST_FRAME)
results["uncommittedWhenFresh"] = constraint_ghost.uncommitted_ghosts(armature)
_dirty.pose.bones[TARGET].location = [
    v + d for v, d in zip(_dirty.pose.bones[TARGET].location, (0.0, 0.0, 0.4))
]
results["uncommittedAfterDrag"] = constraint_ghost.uncommitted_ghosts(armature)
constraint_ghost.commit_ghost(_dirty)
results["uncommittedAfterApply"] = constraint_ghost.uncommitted_ghosts(armature)
constraint_ghost.remove_all_ghosts(armature)
constraint_capture.clear_constraint(armature, KIND, GHOST_FRAME)

# --- fact 4: a ghost only ever stands for a real mark ---------------------
try:
    constraint_ghost.create_ghost(armature, KIND, GHOST_FRAME + 1)
    results["unmarkedFrameRefused"] = None
except constraint_ghost.ConstraintGhostError as error:
    results["unmarkedFrameRefused"] = str(error)

# Blender's own X removes a mark and knows nothing about ghosts.
# Stood up here rather than inherited: the save handler above deliberately
# clears every ghost, so a phase that assumed an earlier one survived was
# measuring an empty scene.
constraint_capture.mark_constraint(armature, KIND, GHOST_FRAME)
constraint_ghost.create_ghost(armature, KIND, GHOST_FRAME)
constraint_capture.clear_constraint(armature, KIND, GHOST_FRAME)
results["pruned"] = constraint_ghost.prune_stale_ghosts(armature)
results["ghostsAfterPrune"] = [g.name for g in constraint_ghost.ghosts_of(armature)]

# And the same thing WITHOUT calling prune: deleting a mark with Blender's own
# X reaches none of this add-on's operators, so until the depsgraph handler ran
# the ghost stood there offering an edit for a frame that was no longer
# constrained. Driven through the handler, so the wiring is what is measured.
constraint_capture.mark_constraint(armature, KIND, GHOST_FRAME)
constraint_ghost.create_ghost(armature, KIND, GHOST_FRAME)
results["ghostsBeforeSilentDelete"] = [
    g.name for g in constraint_ghost.ghosts_of(armature)
]
constraint_capture.clear_constraint(armature, KIND, GHOST_FRAME)
__import__("cclay")._drop_ghosts_whose_mark_is_gone()
results["ghostsAfterSilentDelete"] = [
    g.name for g in constraint_ghost.ghosts_of(armature)
]
# A mark that is still there keeps its ghost: the handler must not take down
# everything just because it ran.
constraint_capture.mark_constraint(armature, KIND, GHOST_FRAME)
constraint_ghost.create_ghost(armature, KIND, GHOST_FRAME)
__import__("cclay")._drop_ghosts_whose_mark_is_gone()
results["ghostsAfterHandlerWithMarkIntact"] = [
    g.name for g in constraint_ghost.ghosts_of(armature)
]
constraint_ghost.remove_all_ghosts(armature)
constraint_capture.clear_constraint(armature, KIND, GHOST_FRAME)

# A ghost held onto across a mark deletion must refuse to write.
constraint_capture.mark_constraint(armature, KIND, GHOST_FRAME)
stale = constraint_ghost.create_ghost(armature, KIND, GHOST_FRAME)
constraint_capture.clear_constraint(armature, KIND, GHOST_FRAME)
handle_before_stale_commit = _handle_on(GHOST_FRAME)
try:
    constraint_ghost.commit_ghost(stale)
    results["staleCommitRefused"] = None
except constraint_ghost.ConstraintGhostError as error:
    results["staleCommitRefused"] = str(error)
results["staleCommitWroteNothing"] = _handle_on(GHOST_FRAME) == handle_before_stale_commit

# --- fact 5: the operators, driven the way the panel drives them ----------
bpy.utils.register_class(__import__("cclay").CCLAY_OT_show_constraint_ghosts)
bpy.utils.register_class(__import__("cclay").CCLAY_OT_dismiss_constraint_ghosts)
constraint_capture.mark_constraint(armature, KIND, GHOST_FRAME)
constraint_ghost.remove_all_ghosts(armature)
# Blender locks interaction to the object whose mode you are in, and it
# defaults to ON. In Pose Mode on the live rig that made every ghost
# unclickable -- the feature was unusable until Show borrowed this.
bpy.context.scene.tool_settings.lock_object_mode = True
results["modeLockBeforeShow"] = bpy.context.scene.tool_settings.lock_object_mode
results["showStatus"] = sorted(bpy.ops.cclay.show_constraint_ghosts())
results["modeLockWhileShowing"] = bpy.context.scene.tool_settings.lock_object_mode
# And with it off, a ghost really can be entered and posed.
_shown = constraint_ghost.ghosts_of(armature)[0]
bpy.ops.object.mode_set(mode="OBJECT")
bpy.context.view_layer.objects.active = _shown
try:
    bpy.ops.object.mode_set(mode="POSE")
    results["ghostEnteredPoseMode"] = _shown.mode
except RuntimeError as error:
    results["ghostEnteredPoseMode"] = str(error)
bpy.ops.object.mode_set(mode="OBJECT")
bpy.context.view_layer.objects.active = armature
bpy.ops.object.mode_set(mode="POSE")
results["ghostsAfterShowOperator"] = [g.name for g in constraint_ghost.ghosts_of(armature)]
results["dismissStatus"] = sorted(bpy.ops.cclay.dismiss_constraint_ghosts())
results["modeLockAfterDismiss"] = bpy.context.scene.tool_settings.lock_object_mode

# --- fact 5b: with a ghost selected, the panel and the grab follow IT ------
# A ghost IS an armature and carries no action by design, so it used to answer
# for itself as "the character" and every clip question came back empty -- the
# ARDY panel collapsed to "no clip to regenerate" and took Apply with it, at
# exactly the moment Apply is what you need. Resolution now maps a ghost to its
# owner. A grab must NOT follow that mapping, or it selects the live rig's
# handle while you are posing the ghost.
bpy.ops.cclay.show_constraint_ghosts()
_g = constraint_ghost.ghosts_of(armature)[0]
_resolved, _reason = character_target.resolve_character(_g)
results["ghostResolvesToOwner"] = _resolved.name if _resolved else None
results["ghostResolveReason"] = _reason
# Recorded rather than hardcoded: an earlier phase renames the rig on purpose.
results["ownerNameAtGrab"] = armature.name

bpy.utils.register_class(__import__("cclay").CCLAY_OT_select_ik_handle)
bpy.utils.register_class(__import__("cclay").CCLAY_OT_edit_constraint_ghost)

# From Object Mode, which is where an animator lands after clicking a ghost in
# the viewport, and where there are no IK handles at all. One operator has to
# get from "that frame" to "posing that frame".
bpy.ops.object.mode_set(mode="OBJECT")
bpy.context.view_layer.objects.active = armature
results["modeBeforeEdit"] = bpy.context.mode
results["editStatus"] = sorted(
    bpy.ops.cclay.edit_constraint_ghost(
        kind=_g.get(constraint_ghost.GHOST_KIND),
        frame=int(_g.get(constraint_ghost.GHOST_FRAME)),
    )
)
results["activeAfterEdit"] = bpy.context.view_layer.objects.active.name
results["editLandedOnTheGhost"] = bpy.context.view_layer.objects.active is _g
results["modeAfterEdit"] = _g.mode
try:
    results["editOnAMissingPose"] = sorted(
        bpy.ops.cclay.edit_constraint_ghost(kind="LeftFoot", frame=999)
    )
except RuntimeError as error:
    results["editOnAMissingPose"] = ["CANCELLED", str(error)]
results["grabStatus"] = sorted(bpy.ops.cclay.select_ik_handle(bone=TARGET))
results["activeAfterGrab"] = bpy.context.view_layer.objects.active.name
results["grabbedTheGhost"] = bpy.context.view_layer.objects.active is _g
results["selectedOnGhost"] = sorted(
    b.name for b in _g.pose.bones if b.select
)
results["selectedOnLiveRig"] = sorted(
    b.name for b in armature.pose.bones if b.select
)
# Removing the ghosts leaves no active object at all, and mode_set needs one,
# so the live rig is made active BEFORE any mode change.
constraint_ghost.remove_all_ghosts(armature)
bpy.context.view_layer.objects.active = armature
for _obj in bpy.context.view_layer.objects:
    _obj.select_set(_obj is armature)
bpy.ops.object.mode_set(mode="POSE")
results["ghostsAfterDismissOperator"] = [
    g.name for g in constraint_ghost.ghosts_of(armature)
]

# --- fact 6: detaching the rig takes the ghosts with it -------------------
# A ghost SHARES this armature's data, so detach is about to delete its
# handles out from under it. Anything left behind would point at bones that no
# longer exist.
constraint_ghost.create_ghost(armature, KIND, GHOST_FRAME)
results["ghostsBeforeDetach"] = [g.name for g in constraint_ghost.ghosts_of(armature)]
detached = ik_rig.detach(armature, keep_edits=False)
results["detachRemovedGhosts"] = detached["removedGhosts"]
results["ghostsAfterDetach"] = [g.name for g in constraint_ghost.ghosts_of(armature)]
results["ghostObjectsLeftInFile"] = sorted(
    obj.name
    for obj in bpy.data.objects
    if obj.name.startswith(constraint_ghost.GHOST_PREFIX)
)
results["ghostCollectionRemoved"] = (
    constraint_ghost.GHOST_COLLECTION not in bpy.data.collections
)

print("CCLAY_CONSTRAINT_GHOST=" + json.dumps(results))
