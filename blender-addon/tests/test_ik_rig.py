"""An IK layer over an ARDY clip is faithful, editable, isolated, and removable.

Every number here comes from Blender's own IK evaluation on the bundled Y-Bot
driven by the recorded ARDY payload, not from a model of it.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
import unittest
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPOSITORY_ROOT / "blender-addon"))
from cclay import ik_chains  # noqa: E402

BLENDER = Path(shutil.which("blender") or "/opt/homebrew/bin/blender")
SCRIPT = REPOSITORY_ROOT / "blender-addon/tests/fixtures/ik_rig_fixture.py"

# The layer exists to be attached to finished animation, so attaching it must not
# be visible. A tenth of a millimetre on a 1.7 m character is four orders of
# magnitude below what a render can show, and the reference 240-frame clip
# measures 0.26 mm worst case; this bound leaves room for that without admitting
# the 79.8 mm a static pole angle produces.
MAX_ATTACH_DEVIATION_MM = 1.0


@unittest.skipUnless(BLENDER.is_file(), "Blender is unavailable")
class IkRigTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        completed = subprocess.run(
            [str(BLENDER), "--background", "--factory-startup", "--python", str(SCRIPT)],
            cwd=REPOSITORY_ROOT,
            check=False,
            capture_output=True,
            text=True,
            timeout=900,
        )
        if completed.returncode != 0:
            raise AssertionError(
                f"headless Blender failed\nstdout:\n{completed.stdout}\nstderr:\n{completed.stderr}"
            )
        lines = [
            line for line in completed.stdout.splitlines() if line.startswith("CCLAY_IK_RIG=")
        ]
        if len(lines) != 1:
            raise AssertionError(f"missing IK rig results\n{completed.stdout}")
        cls.results = json.loads(lines[0].split("=", 1)[1])

    def test_attaching_the_layer_does_not_move_the_character(self):
        # The load-bearing property: an animator lays IK over a clip that is
        # already approved, so the first frame after attaching must look the
        # same as the last frame before it.
        report = self.results["attachReport"]
        self.assertLess(report["worstMidDeviationMm"], MAX_ATTACH_DEVIATION_MM)
        for effector, entry in report["chains"].items():
            self.assertLess(entry["maxMidDeviationMm"], MAX_ATTACH_DEVIATION_MM, effector)

    def test_fidelity_is_measured_against_the_effectors_too(self):
        # The mid joint is the hard case, but a wrist that drifted would be worse
        # and is not covered by the mid-joint figure.
        for effector, deviation in self.results["fidelityAfterAttach"].items():
            self.assertLess(deviation, MAX_ATTACH_DEVIATION_MM, effector)

    def test_every_chain_gets_a_target_and_a_pole(self):
        self.assertEqual(
            self.results["controlBones"],
            [
                "CCLAY-CONSTRAINT-FULLBODY",
                "CCLAY-CONSTRAINT-ROOT2D",
                "CCLAY-IK-POLE-LeftFoot",
                "CCLAY-IK-POLE-LeftHand",
                "CCLAY-IK-POLE-RightFoot",
                "CCLAY-IK-POLE-RightHand",
                "CCLAY-IK-TGT-LeftFoot",
                "CCLAY-IK-TGT-LeftHand",
                "CCLAY-IK-TGT-RightFoot",
                "CCLAY-IK-TGT-RightHand",
            ],
        )

    def test_the_two_constraint_anchors_are_present_after_attach(self):
        # The regenerate flow pins poses against the Full-Body marker and drags
        # the 2D-Root across the floor; attach must create both.
        bones = set(self.results["controlBones"])
        self.assertIn(ik_chains.FULLBODY_ANCHOR, bones)
        self.assertIn(ik_chains.ROOT2D_ANCHOR, bones)

    def test_the_constraint_anchors_do_not_deform_the_mesh(self):
        # Anchors are markers/handles, not anatomy: a deforming anchor would
        # drag skin when its constraint fires.
        anchors = [
            bone
            for bone in self.results["controlBonesDeform"]
            if bone.startswith(ik_chains.CONSTRAINT_PREFIX)
        ]
        self.assertEqual(anchors, [])

    def test_no_control_bone_deforms_the_mesh(self):
        # A handle that weighted a vertex would drag the skin when dragged.
        self.assertEqual(self.results["controlBonesDeform"], [])
    def test_the_constraint_solves_for_the_wrist_not_the_elbow(self):
        # use_tail decides which end of the constrained bone is the effector;
        # with it off the rig solves for the elbow and the hand trails behind.
        for effector, constraints in self.results["ikConstraints"].items():
            self.assertEqual(len(constraints), 1, effector)
            self.assertTrue(constraints[0]["useTail"], effector)
            self.assertEqual(constraints[0]["chainCount"], 2, effector)
            # The bend plane is carried by the keyed pole position; a non-zero
            # constant here would fight it.
            self.assertEqual(constraints[0]["poleAngle"], 0.0, effector)

    def test_attaching_twice_is_refused(self):
        self.assertIn("already carries an IK layer", self.results["doubleAttach"])

    def test_dragging_a_target_moves_that_limb_and_only_that_limb(self):
        edit = self.results["edit"]
        self.assertAlmostEqual(edit["handMovedMm"], edit["requestedMm"], delta=0.01)
        self.assertEqual(edit["otherHandMovedMm"], 0.0)
        self.assertEqual(edit["footMovedMm"], 0.0)

    def test_an_unreachable_target_extends_the_limb_and_stops(self):
        # Reaching past full extension must clamp, not snap, flip, or produce a
        # non-finite pose. The clip starts near a T-pose so the arm is already
        # close to its limit, which is why the reachable edit above pulls the
        # hand toward the shoulder instead of away from it.
        out_of_reach = self.results["outOfReach"]
        self.assertTrue(out_of_reach["finite"])
        self.assertGreater(out_of_reach["movedFartherMm"], 0.0)
        self.assertAlmostEqual(
            out_of_reach["shoulderToHandMm"], out_of_reach["restReachMm"], delta=0.5
        )

    def test_an_edit_is_reversible(self):
        self.assertLess(self.results["editRestoredMm"], 0.01)

    def test_detaching_keeps_the_edit(self):
        self.assertTrue(self.results["detachReport"]["keptEdits"])
        self.assertEqual(self.results["detachReport"]["bakedFrames"], self.results["frames"])
        self.assertLess(self.results["editSurvivedDetachMm"], 0.01)

    def test_the_bake_stays_inside_what_ardy_can_represent(self):
        # cskel27 covers 25 mixamo bones. Baking the whole selection writes
        # rotation keys onto the 40 finger bones as well, and an action carrying
        # those is no longer a motion ARDY could have produced.
        self.assertEqual(self.results["bakedRotationBonesOutsideArdy"], [])

    def test_a_bone_the_layer_cannot_reach_survives_the_bake_untouched(self):
        self.assertTrue(self.results["untouchedBoneUnchanged"])
        # A vacuous pass if the witness bone had no curves at all.
        self.assertEqual(self.results["untouchedBoneCurveCount"], 4)

    def test_detaching_leaves_nothing_behind(self):
        self.assertEqual(self.results["controlBonesAfterDetach"], [])
        self.assertEqual(self.results["ikConstraintsAfterDetach"], [])
        self.assertEqual(self.results["controlFcurvesAfterDetach"], [])

    def test_detaching_removes_custom_property_fcurves_on_control_bones(self):
        # The next regenerate slice keys a "cclay_constraint" custom property on
        # the anchors, so teardown must delete a control-bone curve whose
        # data_path is pose.bones["<name>"]["<prop>"], not just location/rotation.
        # The probe must actually have produced a curve, otherwise the assertion
        # below would pass vacuously.
        self.assertGreater(len(self.results["customPropCurveBeforeDetach"]), 0)
        self.assertEqual(self.results["customPropCurveAfterDetach"], [])

    def test_the_bake_does_not_key_the_constraint_anchors(self):
        # detach(keep_edits=True) bakes with only_selected over the chain bones.
        # The anchors carry no IK constraint and are deselected, so the bake
        # must not leave rotation keys on them — otherwise an action carrying
        # them would not round-trip as an ARDY motion, and teardown would have
        # keys to clean up that the manifest does not expect.
        anchors = {
            ik_chains.FULLBODY_ANCHOR,
            ik_chains.ROOT2D_ANCHOR,
        }
        baked_anchor_bones = [
            path
            for path in self.results.get("bakedRotationBonesOutsideArdy", [])
            if any(path == anchor for anchor in anchors)
        ]
        self.assertEqual(baked_anchor_bones, [])

    def test_detaching_a_rig_without_a_layer_is_refused(self):
        self.assertIn("carries no IK layer", self.results["detachOnCleanRigRefused"])

    def test_attaching_the_layer_does_not_change_the_scene_hash(self):
        # Measured, not reasoned about: an earlier version of this work claimed
        # the opposite in its commit message. manifest._manifest_bones requires
        # an entity id on the armature AND on each bone, and control bones are
        # created with edit_bones.new() and never stamped, so a project with a
        # layer attached still verifies against its stored revision.
        hash_result = self.results["hash"]
        self.assertTrue(hash_result["sceneHashUnchanged"])
        self.assertEqual(
            hash_result["trackedBonesBefore"], hash_result["trackedBonesAfterAttach"]
        )
        # Not vacuous: the bones really are in the scene, just not tracked.
        self.assertEqual(hash_result["controlBonesInScene"], 10)
        self.assertEqual(hash_result["controlBonesTracked"], 0)
        self.assertGreater(hash_result["trackedBonesBefore"], 0)

    def test_detaching_restores_the_bone_list_exactly(self):
        # The layer is temporary, so it must leave the armature as it found it -
        # every bone name and every rest matrix, by either detach route.
        self.assertEqual(
            self.results["boneCountWhileAttached"],
            self.results["boneCountAfterDetach"] + 10,
        )
        self.assertTrue(self.results["boneSignatureRestoredAfterKeep"])
        self.assertTrue(self.results["boneSignatureRestoredAfterDiscard"])

    def test_discarding_restores_the_original_animation_exactly(self):
        # Not "close to": the FK curves were never touched, so every effector
        # must land on its recorded position bit for bit.
        for effector, deviation in self.results["fidelityAfterDiscard"].items():
            self.assertEqual(deviation, 0.0, effector)
        self.assertEqual(self.results["controlBonesAfterDiscard"], [])

    def test_a_rig_that_is_not_a_mixamo_skeleton_is_refused(self):
        self.assertIn("mixamorig:", self.results["nonMixamoRefused"])


if __name__ == "__main__":
    unittest.main()
