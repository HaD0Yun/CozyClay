"""Production directing-evidence rebinder regressions."""

from __future__ import annotations

import hashlib
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from cclay.fixture_registry import BOXING_V4_EVIDENCE_SHA256

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
BLENDER = Path(shutil.which("blender") or "/opt/homebrew/bin/blender")
SCRIPT = REPOSITORY_ROOT / "scripts/generate_directing_evidence.py"
EVIDENCE = (
    REPOSITORY_ROOT
    / "blender-addon/cclay/fixtures/boxing-v4-directing-evidence.json"
)


@unittest.skipUnless(BLENDER.is_file(), "Blender is unavailable")
class DirectingEvidenceGeneratorTests(unittest.TestCase):
    def test_rebinding_is_idempotent_and_registry_digest_matches(self):
        with tempfile.TemporaryDirectory() as directory:
            generated = Path(directory) / EVIDENCE.name
            generated.write_bytes(EVIDENCE.read_bytes())
            command = [
                str(BLENDER),
                "--background",
                "--factory-startup",
                "--python",
                str(SCRIPT),
                "--",
                "--evidence",
                str(generated),
            ]
            first = subprocess.run(
                command,
                cwd=REPOSITORY_ROOT,
                check=True,
                capture_output=True,
                text=True,
                timeout=90,
            )
            first_bytes = generated.read_bytes()
            subprocess.run(
                command,
                cwd=REPOSITORY_ROOT,
                check=True,
                capture_output=True,
                text=True,
                timeout=90,
            )
            self.assertEqual(generated.read_bytes(), first_bytes)
            digest = hashlib.sha256(first_bytes).hexdigest()
            self.assertIn(f"CCLAY_EVIDENCE_SHA256={digest}", first.stdout)
            self.assertEqual(digest, BOXING_V4_EVIDENCE_SHA256)


if __name__ == "__main__":
    unittest.main()
