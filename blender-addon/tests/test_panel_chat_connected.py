"""Real-Blender connected chat-panel integration."""

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
SCRIPT = REPOSITORY_ROOT / "blender-addon/tests/fixtures/connected_panel_chat_fixture.py"


@unittest.skipUnless(BLENDER.is_file() and NODE_EXECUTABLE.is_file(), "Blender or Node is unavailable")
class PanelChatConnectedTests(unittest.TestCase):
    def test_connected_panel_converges_and_cleans_up(self):
        completed = subprocess.run(
            [str(BLENDER), "--background", "--factory-startup", "--python", str(SCRIPT)],
            cwd=REPOSITORY_ROOT,
            env={**os.environ, "OMB_NODE_EXECUTABLE": str(NODE_EXECUTABLE)},
            check=False,
            capture_output=True,
            text=True,
            timeout=180,
        )
        self.assertEqual(
            completed.returncode,
            0,
            f"connected panel fixture failed\nstdout:\n{completed.stdout}\nstderr:\n{completed.stderr}",
        )
        lines = [
            line for line in completed.stdout.splitlines()
            if line.startswith("OMB_PANEL_CHAT_RESULTS=")
        ]
        self.assertEqual(
            len(lines),
            1,
            f"missing connected panel result\nstdout:\n{completed.stdout}\nstderr:\n{completed.stderr}",
        )
        result = json.loads(lines[0].split("=", 1)[1])
        for key in (
            "durableContentsExactlyOnce",
            "deltaReplacedByUtterance",
            "busyPreservedCancelState",
            "terminalClearedCancelState",
            "replayStarted",
            "replayConverged",
            "updateBound32",
            "redrawTagged",
            "qaImageDisplayed",
        ):
            self.assertTrue(result[key], f"{key} failed: {result}")
        self.assertLessEqual(result["timerP95Ms"], 4)
        self.assertLessEqual(result["timerMaxMs"], 8)
        self.assertEqual(result["durableEventsDropped"], 0)
        self.assertEqual(result["transcriptByteMatch"], 0)
        self.assertEqual(result["payloadMode"], 0o600)
        self.assertEqual(result["cleanupTimerCount"], 0)
        self.assertEqual(result["cleanupControllerCount"], 0)
        self.assertEqual(result["cleanupThreadCount"], 0)


if __name__ == "__main__":
    unittest.main()
