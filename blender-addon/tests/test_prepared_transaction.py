"""Pure unit tests for durable prepared-transaction recovery."""

import json
import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from cclay.prepared_transaction import (
    PreparedTransactionError,
    StoreEvidence,
    advance_marker,
    cleanup_transaction,
    create_base_backup,
    execute_reconcile,
    parse_marker,
    prepare_transaction,
    read_marker,
    reconcile_decision,
    restore_base_backup,
    save_candidate,
    write_marker,
)


PROJECT_ID = "123e4567-e89b-42d3-a456-426614174000"
OTHER_PROJECT_ID = "223e4567-e89b-42d3-a456-426614174000"
TRANSACTION_ID = "323e4567-e89b-42d3-a456-426614174000"
REQUEST_ID = "423e4567-e89b-42d3-a456-426614174000"
BASE_REVISION_ID = "a" * 64
BASE_SCENE_HASH = "b" * 64
CANDIDATE_REVISION_ID = "c" * 64
CANDIDATE_SCENE_HASH = "d" * 64
BASE_BYTES = b"base blend bytes"
CANDIDATE_BYTES = b"candidate blend bytes"
BASE_SHA256 = "66a6aaddaa513bff0457f143a9f7f7f7dc38a0a0b324fd2b7244a570d7a73e1e"
CANDIDATE_SHA256 = "f0074fb445d6ee4ad260bd2a126dba681b3bddbfd659d5a41e89cea49569a842"


class PreparedTransactionTests(unittest.TestCase):
    def marker_payload(self, root: Path, phase: str = "prepared") -> dict:
        canonical_hash = None if phase == "prepared" else CANDIDATE_SHA256
        if phase == "rollback_saved":
            canonical_hash = BASE_SHA256
        return {
            "schema_version": 1,
            "transaction_id": TRANSACTION_ID,
            "project_id": PROJECT_ID,
            "operation": "stage_scene",
            "request_id": REQUEST_ID,
            "base_revision_id": BASE_REVISION_ID,
            "base_scene_hash": BASE_SCENE_HASH,
            "candidate_revision_id": CANDIDATE_REVISION_ID,
            "candidate_scene_hash": CANDIDATE_SCENE_HASH,
            "canonical_blend_path": str(root / "scene.blend"),
            "canonical_blend_sha256": canonical_hash,
            "base_backup_path": str(
                root / ".cclay" / "transactions" / TRANSACTION_ID / "base.blend"
            ),
            "base_backup_sha256": BASE_SHA256,
            "base_backup_project_id": PROJECT_ID,
            "created_at": "2026-07-20T08:55:00.000Z",
            "updated_at": "2026-07-20T08:55:00.000Z",
            "phase": phase,
        }

    def test_marker_parser_accepts_exact_17_field_schema(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            payload = self.marker_payload(root)

            marker = parse_marker(
                payload,
                project_root=root,
                canonical_blend_path=root / "scene.blend",
            )

            self.assertEqual(marker.to_dict(), payload)
            self.assertEqual(len(marker.to_dict()), 17)

    def test_marker_parser_accepts_trailing_separator_project_root(self):
        """Blender's bpy.path.abspath("//") hands roots with a trailing slash."""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            payload = self.marker_payload(root)

            marker = parse_marker(
                payload,
                project_root=str(root) + "/",
                canonical_blend_path=root / "scene.blend",
            )

            self.assertEqual(marker.to_dict(), payload)

    def test_marker_parser_rejects_missing_and_unknown_fields(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            payload = self.marker_payload(root)
            for mutated in (
                {key: value for key, value in payload.items() if key != "request_id"},
                {**payload, "unexpected": True},
            ):
                with self.subTest(keys=sorted(mutated)):
                    with self.assertRaisesRegex(PreparedTransactionError, "exactly 17"):
                        parse_marker(mutated, project_root=root)

    def test_marker_parser_enforces_bounds_literals_and_utc_milliseconds(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cases = {
                "schema_version": True,
                "transaction_id": TRANSACTION_ID.upper(),
                "project_id": "not-a-uuid",
                "operation": "delete_scene",
                "base_revision_id": "a" * 63,
                "candidate_scene_hash": "G" * 64,
                "created_at": "2026-07-20T08:55:00Z",
                "updated_at": "2026-07-20T08:54:59.999Z",
                "phase": "unknown",
            }
            for field, invalid in cases.items():
                with self.subTest(field=field):
                    payload = self.marker_payload(root)
                    payload[field] = invalid
                    with self.assertRaises(PreparedTransactionError):
                        parse_marker(payload, project_root=root)

    def test_marker_parser_enforces_phase_hash_invariants(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            prepared = self.marker_payload(root)
            prepared["canonical_blend_sha256"] = CANDIDATE_SHA256
            with self.assertRaisesRegex(PreparedTransactionError, "prepared"):
                parse_marker(prepared, project_root=root)

            for phase in (
                "candidate_saved",
                "manifest_committed",
                "acknowledged",
                "rollback_saved",
            ):
                with self.subTest(phase=phase):
                    payload = self.marker_payload(root, phase)
                    payload["canonical_blend_sha256"] = None
                    with self.assertRaisesRegex(PreparedTransactionError, phase):
                        parse_marker(payload, project_root=root)

            rollback = self.marker_payload(root, "rollback_saved")
            rollback["canonical_blend_sha256"] = CANDIDATE_SHA256
            with self.assertRaisesRegex(PreparedTransactionError, "base backup"):
                parse_marker(rollback, project_root=root)

    def test_marker_parser_rejects_unsafe_or_noncanonical_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cases = []
            outside = self.marker_payload(root)
            outside["base_backup_path"] = str(root.parent / "base.blend")
            cases.append(outside)
            wrong_name = self.marker_payload(root)
            wrong_name["base_backup_path"] = str(
                root / ".cclay" / "transactions" / TRANSACTION_ID / "other.blend"
            )
            cases.append(wrong_name)
            relative = self.marker_payload(root)
            relative["canonical_blend_path"] = "scene.blend"
            cases.append(relative)
            noncanonical = self.marker_payload(root)
            noncanonical["canonical_blend_path"] = f"{root}/sub/../scene.blend"
            cases.append(noncanonical)
            mismatched = self.marker_payload(root)
            mismatched["canonical_blend_path"] = str(root / "other.blend")
            cases.append(mismatched)

            for payload in cases:
                with self.subTest(payload=payload):
                    with self.assertRaises(PreparedTransactionError):
                        parse_marker(
                            payload,
                            project_root=root,
                            canonical_blend_path=root / "scene.blend",
                        )

    def test_marker_parser_rejects_symlinked_path_components(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            real = root / "real"
            real.mkdir()
            linked = root / "linked"
            linked.symlink_to(real, target_is_directory=True)
            payload = self.marker_payload(real)
            payload["canonical_blend_path"] = str(linked / "scene.blend")
            payload["base_backup_path"] = str(
                real / ".cclay" / "transactions" / TRANSACTION_ID / "base.blend"
            )
            with self.assertRaises(PreparedTransactionError):
                parse_marker(payload, project_root=real)

    def test_base_backup_is_private_fsynced_hashed_and_project_verified(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            canonical = root / "scene.blend"
            canonical.write_bytes(BASE_BYTES)
            inspected = []

            def read_project_id(path: Path) -> str:
                inspected.append(path)
                return PROJECT_ID

            with mock.patch(
                "cclay.prepared_transaction.os.fsync", wraps=os.fsync
            ) as fsync:
                backup = create_base_backup(
                    project_root=root,
                    transaction_id=TRANSACTION_ID,
                    canonical_blend_path=canonical,
                    project_id=PROJECT_ID,
                    read_blend_project_id=read_project_id,
                )

            self.assertEqual(backup.path.read_bytes(), BASE_BYTES)
            self.assertEqual(backup.sha256, BASE_SHA256)
            self.assertEqual(inspected, [backup.path])
            self.assertEqual(stat.S_IMODE(backup.path.stat().st_mode), 0o600)
            self.assertEqual(stat.S_IMODE(backup.path.parent.stat().st_mode), 0o700)
            self.assertGreaterEqual(fsync.call_count, 2)

    def test_base_backup_rejects_project_mismatch_without_leaving_backup(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            canonical = root / "scene.blend"
            canonical.write_bytes(BASE_BYTES)
            backup_path = (
                root / ".cclay" / "transactions" / TRANSACTION_ID / "base.blend"
            )

            with self.assertRaisesRegex(PreparedTransactionError, "project_id"):
                create_base_backup(
                    project_root=root,
                    transaction_id=TRANSACTION_ID,
                    canonical_blend_path=canonical,
                    project_id=PROJECT_ID,
                    read_blend_project_id=lambda _path: OTHER_PROJECT_ID,
                )

            self.assertFalse(backup_path.exists())

    def test_existing_backup_is_verified_and_never_overwritten_from_candidate(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            canonical = root / "scene.blend"
            canonical.write_bytes(BASE_BYTES)
            first = create_base_backup(
                project_root=root,
                transaction_id=TRANSACTION_ID,
                canonical_blend_path=canonical,
                project_id=PROJECT_ID,
                read_blend_project_id=lambda _path: PROJECT_ID,
            )
            canonical.write_bytes(CANDIDATE_BYTES)

            second = create_base_backup(
                project_root=root,
                transaction_id=TRANSACTION_ID,
                canonical_blend_path=canonical,
                project_id=PROJECT_ID,
                read_blend_project_id=lambda _path: PROJECT_ID,
            )

            self.assertEqual(second, first)
            self.assertEqual(second.path.read_bytes(), BASE_BYTES)

    def test_prepare_writes_marker_only_after_backup_project_verification(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            canonical = root / "scene.blend"
            canonical.write_bytes(BASE_BYTES)
            marker_path = root / ".cclay" / "prepared-transaction.json"

            def read_project_id(path: Path) -> str:
                self.assertEqual(path.read_bytes(), BASE_BYTES)
                self.assertFalse(marker_path.exists())
                return PROJECT_ID

            marker = prepare_transaction(
                project_root=root,
                transaction_id=TRANSACTION_ID,
                project_id=PROJECT_ID,
                operation="stage_scene",
                request_id=REQUEST_ID,
                base_revision_id=BASE_REVISION_ID,
                base_scene_hash=BASE_SCENE_HASH,
                candidate_revision_id=CANDIDATE_REVISION_ID,
                candidate_scene_hash=CANDIDATE_SCENE_HASH,
                canonical_blend_path=canonical,
                read_blend_project_id=read_project_id,
                now=lambda: "2026-07-20T08:55:00.000Z",
            )

            self.assertEqual(read_marker(root), marker)
            self.assertEqual(stat.S_IMODE(marker_path.stat().st_mode), 0o600)
            self.assertIsNone(marker.canonical_blend_sha256)
            self.assertEqual(marker.phase, "prepared")

    def test_atomic_restore_replaces_candidate_verifies_and_marks_rollback(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            canonical = root / "scene.blend"
            canonical.write_bytes(BASE_BYTES)
            backup = create_base_backup(
                project_root=root,
                transaction_id=TRANSACTION_ID,
                canonical_blend_path=canonical,
                project_id=PROJECT_ID,
                read_blend_project_id=lambda _path: PROJECT_ID,
            )
            payload = self.marker_payload(root, "candidate_saved")
            payload["base_backup_sha256"] = backup.sha256
            marker = parse_marker(payload, project_root=root)
            write_marker(root, marker)
            canonical.write_bytes(CANDIDATE_BYTES)

            restored = restore_base_backup(
                root,
                marker,
                read_blend_project_id=lambda _path: PROJECT_ID,
                now=lambda: "2026-07-20T08:56:00.000Z",
            )

            self.assertEqual(canonical.read_bytes(), BASE_BYTES)
            self.assertEqual(restored.phase, "rollback_saved")
            self.assertEqual(restored.canonical_blend_sha256, backup.sha256)
            self.assertEqual(restored.updated_at, "2026-07-20T08:56:00.000Z")
            self.assertEqual(read_marker(root), restored)

    def test_atomic_restore_failure_preserves_canonical_and_marker(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            canonical = root / "scene.blend"
            canonical.write_bytes(BASE_BYTES)
            backup = create_base_backup(
                project_root=root,
                transaction_id=TRANSACTION_ID,
                canonical_blend_path=canonical,
                project_id=PROJECT_ID,
                read_blend_project_id=lambda _path: PROJECT_ID,
            )
            payload = self.marker_payload(root, "candidate_saved")
            payload["base_backup_sha256"] = backup.sha256
            marker = parse_marker(payload, project_root=root)
            write_marker(root, marker)
            canonical.write_bytes(CANDIDATE_BYTES)
            original_replace = os.replace

            def fail_canonical_replace(source, destination):
                if Path(destination) == canonical:
                    raise OSError("simulated replace failure")
                return original_replace(source, destination)

            with mock.patch(
                "cclay.prepared_transaction.os.replace",
                side_effect=fail_canonical_replace,
            ):
                with self.assertRaisesRegex(PreparedTransactionError, "restore"):
                    restore_base_backup(
                        root,
                        marker,
                        read_blend_project_id=lambda _path: PROJECT_ID,
                    )

            self.assertEqual(canonical.read_bytes(), CANDIDATE_BYTES)
            self.assertEqual(read_marker(root), marker)

    def test_atomic_restore_refuses_when_canonical_diverged_since_the_marker(self):
        # Regression: a raw script (or a later legitimate commit) can rewrite
        # the canonical blend after this marker last recorded what it expected
        # to find there. Restoring the base backup on top of unrecognized
        # content would silently discard that newer work - refuse instead.
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            canonical = root / "scene.blend"
            canonical.write_bytes(BASE_BYTES)
            backup = create_base_backup(
                project_root=root,
                transaction_id=TRANSACTION_ID,
                canonical_blend_path=canonical,
                project_id=PROJECT_ID,
                read_blend_project_id=lambda _path: PROJECT_ID,
            )
            payload = self.marker_payload(root, "candidate_saved")
            payload["base_backup_sha256"] = backup.sha256
            marker = parse_marker(payload, project_root=root)
            write_marker(root, marker)
            # Someone rewrites the canonical blend to bytes this marker never
            # recorded (neither the candidate it saved nor the base it backed
            # up) - e.g. a manual bpy script save outside the bridge.
            canonical.write_bytes(b"unrelated manual edit bytes")

            with self.assertRaisesRegex(
                PreparedTransactionError, "does not match this transaction"
            ):
                restore_base_backup(
                    root,
                    marker,
                    read_blend_project_id=lambda _path: PROJECT_ID,
                )

            self.assertEqual(canonical.read_bytes(), b"unrelated manual edit bytes")
            self.assertEqual(read_marker(root), marker)

    def test_reconcile_decision_matrix_matches_all_twenty_controlling_rows(self):
        candidate = "candidate_authoritative"
        base = "base_authoritative"
        unknown = "unknown"
        cases = {
            ("prepared", StoreEvidence.CONFLICT): (unknown, "none", "none"),
            ("prepared", StoreEvidence.TARGET): (
                candidate,
                "none",
                "verify_candidate_and_mark_manifest_committed",
            ),
            ("prepared", StoreEvidence.JOURNAL_FORWARD): (
                candidate,
                "journal_forward",
                "verify_candidate_and_mark_manifest_committed",
            ),
            ("prepared", StoreEvidence.BASE): (base, "none", "restore_base_backup"),
            ("candidate_saved", StoreEvidence.CONFLICT): (unknown, "none", "none"),
            ("candidate_saved", StoreEvidence.TARGET): (
                candidate,
                "none",
                "verify_candidate_and_mark_manifest_committed",
            ),
            ("candidate_saved", StoreEvidence.JOURNAL_FORWARD): (
                candidate,
                "journal_forward",
                "verify_candidate_and_mark_manifest_committed",
            ),
            ("candidate_saved", StoreEvidence.BASE): (base, "none", "restore_base_backup"),
            ("manifest_committed", StoreEvidence.CONFLICT): (unknown, "none", "none"),
            ("manifest_committed", StoreEvidence.TARGET): (
                candidate,
                "none",
                "request_committed_ack",
            ),
            ("manifest_committed", StoreEvidence.JOURNAL_FORWARD): (
                candidate,
                "journal_forward",
                "request_committed_ack",
            ),
            ("manifest_committed", StoreEvidence.BASE): (unknown, "none", "none"),
            ("acknowledged", StoreEvidence.CONFLICT): (unknown, "none", "none"),
            ("acknowledged", StoreEvidence.TARGET): (
                candidate,
                "none",
                "send_acknowledged_and_clean",
            ),
            ("acknowledged", StoreEvidence.JOURNAL_FORWARD): (
                candidate,
                "journal_forward",
                "send_acknowledged_and_clean",
            ),
            ("acknowledged", StoreEvidence.BASE): (unknown, "none", "none"),
            ("rollback_saved", StoreEvidence.CONFLICT): (unknown, "none", "none"),
            ("rollback_saved", StoreEvidence.TARGET): (unknown, "none", "none"),
            ("rollback_saved", StoreEvidence.JOURNAL_FORWARD): (unknown, "none", "none"),
            ("rollback_saved", StoreEvidence.BASE): (
                base,
                "none",
                "verify_base_and_clean",
            ),
        }
        self.assertEqual(len(cases), 20)

        for (phase, evidence), expected in cases.items():
            with self.subTest(phase=phase, evidence=evidence):
                decision = reconcile_decision(phase, evidence)
                self.assertEqual(
                    (decision.status, decision.store_action, decision.blender_action),
                    expected,
                )
                self.assertEqual(decision.recovery_required, expected[0] == unknown)

    def test_rollback_saved_journal_and_every_unknown_decision_are_read_only(self):
        mutations = []
        for phase in (
            "prepared",
            "candidate_saved",
            "manifest_committed",
            "acknowledged",
            "rollback_saved",
        ):
            for evidence in StoreEvidence:
                decision = reconcile_decision(phase, evidence)
                if decision.status != "unknown":
                    continue
                with self.subTest(phase=phase, evidence=evidence):
                    observed = execute_reconcile(
                        phase,
                        evidence,
                        journal_forward=lambda: mutations.append("store"),
                        blender_action=lambda _action: mutations.append("blender"),
                    )
                    self.assertEqual(observed.status, "unknown")
                    self.assertEqual(mutations, [])

        corrected = reconcile_decision(
            "rollback_saved", StoreEvidence.JOURNAL_FORWARD
        )
        self.assertEqual(corrected.status, "unknown")
        self.assertEqual(corrected.store_action, "none")
        self.assertEqual(corrected.blender_action, "none")

    def test_read_marker_rejects_non_json_and_write_revalidates(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cclay = root / ".cclay"
            cclay.mkdir()
            marker_path = cclay / "prepared-transaction.json"
            marker_path.write_text("{broken", encoding="utf-8")
            marker_path.chmod(0o600)
            with self.assertRaisesRegex(PreparedTransactionError, "read marker"):
                read_marker(root)

            marker_path.write_text(json.dumps(self.marker_payload(root)), encoding="utf-8")
            marker_path.chmod(0o600)
            marker = read_marker(root)
            self.assertEqual(marker.to_dict(), self.marker_payload(root))

    def test_candidate_save_fsyncs_hashes_and_advances_closed_phases(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            canonical = root / "scene.blend"
            canonical.write_bytes(BASE_BYTES)
            marker = prepare_transaction(
                project_root=root,
                transaction_id=TRANSACTION_ID,
                project_id=PROJECT_ID,
                operation="apply_camera_plan",
                request_id=REQUEST_ID,
                base_revision_id=BASE_REVISION_ID,
                base_scene_hash=BASE_SCENE_HASH,
                candidate_revision_id=CANDIDATE_REVISION_ID,
                candidate_scene_hash=CANDIDATE_SCENE_HASH,
                canonical_blend_path=canonical,
                read_blend_project_id=lambda _path: PROJECT_ID,
                now=lambda: "2026-07-20T08:55:00.000Z",
            )

            with mock.patch(
                "cclay.prepared_transaction.os.fsync", wraps=os.fsync
            ) as fsync:
                candidate = save_candidate(
                    root,
                    marker,
                    save_blend=lambda path: path.write_bytes(CANDIDATE_BYTES),
                    read_blend_project_id=lambda _path: PROJECT_ID,
                    now=lambda: "2026-07-20T08:56:00.000Z",
                )

            self.assertEqual(candidate.phase, "candidate_saved")
            self.assertEqual(candidate.canonical_blend_sha256, CANDIDATE_SHA256)
            self.assertGreaterEqual(fsync.call_count, 2)
            committed = advance_marker(
                root,
                candidate,
                "manifest_committed",
                now=lambda: "2026-07-20T08:57:00.000Z",
            )
            acknowledged = advance_marker(
                root,
                committed,
                "acknowledged",
                now=lambda: "2026-07-20T08:58:00.000Z",
            )
            self.assertEqual(acknowledged.phase, "acknowledged")
            self.assertEqual(read_marker(root), acknowledged)

    def test_acknowledged_cleanup_verifies_and_removes_all_transaction_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            canonical = root / "scene.blend"
            canonical.write_bytes(BASE_BYTES)
            marker = prepare_transaction(
                project_root=root,
                transaction_id=TRANSACTION_ID,
                project_id=PROJECT_ID,
                operation="stage_scene",
                request_id=REQUEST_ID,
                base_revision_id=BASE_REVISION_ID,
                base_scene_hash=BASE_SCENE_HASH,
                candidate_revision_id=CANDIDATE_REVISION_ID,
                candidate_scene_hash=CANDIDATE_SCENE_HASH,
                canonical_blend_path=canonical,
                read_blend_project_id=lambda _path: PROJECT_ID,
            )
            candidate = save_candidate(
                root,
                marker,
                save_blend=lambda path: path.write_bytes(CANDIDATE_BYTES),
                read_blend_project_id=lambda _path: PROJECT_ID,
            )
            committed = advance_marker(root, candidate, "manifest_committed")
            acknowledged = advance_marker(root, committed, "acknowledged")
            transaction_directory = Path(acknowledged.base_backup_path).parent

            cleanup_transaction(
                root,
                acknowledged,
                read_blend_project_id=lambda _path: PROJECT_ID,
            )

            self.assertFalse((root / ".cclay" / "prepared-transaction.json").exists())
            self.assertFalse(transaction_directory.exists())
            self.assertEqual(canonical.read_bytes(), CANDIDATE_BYTES)

    def test_corrupt_candidate_blocks_phase_advance_and_cleanup_without_deleting_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            canonical = root / "scene.blend"
            canonical.write_bytes(BASE_BYTES)
            marker = prepare_transaction(
                project_root=root,
                transaction_id=TRANSACTION_ID,
                project_id=PROJECT_ID,
                operation="stage_scene",
                request_id=REQUEST_ID,
                base_revision_id=BASE_REVISION_ID,
                base_scene_hash=BASE_SCENE_HASH,
                candidate_revision_id=CANDIDATE_REVISION_ID,
                candidate_scene_hash=CANDIDATE_SCENE_HASH,
                canonical_blend_path=canonical,
                read_blend_project_id=lambda _path: PROJECT_ID,
            )
            candidate = save_candidate(
                root,
                marker,
                save_blend=lambda path: path.write_bytes(CANDIDATE_BYTES),
                read_blend_project_id=lambda _path: PROJECT_ID,
            )
            canonical.write_bytes(b"corrupt")
            with self.assertRaisesRegex(PreparedTransactionError, "SHA-256"):
                advance_marker(root, candidate, "manifest_committed")
            self.assertEqual(read_marker(root), candidate)
            self.assertTrue(Path(candidate.base_backup_path).exists())


if __name__ == "__main__":
    unittest.main()
