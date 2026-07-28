"""The mark/clear frame-range guards behave in real Blender 5.2.

Each numbered fact from the assignment has its own named test method. The
fixture builds a real Y-Bot rig, bakes the 3-frame ARDY clip, stamps the clip
metadata, attaches the IK layer, and drives the operators through bpy.ops so
the guards execute in the same path the UI takes.
"""

import json
import shutil
import subprocess
import unittest
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
BLENDER = Path(shutil.which("blender") or "/opt/homebrew/bin/blender")
SCRIPT = REPOSITORY_ROOT / "blender-addon/tests/fixtures/constraint_frame_guard_fixture.py"


@unittest.skipUnless(BLENDER.is_file(), "Blender is unavailable")
class ConstraintFrameGuardTests(unittest.TestCase):
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
            if line.startswith("CCLAY_CONSTRAINT_FRAME_GUARD=")
        ]
        if len(lines) != 1:
            raise AssertionError(f"missing constraint frame guard report\n{completed.stdout}")
        cls.report = json.loads(lines[0].split("=", 1)[1])

    def test_inside_the_clip_still_works(self):
        # Fact 1. A mark on a frame the clip actually has must still land. If
        # the guard were over-eager (bounding by the scene start, or by an
        # off-by-one on the clip end) this is where it would surface.
        self.assertEqual(self.report["insideStatus"], ["FINISHED"])
        self.assertIn(2, self.report["insideMarkedFrames"])

    def test_outside_the_clip_is_refused_at_mark_time(self):
        # Fact 2. The refused frame is past the clip end, so the operator must
        # CANCEL. The before/after lists are recorded so this asserts on the
        # actual marker set, not just the status: a CANCELLED that left a stray
        # key would pass a status-only check and fail in production when
        # Regenerate read the out-of-range frame. The message is captured too,
        # so the refusal reason is observable: it must name the clip range
        # [1, 3], proving the guard checked the clip and not the scene.
        self.assertEqual(self.report["outsideStatus"], ["CANCELLED"])
        self.assertEqual(
            self.report["outsideMarkedAfter"],
            self.report["outsideMarkedBefore"],
            "a refused mark must not change the committed marker set",
        )
        self.assertIn(
            "[1, 3]",
            self.report["outsideMessage"],
            "the refusal must name the clip range, not the scene range",
        )

    def test_the_refusal_is_the_clips_bound_not_the_scenes(self):
        # Fact 3. The load-bearing distinction: the scene is longer than the
        # clip, and the refused frame was inside the scene range. If the guard
        # checked the scene range instead of the clip's, frame 20 would be
        # accepted (FINISHED) and this test would fail on the status recorded
        # in fact 2; this test pins the precondition that makes fact 2
        # meaningful. The scene end is recorded rather than asserted from a
        # constant so a future change to SCENE_END does not desync the two.
        self.assertEqual(self.report["refusedFrame"], 20)
        self.assertTrue(
            self.report["refusedFrameInsideScene"],
            "frame 20 must be inside the scene range or its refusal proves nothing",
        )
        self.assertGreater(
            self.report["sceneFrameEnd"],
            self.report["clipRange"][1],
            "the scene must outlive the clip or fact 2 is vacuous",
        )
        self.assertEqual(self.report["clipRange"], [1, 3])

    def test_the_escape_hatch_survives(self):
        # Fact 4. A mark planted outside the clip by the pure function (the
        # unguarded path) must be removable through the clear operator. clear
        # is deliberately NOT range-guarded so a stranded mark left by an
        # earlier, longer clip stays droppable; if it were guarded the rig
        # would be stuck with a constraint it can neither use nor drop.
        self.assertIn(20, self.report["escapeHatchPlanted"])
        self.assertEqual(self.report["escapeHatchStatus"], ["FINISHED"])
        self.assertNotIn(20, self.report["escapeHatchAfter"])

    def test_marking_writes_the_dot_and_touches_nothing_else(self):
        # Fact 6. Marking used to re-key the anchor's location too, so placing
        # a dot silently rewrote the pose at that frame -- and clearing the dot
        # could not put it back, which is how an animator discovered that the
        # two buttons were not opposites.
        before = self.report["symmetryBefore"]
        after = self.report["symmetryAfterMark"]
        self.assertEqual(before["markerKeys"], [])
        self.assertEqual(after["markerKeys"], [2])
        self.assertEqual(after["locationKeyCount"], before["locationKeyCount"])
        self.assertEqual(after["locationAtFrame"], before["locationAtFrame"])

    def test_marking_and_clearing_are_inverse_operations(self):
        # Fact 6, the other half: after the round trip the curves are exactly
        # what they were, dot included.
        self.assertEqual(
            self.report["symmetryAfterClear"], self.report["symmetryBefore"]
        )

    def test_a_handle_moved_but_never_keyed_is_refused(self):
        # Fact 7. collect_constraints scrubs to the frame and reads the pose
        # the curves give back, so an unkeyed drag is discarded and the OLD
        # position is what reaches ARDY -- under a dot that looks correct.
        self.assertEqual(self.report["driftedControlsBeforeMove"], 0)
        self.assertEqual(self.report["driftedControlsAfterMove"], 1)
        self.assertEqual(self.report["unkeyedStatus"], ["CANCELLED"])
        self.assertNotIn("Traceback", self.report["unkeyedMessage"])
        # The message has to name the way out, not just the problem.
        self.assertIn("Auto Keying", self.report["unkeyedMessage"])
        # And the refusal must leave nothing behind.
        self.assertEqual(self.report["unkeyedMarkedAfter"], [])

    def test_keying_the_drag_makes_the_same_mark_succeed(self):
        # Fact 7, the other half. The guard is about the curves disagreeing
        # with the pose, not about refusing handles that have been edited --
        # editing handles is the entire point of the rig.
        self.assertEqual(self.report["driftedControlsAfterKeying"], 0)
        self.assertEqual(self.report["afterKeyingStatus"], ["FINISHED"])
        self.assertEqual(self.report["afterKeyingMarked"], [2])

    def test_a_rig_with_no_ardy_clip_metadata_is_reported_not_crashed(self):
        # Fact 5. base_clip_of raises ConstraintCaptureError when
        # cclay.motion_id is absent, and the mark operator catches that and
        # returns CANCELLED. A traceback escaping execute() is recorded as
        # EXCEPTION rather than CANCELLED, so the status alone separates
        # "reported" from "crashed", and the message carries no interpreter
        # tag. Also confirms the fixture's precondition (no motion_id) held.
        self.assertEqual(self.report["noMetadataStatus"], ["CANCELLED"])
        self.assertNotIn("Traceback", self.report["noMetadataMessage"])
        self.assertFalse(self.report["noMetadataHasMotionId"])


    def test_an_unkeyed_pole_drag_blocks_a_full_body_mark(self):
        # Both reviewers found this as a live bypass. The previous guard looked
        # at the six marker ANCHORS, which meant it never looked at the poles
        # and returned "nothing to check" for Full-Body -- yet a Full-Body
        # constraint captures the whole evaluated pose, and a pole is what
        # bends the limb. An unkeyed pole drag was therefore discarded by the
        # capture's frame set and the old pose committed under the mark.
        self.assertGreaterEqual(self.report["poleDriftedControls"], 1)
        self.assertEqual(self.report["poleFullBodyStatus"], ["CANCELLED"])
        self.assertIn("POLE", self.report["poleFullBodyMessage"])
        self.assertNotIn("Traceback", self.report["poleFullBodyMessage"])
        self.assertEqual(self.report["poleFullBodyMarked"], [])

    def test_moving_a_constraint_anchor_is_not_a_pose_edit(self):
        # The other direction: a dedicated anchor carries marker keys and
        # nothing else, capture never reads where it is, so moving one must
        # refuse nothing. Review caught the first version of this test passing
        # for the wrong reason -- the anchor had no location curve, so the
        # guard skipped it for having nothing keyed to disagree with, and the
        # assertion compared two already-nonzero counts. The fixture now keys
        # the anchor first and every earlier drift is restored, so the expected
        # answer is an exact empty list on both sides of the move.
        self.assertEqual(self.report["driftedBeforeAnchorMove"], [])
        self.assertTrue(self.report["anchorHasLocationCurve"])
        self.assertEqual(self.report["driftedAfterAnchorMove"], [])


    def test_an_unkeyed_hips_move_blocks_a_root_2d_mark(self):
        # Round-3 finding. Hips is neither a target nor a pole, so a guard that
        # enumerated IK controls missed it -- yet Root2D serialises the Hips
        # position outright and Full-Body carries it as the root. The guard is
        # now over every animated bone, which is what capture actually reads.
        self.assertIn("mixamorig:Hips", self.report["hipsDrifted"])
        self.assertEqual(self.report["hipsRoot2DStatus"], ["CANCELLED"])
        self.assertIn("Hips", self.report["hipsRoot2DMessage"])
        self.assertEqual(self.report["hipsRoot2DMarked"], [])


if __name__ == "__main__":
    unittest.main()
