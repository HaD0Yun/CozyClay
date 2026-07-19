"""Real daemon/add-on protocol-v2 `render_qa_frames` vertical slice."""

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
SCRIPT = REPOSITORY_ROOT / "blender-addon/tests/fixtures/connected_qa_render_fixture.py"


@unittest.skipUnless(BLENDER.is_file() and NODE_EXECUTABLE.is_file(), "Blender or Node is unavailable")
class RenderQaFramesConnectedTests(unittest.TestCase):
    def test_clause_real_inspect_apply_render_bridge_publishes_verifiable_artifacts(self):
        """Task clause: mandatory real connected e2e through the actual protocol-v2 bridge."""
        completed = subprocess.run(
            [str(BLENDER), "--background", "--factory-startup", "--python", str(SCRIPT)],
            cwd=REPOSITORY_ROOT,
            env={**os.environ, "OMB_NODE_EXECUTABLE": str(NODE_EXECUTABLE)},
            check=False,
            capture_output=True,
            text=True,
            timeout=150,
        )
        self.assertEqual(
            completed.returncode,
            0,
            f"connected QA fixture failed\nstdout:\n{completed.stdout}\nstderr:\n{completed.stderr}",
        )
        lines = [
            line for line in completed.stdout.splitlines()
            if line.startswith("OMB_CONNECTED_QA_RESULTS=")
        ]
        self.assertEqual(len(lines), 1, completed.stdout)
        result = json.loads(lines[0].split("=", 1)[1])
        self.assertEqual(result["inspect"], "response")
        self.assertEqual([item["frame"] for item in result["artifacts"]], [79, 80, 81])
        for artifact in result["artifacts"]:
            self.assertEqual(artifact["dimensions"], [640, 360])
            self.assertEqual(artifact["byteLength"], artifact["declaredLength"])
            self.assertEqual(artifact["digest"], artifact["rereadDigest"])
            self.assertEqual(artifact["imageMimeType"], "image/png")
            self.assertTrue(artifact["modelContentMatchesArtifact"], artifact)
        self.assertEqual(result["staleCode"], "STALE_BASE")
        self.assertEqual(result["limitCode"], "RENDER_QA_FRAME_LIMIT")
        self.assertTrue(result["resultHasByteFields"], result)
        self.assertEqual(result["cancelCode"], "CANCELLED")
        self.assertTrue(result["cancelArtifactsUnchanged"], result)
        self.assertTrue(result["cancelAfterChunk"], result)
        self.assertEqual(result["tempEntryCount"], 0)


if __name__ == "__main__":
    unittest.main()
