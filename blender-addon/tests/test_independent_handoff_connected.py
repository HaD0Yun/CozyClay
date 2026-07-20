"""Real-Blender independent bridge and controller-peer handoff integration."""

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
SCRIPT = REPOSITORY_ROOT / "blender-addon/tests/fixtures/connected_independent_handoff_fixture.py"


@unittest.skipUnless(BLENDER.is_file() and NODE_EXECUTABLE.is_file(), "Blender or Node is unavailable")
class IndependentHandoffConnectedTests(unittest.TestCase):
    def test_bridge_and_peer_generations_are_independent(self):
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
            f"independent handoff fixture failed\nstdout:\n{completed.stdout}\nstderr:\n{completed.stderr}",
        )
        lines = [
            line for line in completed.stdout.splitlines()
            if line.startswith("OMB_INDEPENDENT_HANDOFF_RESULTS=")
        ]
        self.assertEqual(
            len(lines),
            1,
            f"missing independent handoff result\nstdout:\n{completed.stdout}\nstderr:\n{completed.stderr}",
        )
        result = json.loads(lines[0].split("=", 1)[1])
        for key in (
            "bridgeGenerationAdvanced",
            "supersededBridgeRejected",
            "peerConsumedFirst",
            "bridgeAttached",
            "peerStillActive",
            "rolesIndependent",
            "tuiSpawnedModeConnected",
        ):
            self.assertTrue(result[key], f"{key} failed: {result}")


if __name__ == "__main__":
    unittest.main()
