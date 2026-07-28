"""The ARDY constraint timeline is Blender's own Dope Sheet channels.

The widget ARDY draws is one named lane per constraint kind with a dot on every
constrained frame. The add-on already writes those dots as real keyframes, so
the lanes are made by naming and ordering channel groups rather than by drawing
anything. An earlier revision did draw it, with a GPU overlay carrying its own
ruler, playhead and hit-testing; two of those were visibly wrong and all of
them were worse copies of what the editor does natively.

Two stages, because the two halves need opposite environments. Building an IK
rig drives object.mode_set, whose poll reads a window's context, so it must
happen in --background; measuring which editors the lanes appear in, and
whether Blender's own delete removes a dot, needs a real window. The first
stage saves the rig it built and the second opens it.
"""

import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
BLENDER = Path(shutil.which("blender") or "/opt/homebrew/bin/blender")
FIXTURES = REPOSITORY_ROOT / "blender-addon/tests/fixtures"
BACKGROUND_SCRIPT = FIXTURES / "constraint_lanes_fixture.py"
WINDOW_SCRIPT = FIXTURES / "constraint_lanes_window_fixture.py"


def _parse(completed, marker):
    for line in completed.stdout.splitlines():
        if line.startswith(marker):
            return json.loads(line[len(marker) :])
    raise AssertionError(
        f"{marker} missing.\nstdout:\n{completed.stdout}\nstderr:\n{completed.stderr}"
    )


@unittest.skipUnless(BLENDER.is_file(), "Blender is unavailable")
class ConstraintLaneTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._temporary = tempfile.TemporaryDirectory()
        prepared = Path(cls._temporary.name) / "lanes.blend"
        background = subprocess.run(
            [
                str(BLENDER),
                "--background",
                "--factory-startup",
                "--python",
                str(BACKGROUND_SCRIPT),
                "--",
                str(prepared),
            ],
            cwd=REPOSITORY_ROOT,
            check=False,
            capture_output=True,
            text=True,
            timeout=900,
        )
        cls.report = _parse(background, "CCLAY_CONSTRAINT_LANES=")
        windowed = subprocess.run(
            [
                str(BLENDER),
                str(prepared),
                "--window-geometry",
                "0",
                "0",
                "1200",
                "800",
                "--python",
                str(WINDOW_SCRIPT),
                "--python-expr",
                "import bpy; bpy.ops.wm.quit_blender()",
            ],
            cwd=REPOSITORY_ROOT,
            check=False,
            capture_output=True,
            text=True,
            timeout=900,
        )
        cls.window = _parse(windowed, "CCLAY_CONSTRAINT_LANES_WINDOW=")
        # Kept for the console-noise test below. The window fixture runs the
        # show operator several times, which is exactly when re-grouping an
        # already-grouped curve would report.
        cls.windowed_output = windowed.stdout + windowed.stderr

    @classmethod
    def tearDownClass(cls) -> None:
        cls._temporary.cleanup()

    def test_settling_the_lanes_again_reports_nothing(self):
        # Blender reports "F-Curve already belongs to this group" when a curve
        # is assigned to the group it is already in, and ensure_lanes runs
        # twice per invocation on purpose -- expanding the channels re-opens
        # the groups it just collapsed, so they have to be collapsed again.
        # The guard compares groups by NAME: RNA hands back a fresh wrapper on
        # every access, so an identity check silently does nothing and the
        # animator gets four errors per click with no Python exception to
        # notice.
        self.assertNotIn("already belongs to this group", self.windowed_output)

    def test_all_six_lanes_exist_before_a_single_mark(self):
        # The change this run is for. The Dope Sheet draws a channel for an
        # F-curve whether or not it holds keys, so attach() creates the six
        # empty marker curves and the animator has six rows to click straight
        # away. A lane has to EXIST to be selected, and a selected lane is what
        # makes Blender's own I place a mark -- so the earlier contract, which
        # created a curve only when a mark arrived, meant the first mark of
        # every kind could only ever come from a panel button.
        self.assertEqual(
            self.report["lanesBeforeAnyMark"], self.report["ardyOrder"]
        )
        self.assertEqual(len(self.report["ardyOrder"]), 6)

    def test_attaching_leaves_the_lanes_already_named_and_ordered(self):
        # Grouping is a persistent change to the action, so it belongs to the
        # rig operations -- attach and the backfill operator, both undoable --
        # and NOT to Show, which only filters an editor and is not on the undo
        # stack. Measured before this fixture calls ensure_lanes itself, or it
        # would prove nothing about attach.
        self.assertEqual(
            self.report["groupsAfterAttachAlone"], self.report["ardyOrder"]
        )

    def test_creating_the_lanes_invents_no_constraints(self):
        # An empty lane must be an empty lane. A keyframe placed here would be
        # a constraint nobody asked for, and regeneration would honour it.
        self.assertEqual(
            self.report["markedBeforeAnyMark"],
            {kind: [] for kind in self.report["createdByAttach"]},
        )

    def test_ensuring_the_lanes_again_creates_nothing(self):
        # Idempotent, because attach is not the only caller and a second pass
        # must not duplicate channels or disturb existing marks.
        self.assertIsNone(self.report["secondEnsureRaised"])
        self.assertEqual(self.report["secondEnsureCreated"], [])
        self.assertEqual(
            self.report["lanesAfterSecondEnsure"], self.report["lanesBeforeAnyMark"]
        )

    def test_marking_changes_the_dots_not_the_set_of_lanes(self):
        # The lanes are a fixed frame of reference. If they appeared and
        # vanished as marks came and went, the row an animator aimed at would
        # move under them.
        self.assertEqual(
            self.report["lanesAfterMarking"], self.report["lanesBeforeAnyMark"]
        )
        marked = self.report["markedAfterMarking"]
        self.assertEqual(sorted(k for k, v in marked.items() if v), ["FullBody", "LeftHand", "RightFoot", "Root2D"])
        for kind in self.report["unmarkedKinds"]:
            self.assertEqual(marked[kind], [])

    def test_lanes_are_ordered_as_ardy_orders_them_not_as_marks_arrived(self):
        # Fact 2, and the reason ensure_lanes creates groups in TRACKS order:
        # Blender draws channel groups in creation order, so grouping as marks
        # arrive would give a different lane order in every scene. The fixture
        # marks them deliberately scrambled.
        self.assertEqual(
            self.report["markedInThisOrder"],
            ["RightFoot", "FullBody", "LeftHand", "Root2D"],
        )
        self.assertEqual(self.report["shownLanes"], self.report["ardyOrder"])

    def test_the_groups_in_the_action_match_the_lanes_reported(self):
        # A lane the caller is told about but that is not in the action would
        # be a label with nothing behind it.
        self.assertEqual(
            self.report["laneGroupsInAction"], self.report["shownLanes"]
        )

    def test_each_lane_is_one_collapsed_row(self):
        # Fact 3. Expanded, a group draws a header plus a child channel: two
        # rows per kind, which is not what ARDY shows.
        self.assertTrue(self.report["collapsed"])
        for label, expanded in self.report["collapsed"].items():
            self.assertFalse(expanded, f"{label} would draw two rows")

    def test_an_editor_that_cannot_show_channels_is_left_alone(self):
        # Fact 5. A DOPESHEET_EDITOR in TIMELINE mode draws no channel list, so
        # the lanes are invisible there and Blender's delete cancels rather
        # than removing a mark. Naming the lanes still succeeds -- the naming
        # is on the rig, not on the editor -- but no filter is written.
        self.assertEqual(self.window["timelineModeStatus"], ["FINISHED"])
        self.assertEqual(self.window["timelineModeFilter"], "")

    def test_a_dope_sheet_is_filtered_down_to_the_lanes(self):
        # Fact 6.
        self.assertEqual(self.window["dopesheetModeStatus"], ["FINISHED"])
        self.assertEqual(
            self.window["filterWhileShowing"], self.window["expectedFilter"]
        )
        # Only Show Selected would hide the lanes again the moment the animator
        # selects a single bone.
        self.assertFalse(self.window["onlySelectedWhileShowing"])

    def test_the_animators_own_channel_search_survives_the_round_trip(self):
        # Fact 7. The filter is the animator's, borrowed and given back. The
        # fixture runs the show operator twice before hiding, because a second
        # run that re-remembers would hand back the add-on's own filter.
        self.assertEqual(
            self.window["filterBefore"], self.window["searchThatMustComeBack"]
        )
        self.assertEqual(self.window["hideStatus"], ["FINISHED"])
        self.assertEqual(
            self.window["filterAfterHide"], self.window["searchThatMustComeBack"]
        )

    def test_blenders_own_delete_removes_a_dot(self):
        # Fact 8, and the claim the whole native design rests on: the dots are
        # real keyframes, so X is a working removal path and the add-on does
        # not need to implement one.
        self.assertEqual(self.window["beforeDelete"]["markerKeys"], [2])
        self.assertEqual(self.window["blenderDeleteStatus"], ["FINISHED"])
        self.assertEqual(self.window["afterBlenderDelete"]["markerKeys"], [])

    def test_blenders_delete_and_the_clear_operator_agree_exactly(self):
        # Fact 8, the other half. Two removal paths that disagreed would make
        # the rig's state depend on which one the animator happened to use.
        self.assertEqual(
            self.window["beforeDelete"], self.window["beforeClearOperator"]
        )
        self.assertEqual(
            self.window["afterBlenderDelete"], self.window["afterClearOperator"]
        )

    def test_blenders_own_I_places_a_mark_on_an_empty_lane(self):
        # The other half of the native loop, and the payoff of the six-lane
        # change. The Dope Sheet binds I to action.keyframe_insert, which keys
        # the selected channels from their current value -- and a marker curve
        # IS a channel. Run on a lane with NO keys, because that is the case
        # this change exists for: before it, a kind with no marks had no
        # channel, so there was nothing to select and nothing for I to key.
        self.assertTrue(self.window["emptyLaneHasChannel"])
        self.assertEqual(self.window["emptyLaneFramesBefore"], [])
        self.assertEqual(self.window["insertStatus"], ["FINISHED"])
        self.assertEqual(self.window["emptyLaneFramesAfterInsert"], [3])

    def test_clearing_a_lane_that_holds_nothing_is_a_no_op(self):
        # Blender raises TypeError, not RuntimeError, when the property carries
        # no animation at all, and clear_constraint only caught RuntimeError --
        # so it crashed on an empty lane. Harmless while a kind with no marks
        # had no curve; a real defect the moment every kind always has one.
        self.assertIsNone(self.window["clearEmptyLaneRaised"])
        self.assertEqual(self.window["emptyLaneFramesAfterEmptyClear"], [])
        # And on a rig that has no marker property at all -- the shape of
        # every rig attached before lanes existed, which is sitting in saved
        # .blend files right now. That is the TypeError case.
        self.assertFalse(self.window["removedChannelStillPresent"])
        self.assertFalse(self.window["removedPropertyStillPresent"])
        self.assertIsNone(self.window["clearRemovedChannelRaised"])

    def test_blenders_I_and_the_mark_operator_produce_the_same_mark(self):
        # Two creation paths that disagreed would make the rig's state depend
        # on which one the animator happened to use, exactly as for the two
        # removal paths above.
        self.assertEqual(self.window["emptyLaneFramesAfterClear"], [])
        self.assertEqual(
            self.window["emptyLaneFramesAfterMarkOperator"],
            self.window["emptyLaneFramesAfterInsert"],
        )

    def test_neither_removal_path_touches_the_ik_handles_animation(self):
        # The IK handle's location curve is keyed on every clip frame. A hole
        # punched in it by either path would break the rig, and would show up
        # as a changed key count or a changed value at the frame.
        before = self.window["beforeDelete"]
        for after in (
            self.window["afterBlenderDelete"],
            self.window["afterClearOperator"],
        ):
            self.assertEqual(after["locationKeyCount"], before["locationKeyCount"])
            self.assertEqual(after["locationAtFrame"], before["locationAtFrame"])


    def test_hiding_without_showing_keeps_the_animators_own_search(self):
        # Red-team finding. Hide blanked filter_text unconditionally, so
        # pressing it without ever having shown the lanes destroyed whatever
        # the animator was searching for. The operator borrows a filter; it has
        # no business deleting one it never took.
        self.assertEqual(self.window["hideWithoutShowStatus"], ["FINISHED"])
        self.assertEqual(
            self.window["filterAfterBareHide"], self.window["searchThatMustSurvive"]
        )
        # Non-empty, or the assertion above would hold trivially. Blender
        # truncates filter_text, which is why the fixture reads back what was
        # stored instead of comparing against the literal it wrote.
        self.assertTrue(self.window["searchThatMustSurvive"])
        self.assertTrue(self.window["searchWasTruncatedByBlender"])

    def test_hiding_still_clears_a_filter_that_is_unmistakably_ours(self):
        # The other side of that rule: a memo lost to a reload or a closed
        # session must not strand the add-on's own filter forever.
        self.assertEqual(self.window["filterAfterHidingOurOwn"], "")

    def test_a_rig_attached_before_lanes_existed_gets_them_back(self):
        # attach() refuses an armature that already carries an IK layer, so
        # without a backfill the animator would have to destroy and rebuild the
        # rig to reach the other five lanes. Show does it, idempotently.
        self.assertEqual(self.window["legacyLanesBefore"], ["Full-Body"])
        # Show alone does NOT migrate. It only filters the editor; mixing a
        # data change into a view toggle meant one Ctrl+Z could remove the
        # lanes and leave the Dope Sheet filtered to nothing.
        self.assertEqual(self.window["legacyLanesAfterShowOnly"], ["Full-Body"])
        self.assertEqual(self.window["legacyShowStatus"], ["FINISHED"])
        self.assertEqual(len(self.window["legacyLanesAfter"]), 6)
        # And it is idempotent, so the panel button is safe to press twice.
        self.assertEqual(self.window["legacyBackfillAgain"], ["FINISHED"])

    def test_backfilling_a_legacy_rig_preserves_the_marks_it_had(self):
        # A migration that dropped existing constraints would be worse than no
        # migration at all.
        self.assertEqual(
            self.window["legacySurvivorAfter"], self.window["legacySurvivorBefore"]
        )
        self.assertTrue(self.window["legacySurvivorBefore"])


    def test_a_search_typed_after_showing_belongs_to_the_animator(self):
        # Red-team round 2. Show borrows the filter; the animator then typed
        # something new over it, and Hide restored the stale memo, deleting
        # what they had just written. A memo is only worth restoring while the
        # filter is still the one the operator installed.
        self.assertEqual(self.window["typedAfterShow"], "typed after showing")
        self.assertEqual(
            self.window["filterAfterHidingTypedText"], self.window["typedAfterShow"]
        )

    def test_a_reload_leaves_no_stranded_filter(self):
        # The memo is memory-only and keyed by area addresses, so reopening the
        # file loses it and the borrowed search is NOT recovered. That is a
        # deliberate trade: the alternative was mirroring the memo onto the
        # Screen, and a Screen is a datablock saved in the .blend, so a view
        # toggle with no undo would have been performing persistent data
        # mutation -- the same mixing that had to be undone when Show was
        # creating F-curves. What must still hold is that nothing is stranded:
        # Hide recognises the add-on's own filter and clears it, leaving the
        # animator an ordinary editor rather than one filtered to six channels
        # by an add-on they may not remember enabling. The fixture performs a
        # real save and open_mainfile, not a simulation.
        self.assertEqual(self.window["reloadFilterAfterReopen"], "cclay_constraint")
        self.assertEqual(self.window["reloadStatus"], ["FINISHED"])
        self.assertEqual(self.window["reloadFilterAfterHide"], "")


    def test_a_lane_failure_leaves_a_usable_rig_and_a_reason(self):
        # The rig is fully attached by the time lanes are built, so a failure
        # there must degrade rather than raise: an exception here would strand
        # a mutated armature behind a cancelled attach. Injected by making
        # ensure_lanes raise, which is exactly the failure the preflight cannot
        # rule out. This contract existed once and was silently lost to a bad
        # restore because nothing exercised it.
        self.assertIsNone(self.report["degradedRaised"])
        self.assertEqual(self.report["degradedError"], "injected lane failure")
        self.assertTrue(self.report["degradedRigStillAttached"])


    def test_show_borrows_only_show_selected_and_hide_gives_it_back(self):
        # Only Show Selected is on by default, and no anchor bone is selected
        # right after attach, so with it on the animator gets a filtered but
        # EMPTY editor -- measured in a real window: only the Summary row drew.
        # Show must turn it off, and because it is the animator's setting for
        # every other channel they will ever look at here, Hide must return it.
        self.assertTrue(self.window["onlySelectedBefore"])
        self.assertFalse(self.window["onlySelectedWhileShowing"])
        self.assertTrue(self.window["onlySelectedAfterHide"])


    def test_blenders_I_marks_every_lane_that_is_showing(self):
        # action.keyframe_insert defaults to ALL, meaning every channel the
        # editor is currently showing -- and Show filters to exactly the six
        # lanes, so one press marks all six. This is Blender behaving as
        # documented, not a defect, but it is the opposite of what "click a
        # lane, press I" implies, so it is written down rather than guessed at.
        before = self.window["marksBeforeNaiveI"]
        after = self.window["marksAfterNaiveI"]
        self.assertEqual(self.window["naiveInsertStatus"], ["FINISHED"])
        self.assertEqual(len(before), 6)
        for path, count in before.items():
            self.assertEqual(after[path], count + 1, path)

    def test_choosing_one_lane_and_asking_for_selected_marks_only_it(self):
        # The gesture that means ONE constraint: choose the lane, then ask for
        # selected channels only. A lane IS a collapsed channel group, so the
        # row a click lands on is the group row and selecting the curve alone
        # is a state no click can produce -- which is why the fixture selects
        # the group here.
        #
        # Deliberately measured with the selection set explicitly rather than
        # inherited: what this asserts is that the GESTURE is exact. That the
        # rig also STARTS with nothing chosen is a separate guarantee, and
        # test_a_fresh_rig_hands_over_no_lane_already_chosen is what holds it.
        # Before both fixes every group was born selected and even this SEL
        # variant marked all six.
        before = self.window["marksBeforeSelI"]
        after = self.window["marksAfterSelI"]
        self.assertEqual(self.window["selInsertStatus"], ["FINISHED"])
        moved = [path for path in before if after[path] != before[path]]
        self.assertEqual(len(moved), 1, moved)
        self.assertIn("LeftFoot", moved[0])
        self.assertEqual(after[moved[0]], before[moved[0]] + 1)

    def test_a_fresh_rig_hands_over_no_lane_already_chosen(self):
        # Nothing is selected until the animator selects it. Otherwise their
        # first keystroke acts on a choice they never made.
        self.assertEqual(self.window["selectedRightAfterAttach"], [])
        self.assertFalse(
            [row for row in self.window["groupSelection"] if row[2]],
            self.window["groupSelection"],
        )


    def test_up_and_down_walk_the_marks_and_nothing_else(self):
        # The ARDY demo draws a posable skeleton at every constrained frame and
        # lets you drag it from wherever you are standing. Blender has no
        # equivalent: armature ghosting was removed in 2.8 and armatures have
        # no onion skinning -- measured, both property sets come back empty.
        #
        # The native substitute is to GO to the frame, and Blender already has
        # the gesture: screen.keyframe_jump walks the keys the editor is
        # showing, so with the lanes filter up it walks marks and skips the
        # thousands of pose keys underneath.
        jumped = self.window["framesJumpedTo"]
        marks = self.window["marksThatExist"]
        self.assertTrue(marks, "the fixture left no marks to walk")
        self.assertTrue(jumped, "keyframe_jump never moved")
        for frame in jumped:
            self.assertIn(frame, marks)
        # Starting at 1, it must reach every mark after 1 and stop there.
        self.assertEqual(jumped, [f for f in marks if f > 1])


if __name__ == "__main__":
    unittest.main()
