"""Which character the animator means, given whatever they have selected.

Every IK and ARDY-constraint surface acts on an armature, but a character is an
armature plus the meshes skinned to it, and clicking a character in the viewport
selects a mesh -- never the armature. Reading ``context.active_object`` directly
therefore made the panels read "Select a character armature" for the most
natural selection a character has, with no hint that the armature was one
outliner row above the thing under the cursor.

Two different relationships can answer "which armature is this mesh's", and
they are not the same question. The parent chain is scene organisation;
``add_character`` parents every imported mesh to the armature root, so for a
staged character it is the right answer. An ARMATURE modifier is the deform
relationship -- the rig that actually moves those vertices. They agree for a
staged character and can be made to disagree by reparenting a skinned mesh
under a second rig. The operators on the other side of this are destructive
(attach lays a control layer, detach bakes, regeneration replaces the clip), so
a disagreement is refused rather than guessed.

Pure on purpose: no ``bpy`` import, every attribute read through ``getattr``.
That keeps the rule -- which object stands for the character -- unit-testable
without Blender, which is where its edge cases (unparented meshes, cycles,
conflicting rigs) actually live.
"""

# A parented chain this deep is already pathological; the bound also makes a
# corrupted parent cycle terminate rather than hang Blender's UI redraw, which
# is where this runs.
_MAX_PARENT_DEPTH = 64

NOTHING_SELECTED = "Select the character (its mesh or its armature) first"


def is_armature(scene_object) -> bool:
    """Whether ``scene_object`` is an armature object."""
    return getattr(scene_object, "type", None) == "ARMATURE"


def _name(scene_object) -> str:
    return str(getattr(scene_object, "name", scene_object))


def _parent_armature(scene_object):
    """The nearest ARMATURE above ``scene_object`` in the parent chain."""
    seen = set()
    current = scene_object
    for _ in range(_MAX_PARENT_DEPTH):
        marker = id(current)
        if marker in seen:
            return None
        seen.add(marker)
        parent = getattr(current, "parent", None)
        if parent is None:
            return None
        if is_armature(parent):
            return parent
        current = parent
    return None


def _deform_armatures(scene_object) -> list:
    """Distinct armatures deforming ``scene_object``, in modifier order."""
    found = []
    for modifier in getattr(scene_object, "modifiers", ()) or ():
        if getattr(modifier, "type", None) != "ARMATURE":
            continue
        target = getattr(modifier, "object", None)
        if is_armature(target) and not any(target is seen for seen in found):
            found.append(target)
    return found


def resolve_character(scene_object):
    """The armature ``scene_object`` belongs to, and why when there is none.

    Returns ``(armature, None)`` on success and ``(None, reason)`` otherwise,
    where ``reason`` is the sentence to put in front of the animator. Refusing
    with a reason rather than returning ``None`` is what separates "you have
    not selected a character" from "this mesh answers to two rigs and I will
    not choose one for you".
    """
    if scene_object is None:
        return None, NOTHING_SELECTED
    if is_armature(scene_object):
        # A constraint ghost IS an armature, so it used to answer for itself --
        # and it deliberately carries no action, so every panel that asks about
        # the clip concluded there was nothing to work on and drew nothing.
        # Selecting a ghost is not selecting a different character; it is
        # looking at one frame of the same one.
        from . import constraint_ghost

        # Custom properties are read through .get, which the stand-in objects
        # this module is unit-tested against do not have.
        read = getattr(scene_object, "get", None)
        owner = read(constraint_ghost.GHOST_OF) if read is not None else None
        if owner is not None:
            return owner, None
        return scene_object, None

    parent = _parent_armature(scene_object)
    deform = _deform_armatures(scene_object)
    if len(deform) > 1 and parent is None:
        return None, (
            f"{_name(scene_object)} is deformed by "
            f"{_name(deform[0])} and {_name(deform[1])}; "
            "select the armature you mean"
        )
    skin = deform[0] if deform else None
    if parent is not None and skin is not None and parent is not skin:
        return None, (
            f"{_name(scene_object)} is parented to {_name(parent)} but skinned "
            f"to {_name(skin)}; select the armature you mean"
        )
    armature = parent if parent is not None else skin
    if armature is None:
        return None, NOTHING_SELECTED
    return armature, None