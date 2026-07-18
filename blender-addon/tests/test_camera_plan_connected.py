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


if __name__ == "__main__":
    unittest.main()
