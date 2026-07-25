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
        lines = [line for line in completed.stdout.splitlines() if line.startswith("CCLAY_STAGE_SCENE_RESULTS=")]
        if len(lines) != 1:
            raise AssertionError(f"missing stage-scene results\n{completed.stdout}")
        cls.results = json.loads(lines[0].split("=", 1)[1])

    def test_creates_exact_daemon_ids_and_manifest_v3_state(self):
        self.assertTrue(self.results["created"])
        self.assertTrue(self.results["idsExact"])
        self.assertTrue(self.results["manifestAdvanced"])
        self.assertTrue(self.results["manifestStageState"])

    def test_node_material_drift_advances_manifest_hash(self):
        self.assertTrue(self.results["nodeColorDriftHashes"])
        self.assertTrue(self.results["materialDriftRestored"])

    def test_node_state_drift_advances_hash_through_real_extractor(self):
        # Blender >= 4 keeps use_nodes permanently enabled (setter is a no-op), so
        # useNodes cannot drift; live node-state reads are proven via Principled
        # node removal driving principledBaseColor to None and back.
        self.assertTrue(self.results["useNodesPermanentlyEnabled"])
        self.assertTrue(self.results["principledRemovalDrift"])
        self.assertTrue(self.results["principledRemovalRestored"])

    def test_creation_failure_rolls_back_bit_perfect(self):
        self.assertTrue(self.results["creationRollback"])
        self.assertTrue(self.results["checkpointReleased"])

    def test_deletion_is_retained_until_ack_and_restored_bit_perfect_on_failure(self):
        self.assertTrue(self.results["deleteRetainedBeforeAck"])
        self.assertTrue(self.results["deleteRollback"])

    def test_deletion_destroys_only_after_ack_and_rejects_user_owned(self):
        self.assertTrue(self.results["deleteRetainedUntilAck"])
        self.assertTrue(self.results["deleteDestroyedAfterAck"])
        self.assertEqual(self.results["userDeleteCode"], "STAGE_SCENE_TARGET_NOT_CCLAY_OWNED")

    def test_rejects_shared_mesh_light_and_generated_material_datablocks(self):
        for kind in ("Mesh", "Light", "Material"):
            with self.subTest(kind=kind):
                self.assertEqual(
                    self.results[f"shared{kind}Code"],
                    "STAGE_SCENE_SHARED_DATABLOCK",
                )
                self.assertTrue(self.results[f"shared{kind}Rollback"])
                self.assertFalse(self.results[f"shared{kind}CommitEntered"])

    def test_exclusive_datablocks_are_destroyed_after_ack(self):
        self.assertTrue(self.results["exclusiveDeleteDestroyed"])
        self.assertTrue(self.results["exclusiveCommitEntered"])

    def test_light_rename_collision_reports_actual_blender_name(self):
        identity = self.results["collisionIdentity"]
        self.assertEqual(identity["entity_id"], "44444444-4444-4444-8444-444444444444")
        self.assertEqual(identity["requested_name"], "Collision Light")
        self.assertEqual(identity["actual_name"], "Collision Light.001")
        self.assertEqual(self.results["collisionManifestName"], identity["actual_name"])


if __name__ == "__main__":
    unittest.main()
