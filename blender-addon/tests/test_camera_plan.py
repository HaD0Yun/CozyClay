"""G010 real-Blender camera-plan mutation and smooth-predicate regressions."""

from __future__ import annotations

import json
import shutil
import subprocess
import unittest
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
BLENDER = Path(shutil.which("blender") or "/opt/homebrew/bin/blender")
SCRIPT = REPOSITORY_ROOT / "blender-addon/tests/fixtures/apply_camera_plan_fixture.py"


@unittest.skipUnless(BLENDER.is_file(), "Blender is unavailable")
class CameraPlanRealBlenderTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        completed = subprocess.run(
            [str(BLENDER), "--background", "--factory-startup", "--python", str(SCRIPT)],
            cwd=REPOSITORY_ROOT,
            check=False,
            capture_output=True,
            text=True,
            timeout=90,
        )
        if completed.returncode != 0:
            raise AssertionError(
                f"headless Blender failed\nstdout:\n{completed.stdout}\nstderr:\n{completed.stderr}"
            )
        result_lines = [line for line in completed.stdout.splitlines() if line.startswith("CCLAY_CAMERA_PLAN_RESULTS=")]
        if len(result_lines) != 1:
            raise AssertionError(f"missing camera-plan results\n{completed.stdout}")
        cls.results = json.loads(result_lines[0].split("=", 1)[1])

    def test_row_23_smooth_key_not_bezier_or_either_handle_type_not_auto_clamped(self):
        self.assertEqual(self.results["row23"], "SMOOTH_HANDLE_TYPE_INVALID")

    def test_row_24_generated_evaluated_blender_handle_differs_over_1e_6(self):
        self.assertEqual(self.results["row24"], "SMOOTH_HANDLE_TOLERANCE_EXCEEDED")

    def test_row_25_any_smooth_key_handle_or_tangent_nonfinite(self):
        self.assertEqual(self.results["row25"], "SMOOTH_VALUE_NOT_FINITE")

    def test_row_26_handle_outside_adjacent_value_interval_plus_or_minus_1e_6(self):
        self.assertEqual(self.results["row26"], "SMOOTH_HANDLE_OUT_OF_RANGE")

    def test_row_27_tangent_sign_or_magnitude_rule_fails(self):
        self.assertEqual(self.results["row27"], "SMOOTH_TANGENT_SIGN_INVALID")

    def test_smooth_zero_secant_requires_tangent_magnitude_at_most_1e_6(self):
        self.assertTrue(self.results["zeroSecant"])

    def test_smooth_first_and_last_keyframes_use_one_sided_secants(self):
        self.assertTrue(self.results["endpoints"])

    def test_plan_minimum_two_keyframes_singleton_is_row_16_not_schema(self):
        self.assertEqual(self.results["singleton"], "PLAN_MINIMUM_TWO_KEYFRAMES")

    def test_boxing_v4_round_trip_has_exact_cuts_and_stable_manifest_hash(self):
        self.assertEqual(self.results["cuts"], [80, 161, 199, 243])
        self.assertTrue(self.results["roundTrip"])
        self.assertTrue(self.results["stableHash"])
        self.assertTrue(self.results["unrelatedUnchanged"])
        self.assertTrue(self.results["selectionPreserved"])
        self.assertTrue(self.results["evidenceCuts"])
        self.assertEqual(self.results["row29PassedCuts"], [80, 161, 199, 243])
        self.assertEqual(self.results["row30PassedCuts"], [80, 161, 199, 243])
        self.assertEqual(len(self.results["row32ScaleRatios"]), 4)
        self.assertTrue(
            all(ratio <= 1.35 + 1e-6 for ratio in self.results["row32ScaleRatios"])
        )
        self.assertEqual(len(set(self.results["row34AxisSigns"])), 1)
        self.assertNotEqual(self.results["row34AxisSigns"][0], 0)
    def test_flat_camera_plan_produces_a_child_revision(self):
        self.assertTrue(self.results["flatChildRevision"])
    def test_camera_plan_without_evidence_produces_a_child_revision(self):
        self.assertTrue(self.results["noEvidenceChildRevision"])

    def test_commit_failure_rolls_back_and_retains_no_checkpoint(self):
        self.assertTrue(self.results["rollback"])
        self.assertTrue(self.results["checkpointReleased"])
        self.assertTrue(self.results["existingRollback"])


if __name__ == "__main__":
    unittest.main()
