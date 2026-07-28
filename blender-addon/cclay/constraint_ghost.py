"""Editable poses of constrained frames, shown while the playhead is elsewhere.

The ARDY demo draws the pose of every constrained frame in the viewport and
lets the animator drag it from wherever they are standing. Blender has no
equivalent: armature ghosting was removed in 2.8 and armatures have no onion
skinning -- both property sets come back empty when asked. So an animator
working in Blender can only edit frame 70's pose by going to frame 70, which is
the loop the demo abolished.

A GPU overlay is the obvious way to draw one and the wrong way to build this:
an overlay is pixels, so it cannot be clicked or dragged, and dragging is the
entire point.

What makes a real, editable ghost cheap is a property of Blender's data model
that was measured rather than assumed:

  * bones live on the Armature DATA, but the POSE and the CONSTRAINTS live on
    the Object. Two objects sharing one armature datablock therefore hold two
    independent poses at the same instant -- measured: the live rig stayed on
    its frame while the ghost held a completely different pose.
  * because the live rig's attach put the control bones in the armature DATA,
    a ghost sharing that data ALREADY has the IK handles. Only the constraints
    are missing (measured: live ``["IK"]`` against ghost ``[]``), and
    ``ik_rig._attach_constraints`` adds exactly those, pointed at whichever
    object it is handed.

So a ghost is one new Object, no bone data copied, plus the constraint pass the
live rig already uses. Editing it is Blender's ordinary pose editing, with the
same handles, because it IS the same rig.

The pose itself comes from evaluating the action's F-curves at the marked frame
rather than moving the playhead there and back. Measured exact against
``frame_set``, and it leaves the animator's current frame alone, which matters
because a ghost is created while they are looking at something else.
"""

from __future__ import annotations

import re

from . import constraint_capture, ik_chains, ik_rig

try:  # pragma: no cover - exercised inside Blender
    import bpy  # type: ignore
except ImportError:  # pragma: no cover - importable outside Blender
    bpy = None  # type: ignore


# Ghosts are scaffolding, not content. They are named so they are recognisable
# in the outliner, tagged so they can be found again without relying on the
# name, and kept in one collection so hiding or deleting them is one action.
GHOST_COLLECTION = "CCLAY Constraint Ghosts"
GHOST_PREFIX = "CCLAY-GHOST"
# The owner, held as a direct reference to the rig object rather than anything
# describing it. Two weaker versions were measured and both broke:
#   * the armature's NAME -- an animator renames a rig freely, and renaming
#     stranded every ghost: ghosts_of returned [], commit failed with "the rig
#     this ghost belongs to is gone", and detach reported removing nothing
#     while leaving twelve ghosts holding IK constraints on bones it had just
#     deleted.
#   * a uuid stamped on the rig -- Alt+D copies custom properties AND shares
#     the datablock, so both the original and the linked duplicate satisfied
#     the ownership test and the owner resolved to whichever came first.
# A reference is the identity. Nothing derived from it can drift.
GHOST_OF = "cclay.ghost_of"
GHOST_KIND = "cclay.ghost_kind"
GHOST_FRAME = "cclay.ghost_frame"

_BONE_PATH = re.compile(r'^pose\.bones\["(?P<bone>[^"]+)"\]\.(?P<prop>[A-Za-z_]+)$')


class ConstraintGhostError(RuntimeError):
    """A ghost cannot be built for, or committed back to, this rig."""


def ghost_name(kind: str, frame: int) -> str:
    # Display only. Two rigs can carry the same kind at the same frame, so
    # Blender's own .001 suffixing settles the collision and nothing looks a
    # ghost up by this string.
    return f"{GHOST_PREFIX}-{kind}-{int(frame)}"


def _require_armature(armature):
    if armature is None or getattr(armature, "type", None) != "ARMATURE":
        raise ConstraintGhostError("a ghost needs an armature")
    if not ik_rig.has_ik_layer(armature):
        # Without the control bones there are no handles to edit, so a ghost
        # would be a pose the animator can look at and not touch.
        raise ConstraintGhostError(
            "attach the IK rig before showing a ghost, or it has no handles"
        )


def _ghost_collection(scene):
    collection = bpy.data.collections.get(GHOST_COLLECTION)
    if collection is None:
        collection = bpy.data.collections.new(GHOST_COLLECTION)
    if collection.name not in {child.name for child in scene.collection.children}:
        scene.collection.children.link(collection)
    # Scaffolding must not reach a render. This is set every time rather than
    # only at creation, because the flags are reachable from the outliner and a
    # ghost that renders would silently corrupt an output the animator never
    # thought to check.
    collection.hide_render = True
    return collection


def evaluated_pose(armature, frame: int) -> dict:
    """Every animated pose channel of ``armature``, valued at ``frame``.

    Read from the F-curves directly instead of setting the scene frame. Two
    reasons, both load-bearing: a ghost is created while the animator is
    looking at another frame and moving the playhead under them is rude, and
    frame changes fire handlers -- including this add-on's own -- so a
    round trip would be a far larger action than reading a curve.
    """
    pose: dict = {}
    for curve in constraint_capture._fcurves(armature):
        match = _BONE_PATH.match(curve.data_path)
        if match is None:
            continue
        channel = pose.setdefault((match["bone"], match["prop"]), {})
        channel[curve.array_index] = curve.evaluate(frame)
    return pose


def _apply_pose(ghost, pose: dict) -> None:
    for (bone_name, prop), values in pose.items():
        pose_bone = ghost.pose.bones.get(bone_name)
        if pose_bone is None:
            # The live rig's action can name a bone this armature no longer
            # has. Skipping is right: a ghost is a view of a pose, and a
            # channel with nowhere to land simply has no effect on it.
            continue
        current = getattr(pose_bone, prop, None)
        if current is None:
            continue
        for index, value in values.items():
            if index < len(current):
                current[index] = value


def create_ghost(armature, kind: str, frame: int):
    """Build, or refresh, the editable ghost of one marked frame.

    Idempotent per ``(kind, frame)``: asking twice refreshes the pose of the
    existing ghost rather than stacking a second copy on top of it, because the
    obvious way to use this is to press the button again after changing
    something.
    """
    _require_armature(armature)
    if kind not in constraint_capture.ANCHOR_BY_KIND:
        raise ConstraintGhostError(f"unknown constraint kind: {kind}")
    frame = int(frame)
    if frame not in constraint_capture.marked_frames(armature, kind):
        # A ghost stands for a constraint. One at a frame carrying no mark
        # would be an edit the animator believes ARDY will honour and it will
        # not, which is worse than no ghost at all.
        raise ConstraintGhostError(
            f"frame {frame} carries no {kind} mark, so there is nothing to show"
        )

    scene = bpy.context.scene
    ghost = _find_ghost(armature, kind, frame)
    if ghost is None:
        name = ghost_name(kind, frame)
        # Shares the armature datablock: no bones are copied, and the control
        # bones the live rig created are already present on it.
        ghost = bpy.data.objects.new(name, armature.data)
        ghost[GHOST_OF] = armature
        ghost[GHOST_KIND] = kind
        ghost[GHOST_FRAME] = frame
    collection = _ghost_collection(scene)
    if ghost.name not in collection.objects:
        collection.objects.link(ghost)

    ghost.matrix_world = armature.matrix_world.copy()
    # No animation data, deliberately. A ghost holds one frame and must not
    # move when the playhead does -- that stillness is what lets the animator
    # compare it against the live rig.
    ghost.animation_data_clear()
    # A freshly linked object has no ``pose`` until the depsgraph has built one
    # from the armature data, so everything below would be reading None.
    bpy.context.view_layer.update()
    _apply_pose(ghost, evaluated_pose(armature, frame))
    # The same constraint pass the live rig uses, pointed at the ghost, which
    # is what makes its handles actually drive its joints.
    ik_rig._attach_constraints(ghost)
    # Drawn as bones only. A ghost overlapping the live rig at full opacity is
    # a pose you cannot read; in wireframe the two are distinguishable and the
    # handles stay clickable.
    ghost.display_type = "WIRE"
    ghost.show_in_front = True
    return ghost


def is_ghost(obj) -> bool:
    return obj is not None and obj.get(GHOST_OF) is not None


def _belongs_to(obj, armature) -> bool:
    """Whether ``obj`` is a ghost of ``armature``, by identity and by data.

    Both halves matter. The id survives renaming, which the name did not; and
    requiring the shared datablock means an object carrying a copied-over tag
    -- from a duplicate, an append, or a hand-edited custom property -- is not
    mistaken for a ghost of this rig and handed to code that will pose it.
    """
    if not is_ghost(obj):
        return False
    # Both halves matter. The reference is what survives renaming and linked
    # duplication; requiring the shared datablock rejects a FULL copy, whose
    # custom properties came along but whose skeleton is a different one --
    # posing or committing that would push a pose from another rig onto this.
    return obj.get(GHOST_OF) is armature and obj.data is armature.data


def _find_ghost(armature, kind: str, frame: int):
    for obj in ghosts_of(armature):
        if obj.get(GHOST_KIND) == kind and int(obj.get(GHOST_FRAME, -1)) == int(frame):
            return obj
    return None


def ghosts_of(armature) -> list:
    """Every live ghost belonging to ``armature``, by kind then frame."""
    if bpy is None or armature is None:
        return []
    found = [obj for obj in bpy.data.objects if _belongs_to(obj, armature)]
    return sorted(found, key=lambda obj: (obj.get(GHOST_KIND, ""), obj.get(GHOST_FRAME, 0)))


def remove_ghost(ghost) -> None:
    if ghost is None:
        return
    bpy.data.objects.remove(ghost, do_unlink=True)


def remove_all_ghosts(armature) -> list:
    """Drop every ghost of ``armature``; returns the names removed."""
    removed = []
    for ghost in ghosts_of(armature):
        removed.append(ghost.name)
        remove_ghost(ghost)
    collection = bpy.data.collections.get(GHOST_COLLECTION)
    if collection is not None and not collection.objects:
        bpy.data.collections.remove(collection)
    return sorted(removed)


def prune_stale_ghosts(armature) -> list:
    """Drop ghosts whose mark is gone; returns the names removed.

    A mark can be deleted with Blender's own X, which knows nothing about
    ghosts. Left alone, the ghost would keep offering an edit that no longer
    corresponds to any constraint.
    """
    removed = []
    for ghost in ghosts_of(armature):
        kind = ghost.get(GHOST_KIND)
        frame = ghost.get(GHOST_FRAME)
        if kind is None or frame is None:
            continue
        if int(frame) not in constraint_capture.marked_frames(armature, kind):
            removed.append(ghost.name)
            remove_ghost(ghost)
    return sorted(removed)


# How far a control bone may sit from what its frame holds before the edit
# counts as unapplied. Handles carry object scale 0.01, so this is generous in
# world terms and still far below any deliberate drag.
_UNAPPLIED_TOLERANCE = 1e-4


def uncommitted_ghosts(armature) -> list:
    """Ghosts holding an edit that the rig has not been told about.

    Regeneration reads the LIVE rig's curves and nothing else. A ghost is a
    working surface, so a pose dragged on one and never applied is invisible to
    it: the request would carry the OLD pose at that frame, and the animator
    would get back a clip that ignores the edit they are looking at.

    Compares only the control bones, because those are the ones ``commit_ghost``
    writes and the only ones the IK solve reads.
    """
    stale = []
    for ghost in ghosts_of(armature):
        frame = int(ghost.get(GHOST_FRAME))
        committed = evaluated_pose(armature, frame)
        for chain in ik_chains.IK_CHAINS:
            for bone_name in (
                ik_chains.target_bone_name(chain.effector),
                ik_chains.pole_bone_name(chain.effector),
            ):
                pose_bone = ghost.pose.bones.get(bone_name)
                if pose_bone is None:
                    continue
                for prop in ("location", "rotation_quaternion"):
                    values = committed.get((bone_name, prop))
                    if not values:
                        continue
                    current = getattr(pose_bone, prop)
                    if any(
                        abs(current[index] - value) > _UNAPPLIED_TOLERANCE
                        for index, value in values.items()
                        if index < len(current)
                    ):
                        stale.append(f"{ghost.get(GHOST_KIND)} @ {frame}")
                        break
                else:
                    continue
                break
            else:
                continue
            break
    return sorted(set(stale))


def commit_ghost(ghost) -> dict:
    """Write the ghost's edited handles onto its own frame of the live rig.

    Only the control bones are carried back. They are what the IK solve reads,
    so they carry the whole edit, and confining the write to them means a ghost
    can never overwrite the underlying FK animation it was only ever a view of.

    The live rig's playhead is not moved: the keyframes are inserted at the
    ghost's frame explicitly, so committing from frame 44 writes frame 70 and
    leaves frame 44 exactly as it was.
    """
    if not is_ghost(ghost):
        raise ConstraintGhostError("not a constraint ghost")
    armature = next(
        (obj for obj in bpy.data.objects if _belongs_to(ghost, obj)),
        None,
    )
    if armature is None:
        raise ConstraintGhostError("the rig this ghost belongs to is gone")
    frame = int(ghost.get(GHOST_FRAME))
    kind = ghost.get(GHOST_KIND)
    if frame not in constraint_capture.marked_frames(armature, kind):
        raise ConstraintGhostError(
            f"frame {frame} no longer carries a {kind} mark; the edit would not be honoured"
        )

    written = []
    for chain in ik_chains.IK_CHAINS:
        for bone_name in (
            ik_chains.target_bone_name(chain.effector),
            ik_chains.pole_bone_name(chain.effector),
        ):
            source = ghost.pose.bones.get(bone_name)
            target = armature.pose.bones.get(bone_name)
            if source is None or target is None:
                continue
            # Keying another frame means routing the value through the live
            # pose bone, because that is what keyframe_insert reads. Passing
            # frame= chooses where the KEY lands; it does nothing about the
            # value now sitting on the bone, which is the pose at the frame the
            # animator is actually looking at. Left there, Apply visibly jerks
            # the live rig until something re-evaluates it.
            was = (tuple(target.location), tuple(target.rotation_quaternion))
            target.location = source.location
            target.rotation_quaternion = source.rotation_quaternion
            for path in ("location", "rotation_quaternion"):
                target.keyframe_insert(data_path=path, frame=frame)
            target.location, target.rotation_quaternion = was
            written.append(bone_name)
    return {"frame": frame, "kind": kind, "bones": sorted(written)}
