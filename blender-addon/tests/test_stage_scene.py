"""Real-Blender StageScenePlanV1 transaction and deferred deletion coverage."""

from __future__ import annotations

import json
import shutil
import subprocess
import unittest
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
BLENDER = Path(shutil.which("blender") or "/opt/homebrew/bin/blender")
SCRIPT = REPOSITORY_ROOT / "blender-addon/tests/fixtures/stage_scene_fixture.py"


@unittest.skipUnless(BLENDER.is_file(), "Blender is unavailable")
class StageSceneRealBlenderTests(unittest.TestCase):
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
        lines = [line for line in completed.stdout.splitlines() if line.startswith("OMB_STAGE_SCENE_RESULTS=")]
        if len(lines) != 1:
            raise AssertionError(f"missing stage-scene results\n{completed.stdout}")
        cls.results = json.loads(lines[0].split("=", 1)[1])

    def test_creates_exact_daemon_ids_and_manifest_v3_state(self):
        self.assertTrue(self.results["created"])
        self.assertTrue(self.results["idsExact"])
        self.assertTrue(self.results["manifestAdvanced"])
        self.assertTrue(self.results["manifestStageState"])

    def test_creation_failure_rolls_back_bit_perfect(self):
        self.assertTrue(self.results["creationRollback"])
        self.assertTrue(self.results["checkpointReleased"])

    def test_deletion_is_retained_until_ack_and_restored_bit_perfect_on_failure(self):
        self.assertTrue(self.results["deleteRetainedBeforeAck"])
        self.assertTrue(self.results["deleteRollback"])

    def test_deletion_destroys_only_after_ack_and_rejects_user_owned(self):
        self.assertTrue(self.results["deleteRetainedUntilAck"])
        self.assertTrue(self.results["deleteDestroyedAfterAck"])
        self.assertEqual(self.results["userDeleteCode"], "STAGE_SCENE_TARGET_NOT_OMB_OWNED")


if __name__ == "__main__":
    unittest.main()
