"""Real-Blender coverage for durable Initialize Project persistence."""

from __future__ import annotations

import json
import shutil
import subprocess
import unittest
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
BLENDER = Path(shutil.which("blender") or "/opt/homebrew/bin/blender")
SCRIPT = REPOSITORY_ROOT / "blender-addon/tests/fixtures/initialize_project_durable_fixture.py"


@unittest.skipUnless(BLENDER.is_file(), "Blender is unavailable")
class InitializeProjectDurableTests(unittest.TestCase):
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
            line for line in completed.stdout.splitlines()
            if line.startswith("CCLAY_INITIALIZE_DURABLE_RESULTS=")
        ]
        if len(lines) != 1:
            raise AssertionError(f"missing initialize results\n{completed.stdout}")
        cls.results = json.loads(lines[0].split("=", 1)[1])

    def test_fresh_init_writes_live_full_durable_document(self):
        self.assertEqual(self.results["freshResult"], ["FINISHED"])
        self.assertTrue(self.results["freshFull"])
        self.assertTrue(self.results["freshManifestMatches"])
        self.assertTrue(self.results["freshRevisionMatches"])

    def test_reinit_preserves_daemon_committed_document_bytes(self):
        self.assertEqual(self.results["reinitResult"], ["FINISHED"])
        self.assertTrue(self.results["reinitByteIdentical"])

    def test_legacy_index_is_upgraded(self):
        self.assertEqual(self.results["legacyResult"], ["FINISHED"])
        self.assertTrue(self.results["legacyUpgraded"])

    def test_mismatch_is_rejected_without_writing(self):
        self.assertEqual(self.results["mismatchResult"], ["CANCELLED"])
        self.assertTrue(self.results["mismatchUnchanged"])

    def test_missing_scene_id_with_existing_document_is_rejected_without_mutation(self):
        self.assertEqual(self.results["existingResult"], ["CANCELLED"])
        self.assertTrue(self.results["existingUnchanged"])

    def test_corrupt_existing_document_fails_closed_without_mutation(self):
        self.assertEqual(self.results["corruptResult"], ["CANCELLED"])
        self.assertTrue(self.results["corruptUnchanged"])

    def test_journal_failure_after_publish_keeps_scene_and_document_consistent(self):
        self.assertEqual(self.results["journalFailureResult"], ["CANCELLED"])
        self.assertTrue(self.results["journalFailureConsistent"])


if __name__ == "__main__":
    unittest.main()
