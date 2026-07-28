"""The character resolver recovers an armature from whatever the animator picked.

A character is an armature plus the meshes skinned to it, but a viewport click
lands on a mesh -- never the armature. ``resolve_character`` is the
rule that turns that selection back into the rig, and its edge cases (unparented
meshes, parent cycles, chains deeper than the bound, armature modifiers that
survive an unparent) are pure: they read attributes through ``getattr`` and
import no ``bpy``, so they are decidable here without Blender rather than by
probing a headless scene.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPOSITORY_ROOT / "blender-addon"))
sys.modules.pop("cclay.character_target", None)

from cclay import character_target  # noqa: E402


class _Object:
    """A Blender-object-shaped stand-in: name, type, parent, modifiers only.

    Blender's ``bpy.types.Object`` exposes far more than these four attributes,
    but the resolver reads nothing else, so this is the minimal honest proxy.
    ``type`` defaults to ``None`` so an instance with no explicit type behaves
    like an object the resolver cannot classify rather than like an armature.
    ``name`` matters because a refusal quotes it back to the animator.
    """

    def __init__(self, type=None, parent=None, modifiers=(), name="object"):
        self.type = type
        self.parent = parent
        self.modifiers = list(modifiers)
        self.name = name


class _Modifier:
    """A modifier stand-in: only ``type`` and ``object`` are read."""

    def __init__(self, type=None, object=None):
        self.type = type
        self.object = object


def _armature(name="armature"):
    return _Object(type="ARMATURE", name=name)


def _mesh(name="mesh"):
    return _Object(type="MESH", name=name)


def _empty(name="empty"):
    return _Object(type="EMPTY", name=name)


def _resolved(scene_object):
    """Just the armature, for the cases whose subject is the choice not the reason."""
    return character_target.resolve_character(scene_object)[0]


class IsArmatureTests(unittest.TestCase):
    def test_true_only_for_the_armature_type_string(self):
        # is_armature gates every resolution route, so a loose comparison (e.g.
        # a substring or case-insensitive match) would let a "MESH" or "Armature"
        # through and route the resolver into the wrong object.
        self.assertTrue(character_target.is_armature(_Object(type="ARMATURE")))

    def test_false_for_none_mesh_and_missing_type(self):
        # None is what the parent walk terminates on; a mesh is the common
        # starting point; a missing type attribute is what getattr-defaults
        # protect against. All three must be refused, or the walk returns a
        # non-armature as the character.
        self.assertFalse(character_target.is_armature(None))
        self.assertFalse(character_target.is_armature(_Object(type="MESH")))
        self.assertFalse(character_target.is_armature(_Object()))


class ResolveCharacterArmatureTests(unittest.TestCase):
    def test_an_armature_resolves_to_itself(self):
        # Route 1: an animator in pose mode, or a deliberate outliner click, has
        # the armature itself active. Returning anything else here loses the rig.
        armature = _armature()
        self.assertIs(_resolved(armature), armature)

    def test_a_mesh_parented_directly_to_an_armature_resolves_to_that_armature(self):
        # Route 2 and the viewport-click case the module exists for: the click
        # selects the mesh, the armature is exactly one parent hop above.
        armature = _armature()
        mesh = _Object(type="MESH", parent=armature)
        self.assertIs(_resolved(mesh), armature)

    def test_a_mesh_nested_below_an_armature_through_an_empty_resolves(self):
        # Route 2 over more than one hop: the armature is an ancestor, not the
        # immediate parent. A walk that only checked the first parent would miss
        # the rig that owns a character assembled under an organizing empty.
        armature = _armature()
        empty = _Object(type="EMPTY", parent=armature)
        mesh = _Object(type="MESH", parent=empty)
        self.assertIs(_resolved(mesh), armature)

    def test_the_nearest_armature_ancestor_wins(self):
        # Two armatures stacked in one chain is a real scene layout (a rig
        # parented to a control rig). The resolver must report the closest one,
        # not the first armature anywhere in the outliner, or the panels edit
        # the wrong skeleton.
        outer = _armature("outer")
        inner = _armature("inner")
        inner.parent = outer
        mesh = _Object(type="MESH", parent=inner)
        self.assertIs(_resolved(mesh), inner)

    def test_none_input_returns_none(self):
        # context.active_object can be None when nothing is selected; the
        # resolver must not raise on that, it must report no character.
        self.assertIsNone(_resolved(None))

    def test_an_unparented_non_armature_with_no_armature_modifier_returns_none(self):
        # A loose object the animator dropped into the scene is not a character.
        # Reporting an armature here would route a mutation onto a rig that does
        # not own this mesh.
        self.assertIsNone(
            _resolved(_Object(type="MESH"))
        )

    def test_an_armature_modifier_resolves_when_the_parent_chain_has_no_armature(self):
        # Route 3: an animator unparented a mesh to move it without the rig, so
        # the parent walk finds nothing, but the ARMATURE modifier still names
        # the deform target. This is the case that survives losing the parent.
        armature = _armature()
        modifier = _Modifier(type="ARMATURE", object=armature)
        mesh = _Object(type="MESH", modifiers=[modifier])
        self.assertIs(_resolved(mesh), armature)

    def test_a_parent_and_a_deform_rig_that_disagree_are_refused(self):
        # Both routes name an armature and they name different ones. The parent
        # chain is scene organisation; the modifier is what actually moves the
        # vertices. Everything downstream of this resolution is destructive --
        # attach lays a control layer, detach bakes, regeneration replaces the
        # clip -- so choosing one and being wrong silently rewrites the wrong
        # character. Refusing with a reason is the only safe answer.
        chain_armature = _armature("chain")
        modifier_armature = _armature("modifier")
        modifier = _Modifier(type="ARMATURE", object=modifier_armature)
        mesh = _Object(type="MESH", parent=chain_armature, modifiers=[modifier])
        self.assertIsNone(_resolved(mesh))
        armature, reason = character_target.resolve_character(mesh)
        self.assertIsNone(armature)
        # The reason has to name both rigs, or the animator cannot tell which
        # two things disagree or which one to select instead.
        self.assertIn("chain", reason)
        self.assertIn("modifier", reason)

    def test_a_parent_that_is_also_the_deform_rig_still_resolves(self):
        # The staged case: add_character parents every imported mesh to the
        # armature root AND leaves the FBX armature modifier pointing at it.
        # Agreement is the normal state, and it must not be read as a conflict.
        armature = _armature("Walker")
        modifier = _Modifier(type="ARMATURE", object=armature)
        mesh = _Object(type="MESH", parent=armature, modifiers=[modifier])
        self.assertIs(_resolved(mesh), armature)

    def test_two_deform_rigs_with_no_parent_are_refused(self):
        # Nothing breaks the tie: neither modifier is more authoritative than
        # the other, and there is no hierarchy to fall back on.
        first = _armature("first")
        second = _armature("second")
        mesh = _Object(
            type="MESH",
            modifiers=[
                _Modifier(type="ARMATURE", object=first),
                _Modifier(type="ARMATURE", object=second),
            ],
        )
        armature, reason = character_target.resolve_character(mesh)
        self.assertIsNone(armature)
        self.assertIn("first", reason)
        self.assertIn("second", reason)

    def test_the_same_rig_named_twice_is_not_a_conflict(self):
        # Two armature modifiers can name one rig; that is a duplicate, not a
        # disagreement, and refusing it would block a perfectly ordinary mesh.
        armature = _armature("Walker")
        mesh = _Object(
            type="MESH",
            modifiers=[
                _Modifier(type="ARMATURE", object=armature),
                _Modifier(type="ARMATURE", object=armature),
            ],
        )
        self.assertIs(_resolved(mesh), armature)

    def test_a_refusal_always_carries_a_reason(self):
        # Every caller reports the reason straight to the animator, so a None
        # armature paired with a None reason would surface as an empty error.
        for candidate in (None, _mesh(), _Object(type="EMPTY")):
            armature, reason = character_target.resolve_character(candidate)
            self.assertIsNone(armature)
            self.assertTrue(reason)

    def test_a_non_armature_or_objectless_armature_modifier_is_ignored(self):
        # A modifier whose type is not ARMATURE is not a deform target, and a
        # modifier whose object is None or is itself not an armature points at
        # nothing useful. None of these should route the resolver into returning
        # a non-armature or None-as-armature.
        mesh = _Object(
            type="MESH",
            modifiers=[
                _Modifier(type="SUBSURF", object=_armature()),
                _Modifier(type="ARMATURE", object=None),
                _Modifier(type="ARMATURE", object=_mesh()),
            ],
        )
        self.assertIsNone(_resolved(mesh))

    def test_a_parent_cycle_terminates_and_returns_none(self):
        # A corrupted scene can link two objects as each other's parent. The
        # resolver must detect the revisit and stop, not loop until the process
        # is killed. Termination is asserted by the returned value: None means
        # the walk exited without finding an armature, which only happens if it
        # broke the cycle.
        a = _Object(type="MESH")
        b = _Object(type="MESH")
        a.parent = b
        b.parent = a
        self.assertIsNone(_resolved(a))

    def test_a_chain_past_the_depth_bound_with_armature_beyond_returns_none(self):
        # _MAX_PARENT_DEPTH is the guard against a pathological depth; the
        # armature sitting one hop beyond that bound must not be reached, or the
        # guard is off-by-one. The chain length is derived from the constant so
        # the test tracks the bound rather than restating 64.
        armature = _armature()
        # `bound` hops of mesh/empty between the start object and the armature,
        # so the armature is at hop bound+1 and therefore unreachable.
        bound = character_target._MAX_PARENT_DEPTH
        node = armature
        for _ in range(bound):
            node = _Object(type="EMPTY", parent=node)
        start = _Object(type="MESH", parent=node)
        self.assertIsNone(_resolved(start))

    def test_an_armature_at_the_last_reachable_hop_still_resolves(self):
        # The complement of the previous case: the armature exactly at hop
        # `bound` (the last iteration the walk performs) must still be found.
        # A bound that is one too small would drop this case along with the
        # over-bound one, so the pair pins both edges of the fence.
        armature = _armature()
        bound = character_target._MAX_PARENT_DEPTH
        # `bound - 1` intermediates put the armature at hop `bound`.
        node = armature
        for _ in range(bound - 1):
            node = _Object(type="EMPTY", parent=node)
        start = _Object(type="MESH", parent=node)
        self.assertIs(_resolved(start), armature)


if __name__ == "__main__":
    unittest.main()
