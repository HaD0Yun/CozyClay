"""Tests for durable project identity persistence."""

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from cclay.identity import IdentityError
from cclay.project_store import (
    ProjectStoreError,
    append_journal,
    apply_property_assignments,
    prepare_project_index,
    read_project_index,
    repair_entity_ids,
    restore_property_assignments,
    verify_connect_precondition,
    verify_project_ids_match,
    write_project_index,
)


PROJECT_ID = "123e4567-e89b-42d3-a456-426614174000"
OTHER_ID = "223e4567-e89b-42d3-a456-426614174000"
MANIFEST = {"revisionId": "a" * 64, "entities": []}


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
            cclay = Path(directory, ".cclay")
            cclay.mkdir()
            index = cclay / "project.json"
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
            final = Path(directory, ".cclay", "project.json")
            prior = final.read_bytes()
            interrupted_temp = final.with_name(".project.json.interrupted")
            interrupted_temp.write_bytes(b'{"project_id":')
            self.assertEqual(final.read_bytes(), prior)
            self.assertEqual(read_project_index(directory), {"project_id": PROJECT_ID})

    def test_line_210_write_failure_before_replace_preserves_prior_index(self):
        with tempfile.TemporaryDirectory() as directory:
            write_project_index(directory, PROJECT_ID)
            with mock.patch("cclay.project_store.os.replace", side_effect=OSError("crash")):
                with self.assertRaises(ProjectStoreError):
                    write_project_index(directory, OTHER_ID)
            self.assertEqual(read_project_index(directory), {"project_id": PROJECT_ID})

    def test_project_index_fsyncs_containing_directory_after_replace(self):
        with tempfile.TemporaryDirectory() as directory:
            with (
                mock.patch(
                    "cclay.project_store.os.open", wraps=os.open
                ) as open_mock,
                mock.patch(
                    "cclay.project_store.os.fsync", wraps=os.fsync
                ) as fsync_mock,
            ):
                write_project_index(directory, PROJECT_ID)
            self.assertEqual(
                open_mock.call_args_list[-1],
                mock.call(Path(directory, ".cclay"), os.O_RDONLY),
            )
            self.assertEqual(fsync_mock.call_count, 2)

    def test_line_210_journal_appends_one_durable_ordered_json_line_per_call(self):
        with tempfile.TemporaryDirectory() as directory:
            entries = [
                {"type": "initialize_project", "project_id": PROJECT_ID},
                {"type": "repair_ids", "reassigned": ["object:1"]},
            ]
            with mock.patch("cclay.project_store.os.fsync", wraps=os.fsync) as fsync:
                append_journal(directory, entries[0])
                first_size = Path(directory, ".cclay", "journal.jsonl").stat().st_size
                append_journal(directory, entries[1])
                journal = Path(directory, ".cclay", "journal.jsonl")
                lines = journal.read_text(encoding="utf-8").splitlines()
                self.assertEqual(journal.stat().st_size - first_size, len((json.dumps(entries[1], separators=(",", ":")) + "\n").encode()))
                self.assertEqual([json.loads(line) for line in lines], entries)
                self.assertEqual(fsync.call_count, 2)

    def test_lines_196_198_journal_requires_nonempty_type(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(ProjectStoreError):
                append_journal(directory, {"project_id": PROJECT_ID})

    def test_lines_203_204_connect_precondition_rejects_dirty_missing_and_mismatch(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ProjectStoreError, "unsaved changes"):
                verify_connect_precondition(directory, PROJECT_ID, True)
            with self.assertRaisesRegex(ProjectStoreError, "not initialized"):
                verify_connect_precondition(directory, PROJECT_ID, False)
            write_project_index(directory, OTHER_ID)
            with self.assertRaises(IdentityError):
                verify_connect_precondition(directory, PROJECT_ID, False)

    def test_line_203_connect_precondition_accepts_matching_index(self):
        with tempfile.TemporaryDirectory() as directory:
            write_project_index(directory, PROJECT_ID)
            self.assertIsNone(verify_connect_precondition(directory, PROJECT_ID, False))

    def test_lines_203_206_reinitialize_matching_index_is_noop_and_mismatch_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            write_project_index(
                directory,
                PROJECT_ID,
                {
                    "current_revision_id": MANIFEST["revisionId"],
                    "manifest": MANIFEST,
                    "future": "preserved",
                },
            )
            with mock.patch("cclay.project_store.write_project_index") as write:
                self.assertFalse(prepare_project_index(directory, PROJECT_ID, False))
                write.assert_not_called()
            with self.assertRaises(IdentityError):
                prepare_project_index(directory, OTHER_ID, False)
            self.assertEqual(
                read_project_index(directory),
                {
                    "current_revision_id": MANIFEST["revisionId"],
                    "manifest": MANIFEST,
                    "project_id": PROJECT_ID,
                    "future": "preserved",
                },
            )

    def test_lines_203_206_initialize_writes_full_document_and_reestablishes_missing_index(self):
        for project_created in (True, False):
            with self.subTest(project_created=project_created):
                with tempfile.TemporaryDirectory() as directory:
                    self.assertTrue(
                        prepare_project_index(
                            directory, PROJECT_ID, project_created, MANIFEST
                        )
                    )
                    self.assertEqual(
                        read_project_index(directory),
                        {
                            "schema_version": 1,
                            "project_id": PROJECT_ID,
                            "current_revision_id": MANIFEST["revisionId"],
                            "manifest": MANIFEST,
                        },
                    )

    def test_prepare_requires_manifest_for_creation_and_legacy_upgrade(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ProjectStoreError, "manifest is required"):
                prepare_project_index(directory, PROJECT_ID, True)
            write_project_index(directory, PROJECT_ID)
            with self.assertRaisesRegex(ProjectStoreError, "manifest is required"):
                prepare_project_index(directory, PROJECT_ID, False)

    def test_project_created_rereads_and_refuses_racing_existing_index(self):
        with tempfile.TemporaryDirectory() as directory:
            write_project_index(directory, PROJECT_ID, {"sentinel": "preserved"})
            with self.assertRaisesRegex(ProjectStoreError, "explicit recovery"):
                prepare_project_index(directory, PROJECT_ID, True, MANIFEST)
            self.assertEqual(
                read_project_index(directory),
                {"project_id": PROJECT_ID, "sentinel": "preserved"},
            )

    def test_line_210_failed_journal_rollback_restores_values_and_absence(self):
        existing = {"cclay.entity_id": PROJECT_ID}
        brand_new = {}
        originals = apply_property_assignments(
            {"existing": existing, "new": brand_new},
            {"existing": OTHER_ID, "new": PROJECT_ID},
        )
        with self.assertRaises(ProjectStoreError):
            try:
                raise ProjectStoreError("journal failed")
            except ProjectStoreError:
                restore_property_assignments(originals)
                raise
        self.assertEqual(existing, {"cclay.entity_id": PROJECT_ID})
        self.assertNotIn("cclay.entity_id", brand_new)
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
