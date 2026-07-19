"""Connected real-daemon/real-Blender stage_scene vertical slice."""

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
SCRIPT = REPOSITORY_ROOT / "blender-addon/tests/fixtures/connected_stage_scene_fixture.py"


@unittest.skipUnless(BLENDER.is_file() and NODE.is_file(), "Blender or Node is unavailable")
class StageSceneConnectedTests(unittest.TestCase):
    def test_real_daemon_bridge_creation_rollback_and_deferred_delete(self):
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
            self.fail(f"connected stage fixture failed\nstdout:\n{completed.stdout}\nstderr:\n{completed.stderr}")
        lines = [line for line in completed.stdout.splitlines() if line.startswith("OMB_CONNECTED_STAGE_RESULTS=")]
        if len(lines) != 1:
            self.fail(f"missing connected stage results\n{completed.stdout}\n{completed.stderr}")
        result = json.loads(lines[0].split("=", 1)[1])
        self.assertEqual(result["createResponse"], "response")
        self.assertEqual(result["rollbackCode"], "HANDLER_ERROR")
        self.assertTrue(result["rollbackExact"])
        self.assertEqual(result["deleteResponse"], "response")
        self.assertTrue(result["daemonIdsMatch"])
        self.assertTrue(result["identityMappingValid"])
        self.assertTrue(result["manifestAdvanced"])
        self.assertEqual(result["stageCounts"], [3, 3])
        self.assertTrue(result["cubeStillPresent"])
        self.assertTrue(result["sphereDestroyed"])
        self.assertTrue(result["deleteRevisionAdvanced"])


if __name__ == "__main__":
    unittest.main()
