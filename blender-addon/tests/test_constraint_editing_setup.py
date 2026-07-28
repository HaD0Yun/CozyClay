"""The IK setup exposes six constraint lanes without deleting drive curves."""

from __future__ import annotations

import json
import shutil
import subprocess
import unittest
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
BLENDER = Path(shutil.which("blender") or "/opt/homebrew/bin/blender")
FIXTURE = REPOSITORY_ROOT / "blender-addon/tests/fixtures/constraint_editing_setup_fixture.py"


@unittest.skipUnless(BLENDER.is_file(), "Blender is unavailable")
class ConstraintEditingSetupTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        completed = subprocess.run(
            [str(BLENDER), "--background", "--factory-startup", "--python", str(FIXTURE)],
            cwd=REPOSITORY_ROOT,
            check=False,
            capture_output=True,
            text=True,
            timeout=900,
        )
        if completed.returncode != 0:
            raise AssertionError(
                f"headless Blender failed\nstdout:\n{completed.stdout}\nstderr:\n{completed.stderr}"
            )
        marker = "CCLAY_CONSTRAINT_EDITING_SETUP="
        rows = [line for line in completed.stdout.splitlines() if line.startswith(marker)]
        if len(rows) != 1:
            raise AssertionError(f"missing setup report\n{completed.stdout}")
        cls.report = json.loads(rows[0][len(marker):])

    def test_one_operator_attaches_the_editing_layer(self):
        self.assertEqual(self.report["status"], ["FINISHED"])
        self.assertTrue(self.report["has_ik_layer"])

    def test_exactly_the_six_constraint_lanes_are_created(self):
        self.assertEqual(self.report["lanes"], self.report["expected_lanes"])
        self.assertEqual(self.report["marker_curve_count"], 6)

    def test_dope_sheets_show_only_constraint_markers(self):
        self.assertTrue(self.report["editors"])
        for editor in self.report["editors"]:
            self.assertEqual(editor["filter"], self.report["expected_filter"])
            self.assertFalse(editor["only_selected"])

    def test_drive_curves_are_preserved_but_hidden(self):
        self.assertGreater(self.report["non_marker_curve_count"], 0)

    def test_auto_key_is_enabled_for_handle_edits(self):
        self.assertTrue(self.report["auto_key"])


if __name__ == "__main__":
    unittest.main()
