"""Real-Blender deterministic QA profile and restoration regression."""

from __future__ import annotations

import json
import shutil
import subprocess
import unittest
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
BLENDER = Path(shutil.which("blender") or "/opt/homebrew/bin/blender")
SCRIPT = REPOSITORY_ROOT / "blender-addon/tests/fixtures/qa_render_fixture.py"


@unittest.skipUnless(BLENDER.is_file(), "Blender is unavailable")
class RenderQaFramesBlenderTests(unittest.TestCase):
    def test_clause_profile_renders_640x360_and_restores_complete_prior_state(self):
        """Plan clause: "Full settings/node checkpoint restore" and pinned 640x360 PNG."""
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
            f"QA render fixture failed\nstdout:\n{completed.stdout}\nstderr:\n{completed.stderr}",
        )
        lines = [
            line for line in completed.stdout.splitlines()
            if line.startswith("CCLAY_QA_RENDER_RESULTS=")
        ]
        self.assertEqual(len(lines), 1, completed.stdout)
        result = json.loads(lines[0].split("=", 1)[1])
        self.assertEqual(result["dimensions"], [640, 360])
        self.assertEqual(result["profile"], "cclay-qa-png-v1")
        self.assertEqual(result["thumbnailMimeType"], "image/jpeg")
        self.assertFalse(result["restatesPng"], result)
        self.assertEqual(result["streamedChunks"], result["declaredChunks"])
        self.assertEqual(result["decodedByteLength"], result["declaredByteLength"])
        self.assertEqual(result["payloadDigest"], result["declaredDigest"])
        self.assertTrue(result["opaqueBackground"], result)
        self.assertEqual(result["pngSignature"], [137, 80, 78, 71, 13, 10, 26, 10])
        self.assertTrue(result["scopeRestored"], result)
        self.assertTrue(result["sceneHashRestored"], result)
        self.assertTrue(result["revisionRestored"], result)
        self.assertEqual(result["temporaryWorlds"], [])


if __name__ == "__main__":
    unittest.main()
