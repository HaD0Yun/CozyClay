"""Constraint capture inside real Blender, and the request file it writes.

The load-bearing property is separation: three constraint kinds committed on
three different frames must each read back on their own frame and nothing
else. A capture that collapsed them into one track would still look like it
worked on a single-constraint clip, which is why the fixture always marks the
mixed case.
"""

import json
import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPOSITORY_ROOT / "blender-addon"))

from cclay import constraint_capture, ik_chains  # noqa: E402

BLENDER = Path(shutil.which("blender") or "/opt/homebrew/bin/blender")
SCRIPT = REPOSITORY_ROOT / "blender-addon/tests/fixtures/constraint_capture_fixture.py"


@unittest.skipUnless(BLENDER.is_file(), "Blender is unavailable")
class ConstraintCaptureTests(unittest.TestCase):
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
            if line.startswith("CCLAY_CONSTRAINT_CAPTURE=")
        ]
        if len(lines) != 1:
            raise AssertionError(f"missing capture results\n{completed.stdout}")
        cls.results = json.loads(lines[0].split("=", 1)[1])

    def test_effector_constraints_reuse_the_ik_handle(self):
        # No second selection: the bone the animator already drags is the anchor.
        self.assertEqual(
            self.results["markedRightHand"], ik_chains.target_bone_name("RightHand")
        )

    def test_full_body_and_root_use_their_own_anchors(self):
        self.assertEqual(self.results["markedFullBody"], ik_chains.FULLBODY_ANCHOR)
        self.assertEqual(self.results["markedRoot2D"], ik_chains.ROOT2D_ANCHOR)

    def test_three_kinds_on_three_frames_stay_separate(self):
        self.assertEqual(self.results["framesRightHand"], [3])
        self.assertEqual(self.results["framesFullBody"], [5])
        self.assertEqual(self.results["framesRoot2D"], [2])

    def test_an_unmarked_kind_reports_no_frames(self):
        # attach() keys every handle densely, so an empty list here is the
        # proof that the marker curve, not the location curve, is being read.
        self.assertEqual(self.results["framesLeftHand"], [])

    def test_committing_the_same_frame_twice_does_not_duplicate_it(self):
        self.assertEqual(self.results["framesRightHandAfterRepeat"], [3])

    def test_clearing_removes_only_that_constraint(self):
        self.assertEqual(self.results["framesRoot2DAfterClear"], [])
        self.assertEqual(self.results["framesFullBody"], [5])

    def test_the_pose_comes_back_as_one_rotation_per_cskel27_joint(self):
        self.assertEqual(self.results["rotationCount"], 27)
        self.assertEqual(self.results["rotationShape"], [3, 3])

    def test_detaching_takes_the_markers_with_it(self):
        # Constraints belong to the layer that carried them; a new clip must
        # not inherit the previous clip's committed frames.
        self.assertEqual(self.results["framesAfterDetach"], [])
        self.assertEqual(self.results["controlBonesAfterDetach"], [])


# uuid4 hex, because that shape is now enforced where request ids are used
# as filenames.
REQUEST_ID = "0123456789abcdef0123456789abcdef"


class RequestFileTests(unittest.TestCase):
    """The queue file is the whole handoff, so it is written all-or-nothing."""

    def _payload(self, request_id=REQUEST_ID):
        return {
            "schema_version": constraint_capture.REQUEST_SCHEMA_VERSION,
            "request_id": request_id,
            "effectors": [],
            "full_body": [],
            "root_2d": [],
        }

    def test_writes_the_payload_under_the_request_id(self):
        with tempfile.TemporaryDirectory() as directory:
            path = constraint_capture.write_request(directory, self._payload())
            self.assertEqual(pathlib.Path(path).name, f"{REQUEST_ID}.json")
            self.assertEqual(json.loads(pathlib.Path(path).read_text()), self._payload())

    def test_leaves_no_partial_file_behind(self):
        with tempfile.TemporaryDirectory() as directory:
            constraint_capture.write_request(directory, self._payload())
            staged = list(
                constraint_capture.request_directory(directory).glob("*.partial")
            )
            self.assertEqual(staged, [])

    def test_is_readable_only_by_its_owner(self):
        with tempfile.TemporaryDirectory() as directory:
            path = constraint_capture.write_request(directory, self._payload())
            self.assertEqual(pathlib.Path(path).stat().st_mode & 0o777, 0o600)

    def test_request_ids_do_not_repeat(self):
        self.assertNotEqual(
            constraint_capture.new_request_id(), constraint_capture.new_request_id()
        )

    def test_rejects_an_unknown_constraint_kind(self):
        with self.assertRaisesRegex(
            constraint_capture.ConstraintCaptureError, "unknown constraint kind"
        ):
            constraint_capture.marked_frames(None, "Elbow")


if __name__ == "__main__":
    unittest.main()


class ContinuityWarningTests(unittest.TestCase):
    """When the regenerated clip's worst jump is worth mentioning.

    Never a gate -- the plan is explicit that the result is always accepted --
    so the only thing to get right is that it stays quiet on noise and speaks
    on real drift.
    """

    def warn(self, previous, current):
        return constraint_capture.continuity_warning(previous, current)

    def test_the_first_regeneration_has_nothing_to_compare_against(self):
        self.assertIsNone(self.warn(None, 0.9))

    def test_a_clip_that_reported_no_continuity_is_not_judged(self):
        self.assertIsNone(self.warn(0.01, None))

    def test_growth_within_the_allowance_is_quiet(self):
        # 0.20 -> 0.24 is exactly the 1.2x allowance, and the boundary is
        # inclusive: an unchanged clip must never warn.
        self.assertIsNone(self.warn(0.20, 0.24))
        self.assertIsNone(self.warn(0.20, 0.20))

    def test_growth_past_the_allowance_is_reported(self):
        message = self.warn(0.20, 0.30)
        self.assertIsNotNone(message)
        self.assertIn("0.3000", message)
        self.assertIn("0.2000", message)

    def test_a_large_ratio_on_a_tiny_jump_stays_quiet(self):
        # 0.0001m -> 0.001m is a tenfold rise and still a tenth of a
        # millimetre; the absolute floor is what keeps this from crying wolf
        # on every clip that started out clean.
        self.assertIsNone(self.warn(0.0001, 0.001))

    def test_the_absolute_floor_does_not_hide_a_real_jump(self):
        self.assertIsNotNone(self.warn(0.0001, 0.06))

    def test_an_improving_clip_is_quiet(self):
        self.assertIsNone(self.warn(0.9, 0.1))


class RequestIdFencingTests(unittest.TestCase):
    """Request ids become filenames, so their shape is the fence.

    pathlib lets an absolute path replace a join outright, so an id of
    "/etc/passwd" reads that file rather than something under the queue
    directory. The id comparison inside validate_outcome catches it afterwards,
    but only afterwards -- the read has already happened.
    """

    def test_an_absolute_path_is_refused_before_anything_is_opened(self):
        with tempfile.TemporaryDirectory() as directory:
            outside = pathlib.Path(directory) / "secret.json"
            outside.write_text(json.dumps({"any": "thing"}), encoding="utf-8")
            with self.assertRaises(constraint_capture.ConstraintCaptureError):
                constraint_capture.read_outcome(directory, str(outside.with_suffix("")))

    def test_a_traversing_id_is_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            for candidate in ("../secret", "../../etc/passwd", "a/b"):
                with self.assertRaises(constraint_capture.ConstraintCaptureError):
                    constraint_capture.read_outcome(directory, candidate)

    def test_a_request_cannot_be_written_under_a_traversing_id(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(constraint_capture.ConstraintCaptureError):
                constraint_capture.write_request(
                    directory,
                    {
                        "schema_version": constraint_capture.REQUEST_SCHEMA_VERSION,
                        "request_id": "../escaped",
                        "effectors": [],
                        "full_body": [],
                        "root_2d": [],
                    },
                )

    def test_generated_ids_satisfy_the_fence(self):
        for _ in range(5):
            constraint_capture._require_request_id(constraint_capture.new_request_id())

    def test_a_request_carrying_nan_is_refused(self):
        # Python emits bare NaN by default, which is not JSON and which the
        # host's schema rejects -- after the add-on has already detached.
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(ValueError):
                constraint_capture.write_request(
                    directory,
                    {
                        "schema_version": constraint_capture.REQUEST_SCHEMA_VERSION,
                        "request_id": REQUEST_ID,
                        "effectors": [
                            {"frame": 1, "joint": "RightHand", "x": float("nan"), "y": 0.0, "z": 0.0}
                        ],
                        "full_body": [],
                        "root_2d": [],
                    },
                )
