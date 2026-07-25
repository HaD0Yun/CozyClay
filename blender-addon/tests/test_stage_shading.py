"""Shading is part of the hashed revision, and an all-flat scene is unaffected."""

from __future__ import annotations

import json
import shutil
import subprocess
import unittest
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
BLENDER = Path(shutil.which("blender") or "/opt/homebrew/bin/blender")
SCRIPT = REPOSITORY_ROOT / "blender-addon/tests/fixtures/stage_shading_fixture.py"


@unittest.skipUnless(BLENDER.is_file(), "Blender is unavailable")
class StageShadingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        completed = subprocess.run(
            [str(BLENDER), "--background", "--factory-startup", "--python", str(SCRIPT)],
            cwd=REPOSITORY_ROOT,
            check=False,
            capture_output=True,
            text=True,
            timeout=180,
        )
        if completed.returncode != 0:
            raise AssertionError(
                f"headless Blender failed\nstdout:\n{completed.stdout}\nstderr:\n{completed.stderr}"
            )
        lines = [
            line for line in completed.stdout.splitlines()
            if line.startswith("CCLAY_STAGE_SHADING=")
        ]
        if len(lines) != 1:
            raise AssertionError(f"missing stage shading results\n{completed.stdout}")
        cls.results = json.loads(lines[0].split("=", 1)[1])

    def test_a_flat_primitive_exports_no_shading_key(self):
        # This is what keeps every scene built before shading existed
        # byte-identical, so its stored revision still verifies.
        self.assertEqual(self.results["exported"]["CUBE"], "<absent>")
        self.assertEqual(self.results["cubeEntryKeys"], ["objectId", "primitiveType"])

    def test_a_curved_primitive_reports_smooth(self):
        self.assertEqual(self.results["exported"]["UV_SPHERE"], "SMOOTH")

    def test_a_swept_primitive_reports_mixed(self):
        # Smooth sides, flat caps: neither fully smooth nor fully flat.
        self.assertEqual(self.results["exported"]["CYLINDER"], "MIXED")

    def test_flattening_a_sphere_out_of_band_changes_the_scene_hash(self):
        # The whole point. Before this the two scenes hashed identically while
        # rendering completely differently, so a stored revision could not prove
        # its own shading and out-of-band edits were invisible.
        self.assertEqual(self.results["flattenedShading"], "<absent>")
        self.assertNotEqual(self.results["flattenedHash"], self.results["smoothHash"])

    def test_unsmoothing_one_face_reports_mixed_and_rehashes(self):
        self.assertEqual(self.results["mixedShading"], "MIXED")
        self.assertNotEqual(self.results["mixedHash"], self.results["smoothHash"])
        self.assertNotEqual(self.results["mixedHash"], self.results["flattenedHash"])

    def test_the_exported_manifest_satisfies_its_own_validator(self):
        self.assertIsNone(self.results["validationError"])

    def test_an_unknown_shading_value_is_refused(self):
        self.assertEqual(self.results["unknownShadingRejected"], "INVALID_SCENE_MANIFEST")


if __name__ == "__main__":
    unittest.main()
