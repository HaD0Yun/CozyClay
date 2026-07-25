"""Real-Blender adopt_entity coverage: foreign-object adoption and fences."""

from __future__ import annotations

import json
import shutil
import subprocess
import unittest
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
BLENDER = Path(shutil.which("blender") or "/opt/homebrew/bin/blender")
SCRIPT = REPOSITORY_ROOT / "blender-addon/tests/fixtures/stage_scene_adopt_fixture.py"


@unittest.skipUnless(BLENDER.is_file(), "Blender is unavailable")
class StageSceneAdoptRealBlenderTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        completed = subprocess.run(
            [str(BLENDER), "--background", "--factory-startup", "--python", str(SCRIPT)],
            cwd=REPOSITORY_ROOT,
            check=False,
            capture_output=True,
            text=True,
            timeout=90,
        )
        if completed.returncode != 0:
            raise AssertionError(
                f"headless Blender failed\nstdout:\n{completed.stdout}\nstderr:\n{completed.stderr}"
            )
        lines = [
            line
            for line in completed.stdout.splitlines()
            if line.startswith("CCLAY_STAGE_SCENE_ADOPT_RESULTS=")
        ]
        if len(lines) != 1:
            raise AssertionError(f"missing adopt results\n{completed.stdout}")
        cls.results = json.loads(lines[0].split("=", 1)[1])

    def test_adopt_and_delete_in_one_plan_removes_the_foreign_cube(self):
        self.assertTrue(self.results["cubeForeignBefore"])
        self.assertTrue(self.results["defaultCubeGone"])
        self.assertTrue(self.results["cubeAbsentFromManifest"])

    def test_adopt_then_transform_in_a_later_plan_succeeds(self):
        self.assertTrue(self.results["sphereOwned"])
        self.assertTrue(self.results["sphereTransformed"])

    def test_readopting_an_owned_entity_is_an_idempotent_success(self):
        self.assertTrue(self.results["readoptCommitEntered"])
        self.assertTrue(self.results["sphereStillOwned"])

    def test_adopt_rejects_unknown_entity_and_rolls_back(self):
        self.assertEqual(self.results["unknownCode"], "STAGE_SCENE_TARGET_NOT_FOUND")
        self.assertTrue(self.results["unknownRollback"])
        self.assertFalse(self.results["unknownCommitEntered"])

    def test_adopt_rejects_shared_datablock_objects(self):
        self.assertEqual(self.results["sharedCode"], "STAGE_SCENE_SHARED_DATABLOCK")
        self.assertTrue(self.results["sharedRollback"])
        self.assertFalse(self.results["sharedCommitEntered"])
        self.assertTrue(self.results["sharedUnstamped"])

    def test_adopt_rejects_entities_owned_by_another_project(self):
        self.assertEqual(self.results["otherCode"], "STAGE_SCENE_TARGET_NOT_CCLAY_OWNED")
        self.assertTrue(self.results["otherRollback"])
        self.assertTrue(self.results["otherOwnerKept"])

    def test_commit_failure_rolls_the_ownership_stamp_back(self):
        self.assertTrue(self.results["stampedBeforeCommit"])
        self.assertTrue(self.results["rollbackUnstamped"])
        self.assertTrue(self.results["rollbackManifest"])
        self.assertTrue(self.results["checkpointReleased"])


if __name__ == "__main__":
    unittest.main()
