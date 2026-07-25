"""Every buildable shape must exist, be solid, and share the -1..1 unit box.

The unit box is what makes `scale` mean one thing across shapes, and the coverage
loop is what stops PRIMITIVE_TYPES from listing a shape the builder cannot make.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
import unittest
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
BLENDER = Path(shutil.which("blender") or "/opt/homebrew/bin/blender")
SCRIPT = REPOSITORY_ROOT / "blender-addon/tests/fixtures/primitive_geometry_fixture.py"

sys.path.insert(0, str(REPOSITORY_ROOT / "blender-addon"))

from cclay.scene_manifest import PRIMITIVE_TYPES  # noqa: E402


@unittest.skipUnless(BLENDER.is_file(), "Blender is unavailable")
class PrimitiveGeometryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        completed = subprocess.run(
            [str(BLENDER), "--background", "--factory-startup", "--python", str(SCRIPT)],
            cwd=REPOSITORY_ROOT,
            check=False,
            capture_output=True,
            text=True,
            timeout=120,
        )
        if completed.returncode != 0:
            raise AssertionError(
                f"headless Blender failed\nstdout:\n{completed.stdout}\nstderr:\n{completed.stderr}"
            )
        lines = [
            line
            for line in completed.stdout.splitlines()
            if line.startswith("CCLAY_PRIMITIVE_GEOMETRY=")
        ]
        if len(lines) != 1:
            raise AssertionError(f"missing primitive geometry results\n{completed.stdout}")
        cls.results = json.loads(lines[0].split("=", 1)[1])

    def test_every_declared_shape_builds(self):
        self.assertEqual(sorted(self.results["shapes"]), sorted(PRIMITIVE_TYPES))

    def test_shapes_are_solid_and_connected(self):
        for primitive_type, shape in self.results["shapes"].items():
            with self.subTest(primitive_type=primitive_type):
                self.assertGreater(shape["verts"], 0)
                self.assertGreater(shape["faces"], 0)
                self.assertEqual(shape["loose_verts"], 0)

    def test_shapes_share_the_unit_box(self):
        for primitive_type, shape in self.results["shapes"].items():
            with self.subTest(primitive_type=primitive_type):
                for axis in range(3):
                    self.assertGreaterEqual(round(shape["min"][axis], 6), -1.0)
                    self.assertLessEqual(round(shape["max"][axis], 6), 1.0)

    def test_shapes_reach_the_unit_box_in_their_widest_axes(self):
        # A shape that never reaches +/-1 would make `scale` mean something
        # different from CUBE, which is the whole point of a shared unit box.
        for primitive_type, shape in self.results["shapes"].items():
            with self.subTest(primitive_type=primitive_type):
                widest = max(
                    shape["max"][axis] - shape["min"][axis] for axis in range(3)
                )
                self.assertAlmostEqual(widest, 2.0, places=5)

    def test_curved_surfaces_are_smooth_shaded(self):
        # Without this every sphere, cylinder, cone and torus rendered visibly
        # faceted, which is a large part of why cclay's objects looked worse.
        for primitive_type in ("UV_SPHERE", "TORUS"):
            with self.subTest(primitive_type=primitive_type):
                shape = self.results["shapes"][primitive_type]
                self.assertEqual(shape["smooth_faces"], shape["faces"])

    def test_flat_surfaces_stay_flat_shaded(self):
        for primitive_type in ("PLANE", "CUBE", "CIRCLE"):
            with self.subTest(primitive_type=primitive_type):
                self.assertEqual(self.results["shapes"][primitive_type]["smooth_faces"], 0)

    def test_swept_shapes_smooth_the_side_but_not_the_caps(self):
        # A cylinder shaded smooth across its caps reads as a dented tube.
        cylinder = self.results["shapes"]["CYLINDER"]
        self.assertEqual(cylinder["smooth_faces"], cylinder["faces"] - 2)
        cone = self.results["shapes"]["CONE"]
        self.assertEqual(cone["smooth_faces"], cone["faces"] - 1)

    def test_unknown_shape_is_refused_instead_of_defaulting(self):
        self.assertEqual(
            self.results["unknownError"], "STAGE_SCENE_PRIMITIVE_UNSUPPORTED"
        )


if __name__ == "__main__":
    unittest.main()
