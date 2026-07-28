"""The ARDY constraint timeline, made of Blender's own animation channels.

ARDY's interactive demo shows one lane per constraint kind with a dot on every
constrained frame. Blender's Dope Sheet is that widget already: the marks the
add-on writes are real keyframes on real F-curves, and a channel group is a
named row. All that is missing is the naming.

So this module does not draw anything. An earlier revision did -- a GPU overlay
with its own ruler, playhead, hit-testing and drag handling -- and every one of
those was a worse copy of something the Dope Sheet does natively, including two
that were visibly wrong: it drew a second ruler and a second playhead on a
scale that disagreed with the editor's own. Putting the curves in named groups
instead costs a few lines and hands back selection, box select, G with numeric
input and snapping, X, copy/paste, channel locking, undo and theming.

What is here is the naming, the ordering, and the bookkeeping needed to put the
editor back exactly as it was found.
"""

from . import constraint_capture

# Lane labels, in ARDY's own top-to-bottom order, so an animator moving between
# the two tools reads the same list in the same places. The right-hand name is
# the constraint kind in constraint_capture.ANCHOR_BY_KIND.
TRACKS = (
    ("Full-Body", "FullBody"),
    ("2D Root", "Root2D"),
    ("Left Hand", "LeftHand"),
    ("Right Hand", "RightHand"),
    ("Left Foot", "LeftFoot"),
    ("Right Foot", "RightFoot"),
)

# Every marker F-curve's data path ends in this property, so it is also the
# channel filter that leaves exactly the constraint lanes on screen.
CHANNEL_FILTER = constraint_capture.CONSTRAINT_MARKER


class ConstraintTimelineError(RuntimeError):
    """The timeline cannot be built on this rig or action."""


def marker_path(kind: str) -> str:
    """The F-curve data path carrying ``kind``'s marks."""
    if kind not in constraint_capture.ANCHOR_BY_KIND:
        raise ConstraintTimelineError(f"unknown constraint kind {kind!r}")
    anchor = constraint_capture.ANCHOR_BY_KIND[kind]
    return f'pose.bones["{anchor}"]["{constraint_capture.CONSTRAINT_MARKER}"]'


# Re-exported rather than re-derived: the walk over layers/strips/channelbags
# belongs to whichever module owns the curves, and that is constraint_capture.
channelbags = constraint_capture.action_channelbags


def ensure_lanes(armature):
    """Name and order the constraint lanes. Returns the labels now on screen.

    Creating the groups in TRACKS order matters: Blender draws channel groups
    in the order they were created, so building them as marks happen to arrive
    would give a different lane order in every scene.

    All six lanes are normally present, because ``attach_ik_rig`` calls
    ``constraint_capture.ensure_marker_curves`` and the Dope Sheet draws a
    channel for a curve whether or not it holds keys. An earlier revision left
    a kind with no marks without a curve and therefore without a lane, on the
    reasoning that an empty row is one an animator can neither click nor
    explain. That reasoning was wrong in exactly the way that mattered: an
    empty lane is precisely what an animator clicks in order to select it and
    press I, and without one the first mark of every kind had to come from a
    panel button. A rig attached before this change still has fewer lanes,
    which is why ``lane_labels`` reports what is actually there.
    """
    action = _require_action(armature)
    shown = []
    for bag in channelbags(action):
        existing = {group.name: group for group in bag.groups}
        curves_by_path = {curve.data_path: curve for curve in bag.fcurves}
        for label, kind in TRACKS:
            curve = curves_by_path.get(marker_path(kind))
            if curve is None:
                continue
            group = existing.get(label)
            if group is None:
                group = bag.groups.new(label)
                existing[label] = group
            # Blender reports "F-Curve already belongs to this group" when a
            # curve is assigned to the group it is already in, so ensure_lanes
            # would spam the console every time it runs over settled lanes --
            # and it deliberately runs twice, because expanding the channels
            # re-opens the groups it just collapsed.
            # Compared by name, not identity: RNA hands back a fresh Python
            # wrapper on every access, so "curve.group is not group" is true
            # even when they are the same group.
            if getattr(curve.group, "name", None) != label:
                curve.group = group
            # Collapsed, so the lane is one row of dots rather than a group
            # header plus a child channel -- which is what ARDY shows.
            group.show_expanded = False
            # And deselected. A lane IS a group, and Blender's channel filter
            # counts every curve inside a SELECTED group as selected -- so six
            # selected groups made the animator's first I key all six lanes at
            # once, even with exactly one curve selected and even with the
            # "Only Selected Channels" variant. Measured both ways. Leaving the
            # group deselected is what makes clicking one lane mean one lane.
            group.select = False
            # The slot row sits between the action and the groups and ships
            # collapsed, hiding the lanes behind one more disclosure triangle.
            # It is the only parent row Python can open directly; the action
            # row above it is reachable only through anim.channels_expand.
            slot = getattr(bag, "slot", None)
            if slot is not None and hasattr(slot, "show_expanded"):
                slot.show_expanded = True
            if label not in shown:
                shown.append(label)
    return shown


def lane_labels(armature):
    """The lane labels this rig currently has marks for, in ARDY order."""
    action = _require_action(armature)
    present = {
        curve.data_path for bag in channelbags(action) for curve in bag.fcurves
    }
    return [label for label, kind in TRACKS if marker_path(kind) in present]


def _require_action(armature):
    action = getattr(getattr(armature, "animation_data", None), "action", None)
    if action is None:
        raise ConstraintTimelineError(
            "this character has no animation to put constraint lanes on"
        )
    return action
