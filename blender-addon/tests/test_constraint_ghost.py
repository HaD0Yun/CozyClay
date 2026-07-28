"""An editable ghost of a constrained frame, asserted against real Blender.

The ARDY demo shows the pose of every constrained frame in the viewport and
lets the animator drag it without leaving the frame they are on. Blender offers
nothing equivalent -- armature ghosting went away in 2.8 and armatures have no
onion skinning -- so this is built rather than borrowed, and every guarantee
below is measured inside Blender rather than reasoned about.
"""

import json
import pathlib
import shutil
import subprocess
import unittest

REPOSITORY_ROOT = pathlib.Path(__file__).resolve().parents[2]
BLENDER = pathlib.Path(shutil.which("blender") or "/opt/homebrew/bin/blender")
SCRIPT = REPOSITORY_ROOT / "blender-addon/tests/fixtures/constraint_ghost_fixture.py"


@unittest.skipUnless(BLENDER.is_file(), "Blender is unavailable")
class ConstraintGhostTests(unittest.TestCase):
    report: dict

    @classmethod
    def setUpClass(cls):
        completed = subprocess.run(
            [str(BLENDER), "--background", "--factory-startup", "--python", str(SCRIPT)],
            cwd=REPOSITORY_ROOT,
            capture_output=True,
            text=True,
            timeout=900,
        )
        lines = [
            line
            for line in completed.stdout.splitlines()
            if line.startswith("CCLAY_CONSTRAINT_GHOST=")
        ]
        if len(lines) != 1:
            raise AssertionError(f"missing ghost report\n{completed.stdout}")
        cls.report = json.loads(lines[0].split("=", 1)[1])

    def test_a_ghost_holds_its_own_frame_while_the_rig_holds_another(self):
        # The entire point: two poses on screen at one instant. If the ghost
        # merely matched the live rig it would be a duplicate, not a ghost.
        self.assertEqual(
            self.report["ghostHandle"], self.report["handleExpectedOnGhostFrame"]
        )
        self.assertEqual(
            self.report["liveHandle"], self.report["handleExpectedOnSceneFrame"]
        )
        self.assertNotEqual(self.report["ghostHandle"], self.report["liveHandle"])

    def test_making_a_ghost_leaves_the_playhead_where_the_animator_put_it(self):
        # The pose is read from the F-curves rather than by visiting the frame.
        # Visiting it would yank the animator's playhead and fire every frame
        # handler in the file, to produce a number a curve can simply be asked
        # for.
        self.assertEqual(
            self.report["sceneFrameBefore"], self.report["sceneFrameAfter"]
        )

    def test_a_ghost_borrows_the_rigs_bones_instead_of_copying_them(self):
        # Sharing the armature datablock is what makes a ghost cheap, and --
        # more importantly -- it is why the ghost already has the IK control
        # bones: attach put them on the DATA, which both objects read.
        self.assertTrue(self.report["sharesArmatureData"])

    def test_a_ghost_does_not_follow_the_playhead(self):
        # Deliberately no animation data. A ghost that animated would be a
        # second copy of the rig, and comparing it against the live one at a
        # different frame would be impossible.
        self.assertFalse(self.report["ghostHasAnimationData"])

    def test_auto_keying_cannot_make_a_ghost_follow_the_playhead(self):
        # This workflow requires Auto Keying, so dragging a ghost handle keys
        # the GHOST -- measured: one transform gave it animation data. An
        # animated ghost drifts with the playhead and stops being a view of its
        # own frame, which is the only thing it is for.
        self.assertTrue(self.report["ghostGainedAnimationData"])
        # Undone on frame change, not on a timer. A timer fires in the middle
        # of a modal drag and would clear the action out from under it, and its
        # mutations sit outside any undo step. A frame change is the exact
        # moment an animated ghost would start drifting.
        self.assertFalse(self.report["ghostAnimationDataAfterFrameChange"])
        # And the edit the animator just made must survive being un-animated:
        # clearing animation data leaves the posed values alone, so only the
        # dependence on the playhead goes away.
        self.assertTrue(self.report["ghostPoseSurvivedFrameChange"])
        # Refreshing is the other way back to a still ghost, measured on a
        # ghost dirtied again after the timer had already cleaned up once.
        self.assertTrue(self.report["ghostDirtyAgain"])
        self.assertFalse(self.report["ghostAnimationDataAfterRefresh"])

    def test_asking_twice_refreshes_rather_than_stacks(self):
        self.assertTrue(self.report["secondAskReturnedSameObject"])
        self.assertEqual(self.report["ghostCountAfterSecondAsk"], 1)

    def test_ghosts_never_reach_a_render(self):
        # Scaffolding in a render is the kind of thing nobody checks until it
        # is in a delivered frame.
        self.assertTrue(self.report["collectionHidesRender"])

    def test_the_ghosts_own_ik_drives_its_joints_and_not_the_rigs(self):
        # Constraints live on the Object, so the ghost gets its own IK pointed
        # at itself. Dragging its handle must bend ITS elbow and leave the live
        # rig alone -- otherwise editing a ghost would corrupt the frame the
        # animator is actually looking at.
        self.assertEqual(self.report["ghostIkCount"], 1)
        self.assertTrue(self.report["ghostIkTargetsItself"])
        self.assertEqual(self.report["liveIkStillTargetsLive"], [True])
        self.assertGreater(self.report["ghostJointMovedMm"], 1.0)
        self.assertEqual(self.report["liveJointMovedMm"], 0.0)

    def test_committing_writes_the_ghosts_frame_and_leaves_the_others_alone(self):
        # Committing from frame 1 must write frame 3 and nothing else, and it
        # must not move the playhead to do it.
        self.assertEqual(
            self.report["committedFrame"],
            int(self.report["ghostName"].rsplit("-", 1)[1]),
        )
        self.assertEqual(
            self.report["sceneFrameBeforeCommit"], self.report["sceneFrameAfterCommit"]
        )
        self.assertEqual(
            self.report["liveOtherFrameBeforeCommit"],
            self.report["liveOtherFrameAfterCommit"],
        )
        self.assertNotEqual(
            self.report["liveGhostFrameBeforeCommit"],
            self.report["liveGhostFrameAfterCommit"],
        )
        # And what landed is exactly what the ghost was holding.
        self.assertEqual(
            self.report["liveGhostFrameAfterCommit"],
            self.report["ghostHandleAtCommit"],
        )

    def test_a_ghost_only_ever_stands_for_a_real_mark(self):
        # A ghost at an unmarked frame is an edit the animator believes ARDY
        # will honour, and it will not. Refusing is the only honest answer.
        self.assertIn("carries no RightHand mark", self.report["unmarkedFrameRefused"])

    def test_deleting_a_mark_does_not_strand_its_ghost(self):
        # Blender's own X removes marks and knows nothing about ghosts.
        self.assertEqual(self.report["pruned"], ["CCLAY-GHOST-RightHand-3"])
        self.assertEqual(self.report["ghostsAfterPrune"], [])

    def test_deleting_a_mark_takes_its_pose_off_the_screen(self):
        # Reported from a real session: the mark was removed in the Dope Sheet
        # and the ghost was still standing there. Blender's X reaches none of
        # this add-on's operators, and pruning only ran when Show was pressed,
        # so a pose offering to be committed onto an unconstrained frame stayed
        # up for as long as the animator did not happen to press it.
        self.assertEqual(
            self.report["ghostsBeforeSilentDelete"], ["CCLAY-GHOST-RightHand-3"]
        )
        self.assertEqual(self.report["ghostsAfterSilentDelete"], [])

    def test_the_handler_leaves_poses_whose_mark_is_still_there(self):
        # It runs on every depsgraph update, so "takes down stale ghosts" and
        # "takes down ghosts" are one careless edit apart.
        self.assertEqual(
            self.report["ghostsAfterHandlerWithMarkIntact"],
            ["CCLAY-GHOST-RightHand-3"],
        )

    def test_a_ghost_whose_mark_vanished_refuses_to_write(self):
        # Held across a deletion, committing would push a pose onto a frame
        # that is no longer constrained. It must refuse, and it must refuse
        # BEFORE writing anything.
        self.assertIn("no longer carries", self.report["staleCommitRefused"])
        self.assertTrue(self.report["staleCommitWroteNothing"])

    def test_show_makes_the_ghosts_actually_clickable(self):
        # Blender locks interaction to the object whose mode you are in, and it
        # defaults to ON -- measured. In Pose Mode on the live rig that makes
        # every ghost unclickable, so the feature shipped unusable: the ghosts
        # were on screen and nothing happened when you clicked them.
        self.assertTrue(self.report["modeLockBeforeShow"])
        self.assertFalse(self.report["modeLockWhileShowing"])
        # Not just selectable -- posable, which is the point.
        self.assertEqual(self.report["ghostEnteredPoseMode"], "POSE")
        # Borrowed, not commandeered. It is the animator's setting for every
        # other object in the scene.
        self.assertTrue(self.report["modeLockAfterDismiss"])

    def test_the_operators_stand_ghosts_up_and_take_them_down(self):
        self.assertEqual(self.report["showStatus"], ["FINISHED"])
        self.assertEqual(
            self.report["ghostsAfterShowOperator"], ["CCLAY-GHOST-RightHand-3"]
        )
        self.assertEqual(self.report["dismissStatus"], ["FINISHED"])
        self.assertEqual(self.report["ghostsAfterDismissOperator"], [])

    def test_detaching_the_rig_takes_every_ghost_with_it(self):
        # A ghost shares the armature data detach is about to strip the control
        # bones from, so one left behind would hold IK constraints pointing at
        # bones that no longer exist. Cleanup lives in ik_rig.detach rather
        # than in the operator so a scripted detach cannot skip it.
        self.assertEqual(
            self.report["ghostsBeforeDetach"], ["CCLAY-GHOST-RightHand-3"]
        )
        self.assertEqual(
            self.report["detachRemovedGhosts"], ["CCLAY-GHOST-RightHand-3"]
        )
        self.assertEqual(self.report["ghostsAfterDetach"], [])
        # Nothing left in the file at all, not merely nothing findable.
        self.assertEqual(self.report["ghostObjectsLeftInFile"], [])
        self.assertTrue(self.report["ghostCollectionRemoved"])


    def test_applying_does_not_disturb_the_frame_being_looked_at(self):
        # Keying a remote frame routes the value through the live pose bone,
        # because that is what keyframe_insert reads. Passing frame= only picks
        # where the KEY lands -- the value stays on the bone, jerking the live
        # rig at the frame the animator is actually watching. A test that reads
        # only F-curves cannot see this, which is how it survived the first
        # round.
        self.assertEqual(
            self.report["livePoseBeforeApply"], self.report["livePoseRightAfterApply"]
        )

    def test_renaming_the_rig_does_not_strand_its_ghosts(self):
        # Reproduced by review with the owner stored as a NAME: after a rename
        # ghosts_of returned [], commit failed with "the rig this ghost belongs
        # to is gone", and detach reported removing nothing while leaving
        # twelve ghosts holding IK constraints on bones it had just deleted.
        # Renaming a rig is ordinary, so identity cannot be a label.
        self.assertEqual(
            self.report["ghostsFoundAfterRename"], ["CCLAY-GHOST-RightHand-3"]
        )
        self.assertIsNone(self.report["commitAfterRenameRaised"])

    def test_a_full_copy_of_a_ghost_is_not_a_ghost_of_this_rig(self):
        # Ctrl+D copies the custom properties and gives the copy its OWN
        # armature data. Matching the owner id alone would count it, and then
        # posing or committing it would push a pose derived from a different
        # skeleton onto the live rig. Ownership requires the shared datablock.
        self.assertTrue(self.report["copyIsADifferentObject"])
        self.assertTrue(self.report["copyKeptTheTag"])
        self.assertTrue(self.report["copyHasItsOwnData"])
        self.assertFalse(self.report["copyCountedAsGhost"])

    def test_saving_the_file_does_not_save_the_scaffolding(self):
        # Measured before the fix: saving with a ghost on screen wrote it into
        # the .blend and it was still there on reopen. Ghosts are cheap to
        # stand back up; a document that carries them is not.
        self.assertEqual(self.report["ghostsBeforeSaveHandler"], 1)
        self.assertEqual(self.report["ghostsAfterSaveHandler"], 0)
        self.assertEqual(self.report["ghostObjectsAfterSaveHandler"], [])


    def test_a_linked_duplicate_of_the_rig_does_not_steal_its_ghosts(self):
        # Alt+D copies custom properties AND shares the datablock, so a uuid
        # stamped on the rig made both objects pass the ownership test and the
        # owner resolved to whichever came first. A direct object reference
        # cannot be copied into meaning something else.
        self.assertTrue(self.report["linkedIsADifferentObject"])
        self.assertTrue(self.report["linkedSharesData"])
        self.assertEqual(
            self.report["ghostsOfOriginal"], ["CCLAY-GHOST-RightHand-3"]
        )
        self.assertEqual(self.report["ghostsOfLinkedCopy"], [])

    def test_saving_does_not_throw_away_an_uncommitted_edit(self):
        # Keeping ghosts out of the document by deleting them destroyed
        # whatever the animator had not committed yet -- worse than the leak it
        # fixed, because it loses live work. They are taken out for the write
        # and put back, pose included.
        self.assertEqual(self.report["uncommittedBeforeSave"], [0.0, 0.0, 0.77])
        self.assertEqual(self.report["ghostsDuringSave"], 0)
        self.assertEqual(
            self.report["ghostsRestoredAfterSave"], ["CCLAY-GHOST-RightHand-3"]
        )
        # create_ghost rebuilds from the COMMITTED curves, so this value can
        # only be here because the record carried it.
        self.assertEqual(self.report["uncommittedAfterSave"], [0.0, 0.0, 0.77])

    def test_the_guarantees_survive_opening_another_file(self):
        # A handler registered without bpy.app.handlers.persistent is cleared
        # when a .blend is loaded while the add-on stays enabled, so both ghost
        # guarantees would quietly stop holding after the animator opened a
        # second file.
        self.assertTrue(self.report["saveHandlerIsPersistent"])
        self.assertTrue(self.report["stillHandlerIsPersistent"])
        self.assertTrue(self.report["restoreHandlerIsPersistent"])


    def test_selecting_a_ghost_still_answers_for_the_real_character(self):
        # A ghost IS an armature and deliberately carries no action, so it used
        # to answer for itself as "the character". Every clip question then
        # came back empty and the ARDY panel collapsed to "no clip to
        # regenerate" -- taking Apply Pose To Its Frame with it, at exactly the
        # moment that button is the one you need. Selecting a ghost is not
        # selecting a different character; it is looking at one frame of the
        # same one.
        self.assertIsNone(self.report["ghostResolveReason"])
        self.assertEqual(
            self.report["ghostResolvesToOwner"], self.report["ownerNameAtGrab"]
        )

    def test_grabbing_a_handle_while_posing_a_ghost_grabs_the_ghosts(self):
        # The mapping above must NOT be followed by a grab. A grab is not a
        # clip question: following it would reach past the pose being edited
        # and select the live rig's handle, so the animator drags the wrong
        # skeleton at the wrong frame.
        self.assertEqual(self.report["grabStatus"], ["FINISHED"])
        self.assertTrue(self.report["grabbedTheGhost"])
        self.assertEqual(
            self.report["selectedOnGhost"], ["CCLAY-IK-TGT-RightHand"]
        )
        self.assertEqual(self.report["selectedOnLiveRig"], [])


    def test_one_click_gets_from_a_listed_pose_to_posing_it(self):
        # Clicking a ghost in the viewport leaves the animator in OBJECT mode,
        # where there are no IK handles at all -- measured in a real session:
        # the ghost was selected and active, the mode read Object Mode, and
        # nothing was draggable. Listing the ghosts as plain text and expecting
        # the animator to find them by eye and switch mode by hand is the hunt
        # this whole feature exists to remove.
        self.assertEqual(self.report["modeBeforeEdit"], "OBJECT")
        self.assertEqual(self.report["editStatus"], ["FINISHED"])
        self.assertTrue(self.report["editLandedOnTheGhost"])
        self.assertEqual(self.report["modeAfterEdit"], "POSE")

    def test_editing_a_pose_that_is_not_shown_is_refused_by_name(self):
        # Says which pose is missing rather than "invalid selection": the
        # ghosts all look alike, so the frame is the only distinguishing fact.
        self.assertEqual(self.report["editOnAMissingPose"][0], "CANCELLED")
        self.assertIn("frame 999", self.report["editOnAMissingPose"][1])


    def test_an_unapplied_ghost_edit_is_visible_as_unapplied(self):
        # Regeneration reads the rig's curves and nothing else, so a pose
        # dragged on a ghost and never applied would be dropped in silence:
        # the request carries the OLD pose at that frame and the animator gets
        # back a clip that ignores the edit in front of them. Same shape of
        # silent loss as the Auto Keying lapse, and detectable here because the
        # ghost is still holding the evidence.
        self.assertEqual(self.report["uncommittedWhenFresh"], [])
        self.assertEqual(self.report["uncommittedAfterDrag"], ["RightHand @ 3"])
        self.assertEqual(self.report["uncommittedAfterApply"], [])


if __name__ == "__main__":
    unittest.main()
