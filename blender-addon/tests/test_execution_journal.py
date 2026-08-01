"""Tests for the Blender-independent execution journal core."""

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from cclay.execution_journal import (
    EXTERNAL_SIDE_EFFECT_DISCLOSURE,
    ExecutionJournal,
    ExecutionJournalError,
    bounded_output,
    outcome_for_journal,
    query_outcome,
    read_journal,
    recovery_gate,
    write_journal,
)

REQUEST_ID = "123e4567-e89b-42d3-a456-426614174000"
REVISION = "a" * 64


def record(status: str, **changes: object) -> ExecutionJournal:
    values = {
        "request_id": REQUEST_ID,
        "base_revision_id": REVISION,
        "backup_path": "/tmp/backup.blend",
        "backup_sha256": "b" * 64,
        "status": status,
    }
    values.update(changes)
    return ExecutionJournal(**values)


class ExecutionJournalTests(unittest.TestCase):
    def test_every_status_has_a_safe_query_shape(self):
        self.assertEqual(outcome_for_journal(record("started"))["outcome"], "outcome_unknown")
        self.assertEqual(outcome_for_journal(record("failed_pending_reload"))["outcome"], "outcome_unknown")
        self.assertEqual(outcome_for_journal(record("succeeded", new_revision_id="c" * 64))["outcome"], "success")
        self.assertEqual(outcome_for_journal(record("finalized", new_revision_id="c" * 64))["outcome"], "success")
        recovered = outcome_for_journal(record("recovered", error_message="bad", error_traceback="trace"))
        self.assertEqual(recovered["outcome"], "failed_recovered")
        self.assertEqual(recovered["restored_revision_id"], REVISION)
        self.assertEqual(recovered["disclosure"], EXTERNAL_SIDE_EFFECT_DISCLOSURE)
        self.assertEqual(outcome_for_journal(record("recovery_verification_failed"))["outcome"], "recovery_required")

    def test_atomic_round_trip_and_missing_malformed_and_stuck_journals(self):
        with tempfile.TemporaryDirectory() as directory:
            self.assertIsNone(read_journal(directory, REQUEST_ID))
            write_journal(directory, record("started"))
            self.assertEqual(read_journal(directory, REQUEST_ID), record("started"))
            self.assertEqual(recovery_gate(directory), [record("started")])
            path = Path(directory, ".cclay", "execution-journal", f"{REQUEST_ID}.json")
            path.write_text("{bad", encoding="utf-8")
            self.assertEqual(query_outcome(directory, REQUEST_ID)["outcome"], "outcome_unknown")
            with self.assertRaises(ExecutionJournalError):
                recovery_gate(directory)

    def test_utf8_boundaries_never_split_a_character(self):
        output, truncated = bounded_output("x" * 4095 + "é")
        self.assertTrue(truncated)
        self.assertEqual(len(output.encode("utf-8")), 4095)
        self.assertEqual(bounded_output("é" * 2048), ("é" * 2048, False))

    def test_invalid_schema_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory, ".cclay", "execution-journal")
            path.mkdir(parents=True)
            (path / f"{REQUEST_ID}.json").write_text(json.dumps({"status": "started"}), encoding="utf-8")
            with self.assertRaises(ExecutionJournalError):
                read_journal(directory, REQUEST_ID)
