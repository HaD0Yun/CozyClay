"""Real-Blender production keepalive integration."""

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
SCRIPT = REPOSITORY_ROOT / "blender-addon/tests/fixtures/connected_keepalive_fixture.py"


@unittest.skipUnless(BLENDER.is_file() and NODE_EXECUTABLE.is_file(), "Blender or Node is unavailable")
class KeepaliveConnectedTests(unittest.TestCase):
    def test_production_pump_keeps_real_daemon_alive_then_silence_closes(self):
        completed = subprocess.run(
            [str(BLENDER), "--background", "--factory-startup", "--python", str(SCRIPT)],
            cwd=REPOSITORY_ROOT,
            env={
                **os.environ,
                "OMB_NODE_EXECUTABLE": str(NODE_EXECUTABLE),
                "OMB_IDLE_TIMEOUT_MS": "21000",
            },
            check=False,
            capture_output=True,
            text=True,
            timeout=110,
        )
        self.assertEqual(
            completed.returncode,
            0,
            f"keepalive fixture failed\nstdout:\n{completed.stdout}\nstderr:\n{completed.stderr}",
        )
        lines = [
            line for line in completed.stdout.splitlines()
            if line.startswith("OMB_CONNECTED_KEEPALIVE_RESULTS=")
        ]
        self.assertEqual(len(lines), 1, f"missing result\nstdout:\n{completed.stdout}")
        result = json.loads(lines[0].split("=", 1)[1])
        self.assertTrue(result["survived"], result)
        self.assertGreaterEqual(result["pongCount"], 3, result)
        self.assertTrue(result["closedAfterSilence"], result)


if __name__ == "__main__":
    unittest.main()
