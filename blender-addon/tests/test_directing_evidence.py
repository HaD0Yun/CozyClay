"""Real-Blender runtime directing-evidence production and trust regressions."""

from __future__ import annotations

import json
import shutil
import subprocess
import unittest
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
BLENDER = Path(shutil.which("blender") or "/opt/homebrew/bin/blender")
SCRIPT = REPOSITORY_ROOT / "blender-addon/tests/fixtures/directing_evidence_fixture.py"


@unittest.skipUnless(BLENDER.is_file(), "Blender is unavailable")
class DirectingEvidenceRealBlenderTests(unittest.TestCase):
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
        result_lines = [
            line
            for line in completed.stdout.splitlines()
            if line.startswith("CCLAY_DIRECTING_EVIDENCE_RESULTS=")
        ]
        if len(result_lines) != 1:
            raise AssertionError(f"missing directing-evidence results\n{completed.stdout}")
        cls.results = json.loads(result_lines[0].split("=", 1)[1])

    def test_produce_returns_the_closed_wire_result_bound_to_the_live_manifest(self):
        self.assertTrue(self.results["resultShape"])
        self.assertTrue(self.results["byteLength"])

    def test_runtime_evidence_files_are_private_0600_inside_a_0700_directory(self):
        self.assertTrue(self.results["privateFiles"])

    def test_static_scene_analysis_yields_a_valid_non_degenerate_action_axis(self):
        self.assertTrue(self.results["staticAxisValid"])
        self.assertTrue(self.results["staticAnalysis"])

    def test_apply_camera_plan_accepts_a_runtime_produced_digest_and_keyframes(self):
        self.assertTrue(self.results["applySucceeded"])

    def test_unknown_digest_still_raises_untrusted_evidence_digest(self):
        self.assertEqual(self.results["unknownDigest"], "UNTRUSTED_EVIDENCE_DIGEST")

    def test_scene_mutation_after_production_raises_scene_hash_mismatch(self):
        self.assertTrue(self.results["sceneMutated"])
        self.assertEqual(self.results["sceneHashMismatch"], "EVIDENCE_SCENE_HASH_MISMATCH")

    def test_tampered_runtime_evidence_bytes_raise_digest_mismatch(self):
        self.assertEqual(self.results["tamperedBytes"], "EVIDENCE_DIGEST_MISMATCH")

    def test_project_id_not_matching_the_live_scene_fails_production(self):
        self.assertEqual(self.results["projectMismatch"], "EVIDENCE_PRODUCTION_FAILED")

    def test_animated_subject_yields_displacement_axis_and_action_peaks(self):
        self.assertTrue(self.results["animatedAnalysis"])

    def test_missing_durable_project_fails_production_closed(self):
        self.assertEqual(
            self.results["missingDurableProject"], "EVIDENCE_PRODUCTION_FAILED"
        )

    def test_child_commit_evidence_binds_the_durable_child_revision(self):
        self.assertTrue(self.results["childCommitBindsDurable"])

    def test_apply_camera_plan_succeeds_on_the_child_commit_base(self):
        self.assertTrue(self.results["childCommitApplySucceeded"])


if __name__ == "__main__":
    unittest.main()
