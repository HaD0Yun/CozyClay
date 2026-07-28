"""End-to-end: cclay.request_constraint_regeneration produces a valid request.

Runs the operator inside real Blender against a real project directory and
then checks what it left on disk, including feeding the request back through
the host's own TypeBox parser. That last step is the point: the add-on writes
the payload in Python and the director reads it in TypeScript, and nothing
else in the repo forces those two definitions to agree.

The synthetic full-body archive is verified against its own rotations. Two
pose archives already in this project have posed_joints that disagree with
their local_rot_mats by 1.4 units, and no consumer notices, so writing one
correctly is not something to take on trust.
"""

import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]

BLENDER = Path(shutil.which("blender") or "/opt/homebrew/bin/blender")
NODE = shutil.which("node")
SCRIPT = REPOSITORY_ROOT / "blender-addon/tests/fixtures/regenerate_request_fixture.py"

# float32 storage noise; a pose archive whose joints were filled in without
# running forward kinematics lands seven orders of magnitude above this.
NPZ_TOLERANCE = 1e-05
# Blender's IK solve does not land exactly on the FK pose it replaced. This is
# the observed worst case over the lab's clips (5.8e-04 npz units at an elbow)
# with headroom, and it applies only to the joints the constraints drive.
IK_RESIDUAL_BOUND = 1e-03

_SEARCH_ROOTS = (
    REPOSITORY_ROOT / ".cclay" / "motions",
    Path.home() / "blenderPi" / "blender-mcp-lab" / ".cclay" / "motions",
)

_PARSE_REQUEST = """
import { parseArdyRegenerateRequest } from './packages/blender-protocol/src/ardy-regenerate.ts';
import { readFileSync } from 'node:fs';
parseArdyRegenerateRequest(JSON.parse(readFileSync(process.argv[1], 'utf8')));
console.log('PARSED_OK');
"""


def _a_real_clip():
    for root in _SEARCH_ROOTS:
        if root.is_dir():
            for path in sorted(root.glob("*.npz")):
                return path
    return None


@unittest.skipUnless(BLENDER.is_file(), "Blender is unavailable")
class RegenerateRequestTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        clip = _a_real_clip()
        if clip is None:
            raise unittest.SkipTest("no .npz motion archive in this checkout")
        cls._directory = tempfile.TemporaryDirectory()
        cls.project = Path(cls._directory.name)
        completed = subprocess.run(
            [
                str(BLENDER), "--background", "--factory-startup",
                "--python", str(SCRIPT), "--", str(clip), str(cls.project),
            ],
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
            if line.startswith("CCLAY_REGENERATE_REQUEST=")
        ]
        if len(lines) != 1:
            raise AssertionError(f"missing operator report\n{completed.stdout}")
        cls.report = json.loads(lines[0].split("=", 1)[1])

    @classmethod
    def tearDownClass(cls) -> None:
        directory = getattr(cls, "_directory", None)
        if directory is not None:
            directory.cleanup()

    def test_the_operator_finishes(self):
        self.assertEqual(self.report["status"], ["FINISHED"])

    def test_it_writes_exactly_one_request_named_after_its_id(self):
        self.assertEqual(self.report["requestCount"], 1)
        self.assertTrue(self.report["requestFilenameMatchesId"])

    def test_the_request_is_owner_only_and_leaves_no_partial_files(self):
        self.assertEqual(self.report["requestFileMode"], "0o600")
        self.assertEqual(self.report["partialsLeft"], [])

    def test_every_marked_constraint_reaches_the_request(self):
        payload = self.report["payload"]
        self.assertEqual(
            sorted(entry["joint"] for entry in payload["effectors"]),
            ["LeftFoot", "RightHand"],
        )
        self.assertEqual(len(payload["full_body"]), 1)
        self.assertEqual(len(payload["root_2d"]), 1)

    def test_the_request_carries_the_scenes_identity_and_revision_guard(self):
        payload = self.report["payload"]
        self.assertEqual(payload["base_motion_id"], "regen-fixture-base")
        self.assertEqual(payload["entity_id"], "3f2504e0-4f89-41d3-9a0c-0305e82c3301")
        self.assertEqual(payload["expected_revision_id"], "b" * 64)
        self.assertEqual(payload["schema_version"], 1)

    def test_the_ik_layer_is_gone_once_the_request_is_published(self):
        # Constraints in the payload prove the read happened before this.
        self.assertFalse(self.report["ikLayerRemains"])
        self.assertTrue(self.report["payload"]["effectors"])

    def test_the_synthetic_pose_archive_has_the_shape_the_generator_reads(self):
        self.assertEqual(
            self.report["syntheticShape"], [[1, 27, 3, 3], [1, 27, 3]]
        )
        self.assertEqual(self.report["syntheticFps"], 20)

    def test_the_synthetic_poses_joints_match_its_own_rotations(self):
        self.assertLess(self.report["syntheticSelfConsistency"], NPZ_TOLERANCE)

    def test_the_synthetic_pose_keeps_the_untouched_joints_exactly(self):
        # Joints the IK layer does not drive are carried straight from the base
        # clip, so anything above float32 noise here is a transform bug.
        self.assertLess(self.report["syntheticCarriedJointError"], NPZ_TOLERANCE)

    def test_the_synthetic_poses_solved_joints_stay_within_the_ik_residual(self):
        # The chain joints come back through Blender's IK solve, so they carry
        # its residual instead of reproducing the clip bit for bit. Measured
        # across every clip in the lab the worst case was 5.8e-04 npz units,
        # i.e. 0.58 mm, and it was always an elbow or knee.
        self.assertLess(self.report["syntheticSolvedJointError"], IK_RESIDUAL_BOUND)

    def test_the_request_is_remembered_on_the_object_not_the_action(self):
        # The action is replaced wholesale by regeneration, so a record kept
        # on it would be destroyed by the very event it exists to survive.
        pending = self.report["pending"]
        assert pending is not None
        self.assertEqual(pending["request_id"], self.report["payload"]["request_id"])
        self.assertEqual(
            pending["marks"],
            {"FullBody": [9], "LeftFoot": [7], "RightHand": [4], "Root2D": [5]},
        )

    def test_applying_the_outcome_puts_the_ik_handles_back(self):
        self.assertEqual(self.report["applyStatus"], ["FINISHED"])
        self.assertTrue(self.report["ikLayerRestored"])
        self.assertTrue(self.report["pendingCleared"])

    def test_constraints_are_re_keyed_onto_the_regenerated_clip(self):
        marks = self.report["restoredMarks"]
        self.assertEqual(marks["RightHand"], [4])
        self.assertEqual(marks["LeftFoot"], [7])
        self.assertEqual(marks["Root2D"], [5])

    def test_a_constraint_past_the_end_of_the_new_clip_is_dropped(self):
        # The regenerated clip is 7 frames from frame 1 while the scene runs to
        # 250, and the full-body constraint sat on frame 9. Bounding by the
        # scene would restore it onto a frame the clip does not have; the next
        # collection would then read it as an out-of-range clip frame.
        self.assertEqual(self.report["restoredMarks"]["FullBody"], [])
        self.assertEqual(self.report["clipRange"], [1, 7])
        self.assertEqual(
            self.report["frameRange"],
            [1, 250],
            "scene and clip ranges must disagree or this proves nothing",
        )

    def test_the_consumed_outcome_is_not_left_behind(self):
        # Outcomes are addressed by request id, so a consumed one left on disk
        # accumulates and can be misread by a later request.
        self.assertTrue(self.report["outcomeDiscarded"])

    def test_the_new_clips_continuity_is_carried_forward_for_the_next_pass(self):
        # Stored on the object, not the action, because the action is what
        # regeneration replaces. Without it every pass is the first pass and
        # drift across repeated regenerations is invisible.
        self.assertAlmostEqual(self.report["continuityAfter"], 0.30)
        self.assertIsNotNone(
            self.report["continuityWarning"],
            "0.30m against 0.10m is past the allowance and must be reported",
        )
    def test_an_out_of_range_mark_is_caught_not_crashed(self):
        # collect_constraints converts every marked scene frame through
        # scene_frame_to_clip_frame, which raises MotionConstraintError for a
        # frame outside the clip. The operator's except tuple now catches it,
        # reports {"ERROR"}, and returns {"CANCELLED"}; before the fix the
        # MotionConstraintError escaped execute() as an unhandled traceback.
        #
        # In Blender 5.2 --background bpy.ops turns an {"ERROR"} report into a
        # RAISED RuntimeError and discards the returned set, so outOfRangeStatus
        # is None (the operator did cancel internally -- the platform just does
        # not surface that set). The discriminating signal is the exception
        # MESSAGE: a caught cancel carries the converter's own range text with
        # no traceback; an uncaught escape carries "Python: Traceback ...". This
        # is the assertion that fails if MotionConstraintError is dropped from
        # the operator's except tuple: the message would then contain
        # "Traceback" and the converter's clean text would be buried inside it.
        self.assertIsNone(
            self.report["outOfRangeStatus"],
            "in --background an ERROR-reporting cancel raises, so the set is None",
        )
        self.assertEqual(self.report["outOfRangeException"], "RuntimeError")
        message = self.report["outOfRangeExceptionMessage"]
        # Positive: the message is the converter's own range text, with the
        # bounds derived from START_FRAME and CLIP_FRAMES, not a wrapped
        # traceback. An unrelated clean failure would not carry this text.
        self.assertIn("outside clip range [1, 12]", message)
        self.assertIn("scene frame 13", message)
        # Negative: no traceback leaked through. An uncaught MotionConstraintError
        # would arrive as "Error: Python: Traceback ... MotionConstraintError: ...".
        self.assertNotIn("Traceback", message)
        self.assertNotIn("Python:", message)

    def test_the_out_of_range_cancel_leaves_the_ik_layer_attached(self):
        # The capture runs before detach, so a cancelled attempt must not have
        # detached the rig. A rig left detached with nothing published is the
        # unsafe outcome this guard exists to prevent.
        self.assertTrue(self.report["outOfRangeIkLayerRemains"])

    def test_the_out_of_range_cancel_writes_no_request_file(self):
        # write_request only runs after a successful capture, so a cancelled
        # one must leave the queue empty. A request written for a frame the
        # clip does not have would send the host garbage.
        self.assertEqual(self.report["outOfRangeRequestsWritten"], [])

    def test_the_planted_out_of_range_mark_is_cleared_afterwards(self):
        # clear_constraint is deliberately unguarded by the clip range, which
        # is what makes a stranded mark removable. Clearing it here restores
        # the state the successful-request phase below expects: only the four
        # legitimate constraints, none out of range.
        self.assertTrue(self.report["plantedMarkCleared"])

    def test_the_planted_out_of_range_mark_was_actually_present(self):
        # Guards against the test vacuously passing because the mark never
        # landed: if mark_constraint silently no-op'd, the cancel and clear
        # assertions would prove nothing about the operator's range guard.
        self.assertTrue(self.report["plantedMarkPresentBefore"])
        # START_FRAME (1) + CLIP_FRAMES (12) = 13, one past the last valid
        # scene frame (12). Derived from the constants, asserted here as a
        # sanity check that the planted frame is the one the converter rejects.
        self.assertEqual(self.report["plantedMarkFrame"], 13)

    def test_a_rig_this_project_does_not_own_is_refused(self):
        # The rig still carries its entity id; only the project stamp is gone,
        # which is exactly the shape of a character appended from another
        # .blend. A check that only looked for an entity id would let that rig
        # through and publish a request against this project's revision for an
        # entity this project never staged.
        #
        # Same platform behaviour as the out-of-range case: an ERROR-reporting
        # cancel arrives as a raised RuntimeError in --background, so the
        # message is what separates a refusal from a crash.
        self.assertIsNone(self.report["foreignStatus"])
        self.assertEqual(self.report["foreignException"], "RuntimeError")
        message = self.report["foreignExceptionMessage"]
        self.assertIn("is not a character this project owns", message)
        self.assertNotIn("Traceback", message)

    def test_the_unowned_refusal_captures_and_publishes_nothing(self):
        # The refusal has to land before capture and detach, or a rig the
        # project does not own would still be collapsed and a request queued.
        self.assertTrue(self.report["foreignIkLayerRemains"])
        self.assertEqual(self.report["foreignRequestsWritten"], [])

    @unittest.skipUnless(NODE, "node is unavailable")
    def test_the_host_schema_accepts_the_addons_request(self):
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as handle:
            json.dump(self.report["payload"], handle)
            request_path = handle.name
        try:
            completed = subprocess.run(
                [
                    NODE, "--experimental-strip-types", "--input-type=module",
                    "-e", _PARSE_REQUEST, request_path,
                ],
                cwd=REPOSITORY_ROOT,
                check=False,
                capture_output=True,
                text=True,
                timeout=180,
            )
        finally:
            Path(request_path).unlink(missing_ok=True)
        self.assertIn(
            "PARSED_OK",
            completed.stdout,
            f"host schema rejected the add-on request\n{completed.stdout}\n{completed.stderr}",
        )


    def test_an_unkeyed_handle_drag_stops_the_request(self):
        # The capture calls scene.frame_set and reads back whatever the curves
        # say, so a handle dragged but never keyed is DISCARDED and the old
        # pose is committed under a mark that looks perfectly correct. The mark
        # operator refuses this too, but Blender's own I places a mark without
        # going near that operator -- and the Dope Sheet lanes exist so that I
        # is the normal way to work -- so the check lives at the boundary both
        # paths share, which is the capture.
        self.assertEqual(self.report["unkeyedDriftedControls"], 1)
        self.assertEqual(self.report["unkeyedStatus"], ["CANCELLED"])
        self.assertIn("not keyed", self.report["unkeyedMessage"])
        self.assertNotIn("Traceback", self.report["unkeyedMessage"])

    def test_the_unkeyed_refusal_detaches_nothing_and_publishes_nothing(self):
        # Refused BEFORE the capture, so before detach and before write. A rig
        # left detached with nothing published is the unsafe outcome.
        self.assertTrue(self.report["unkeyedIkLayerRemains"])
        self.assertEqual(self.report["unkeyedRequestsWritten"], [])
        # And the probe put the pose back, or every later phase would inherit
        # a drifted handle and pass for the wrong reason.
        self.assertEqual(self.report["unkeyedDriftedAfterRestore"], 0)


    def test_regeneration_refuses_while_auto_keying_is_off(self):
        # The sequence review named, which no request-time drift check can
        # catch: Auto Keying off, drag a handle, place a mark with Blender's
        # own I -- which never touches the mark operator or its guard -- then
        # change frame. The drag is discarded by that frame change, so nothing
        # survives to detect it with, and capture would scrub back and publish
        # the OLD pose under a mark that looks perfectly correct.
        #
        # The proof that the drift check alone is not enough is right here:
        # the scene is CLEAN at request time and the request is refused anyway.
        self.assertEqual(self.report["staleDriftAtRequestTime"], [])
        self.assertEqual(self.report["staleStatus"], ["CANCELLED"])
        self.assertIn("Auto Keying has been off", self.report["staleMessage"])
        self.assertNotIn("Traceback", self.report["staleMessage"])

    def test_the_auto_keying_refusal_detaches_nothing_and_publishes_nothing(self):
        self.assertTrue(self.report["staleIkLayerRemains"])
        self.assertEqual(self.report["staleRequestsWritten"], [])


    def test_re_enabling_auto_keying_does_not_unblock_a_stale_mark(self):
        # Review found the first version of this guard bypassable: it sampled
        # the CURRENT Auto Keying setting, so turning it back on after the
        # stale sequence made the scene look clean again. Current state is not
        # historical provenance. The lapse is now recorded when it happens, by
        # the lifecycle timer that native Dope Sheet editing cannot bypass.
        self.assertTrue(self.report["lapseRecordedWhileOff"])
        # Auto Keying is genuinely ON at request time here, so nothing but the
        # recorded lapse can be doing the refusing.
        self.assertTrue(self.report["autoKeyOnAtRequest"])
        self.assertEqual(self.report["reEnabledStatus"], ["CANCELLED"])
        self.assertIn("has been off", self.report["reEnabledMessage"])
        self.assertEqual(self.report["reEnabledRequestsWritten"], [])

    def test_the_lifecycle_timer_is_what_records_the_lapse(self):
        # Native Dope Sheet editing bypasses every operator this add-on owns,
        # so the recorder has to run on something that cannot be bypassed. The
        # timer is that thing, and this measures the WIRING: calling the
        # recorder directly, as the phases above do, proves only that the
        # recorder works.
        self.assertFalse(self.report["lapseClearedBeforePump"])
        self.assertIsNone(self.report["pumpRaised"])
        self.assertTrue(self.report["lapseAfterPump"])

    def test_acknowledging_the_marks_clears_the_lapse(self):
        # The way out has to exist, and it has to be a deliberate act: nothing
        # in the file can tell a mark placed during the lapse from one placed
        # before it, so the only honest gate is someone saying they looked.
        self.assertEqual(self.report["marksCheckedStatus"], ["FINISHED"])
        self.assertFalse(self.report["lapseAfterAcknowledgement"])


    def test_an_unapplied_ghost_edit_stops_the_request(self):
        # Regeneration reads the rig's curves and nothing else, so a pose
        # dragged on a ghost and never applied would be dropped in silence: the
        # request carries the OLD pose at that frame and the animator gets back
        # a clip that ignores the edit they are looking at. Same shape as the
        # Auto Keying lapse, except the evidence is still on screen, so the
        # honest answer is to name it rather than publish past it.
        self.assertEqual(self.report["unappliedGhosts"], ["RightHand @ 4"])
        self.assertEqual(self.report["unappliedStatus"], ["CANCELLED"])
        self.assertIn("not on the rig yet", self.report["unappliedMessage"])
        # And it says both ways out, because discarding is a legitimate answer.
        self.assertIn("Apply Pose To Its Frame", self.report["unappliedMessage"])
        self.assertIn("Hide Marked Poses", self.report["unappliedMessage"])

    def test_the_unapplied_refusal_detaches_nothing_and_publishes_nothing(self):
        # Refusing after detach would leave the animator with a collapsed rig
        # and no request, which is worse than either outcome.
        self.assertTrue(self.report["unappliedIkLayerRemains"])
        self.assertEqual(self.report["unappliedRequestsWritten"], [])


if __name__ == "__main__":
    unittest.main()
