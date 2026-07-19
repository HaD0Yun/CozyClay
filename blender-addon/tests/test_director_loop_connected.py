"""Real-daemon/real-Blender evidence for the bounded director loop."""

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
SCRIPT = REPOSITORY_ROOT / "blender-addon/tests/fixtures/connected_director_loop_fixture.py"


@unittest.skipUnless(BLENDER.is_file() and NODE.is_file(), "Blender or Node is unavailable")
class DirectorLoopConnectedTests(unittest.TestCase):
    def test_faux_director_turn_runs_full_real_blender_loop(self):
        completed = subprocess.run(
            [str(BLENDER), "--background", "--factory-startup", "--python", str(SCRIPT)],
            cwd=REPOSITORY_ROOT,
            env={**os.environ, "OMB_NODE_EXECUTABLE": str(NODE)},
            check=False,
            capture_output=True,
            text=True,
            timeout=180,
        )
        if completed.returncode != 0:
            self.fail(
                "connected director loop fixture failed\n"
                f"stdout:\n{completed.stdout}\nstderr:\n{completed.stderr}"
            )
        lines = [
            line
            for line in completed.stdout.splitlines()
            if line.startswith("OMB_CONNECTED_DIRECTOR_LOOP_RESULTS=")
        ]
        if len(lines) != 1:
            self.fail(f"missing connected director loop results\n{completed.stdout}\n{completed.stderr}")
        result = json.loads(lines[0].split("=", 1)[1])
        self.assertEqual(
            result["toolOrder"],
            [
                "inspect_project",
                "stage_scene",
                "inspect_project",
                "render_qa_frames",
                "apply_camera_plan",
            ],
        )
        self.assertEqual(result["terminalType"], "director_turn_completed")
        self.assertEqual(len(result["revisionChain"]), 3)
        self.assertTrue(result["revisionChainDistinct"], result)
        self.assertTrue(result["terminalMatchesDurable"], result)
        self.assertTrue(result["candidateMatchesDurable"], result)
        self.assertTrue(result["liveMatchesDurable"], result)


if __name__ == "__main__":
    unittest.main()
