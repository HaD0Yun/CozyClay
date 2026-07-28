"""Neither CCLAY panel may raise inside draw(), in any reachable state.

A Blender panel that raises during draw does not fail loudly -- it disappears
from the sidebar and prints a traceback on every redraw, which the animator
reads as the add-on being gone. Both panels now call into constraint_capture
on every redraw (pending record, clip metadata, marker curves), so each of
those reads is a route to a vanished sidebar.

The fixture drives the real draw methods in headless Blender against a
recording layout and reports what each one drew, or the exception that stopped
it.
"""

import json
import shutil
import subprocess
import unittest
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
BLENDER = Path(shutil.which("blender") or "/opt/homebrew/bin/blender")
SCRIPT = REPOSITORY_ROOT / "blender-addon/tests/fixtures/ik_panel_draw_fixture.py"

# Every state the fixture draws, both panels included. Named here so a state
# added to the fixture without an assertion is caught by the completeness test
# rather than silently going unchecked.
# Values the fixture reports that are NOT drawn panels. They are named
# separately because the sweeps below index every DRAWN_STATES entry as a draw
# result, and a bare string has no "error" to check.
PLAIN_FACTS = ("ghostKind", "ghostFrame")

DRAWN_STATES = (
    "emptyIk",
    "emptyArdy",
    "conflictedIk",
    "conflictedArdy",
    "conflictedActiveIk",
    "conflictedActiveArdy",
    "meshIk",
    "meshArdy",
    "attachedIk",
    "attachedArdy",
    "offClipArdy",
    "noGhostsArdy",
    "ghostShownArdy",
    "lapsedArdy",
    "unlapsedArdy",
    "corruptPendingArdy",
    "pendingArdy",
    "noClipMetadataArdy",
    "zeroFrameArdy",
    "keysHiddenIk",
    "keysShownIk",
    "autoKeyOffIk",
    "autoKeyOnIk",
)


@unittest.skipUnless(BLENDER.is_file(), "Blender is unavailable")
class IkPanelDrawTests(unittest.TestCase):
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
                f"headless Blender failed\nstdout:\n{completed.stdout}\n"
                f"stderr:\n{completed.stderr}"
            )
        lines = [
            line
            for line in completed.stdout.splitlines()
            if line.startswith("CCLAY_IK_PANEL_DRAW=")
        ]
        if len(lines) != 1:
            raise AssertionError(f"missing panel-draw report\n{completed.stdout}")
        cls.report = json.loads(lines[0].split("=", 1)[1])

    def test_every_state_the_fixture_drives_is_asserted_here(self):
        # The fixture is the only place new states get added. If one lands
        # without a name in DRAWN_STATES, the no-raise sweep below silently
        # stops covering it.
        self.assertEqual(sorted(self.report), sorted(DRAWN_STATES + PLAIN_FACTS))

    def test_no_state_raises_inside_draw(self):
        for state in DRAWN_STATES:
            with self.subTest(state=state):
                self.assertIsNone(
                    self.report[state]["error"],
                    f"{state} raised inside draw(); the panel would vanish",
                )

    def test_no_state_draws_an_empty_panel(self):
        # A panel that draws nothing at all is indistinguishable from one that
        # failed to register. Every state must say something.
        for state in DRAWN_STATES:
            with self.subTest(state=state):
                drawn = self.report[state]
                self.assertTrue(
                    drawn["labels"] or drawn["operators"],
                    f"{state} drew nothing",
                )

    def test_an_unresolvable_selection_says_what_to_click(self):
        for state in ("emptyIk", "emptyArdy"):
            with self.subTest(state=state):
                self.assertIn(
                    "Select the character", self.report[state]["labels"][0]
                )

    def test_a_conflicted_mesh_names_both_rigs_instead_of_guessing(self):
        # The refusal is only useful if it says which two rigs disagree; the
        # animator has to know which one to select instead.
        for state in ("conflictedActiveIk", "conflictedActiveArdy"):
            with self.subTest(state=state):
                label = self.report[state]["labels"][0]
                self.assertIn("parented to OtherRig", label)
                self.assertIn("skinned to Armature", label)
        # And it must refuse rather than offer an action on a guessed rig.
        self.assertEqual(self.report["conflictedActiveIk"]["operators"], [])

    def test_the_panel_answers_for_the_character_through_its_mesh(self):
        # The headline fix, seen from the panel: with a child mesh active the
        # IK panel names the armature and offers Attach, instead of refusing.
        self.assertEqual(self.report["meshIk"]["labels"][0], "Armature")
        self.assertIn("cclay.attach_ik_rig", self.report["meshIk"]["operators"])

    def test_the_attached_panel_offers_a_button_per_control_not_per_chain(self):
        # Four chains, and each has two things an animator grabs: the handle
        # that places the limb and the pole that sets which way it bends. Both
        # are buttons now, which is the row that replaces hunting for
        # CCLAY-IK-TGT-* and CCLAY-IK-POLE-* in the outliner.
        operators = self.report["attachedIk"]["operators"]
        self.assertEqual(operators.count("cclay.select_ik_handle"), 8)
        self.assertIn("cclay.detach_ik_rig", operators)
        self.assertIn("cclay.discard_ik_rig", operators)

    def test_the_constraint_panel_states_the_clip_range(self):
        # The clip is 3 frames inside a 40-frame scene. Without this line the
        # animator has no way to know which frames can carry a constraint.
        self.assertIn("Clip: frames 1-3", self.report["attachedArdy"]["labels"])

    def test_an_off_clip_frame_is_called_out_before_marking(self):
        labels = self.report["offClipArdy"]["labels"]
        self.assertIn("Frame 30 is outside the clip - nothing to mark", labels)
        # The rows still draw: clearing an existing mark stays reachable off
        # the clip, so the panel must not collapse.
        self.assertIn("RightHand", labels)

    def test_a_zero_frame_clip_does_not_print_an_inverted_range(self):
        # "frames 1-0" reads as a broken panel rather than a broken clip.
        labels = self.report["zeroFrameArdy"]["labels"]
        self.assertIn("Clip: no frames recorded", labels)
        self.assertNotIn("Clip: frames 1-0", labels)

    def test_a_corrupt_pending_record_reports_instead_of_vanishing(self):
        # read_pending_request raises for an unparseable record. The panel has
        # to render that and carry on drawing the rest.
        drawn = self.report["corruptPendingArdy"]
        self.assertIn(
            "the pending regeneration record on this object is unreadable",
            drawn["labels"],
        )
        self.assertIn("cclay.mark_constraint", drawn["operators"])

    def test_a_pending_request_collapses_to_the_recovery_button(self):
        # While a request is out the rig has no handles, so the only useful
        # action is the one that puts them back.
        drawn = self.report["pendingArdy"]
        self.assertEqual(drawn["operators"], ["cclay.apply_regeneration_outcome"])

    def test_a_clip_without_ardy_metadata_says_so(self):
        labels = self.report["noClipMetadataArdy"]["labels"]
        self.assertTrue(
            any("was not applied by apply_motion" in label for label in labels),
            labels,
        )

    def test_the_hidden_keys_row_appears_only_while_keys_are_hidden(self):
        # An empty timeline is the symptom the animator actually sees, so the
        # row has to name that cause while it is true -- and stop taking up
        # panel space the moment it is not.
        hidden = self.report["keysHiddenIk"]
        self.assertIn("cclay.show_character_keys", hidden["operators"])
        self.assertTrue(
            any("Timeline hides" in label for label in hidden["labels"]),
            hidden["labels"],
        )
        shown = self.report["keysShownIk"]
        self.assertNotIn("cclay.show_character_keys", shown["operators"])
        self.assertFalse(
            [label for label in shown["labels"] if "Timeline hides" in label],
            shown["labels"],
        )

    def test_clearing_the_filter_costs_the_panel_nothing_else(self):
        # The row is additive: hiding or showing keys must not change which IK
        # controls the panel offers, or the fix would be trading one missing
        # affordance for another.
        hidden = self.report["keysHiddenIk"]["operators"]
        shown = self.report["keysShownIk"]["operators"]
        self.assertEqual(
            [op for op in hidden if op != "cclay.show_character_keys"], shown
        )

    def test_the_auto_key_row_appears_only_while_a_drag_would_be_lost(self):
        # A warning that is always on screen is one the animator stops reading.
        # With Auto Keying on the drag is kept, so the warning would be a lie.
        off = self.report["autoKeyOffIk"]
        self.assertIn("cclay.enable_auto_key", off["operators"])
        self.assertTrue(
            any("Auto Keying is off" in label for label in off["labels"]),
            off["labels"],
        )
        on = self.report["autoKeyOnIk"]
        self.assertNotIn("cclay.enable_auto_key", on["operators"])
        self.assertFalse(
            [label for label in on["labels"] if "Auto Keying is off" in label],
            on["labels"],
        )

    def test_every_chain_offers_both_its_handle_and_its_pole(self):
        # The pole used to be a sentence naming a bone to go find in the
        # outliner, which is exactly the hunt the handle buttons abolish. Both
        # controls now reach the same operator, so the count is two per chain.
        drawn = self.report["autoKeyOnIk"]
        selects = [op for op in drawn["operators"] if op == "cclay.select_ik_handle"]
        self.assertEqual(len(selects), 8)

    def test_the_panel_no_longer_recites_a_procedure(self):
        # The behaviour is correct now, so the prose that stood in for it is
        # gone. A panel that explains a workaround is a panel with a bug in it.
        labels = self.report["autoKeyOnIk"]["labels"]
        for stale in ("Mark keys the handle", "CCLAY-IK-POLE", "the move is lost"):
            self.assertFalse(
                [label for label in labels if stale in label], (stale, labels)
            )


    def test_the_ardy_panel_names_the_dope_sheet_as_the_place_to_work(self):
        # The lanes made the Dope Sheet the primary surface: select a lane and
        # Blender's own I places a mark, X removes one, G moves one. A panel
        # that still reads as the only way in would send an animator back to
        # clicking one diamond per constraint per frame, which is the thing
        # this whole change replaced.
        drawn = self.report["attachedArdy"]
        self.assertIn("cclay.show_constraint_lanes", drawn["operators"])
        self.assertIn("cclay.hide_constraint_lanes", drawn["operators"])
        self.assertTrue(
            any("X removes a mark" in label for label in drawn["labels"]),
            f"the panel never names the keys: {drawn['labels']}",
        )
        # And it must not sell I as the single-lane gesture. Measured:
        # keyframe_insert defaults to ALL channels, Show filters to exactly the
        # six lanes, so one I marks all six. The panel used to say "click a
        # lane, then I / X / G", which reads as one lane and is not.
        self.assertTrue(
            any("every lane shown" in label for label in drawn["labels"]),
            drawn["labels"],
        )
        self.assertTrue(
            any("Only Selected Channels" in label for label in drawn["labels"]),
            drawn["labels"],
        )


    def test_a_recorded_lapse_offers_the_way_out_and_then_stops(self):
        # Regeneration refuses while a lapse stands, so the panel has to say so
        # and has to carry the acknowledgement -- a refusal with no visible
        # remedy reads as the add-on being broken. The row is conditional, so
        # it is also the one that would ship with a draw exception nobody hit;
        # an exception here takes the whole sidebar, not just this row.
        lapsed = self.report["lapsedArdy"]
        self.assertIn("cclay.marks_checked", lapsed["operators"])
        self.assertTrue(
            any("Auto Keying was off" in label for label in lapsed["labels"]),
            lapsed["labels"],
        )
        # And it goes away once acknowledged: a warning that never clears is a
        # warning the animator learns to ignore.
        unlapsed = self.report["unlapsedArdy"]
        self.assertNotIn("cclay.marks_checked", unlapsed["operators"])
        self.assertFalse(
            [label for label in unlapsed["labels"] if "Auto Keying was off" in label],
            unlapsed["labels"],
        )


    def test_the_panel_offers_a_marked_pose_and_then_names_it(self):
        # The ghost is the one thing here Blender cannot do at all -- armature
        # ghosting was removed in 2.8 and armatures have no onion skinning --
        # so it has to be offered, not described. Before any exists the panel
        # offers to stand them up; it must not offer commit or dismiss, which
        # would act on nothing.
        empty = self.report["noGhostsArdy"]["operators"]
        self.assertIn("cclay.show_constraint_ghosts", empty)
        self.assertNotIn("cclay.commit_constraint_ghost", empty)
        self.assertNotIn("cclay.dismiss_constraint_ghosts", empty)

        # Once one exists the panel names WHICH frame it is. Ghosts look
        # exactly like the rig -- same armature data -- so without the label
        # there is nothing on screen saying which pose is being edited.
        shown = self.report["ghostShownArdy"]
        self.assertIn("cclay.commit_constraint_ghost", shown["operators"])
        # And each listed pose is reachable, not just described. Clicking a
        # ghost in the viewport lands in Object Mode where nothing is
        # draggable, so the list has to be the way in.
        self.assertIn("cclay.edit_constraint_ghost", shown["operators"])
        self.assertIn("cclay.dismiss_constraint_ghosts", shown["operators"])
        self.assertNotIn("cclay.show_constraint_ghosts", shown["operators"])
        expected = f"{self.report['ghostKind']} @ {self.report['ghostFrame']}"
        self.assertTrue(
            any(expected in label for label in shown["labels"]),
            (expected, shown["labels"]),
        )


if __name__ == "__main__":
    unittest.main()
