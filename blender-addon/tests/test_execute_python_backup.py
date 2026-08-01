"""Backup and recovery behavior for execute_blender_python."""

import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import cclay.execution_journal as execution_journal
from cclay.execution_journal import ExecutionCoordinator, ExecutionJournalError, read_journal

REQUEST_ID = "123e4567-e89b-42d3-a456-426614174000"
REVISION = "a" * 64
NEW_REVISION = "b" * 64
REQUEST = {
    "type": "execute_blender_python",
    "request_id": REQUEST_ID,
    "script": "print('ok')",
    "deadline_ms": 1,
    "capture_stdout": True,
    "expected_revision_id": REVISION,
}


class ExecutePythonBackupTests(unittest.TestCase):
    def coordinator(self, directory, script=None, save=None, mint=None):
        source = Path(directory, "scene.blend")
        source.write_bytes(b"source")

        def save_backup(target):
            if save is not None:
                return save(target)
            target.write_bytes(source.read_bytes())

        return ExecutionCoordinator(
            project_root=directory,
            source_blend_path=lambda: source,
            save_backup=save_backup,
            execute_script=script or (lambda _: ("stdout", "stderr")),
            mint_revision=mint or (lambda: NEW_REVISION),
        )

    def test_success_creates_verified_backup_and_mints_exactly_once(self):
        with tempfile.TemporaryDirectory() as directory:
            mint = mock.Mock(return_value=NEW_REVISION)
            result = self.coordinator(directory, mint=mint).execute(REQUEST)
            self.assertEqual(result["outcome"], "success")
            self.assertEqual(mint.call_count, 1)
            record = read_journal(directory, REQUEST_ID)
            self.assertEqual(record.status, "finalized")
            self.assertTrue(Path(record.backup_path).is_file())

    def test_unsaved_and_outside_project_and_backup_failure_leave_no_journal(self):
        with tempfile.TemporaryDirectory() as directory:
            coordinator = self.coordinator(directory)
            coordinator.source_blend_path = lambda: None
            self.assertEqual(coordinator.execute(REQUEST)["code"], "UNSAVED_PROJECT")
            self.assertIsNone(read_journal(directory, REQUEST_ID))
            coordinator.source_blend_path = lambda: Path(directory).parent / "other.blend"
            self.assertEqual(coordinator.execute(REQUEST)["code"], "UNSAVED_PROJECT")
            self.assertIsNone(read_journal(directory, REQUEST_ID))
            coordinator = self.coordinator(directory, save=lambda _: (_ for _ in ()).throw(OSError("disk full")))
            self.assertEqual(coordinator.execute(REQUEST)["code"], "BACKUP_UNAVAILABLE")
            self.assertIsNone(read_journal(directory, REQUEST_ID))

    def test_exception_requires_reload_then_reports_base_revision_without_minting(self):
        with tempfile.TemporaryDirectory() as directory:
            mint = mock.Mock(return_value=NEW_REVISION)
            coordinator = self.coordinator(directory, script=lambda _: (_ for _ in ()).throw(RuntimeError("boom")), mint=mint)
            pending = coordinator.execute(REQUEST)
            self.assertEqual(pending["outcome"], "outcome_unknown")
            self.assertEqual(read_journal(directory, REQUEST_ID).status, "failed_pending_reload")
            recovered = coordinator.recover(REQUEST_ID, lambda _: None, lambda revision: revision == REVISION)
            self.assertEqual(recovered["outcome"], "failed_recovered")
            self.assertEqual(recovered["restored_revision_id"], REVISION)
            self.assertEqual(mint.call_count, 0)

    def test_failed_verification_requires_operator_and_never_mints(self):
        with tempfile.TemporaryDirectory() as directory:
            mint = mock.Mock(return_value=NEW_REVISION)
            coordinator = self.coordinator(directory, script=lambda _: (_ for _ in ()).throw(RuntimeError("boom")), mint=mint)
            coordinator.execute(REQUEST)
            result = coordinator.recover(REQUEST_ID, lambda _: None, lambda _: False)
            self.assertEqual(result["outcome"], "recovery_required")
            self.assertEqual(mint.call_count, 0)
    def test_backup_path_durability_precedes_hash_journal_and_script(self):
        with tempfile.TemporaryDirectory() as directory:
            events = []

            def save_backup(target):
                events.append("backup_write")
                target.write_bytes(b"backup")

            def execute_script(_):
                events.append("script")
                return "stdout", "stderr"

            def fsync_directory(path):
                events.append(f"{path.name}_directory_fsync")

            def write_started(_, record):
                events.append(f"journal_{record.status}")

            coordinator = self.coordinator(
                directory, save=save_backup, script=execute_script
            )
            with (
                mock.patch.object(
                    execution_journal,
                    "_fsync_file",
                    side_effect=lambda _: events.append("backup_file_fsync"),
                ),
                mock.patch.object(
                    execution_journal,
                    "_fsync_directory",
                    side_effect=fsync_directory,
                ),
                mock.patch.object(
                    execution_journal,
                    "_sha256_file",
                    side_effect=lambda _: events.append("backup_hash") or "c" * 64,
                ),
                mock.patch.object(
                    execution_journal, "write_journal", side_effect=write_started
                ),
            ):
                result = coordinator.execute(REQUEST)

            self.assertEqual(result["outcome"], "success")
            self.assertEqual(
                events[:7],
                [
                    "backup_write",
                    "backup_file_fsync",
                    "execution-backups_directory_fsync",
                    ".cclay_directory_fsync",
                    "backup_hash",
                    "journal_started",
                    "script",
                ],
            )

    def test_backup_ancestor_directory_fsync_failure_leaves_no_started_journal_or_execution(self):
        with tempfile.TemporaryDirectory() as directory:
            script = mock.Mock(return_value=("stdout", "stderr"))
            coordinator = self.coordinator(directory, script=script)
            ancestor = Path(directory, ".cclay").resolve()

            def fsync_directory(path):
                if path == ancestor:
                    raise OSError("ancestor directory fsync failed")

            with mock.patch.object(
                execution_journal,
                "_fsync_directory",
                side_effect=fsync_directory,
            ):
                result = coordinator.execute(REQUEST)

            self.assertEqual(result["type"], "precondition_failed")
            self.assertEqual(result["code"], "BACKUP_UNAVAILABLE")
            self.assertIsNone(read_journal(directory, REQUEST_ID))
            script.assert_not_called()

    def test_journal_write_failure_does_not_claim_execution(self):
        with tempfile.TemporaryDirectory() as directory:
            coordinator = self.coordinator(directory)
            with mock.patch.object(
                execution_journal.os, "replace", side_effect=OSError("replace failed")
            ):
                with self.assertRaises(ExecutionJournalError):
                    coordinator.execute(REQUEST)
            self.assertIsNone(read_journal(directory, REQUEST_ID))
