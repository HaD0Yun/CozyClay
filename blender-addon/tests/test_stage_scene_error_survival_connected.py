"""Connected fixed-error stage_scene survival acceptance test."""

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
SCRIPT = REPOSITORY_ROOT / "blender-addon/tests/fixtures/connected_stage_scene_error_survival_fixture.py"


@unittest.skipUnless(BLENDER.is_file() and NODE.is_file(), "Blender or Node is unavailable")
class StageSceneErrorSurvivalConnectedTests(unittest.TestCase):
    def test_plain_runtime_failure_is_fixed_and_bridge_survives(self):
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
                "connected stage error survival fixture failed\n"
                f"stdout:\n{completed.stdout}\nstderr:\n{completed.stderr}"
            )
        lines = [
            line
            for line in completed.stdout.splitlines()
            if line.startswith("OMB_CONNECTED_STAGE_ERROR_SURVIVAL_RESULTS=")
        ]
        if len(lines) != 1:
            self.fail(f"missing connected results\n{completed.stdout}\n{completed.stderr}")
        result = json.loads(lines[0].split("=", 1)[1])
        self.assertEqual(result["failure"]["type"], "error")
        self.assertEqual(result["failure"]["code"], "STAGE_SCENE_FAILED")
        self.assertEqual(result["failure"]["message"], "stage_scene operation failed")
        self.assertFalse(result["failure"]["retryable"])
        self.assertTrue(result["sentinelAbsent"])
        self.assertEqual(result["inspectType"], "response")
        self.assertTrue(result["bridgeAlive"])
        self.assertTrue(result["durableUnchanged"])


if __name__ == "__main__":
    unittest.main()
