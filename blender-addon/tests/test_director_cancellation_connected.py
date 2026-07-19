"""Real staged-mutation rollback evidence for director cancellation."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import unittest
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
BLENDER = Path(shutil.which("blender") or "/opt/homebrew/bin/blender")
NODE = Path(shutil.which("node") or "/nonexistent").resolve()
SCRIPT = REPOSITORY_ROOT / "blender-addon/tests/fixtures/connected_director_cancellation_fixture.py"


@unittest.skipUnless(BLENDER.is_file() and NODE.is_file(), "Blender or Node is unavailable")
class DirectorCancellationConnectedTests(unittest.TestCase):
    def test_cancel_during_real_stage_rolls_back_once(self):
        completed = subprocess.run(
            [str(BLENDER), "--background", "--factory-startup", "--python", str(SCRIPT)],
            cwd=REPOSITORY_ROOT,
            env={**os.environ, "OMB_NODE_EXECUTABLE": str(NODE)},
            check=False,
            capture_output=True,
            text=True,
            timeout=120,
        )
        if completed.returncode != 0:
            self.fail(
                "connected director cancellation fixture failed\n"
                f"stdout:\n{completed.stdout}\nstderr:\n{completed.stderr}"
            )
        lines = [
            line
            for line in completed.stdout.splitlines()
            if line.startswith("OMB_CONNECTED_DIRECTOR_CANCEL_RESULTS=")
        ]
        if len(lines) != 1:
            self.fail(f"missing director cancellation results\n{completed.stdout}\n{completed.stderr}")
        result = json.loads(lines[0].split("=", 1)[1])
        self.assertTrue(result["mutationAppliedBeforeCancel"], result)
        self.assertEqual(result["cancelAckStatus"], "accepted")
        self.assertEqual(result["terminalCount"], 1)
        self.assertEqual(result["terminalTypes"], ["director_turn_cancelled"])
        self.assertTrue(result["bitPerfectSceneRestore"], result)
        self.assertTrue(result["bitPerfectDurableRestore"], result)
        self.assertTrue(result["durableRevisionUnchanged"], result)


if __name__ == "__main__":
    unittest.main()
