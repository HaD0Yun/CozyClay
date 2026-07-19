"""Real daemon/add-on protocol-v2 CameraPlanV1 vertical-slice regression."""

from __future__ import annotations

import json
import shutil
import subprocess
import unittest
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
BLENDER = Path(shutil.which("blender") or "/opt/homebrew/bin/blender")
SCRIPT = REPOSITORY_ROOT / "blender-addon/tests/fixtures/connected_camera_plan_fixture.py"
RECONCILIATION_SCRIPT = (
    REPOSITORY_ROOT
    / "blender-addon/tests/fixtures/connected_commit_reconciliation_fixture.py"
)
FAULT_MATRIX_SCRIPT = (
    REPOSITORY_ROOT
    / "blender-addon/tests/fixtures/connected_disconnect_fault_matrix_fixture.py"
)


@unittest.skipUnless(BLENDER.is_file(), "Blender is unavailable")
class CameraPlanConnectedTests(unittest.TestCase):
    def test_inspect_apply_inspect_uses_real_v2_bridge_and_exact_codes(self):
        completed = subprocess.run(
            [str(BLENDER), "--background", "--factory-startup", "--python", str(SCRIPT)],
            cwd=REPOSITORY_ROOT,
            check=False,
            capture_output=True,
            text=True,
            timeout=120,
        )
        self.assertEqual(
            completed.returncode,
            0,
            f"connected Blender fixture failed\nstdout:\n{completed.stdout}\nstderr:\n{completed.stderr}",
        )
        lines = [
            line for line in completed.stdout.splitlines()
            if line.startswith("OMB_CONNECTED_CAMERA_RESULTS=")
        ]
        self.assertEqual(len(lines), 1, completed.stdout)
        result = json.loads(lines[0].split("=", 1)[1])
        self.assertEqual(result["before"], "response")
        self.assertEqual(result["after"], "response")
        self.assertEqual(result["cuts"], [80, 161, 199, 243])
        self.assertEqual(result["durableRevision"], result["liveRevision"])
        self.assertEqual(result["codes"], [
            "PLAN_FRAME_OUT_OF_EVIDENCE_RANGE",
            "EVIDENCE_SUBJECT_SAMPLE_MISSING",
            "EVIDENCE_ACTION_AXIS_ZERO_LENGTH",
            "EVIDENCE_ACTION_AXIS_PARALLEL_TO_UP",
            "PLAN_FRAME_NOT_INTEGER",
            "PLAN_MINIMUM_TWO_KEYFRAMES",
            "PLAN_FRAME_ORDER_INVALID",
            "PLAN_FIRST_TRANSITION_NOT_SMOOTH",
            "UNSUPPORTED_PLAN_UP",
            "PLAN_ZERO_VIEW_DISTANCE",
            "PLAN_POSE_COLLINEAR_UP",
            "SMOOTH_HANDLE_TYPE_INVALID",
            "SMOOTH_HANDLE_TOLERANCE_EXCEEDED",
            "SMOOTH_VALUE_NOT_FINITE",
            "SMOOTH_HANDLE_OUT_OF_RANGE",
            "SMOOTH_TANGENT_SIGN_INVALID",
            "FRAMING_BAND_VIOLATION",
            "CUT_NOT_AT_MOTION_VALLEY",
            "CUT_SPLITS_ACTION_PEAK",
            "CUT_SCALE_UNDEFINED",
            "CUT_SCALE_DISCONTINUITY",
            "CAMERA_ON_ACTION_AXIS",
            "ACTION_AXIS_CROSSING",
        ])


    def test_post_bridge_result_ack_loss_reconciles_live_and_durable_scene(self):
        for branch_args in ((), ("--fail-commit",)):
            with self.subTest(branch=branch_args or ("committed",)):
                completed = subprocess.run(
                    [
                        str(BLENDER),
                        "--background",
                        "--factory-startup",
                        "--python",
                        str(RECONCILIATION_SCRIPT),
                        "--",
                        *branch_args,
                    ],
                    cwd=REPOSITORY_ROOT,
                    check=False,
                    capture_output=True,
                    text=True,
                    timeout=120,
                )
                self.assertEqual(
                    completed.returncode,
                    0,
                    f"reconciliation fixture failed\nstdout:\n{completed.stdout}\n"
                    f"stderr:\n{completed.stderr}",
                )
                lines = [
                    line for line in completed.stdout.splitlines()
                    if line.startswith("OMB_COMMIT_RECONCILIATION_RESULTS=")
                ]
                self.assertEqual(len(lines), 1, completed.stdout)
                result = json.loads(lines[0].split("=", 1)[1])
                self.assertEqual(
                    result["liveSceneHash"],
                    result["durableSceneHash"],
                    result,
                )
                self.assertEqual(
                    result["liveRevision"],
                    result["durableRevision"],
                    result,
                )
                self.assertIn(
                    result["reconciliation"]["outcome"],
                    {"committed", "not_committed"},
                )
    def test_real_socket_disconnect_matrix_preserves_transaction_cas_ownership(self):
        """Architecture §4/§15.3: all five real-socket fault points have one terminal owner."""
        expected_outcomes = {
            "after_checkpoint": "disconnect_win",
            "mid_mutation": "disconnect_win",
            "before_verify": "disconnect_win",
            "commit_eligibility": "commit_cas",
            "after_response": "response_win",
        }
        for phase, expected in expected_outcomes.items():
            with self.subTest(phase=phase):
                completed = subprocess.run(
                    [
                        str(BLENDER),
                        "--background",
                        "--factory-startup",
                        "--python",
                        str(FAULT_MATRIX_SCRIPT),
                        "--",
                        "--fault-phase",
                        phase,
                    ],
                    cwd=REPOSITORY_ROOT,
                    check=False,
                    capture_output=True,
                    text=True,
                    timeout=120,
                )
                self.assertEqual(
                    completed.returncode,
                    0,
                    f"fault matrix fixture failed ({phase})\n"
                    f"stdout:\n{completed.stdout}\nstderr:\n{completed.stderr}",
                )
                lines = [
                    line for line in completed.stdout.splitlines()
                    if line.startswith("OMB_DISCONNECT_FAULT_RESULTS=")
                ]
                self.assertEqual(len(lines), 1, completed.stdout)
                result = json.loads(lines[0].split("=", 1)[1])
                self.assertEqual(result["phase"], phase)
                self.assertEqual(result["outcome"], expected)
                self.assertEqual(result["liveSceneHash"], result["durableSceneHash"])
                self.assertEqual(result["restoreCount"], result["expectedRestoreCount"])
                self.assertEqual(result["verifyCount"], result["expectedRestoreCount"])
                self.assertTrue(result["requestTerminal"])
                self.assertTrue(result["childExited"])
                self.assertTrue(result["socketClosed"])
                self.assertFalse(result["timerRegistered"])

if __name__ == "__main__":
    unittest.main()
