"""Real-Blender enumeration of all 48 transaction crash assertions."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import unittest
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
BLENDER = Path(shutil.which("blender") or "/opt/homebrew/bin/blender")
NODE_EXECUTABLE = Path(shutil.which("node") or "/nonexistent").resolve()
SCRIPT = (
    REPOSITORY_ROOT
    / "blender-addon/tests/fixtures/connected_transaction_recovery_fixture.py"
)


@unittest.skipUnless(
    BLENDER.is_file() and NODE_EXECUTABLE.is_file(),
    "Blender or Node is unavailable",
)
class TransactionRecoveryConnectedTests(unittest.TestCase):
    rows_by_id: dict[str, dict]
    result: dict

    @classmethod
    def setUpClass(cls):
        completed = subprocess.run(
            [
                str(BLENDER),
                "--background",
                "--factory-startup",
                "--python",
                str(SCRIPT),
            ],
            cwd=REPOSITORY_ROOT,
            env={**os.environ, "CCLAY_NODE_EXECUTABLE": str(NODE_EXECUTABLE)},
            check=False,
            capture_output=True,
            text=True,
            timeout=180,
        )
        if completed.returncode != 0:
            raise AssertionError(
                "transaction recovery fixture failed\n"
                f"stdout:\n{completed.stdout}\nstderr:\n{completed.stderr}"
            )
        lines = [
            line
            for line in completed.stdout.splitlines()
            if line.startswith("CCLAY_TRANSACTION_RECOVERY_RESULTS=")
        ]
        if len(lines) != 1:
            raise AssertionError(f"{completed.stdout}\n{completed.stderr}")
        cls.result = json.loads(lines[0].split("=", 1)[1])
        cls.rows_by_id = {row["id"]: row for row in cls.result["rows"]}

    def test_recovery_summary_counters(self):
        self.assertEqual(self.result["ordinaryCrashRecoveryRequired"], 0)
        self.assertEqual(self.result["authoritativeMismatch"], 0)
        self.assertEqual(self.result["duplicateJournalCommits"], 0)
        self.assertEqual(self.result["corruptEvidenceRecoveryRequired"], 1)
        self.assertEqual(len(self.rows_by_id), 48)


def _install_crash_assertion(crash_id: str) -> None:
    def assertion(self: TransactionRecoveryConnectedTests) -> None:
        row = self.rows_by_id.get(crash_id)
        self.assertIsNotNone(row, crash_id)
        assert row is not None
        self.assertFalse(row["recoveryRequired"], crash_id)
        self.assertEqual(
            row["observedAuthority"],
            row["expectedAuthority"],
            crash_id,
        )

    assertion.__name__ = "test_" + crash_id.lower().replace("-", "_")
    assertion.__doc__ = crash_id
    setattr(TransactionRecoveryConnectedTests, assertion.__name__, assertion)


for _prefix in ("SS", "CP"):
    for _index in range(1, 13):
        _install_crash_assertion(f"CRASH-{_prefix}-{_index:02d}")
        _install_crash_assertion(f"CRASH-{_prefix}-R{_index:02d}")
