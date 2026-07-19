"""Architecture §4 real disconnect/restart/reconnect-hash-gate integration."""

from __future__ import annotations

import json
import shutil
import subprocess
import unittest
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
BLENDER = Path(shutil.which("blender") or "/opt/homebrew/bin/blender")
SCRIPT = REPOSITORY_ROOT / "blender-addon/tests/fixtures/connected_reconnect_fault_fixture.py"


@unittest.skipUnless(BLENDER.is_file(), "Blender is unavailable")
class ReconnectConnectedTests(unittest.TestCase):
    def test_real_response_win_child_restart_and_full_v2_hash_gate(self):
        """Architecture §4: real sever, fresh identities, V2 gate, mismatch, no leaks."""
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
            f"reconnect fixture failed\nstdout:\n{completed.stdout}\nstderr:\n{completed.stderr}",
        )
        lines = [
            line for line in completed.stdout.splitlines()
            if line.startswith("OMB_RECONNECT_FAULT_RESULTS=")
        ]
        self.assertEqual(len(lines), 1, completed.stdout)
        result = json.loads(lines[0].split("=", 1)[1])
        self.assertEqual(result["reconnectedInspect"], "response")
        for key in (
            "oldChildExited",
            "identitiesFresh",
            "requestIdsFresh",
            "toolsExposedAfterGate",
            "responseWinPreserved",
            "mismatchRejected",
            "rejectedChildExited",
            "resourcesReleased",
        ):
            self.assertTrue(result[key], f"{key} failed: {result}")


if __name__ == "__main__":
    unittest.main()
