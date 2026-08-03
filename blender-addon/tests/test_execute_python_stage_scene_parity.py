"""Real-Blender parity coverage for ordinary operations migrated to Python execution."""
from __future__ import annotations

import json
import shutil
import subprocess
import unittest
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
BLENDER = Path(shutil.which("blender") or "/opt/homebrew/bin/blender")
SCRIPT = REPOSITORY_ROOT / "blender-addon/tests/fixtures/execute_python_stage_scene_parity_fixture.py"
REMOVED_OPERATIONS = {
    "add_primitive",
    "add_camera",
    "set_material_color",
    "upsert_area_light",
    "delete_entity",
    "create_assembly",
    "set_parent",
    "transform_assembly",
    "transform_entity",
    "set_light_property",
    "set_camera_property",
    "rename_entity",
    "set_camera_focus_distance",
    "set_light_cutoff_distance",
}


@unittest.skipUnless(BLENDER.is_file(), "Blender is unavailable")
class ExecutePythonStageSceneParityTests(unittest.TestCase):
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
            if line.startswith("CCLAY_EXECUTE_PYTHON_STAGE_SCENE_PARITY_RESULTS=")
        ]
        if len(lines) != 1:
            raise AssertionError(f"missing execute parity results\n{completed.stdout}")
        cls.results = json.loads(lines[0].split("=", 1)[1])

    def test_matrix_has_exactly_one_named_case_per_removed_operation(self) -> None:
        self.assertEqual(set(self.results["removedOperations"]), REMOVED_OPERATIONS)
        self.assertEqual(self.results["matrixCaseCount"], len(REMOVED_OPERATIONS))
        self.assertEqual(set(self.results["outcomes"]), REMOVED_OPERATIONS)

    def test_every_migration_uses_the_standalone_execution_boundary(self) -> None:
        self.assertTrue(self.results["defaultPermission"])
        self.assertTrue(self.results["manifestAdvanced"])
        self.assertEqual(self.results["stageSceneOperationInvocations"], 0)
        for name, outcome in self.results["outcomes"].items():
            with self.subTest(operation=name):
                self.assertTrue(outcome["executionBoundary"])
                self.assertTrue(outcome["success"])
                self.assertTrue(outcome["observable"])

    def test_successful_scripts_persist_without_claiming_rollback(self) -> None:
        for name, outcome in self.results["outcomes"].items():
            with self.subTest(operation=name):
                self.assertTrue(outcome["noRecoveryRequired"])
                self.assertTrue(outcome["observable"])

    def test_exception_uses_reload_recovery_while_successful_scripts_persist(self) -> None:
        self.assertTrue(self.results["exceptionRecoveryReloadedBackup"])

    def test_read_only_execution_does_not_mint_a_new_revision(self) -> None:
        self.assertTrue(self.results["readOnlySameRevision"], self.results)

    def test_playhead_move_does_not_mint_a_new_revision(self) -> None:
        self.assertTrue(self.results["frameChangeSameRevision"], self.results)

    def test_a_real_mutation_still_advances_the_revision(self) -> None:
        self.assertTrue(self.results["realMutationAdvancesRevision"], self.results)


if __name__ == "__main__":
    unittest.main()
