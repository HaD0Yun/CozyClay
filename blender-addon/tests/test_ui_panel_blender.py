"""Real-Blender registration and rendered-content clause for the Pi status panel."""

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
    def test_panel_registers_renders_recovery_state_and_unloads(self):
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
            if line.startswith("OMB_UI_PANEL_RESULTS=")
        ]
        self.assertEqual(len(lines), 1, completed.stdout)
        result = json.loads(lines[0].split("=", 1)[1])
        self.assertTrue(result["registered"], result)
        self.assertTrue(result["unregistered"], result)
        self.assertEqual(result["spaceType"], "VIEW_3D")
        self.assertEqual(result["regionType"], "UI")
        self.assertEqual(result["category"], "Oh My Blender")
        self.assertIn("Lifecycle: Recovery required", result["labels"])
        self.assertIn("Tools: Hidden until verified recovery", result["labels"])
        self.assertIn("Provider: anthropic", result["labels"])
        self.assertIn("Model: claude-sonnet-4", result["labels"])
        self.assertEqual(result["operators"], [])


if __name__ == "__main__":
    unittest.main()
