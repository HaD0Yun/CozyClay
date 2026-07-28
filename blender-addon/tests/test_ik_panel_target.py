"""The IK/constraint operators act on the character, not the active object.

A character is an armature plus the meshes skinned to it, and a viewport click
selects a mesh. The fix under test routes every IK/ARDY-constraint operator
through ``character_target.resolve_character`` on
``context.active_object`` instead of reading the active object directly, so the
operators work when the animator has a mesh selected and report -- not crash --
when nothing resolves.

Every fact here is measured against real Blender 5.2 driving the real operators
through ``bpy.ops`` on a Y-Bot rig baked from the recorded ARDY payload. The
fixture sets a child MESH active (the selection a viewport click produces) and
records what the operators did; these methods assert the observable results.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import unittest
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
BLENDER = Path(shutil.which("blender") or "/opt/homebrew/bin/blender")
SCRIPT = REPOSITORY_ROOT / "blender-addon/tests/fixtures/ik_panel_target_fixture.py"


@unittest.skipUnless(BLENDER.is_file(), "Blender is unavailable")
class IkPanelTargetTests(unittest.TestCase):
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
            line
            for line in completed.stdout.splitlines()
            if line.startswith("CCLAY_IK_PANEL_TARGET=")
        ]
        if len(lines) != 1:
            raise AssertionError(f"missing panel-target report\n{completed.stdout}")
        cls.results = json.loads(lines[0].split("=", 1)[1])

    def test_the_active_object_was_a_mesh_parented_to_the_armature(self):
        # The precondition for every fact below: the fixture really ran from a
        # child mesh, not the armature. Without this the attach claim is
        # vacuous -- attach always worked when the armature itself was active.
        self.assertEqual(self.results["meshType"], "MESH")
        self.assertTrue(self.results["meshParentIsArmature"])
        # The mesh's name must differ from the armature's, or the "ran from a
        # mesh" claim is indistinguishable from "ran from the armature".
        self.assertNotEqual(self.results["meshName"], self.results["armatureName"])

    def test_attach_ik_rig_finishes_with_a_mesh_active(self):
        # The headline fix: with a child MESH as the active object, the operator
        # resolves the armature through it and returns FINISHED.
        self.assertEqual(self.results["attachStatus"], ["FINISHED"])

    def test_the_ik_layer_is_present_after_attaching_from_the_mesh(self):
        self.assertTrue(self.results["hasIkLayerAfterAttach"])

    def test_blender_really_ships_the_timeline_filtering_unselected_keys(self):
        # The precondition the whole timeline fix rests on. Asserted rather than
        # assumed: if a future Blender shipped this filter off, every assertion
        # below would pass without the fix doing anything.
        self.assertGreaterEqual(self.results["timelineEditorCount"], 1)
        self.assertEqual(
            self.results["timelineFilterAtStartup"],
            [True] * self.results["timelineEditorCount"],
        )

    def test_attaching_shows_only_the_six_constraint_lanes(self):
        # The Mixamo FK curves and dense target/pole keys still drive the pose,
        # but they are implementation detail. One setup click promotes the
        # stock Timeline to a Dope Sheet, filters it to cclay_constraint, and
        # disables Only Show Selected so Full-Body, 2D Root and four limbs are
        # the only rows the animator sees.
        filters = self.results["constraintEditorFilterAfterAttach"]
        searches = self.results["constraintEditorSearchAfterAttach"]
        self.assertTrue(filters, "attach left no Dope Sheet showing the lanes")
        self.assertEqual(filters, [False] * len(filters))
        self.assertEqual(
            searches,
            [self.results["expectedConstraintFilter"]] * len(searches),
        )

    def test_blender_really_ships_auto_keying_off(self):
        # The precondition for the scrub test below. If a future Blender shipped
        # Auto Keying on, that test would pass without the add-on doing anything.
        self.assertFalse(self.results["autoKeyBeforeAttach"])

    def test_attaching_turns_on_auto_keying(self):
        # A handle exists to be dragged, and in Blender a dragged bone is only
        # kept when Auto Keying is on.
        self.assertTrue(self.results["autoKeyAfterAttach"])

    def test_a_handle_drag_survives_scrubbing_away_and_back(self):
        # The whole point. The drag goes through transform.translate -- the
        # operator G runs -- then the frame is changed and changed back. Before
        # Auto Keying was turned on, returning to the frame restored the baked
        # pose and the animator's work was gone with no message.
        self.assertNotEqual(self.results["scrubDragApplied"], [0.0, 0.0, 0.0])
        self.assertEqual(
            self.results["scrubHandleAfterReturn"], self.results["scrubDragApplied"]
        )

    def test_the_drag_left_a_keyframe_behind(self):
        # The mechanism behind the assertion above: surviving a scrub without a
        # key would mean the frame simply was not re-evaluated, which would make
        # that test pass for the wrong reason.
        self.assertTrue(self.results["scrubKeyedTheHandle"])

    def test_a_stock_blend_hides_keys_on_workspaces_that_are_not_open(self):
        # The shape of the defect, asserted so it cannot quietly go away. A
        # window shows one screen at a time, but the file carries an animation
        # editor on several workspaces, and Blender ships them all filtered.
        self.assertGreater(self.results["screenCount"], 1)
        self.assertGreater(self.results["offscreenEditorCount"], 0)
        self.assertEqual(
            self.results["offscreenFilterBefore"],
            [True] * self.results["offscreenEditorCount"],
        )

    def test_an_editor_on_an_unopened_workspace_is_cleared_too(self):
        # The bug the user hit: Layout looked fixed, then switching to the
        # Animation tab showed a blank timeline again, because the walk only
        # ever reached the screen the window happened to be showing.
        self.assertEqual(self.results["offscreenSweepStatus"], ["FINISHED"])
        self.assertEqual(
            self.results["offscreenFilterAfter"],
            [False] * self.results["offscreenEditorCount"],
        )
        # Nothing anywhere in the file is left hiding keys.
        self.assertNotIn(True, self.results["everyFilterAfter"])

    def test_show_character_keys_clears_every_editor_not_just_the_timeline(self):
        # One more editor than the file started with, and every one of them
        # filtered. Reaching only for the Timeline, or stopping at the first
        # match, leaves some behind.
        expected = self.results["timelineEditorCount"] + 1
        self.assertEqual(self.results["timelineEditorCountWithSecond"], expected)
        self.assertEqual(self.results["timelineFilterBeforeShow"], [True] * expected)
        self.assertEqual(self.results["showKeysStatus"], ["FINISHED"])
        self.assertEqual(self.results["timelineFilterAfterShow"], [False] * expected)

    def test_show_character_keys_is_idempotent_with_nothing_left_to_clear(self):
        # The panel offers the button only while keys are hidden, so this is a
        # race the animator can lose by clearing the filter by hand first. The
        # operator asks for a state, not for a change, so the state already
        # holding is success -- CANCELLED would tell a caller the keys are
        # still hidden when they are not.
        self.assertEqual(self.results["showKeysAgainStatus"], ["FINISHED"])
        self.assertIsNone(self.results["showKeysAgainException"])
        # And the second call must not undo the work the first one did.
        self.assertEqual(
            self.results["timelineFilterAfterSecondShow"],
            [False] * (self.results["timelineEditorCount"] + 1),
        )

    def test_the_graph_editor_is_swept_too(self):
        # The Graph Editor carries the same filter and is where the curves an
        # IK edit produced get tuned. Matching on editor type instead of on the
        # filter left this one hiding the character's channels, which is the
        # same blank-editor symptom one tab over.
        self.assertTrue(self.results["graphEditorCarriesTheFilter"])
        self.assertTrue(self.results["graphEditorFilterBefore"])
        self.assertEqual(self.results["graphSweepStatus"], ["FINISHED"])
        self.assertFalse(self.results["graphEditorFilterAfter"])

    def test_resolve_character_returns_the_armature_for_the_mesh(self):
        # The resolver must turn the mesh into the armature. This is a direct
        # call to the pure function (not the operator path), so it proves the
        # resolver works on the real imported mesh. The operator-path proof is
        # test_attach_ik_rig_finishes_with_a_mesh_active: that is the single
        # assertion that would fail if _character_armature were reverted to
        # context.active_object, because the operator would get the mesh, fail
        # validation, and return CANCELLED instead of FINISHED.
        self.assertEqual(self.results["resolvedArmatureName"], self.results["armatureName"])

    def test_select_ik_handle_finishes_for_an_existing_handle(self):
        self.assertEqual(self.results["selectRightHandStatus"], ["FINISHED"])

    def test_select_ik_handle_makes_the_armature_the_active_object(self):
        self.assertEqual(self.results["activeObjectAfterSelect"], self.results["armatureName"])

    def test_select_ik_handle_enters_pose_mode(self):
        self.assertEqual(self.results["armatureModeAfterSelect"], "POSE")

    def test_select_ik_handle_leaves_exactly_one_pose_bone_selected(self):
        # Seeded first with a different handle (LeftFoot), so reaching exactly
        # one proves the prior selection was deselected rather than starting
        # from an empty selection.
        self.assertEqual(self.results["seedActiveBeforeRightHand"], "CCLAY-IK-TGT-LeftFoot")
        selected = self.results["selectedPoseBonesAfterSelect"]
        self.assertEqual(len(selected), 1)
        self.assertEqual(selected[0], "CCLAY-IK-TGT-RightHand")

    def test_select_ik_handle_sets_the_data_active_bone_to_the_handle(self):
        self.assertEqual(self.results["activeBoneAfterSelect"], "CCLAY-IK-TGT-RightHand")

    def test_select_ik_handle_refuses_a_missing_bone(self):
        # CCLAY-IK-TGT-Nose is not a chain effector, so it does not exist after
        # attach. The operator must return CANCELLED, not raise.
        self.assertEqual(self.results["selectMissingStatus"], ["CANCELLED"])
        self.assertIsNone(self.results["selectMissingException"])

    def test_select_ik_handle_leaves_the_prior_active_bone_unchanged_on_refusal(self):
        # The refusal must not have side effects: the bone that was active
        # before the refused call stays active.
        self.assertEqual(self.results["activeBoneAfterMissing"], "CCLAY-IK-TGT-RightHand")

    def test_detach_ik_rig_finishes_with_a_mesh_active(self):
        self.assertEqual(self.results["detachStatus"], ["FINISHED"])

    def test_the_ik_layer_is_gone_after_detaching_from_the_mesh(self):
        self.assertFalse(self.results["hasIkLayerAfterDetach"])

    def test_attach_ik_rig_cancels_when_nothing_resolves(self):
        # A lone unparented EMPTY resolves to no armature. The operator's own
        # report string is not observable from bpy.ops, so the return status is
        # what gets asserted: CANCELLED is the boundary between 'refused with a
        # message' and 'did something'.
        self.assertEqual(self.results["lonelyType"], "EMPTY")
        self.assertIsNone(self.results["lonelyParent"])
        self.assertEqual(self.results["attachLonelyStatus"], ["CANCELLED"])
        self.assertIsNone(self.results["attachLonelyException"])

    def test_a_character_outside_the_view_layer_is_refused_not_crashed(self):
        # Resolving through a mesh is what makes this reachable at all: the
        # armature can sit on an excluded collection while its mesh does not,
        # so an operator can now be aimed at a rig Blender will not let anyone
        # select. select_set RAISES for such an object instead of returning
        # False, so the refusal has to be checked for, not caught by luck.
        self.assertFalse(
            self.results["excludedInViewLayer"],
            "the fixture must really have taken the armature out of the layer",
        )
        self.assertEqual(self.results["excludedSelectStatus"], ["CANCELLED"])
        self.assertIsNone(self.results["excludedSelectException"])
        self.assertEqual(self.results["excludedDetachStatus"], ["CANCELLED"])
        self.assertIsNone(self.results["excludedDetachException"])
        # Refused means nothing happened: the layer the animator built is
        # still there to come back to once the collection is re-enabled.
        self.assertTrue(self.results["excludedIkLayerRemains"])

    def test_the_crash_classifier_tells_a_refusal_from_a_crash(self):
        # Every CANCELLED assertion above rides on the fixture translating the
        # RuntimeError bpy.ops raises for a reported ERROR. That translation is
        # a string heuristic against Blender's wrapper message, so it is
        # calibrated here rather than trusted: two throwaway operators, one
        # that reports and cancels and one that raises a sentinel, must land on
        # opposite sides. If this pair ever agrees, every refusal test in this
        # file has quietly stopped proving anything.
        self.assertEqual(self.results["calibrationCancelStatus"], ["CANCELLED"])
        self.assertIsNone(self.results["calibrationCancelException"])
        self.assertEqual(self.results["calibrationCrashStatus"], ["EXCEPTION"])
        self.assertIn(
            "fixture sentinel crash", self.results["calibrationCrashException"]
        )


if __name__ == "__main__":
    unittest.main()
