"""Connected-style real-Blender assembly fixture wrapper."""

from __future__ import annotations

import json
import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BLENDER = Path(shutil.which("blender") or "/opt/homebrew/bin/blender")
FIXTURE = ROOT / "blender-addon/tests/fixtures/connected_stage_scene_assembly_fixture.py"


@unittest.skipUnless(BLENDER.is_file(), "Blender is unavailable")
class StageSceneAssemblyConnectedTests(unittest.TestCase):
    def test_assembly_hierarchy_transform_cycle_and_reload(self):
        completed = subprocess.run(
            [str(BLENDER), "--background", "--factory-startup", "--python", str(FIXTURE)],
            cwd=ROOT, capture_output=True, text=True, check=False, timeout=90,
        )
        if completed.returncode != 0:
            self.fail(f"assembly fixture failed\n{completed.stdout}\n{completed.stderr}")
        lines = [line for line in completed.stdout.splitlines() if line.startswith("CCLAY_STAGE_SCENE_ASSEMBLY_RESULTS=")]
        self.assertEqual(len(lines), 1, completed.stdout)
        result = json.loads(lines[0].split("=", 1)[1])
        self.assertTrue(result["keepTransform"])
        self.assertEqual(result["cycleCode"], "STAGE_SCENE_PARENT_CYCLE")
        self.assertTrue(result["movedTogether"])
        self.assertEqual(result["rootType"], "EMPTY")
        self.assertEqual(result["assemblyMembers"], 3)
        self.assertTrue(result["hashStable"])


if __name__ == "__main__":
    unittest.main()
