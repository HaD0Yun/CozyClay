"""Real-Blender T2 controller-to-bridge attach integration."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import unittest
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
BLENDER = Path(shutil.which("blender") or "/opt/homebrew/bin/blender")
NODE_EXECUTABLE = Path(shutil.which("node") or "/nonexistent").resolve()
SCRIPT = REPOSITORY_ROOT / "blender-addon/tests/fixtures/connected_attach_fixture.py"


@unittest.skipUnless(BLENDER.is_file() and NODE_EXECUTABLE.is_file(), "Blender or Node is unavailable")
class ConnectionAttachConnectedTests(unittest.TestCase):
    def test_real_blender_attaches_with_controller_ticket_and_mutates(self):
        completed = subprocess.run(
            [str(BLENDER), "--background", "--factory-startup", "--python", str(SCRIPT)],
            cwd=REPOSITORY_ROOT,
            env={**os.environ, "OMB_NODE_EXECUTABLE": str(NODE_EXECUTABLE)},
            check=False,
            capture_output=True,
            text=True,
            timeout=120,
        )
        self.assertEqual(
            completed.returncode,
            0,
            f"attach fixture failed\nstdout:\n{completed.stdout}\nstderr:\n{completed.stderr}",
        )
        lines = [
            line for line in completed.stdout.splitlines()
            if line.startswith("OMB_CONNECTED_ATTACH_RESULTS=")
        ]
        self.assertEqual(
            len(lines),
            1,
            f"missing attach result\nstdout:\n{completed.stdout}\nstderr:\n{completed.stderr}",
        )
        result = json.loads(lines[0].split("=", 1)[1])
        self.assertEqual(result["responseType"], "response")
        self.assertEqual(result["attachMode"], "ticket")
        for key in ("attachedWithoutChild", "revisionAdvanced", "runtimeOutsideProject"):
            self.assertTrue(result[key], f"{key} failed: {result}")


if __name__ == "__main__":
    unittest.main()
