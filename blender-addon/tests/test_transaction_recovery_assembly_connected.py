"""Real-Blender prepared-transaction recovery with a V4 assembly scene."""

from __future__ import annotations

import json
import shutil
import subprocess
import unittest
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
BLENDER = Path(shutil.which("blender") or "/opt/homebrew/bin/blender")
SCRIPT = REPOSITORY_ROOT / "blender-addon/tests/fixtures/connected_transaction_recovery_assembly_fixture.py"


@unittest.skipUnless(BLENDER.is_file(), "Blender is unavailable")
class TransactionRecoveryAssemblyConnectedTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
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
                "assembly transaction recovery fixture failed\n"
                f"stdout:\n{completed.stdout}\nstderr:\n{completed.stderr}"
            )
        lines = [
            line for line in completed.stdout.splitlines()
            if line.startswith("CCLAY_ASSEMBLY_RECOVERY_RESULTS=")
        ]
        if len(lines) != 1:
            raise AssertionError(f"{completed.stdout}\n{completed.stderr}")
        cls.result = json.loads(lines[0].split("=", 1)[1])

    def test_base_authoritative_assembly_recovery(self):
        result = self.result["base"]
        self.assertEqual(result["status"], "base_authoritative")
        self.assertEqual(result["revisionId"], "a" * 64)
        self.assertEqual(result["sceneHash"], result["baseSceneHash"])
        self.assertEqual(result["schemaVersion"], 4)
        self.assertTrue(result["toolsExposed"])
        self.assertFalse(result["markerExists"])

    def test_candidate_authoritative_assembly_recovery(self):
        result = self.result["candidate"]
        self.assertEqual(result["status"], "candidate_authoritative")
        self.assertEqual(result["revisionId"], "c" * 64)
        self.assertEqual(result["sceneHash"], result["candidateSceneHash"])
        self.assertEqual(result["schemaVersion"], 4)
        self.assertTrue(result["toolsExposed"])
        self.assertFalse(result["markerExists"])
        self.assertEqual(result["messages"], [
            "bridge_transaction_reconcile",
            "bridge_transaction_acknowledged",
        ])


if __name__ == "__main__":
    unittest.main()
