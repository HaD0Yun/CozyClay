"""The IK chain vocabulary stays inside what ARDY can represent, and the pole
geometry survives the straight-limb singularity.

The chains exist so an animator can grab a hand or a foot after ``apply_motion``
has baked an ARDY clip onto the rig. That only round-trips if every bone the IK
layer rotates is a bone ARDY itself drives: cskel27 has 27 joints, three of
which (the extra spine joint and the two ``HandEnd`` leaves) have no mixamo
counterpart, so a chain reaching outside the driven set would produce an edit
that cannot be expressed
back in the motion representation. These tests make that containment decidable
rather than a comment.
"""

from __future__ import annotations

import math
import sys
import unittest
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPOSITORY_ROOT / "blender-addon"))
sys.modules.pop("cclay.ik_chains", None)
sys.modules.pop("cclay.motion_retarget", None)

from cclay import ik_chains, motion_retarget  # noqa: E402


class ArdyCoverageTests(unittest.TestCase):
    def test_every_chain_bone_is_a_bone_ardy_drives(self):
        # The load-bearing invariant. An IK chain that rotates a bone outside
        # this set produces a pose no ARDY clip can carry.
        driven = {name for name in motion_retarget.MIXAMO_TARGETS.values() if name}
        for chain in ik_chains.IK_CHAINS:
            for bone in chain.bones():
                self.assertIn(
                    bone,
                    driven,
                    f"{chain.effector} chain rotates {bone}, which ARDY does not drive",
                )

    def test_chain_bone_count_matches_the_declared_chain_count(self):
        # chain_count is what Blender's IK constraint consumes; if it disagrees
        # with the declared bone list the rig silently rotates a different set.
        for chain in ik_chains.IK_CHAINS:
            self.assertEqual(len(chain.bones()), chain.chain_count, chain.effector)

    def test_the_constrained_bone_is_the_last_bone_of_the_chain(self):
        # The IK effector is the constrained bone's tail, so it must be the
        # distal end. Naming the root here would solve for the wrong point.
        for chain in ik_chains.IK_CHAINS:
            self.assertEqual(chain.bones()[-1], chain.constrained, chain.effector)
            self.assertEqual(chain.bones()[0], chain.chain_root, chain.effector)

    def test_both_sides_are_covered_symmetrically(self):
        effectors = {chain.effector for chain in ik_chains.IK_CHAINS}
        for left in [name for name in effectors if name.startswith("Left")]:
            self.assertIn("Right" + left[len("Left"):], effectors)
        self.assertEqual(len(ik_chains.IK_CHAINS), len(effectors))

    def test_the_effector_is_not_itself_rotated_by_the_chain(self):
        # The hand must stay free to keep the wrist rotation the clip authored;
        # including it would make the IK solve overwrite that.
        for chain in ik_chains.IK_CHAINS:
            self.assertNotIn(chain.effector, chain.bones(), chain.effector)


class ControlBoneNamingTests(unittest.TestCase):
    def test_control_bone_names_never_collide_with_a_driven_bone(self):
        driven = {name for name in motion_retarget.MIXAMO_TARGETS.values() if name}
        for chain in ik_chains.IK_CHAINS:
            for name in (
                ik_chains.target_bone_name(chain.effector),
                ik_chains.pole_bone_name(chain.effector),
            ):
                self.assertNotIn(name, driven)
                self.assertTrue(ik_chains.is_control_bone(name), name)

    def test_a_driven_bone_is_not_mistaken_for_a_control_bone(self):
        # Removal walks the armature deleting control bones; a false positive
        # here would delete a bone the motion drives.
        for name in motion_retarget.MIXAMO_TARGETS.values():
            if name:
                self.assertFalse(ik_chains.is_control_bone(name), name)
                self.assertFalse(ik_chains.is_control_bone("mixamorig:" + name), name)

    def test_control_bone_names_are_unique_across_every_chain(self):
        names = [
            name
            for chain in ik_chains.IK_CHAINS
            for name in (
                ik_chains.target_bone_name(chain.effector),
                ik_chains.pole_bone_name(chain.effector),
            )
        ]
        self.assertEqual(len(names), len(set(names)))

class ConstraintAnchorTests(unittest.TestCase):
    """The constraint anchors extend the control layer without colliding.

    ``is_control_bone`` must recognise both the existing IK handles and the new
    anchors, while still rejecting every bone the motion drives. The anchors
    live on ``CONSTRAINT_PREFIX``; the chain targets and poles live on
    ``CONTROL_PREFIX``; a mixamo bone carries ``BONE_PREFIX``. The three
    namespaces must stay disjoint so teardown, which deletes anything
    ``is_control_bone`` accepts, never reaches a driven bone.
    """

    def test_anchors_and_ik_handles_are_all_control_bones(self):
        # One representative of each control-layer species.
        names = [
            ik_chains.target_bone_name(ik_chains.IK_CHAINS[0].effector),
            ik_chains.pole_bone_name(ik_chains.IK_CHAINS[0].effector),
            ik_chains.FULLBODY_ANCHOR,
            ik_chains.ROOT2D_ANCHOR,
        ]
        for name in names:
            self.assertTrue(ik_chains.is_control_bone(name), name)

    def test_driven_bones_and_empty_are_not_control_bones(self):
        # False positives here would delete a bone the motion drives.
        for name in motion_retarget.MIXAMO_TARGETS.values():
            if name:
                self.assertFalse(ik_chains.is_control_bone(name), name)
                self.assertFalse(ik_chains.is_control_bone("mixamorig:" + name), name)
        self.assertFalse(ik_chains.is_control_bone("mixamorig:Spine"))
        self.assertFalse(ik_chains.is_control_bone(""))
        # A bare mixamo-style name with no joint is still not a control bone.
        self.assertFalse(ik_chains.is_control_bone("mixamorig:"))

    def test_anchors_cannot_collide_with_chain_targets_or_poles(self):
        # The two prefixes diverge after the shared "CCLAY-" stem, and the
        # chain builders only emit CONTROL_PREFIX, so neither anchor can equal
        # a target or pole for any effector.
        chain_names = {
            name
            for chain in ik_chains.IK_CHAINS
            for name in (ik_chains.target_bone_name(chain.effector), ik_chains.pole_bone_name(chain.effector))
        }
        for anchor in (ik_chains.FULLBODY_ANCHOR, ik_chains.ROOT2D_ANCHOR):
            self.assertTrue(anchor.startswith(ik_chains.CONSTRAINT_PREFIX), anchor)
            self.assertNotIn(anchor, chain_names)
            self.assertFalse(anchor.startswith(ik_chains.CONTROL_PREFIX), anchor)

    def test_prefixes_cannot_collide(self):
        # A control-prefix name never starts with the constraint prefix and
        # vice versa; both are disjoint from the mixamo bone prefix.
        self.assertFalse(ik_chains.CONTROL_PREFIX.startswith(ik_chains.CONSTRAINT_PREFIX))
        self.assertFalse(ik_chains.CONSTRAINT_PREFIX.startswith(ik_chains.CONTROL_PREFIX))
        self.assertFalse(ik_chains.CONTROL_PREFIX.startswith(ik_chains.BONE_PREFIX))
        self.assertFalse(ik_chains.CONSTRAINT_PREFIX.startswith(ik_chains.BONE_PREFIX))


class PoleGeometryTests(unittest.TestCase):
    def test_the_pole_sits_on_the_bend_plane_at_the_requested_distance(self):
        # A bent limb in the x/z plane: the knee is offset along +z.
        root = (0.0, 0.0, 0.0)
        mid = (0.5, 0.0, 0.3)
        effector = (1.0, 0.0, 0.0)
        pole = ik_chains.pole_position(root, mid, effector, 0.4)
        offset = tuple(pole[i] - mid[i] for i in range(3))
        self.assertAlmostEqual(math.sqrt(sum(c * c for c in offset)), 0.4, places=9)
        # The bend direction here is exactly +z, so the pole must be pushed
        # along +z and stay in the plane (y remains zero).
        self.assertAlmostEqual(offset[0], 0.0, places=9)
        self.assertAlmostEqual(offset[1], 0.0, places=9)
        self.assertAlmostEqual(offset[2], 0.4, places=9)

    def test_the_pole_is_perpendicular_to_the_chain_axis(self):
        root = (0.1, -0.2, 0.3)
        mid = (0.6, 0.1, 0.9)
        effector = (1.3, 0.4, 0.2)
        pole = ik_chains.pole_position(root, mid, effector, 0.35)
        axis = tuple(effector[i] - root[i] for i in range(3))
        offset = tuple(pole[i] - mid[i] for i in range(3))
        dot = sum(axis[i] * offset[i] for i in range(3))
        self.assertAlmostEqual(dot, 0.0, places=9)

    def test_a_straight_limb_still_yields_a_usable_pole(self):
        # The elbow is the real case: measured bend offset on the ARDY stair
        # clip is 0.055 m against 0.265 m at the knee, and a perfectly straight
        # limb has no bend plane at all. Returning something degenerate here
        # makes the IK constraint snap the limb on the first evaluated frame.
        root = (0.0, 0.0, 0.0)
        mid = (0.5, 0.0, 0.0)
        effector = (1.0, 0.0, 0.0)
        pole = ik_chains.pole_position(root, mid, effector, 0.4)
        offset = tuple(pole[i] - mid[i] for i in range(3))
        length = math.sqrt(sum(c * c for c in offset))
        self.assertAlmostEqual(length, 0.4, places=9)
        for component in pole:
            self.assertTrue(math.isfinite(component))
        axis = (1.0, 0.0, 0.0)
        self.assertAlmostEqual(sum(axis[i] * offset[i] for i in range(3)), 0.0, places=9)

    def test_a_collapsed_limb_yields_a_finite_pole(self):
        # Root and effector coincident: the axis itself is undefined.
        pole = ik_chains.pole_position((0.0, 0.0, 0.0), (0.0, 0.0, 0.0), (0.0, 0.0, 0.0), 0.4)
        for component in pole:
            self.assertTrue(math.isfinite(component))
        self.assertAlmostEqual(math.sqrt(sum(c * c for c in pole)), 0.4, places=9)

    def test_a_non_positive_distance_is_refused(self):
        # A zero-length pole offset lands the pole on the joint, which is the
        # singular configuration the fallback exists to avoid.
        for distance in (0.0, -0.1):
            with self.assertRaises(ValueError):
                ik_chains.pole_position((0.0, 0.0, 0.0), (0.5, 0.0, 0.3), (1.0, 0.0, 0.0), distance)


class SignedAngleTests(unittest.TestCase):
    def test_a_quarter_turn_about_z_is_positive(self):
        angle = ik_chains.signed_angle_about_axis((1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, 1.0))
        self.assertAlmostEqual(angle, math.pi / 2, places=9)

    def test_the_sign_follows_the_axis_direction(self):
        forward = ik_chains.signed_angle_about_axis(
            (1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, 1.0)
        )
        reversed_axis = ik_chains.signed_angle_about_axis(
            (1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, -1.0)
        )
        self.assertAlmostEqual(forward, -reversed_axis, places=9)

    def test_identical_directions_give_zero(self):
        angle = ik_chains.signed_angle_about_axis((0.3, 0.4, 0.0), (0.6, 0.8, 0.0), (0.0, 0.0, 1.0))
        self.assertAlmostEqual(angle, 0.0, places=9)

    def test_antiparallel_directions_give_pi(self):
        # atan2(0, -1) is +pi, which is the correct half turn; the important
        # property is that it is finite and half a turn, not which way it goes.
        angle = ik_chains.signed_angle_about_axis(
            (1.0, 0.0, 0.0), (-1.0, 0.0, 0.0), (0.0, 0.0, 1.0)
        )
        self.assertAlmostEqual(abs(angle), math.pi, places=9)

    def test_the_component_along_the_axis_is_ignored(self):
        # The refinement loop rotates the pole about the chain axis, so only the
        # perpendicular part of each direction may influence the angle.
        base = ik_chains.signed_angle_about_axis(
            (1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, 1.0)
        )
        tilted = ik_chains.signed_angle_about_axis(
            (1.0, 0.0, 5.0), (0.0, 1.0, -3.0), (0.0, 0.0, 1.0)
        )
        self.assertAlmostEqual(base, tilted, places=9)


if __name__ == "__main__":
    unittest.main()
