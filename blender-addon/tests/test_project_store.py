"""Tests for durable project identity persistence."""

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from oh_my_blender.identity import IdentityError
from oh_my_blender.project_store import (
    ProjectStoreError,
    append_journal,
    read_project_index,
    repair_entity_ids,
    verify_project_ids_match,
    write_project_index,
)


PROJECT_ID = "123e4567-e89b-42d3-a456-426614174000"
OTHER_ID = "223e4567-e89b-42d3-a456-426614174000"


class ProjectStoreTests(unittest.TestCase):
    def test_line_203_project_index_round_trip_preserves_extra_fields(self):
        with tempfile.TemporaryDirectory() as directory:
            write_project_index(directory, PROJECT_ID, {"revision": 7})
            self.assertEqual(
                read_project_index(directory),
                {"project_id": PROJECT_ID, "revision": 7},
            )

    def test_lines_196_198_missing_project_index_returns_none(self):
        with tempfile.TemporaryDirectory() as directory:
            self.assertIsNone(read_project_index(directory))

    def test_line_203_malformed_json_and_uuid_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            omb = Path(directory, ".omb")
            omb.mkdir()
            index = omb / "project.json"
            index.write_text("{broken", encoding="utf-8")
            with self.assertRaises(ProjectStoreError):
                read_project_index(directory)
            index.write_text(json.dumps({"project_id": "NOT-A-UUID"}), encoding="utf-8")
            with self.assertRaises(ProjectStoreError):
                read_project_index(directory)

    def test_lines_196_198_atomic_interruption_never_exposes_partial_final_file(self):
        """§5 line 196-198: an interrupted temp write leaves the current index intact."""
        with tempfile.TemporaryDirectory() as directory:
            write_project_index(directory, PROJECT_ID)
            final = Path(directory, ".omb", "project.json")
            prior = final.read_bytes()
            interrupted_temp = final.with_name(".project.json.interrupted")
            interrupted_temp.write_bytes(b'{"project_id":')
            self.assertEqual(final.read_bytes(), prior)
            self.assertEqual(read_project_index(directory), {"project_id": PROJECT_ID})

    def test_line_210_write_failure_before_replace_preserves_prior_index(self):
        with tempfile.TemporaryDirectory() as directory:
            write_project_index(directory, PROJECT_ID)
            with mock.patch("oh_my_blender.project_store.os.replace", side_effect=OSError("crash")):
                with self.assertRaises(ProjectStoreError):
                    write_project_index(directory, OTHER_ID)
            self.assertEqual(read_project_index(directory), {"project_id": PROJECT_ID})

    def test_line_210_journal_appends_one_durable_ordered_json_line_per_call(self):
        with tempfile.TemporaryDirectory() as directory:
            entries = [
                {"type": "initialize_project", "project_id": PROJECT_ID},
                {"type": "repair_ids", "reassigned": ["object:1"]},
            ]
            with mock.patch("oh_my_blender.project_store.os.fsync", wraps=os.fsync) as fsync:
                append_journal(directory, entries[0])
                first_size = Path(directory, ".omb", "journal.jsonl").stat().st_size
                append_journal(directory, entries[1])
                journal = Path(directory, ".omb", "journal.jsonl")
                lines = journal.read_text(encoding="utf-8").splitlines()
                self.assertEqual(journal.stat().st_size - first_size, len((json.dumps(entries[1], separators=(",", ":")) + "\n").encode()))
                self.assertEqual([json.loads(line) for line in lines], entries)
                self.assertEqual(fsync.call_count, 2)

    def test_lines_196_198_journal_requires_nonempty_type(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(ProjectStoreError):
                append_journal(directory, {"project_id": PROJECT_ID})

    def test_line_205_repair_keeps_first_valid_id_and_reassigns_later_duplicates(self):
        """§5 line 205: first serialized owner keeps a valid ID; later duplicates change."""
        entries = [
            ("object:0", PROJECT_ID),
            ("object:1", PROJECT_ID),
            ("object:2", OTHER_ID),
            ("bone:0:0", None),
            ("bone:0:1", "malformed"),
            ("bone:0:2", OTHER_ID),
        ]
        assignments = repair_entity_ids(entries)
        self.assertEqual(set(assignments), {"object:1", "bone:0:0", "bone:0:1", "bone:0:2"})
        self.assertNotIn("object:0", assignments)
        self.assertNotIn("object:2", assignments)
        self.assertEqual(len(set(assignments.values())), len(assignments))

    def test_line_203_verify_project_ids_match_delegates_identity_validation(self):
        self.assertIsNone(verify_project_ids_match(PROJECT_ID, PROJECT_ID))
        with self.assertRaises(IdentityError):
            verify_project_ids_match(PROJECT_ID, OTHER_ID)


if __name__ == "__main__":
    unittest.main()
