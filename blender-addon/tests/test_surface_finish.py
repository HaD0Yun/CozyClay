"""Roughness and metallic reach the Principled node without changing the manifest
for any material that does not use them.

Every generated material used to carry roughness 0.5 / metallic 0.0 with no way to
change it, so a metal handrail, matte concrete and polished stone were the same
mid-roughness plastic. These fields fix that, and must stay hash-neutral: they are
exported only when the value leaves Blender's default.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import unittest
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
BLENDER = Path(shutil.which("blender") or "/opt/homebrew/bin/blender")
SCRIPT = REPOSITORY_ROOT / "blender-addon/tests/fixtures/surface_finish_fixture.py"

FINISH_KEYS = ("principledRoughness", "principledMetallic")


@unittest.skipUnless(BLENDER.is_file(), "Blender is unavailable")
class SurfaceFinishTests(unittest.TestCase):
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
            line
            for line in completed.stdout.splitlines()
            if line.startswith("CCLAY_SURFACE_FINISH=")
        ]
        if len(lines) != 1:
            raise AssertionError(f"missing surface finish results\n{completed.stdout}")
        cls.results = json.loads(lines[0].split("=", 1)[1])

    def test_requested_finish_reaches_the_principled_node(self):
        self.assertAlmostEqual(self.results["applied_roughness"], 0.28, places=4)
        self.assertEqual(self.results["applied_metallic"], 1.0)

    def test_finish_is_exported_when_it_leaves_the_defaults(self):
        # Blender stores the socket as float32, so the exported value is the
        # float32 neighbour of the request, exactly like baseColor already is.
        # It is deterministic, so the revision hash stays stable.
        metal = self.results["metal_entry"]
        self.assertAlmostEqual(metal["principledRoughness"], 0.28, places=6)
        self.assertEqual(metal["principledMetallic"], 1.0)

    def test_a_material_without_finish_exports_no_finish_keys(self):
        # This is what keeps every previously built scene hash-identical.
        for key in FINISH_KEYS:
            self.assertNotIn(key, self.results["plain_entry"])
            self.assertNotIn(key, self.results["legacy_entry"])

    def test_an_untouched_material_is_byte_identical_to_the_legacy_export(self):
        self.assertEqual(self.results["plain_entry"], self.results["legacy_entry"])


if __name__ == "__main__":
    unittest.main()
