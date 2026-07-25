"""Real-Blender operator lifecycle and panel formatter integration coverage."""

from __future__ import annotations

import json
import shutil
import subprocess
import unittest
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
BLENDER = Path(shutil.which("blender") or "/opt/homebrew/bin/blender")
SCRIPT = REPOSITORY_ROOT / "blender-addon/tests/fixtures/ui_panel_fixture.py"


@unittest.skipUnless(BLENDER.is_file(), "Blender is unavailable")
class UiPanelBlenderTests(unittest.TestCase):
    def test_real_operator_lifecycle_formats_live_status_without_operator_calls(self):
        completed = subprocess.run(
            [str(BLENDER), "--background", "--factory-startup", "--python", str(SCRIPT)],
            cwd=REPOSITORY_ROOT,
            check=False,
            capture_output=True,
            text=True,
            timeout=60,
        )
        self.assertEqual(
            completed.returncode,
            0,
            f"UI panel fixture failed\nstdout:\n{completed.stdout}\nstderr:\n{completed.stderr}",
        )
        lines = [
            line
            for line in completed.stdout.splitlines()
            if line.startswith("CCLAY_UI_PANEL_RESULTS=")
        ]
        self.assertEqual(len(lines), 1, completed.stdout)
        result = json.loads(lines[0].split("=", 1)[1])
        self.assertTrue(result["registered"], result)
        self.assertTrue(result["unregistered"], result)
        self.assertEqual(result["spaceType"], "VIEW_3D")
        self.assertEqual(result["regionType"], "UI")
        self.assertEqual(result["category"], "CozyClay")
        self.assertTrue(result["credentialSuppressed"], result)
        self.assertGreater(len(result["captures"]), 4, result)
        self.assertTrue(
            all(capture["layoutType"] == "UILayout" for capture in result["captures"]),
            result,
        )
        labels = [
            label
            for capture in result["captures"]
            for label in capture["labels"]
        ]
        self.assertIn("Lifecycle: Not connected", labels)
        self.assertIn("Task: Camera plan", labels)
        self.assertIn("Progress: Mutating (0/1)", labels)
        self.assertIn("Evidence: Revision sha256:cccccccccccc", labels)
        self.assertIn("Task: QA render", labels)
        self.assertIn("Progress: Rendering (0/2)", labels)
        self.assertIn(
            "Evidence: Frames 80:sha256:2d711642b726, 161:sha256:2d711642b726",
            labels,
        )
        self.assertIn("Lifecycle: Recovery required", labels)
        self.assertIn("Tools: Hidden until verified recovery", labels)
        self.assertEqual(result["operators"], [])


if __name__ == "__main__":
    unittest.main()
