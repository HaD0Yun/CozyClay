"""Prepared transaction bridge sequencing and evidence retention."""

import tempfile
import unittest
from pathlib import Path

from cclay.connection import (
    Connection,
    ConnectionError,
    DurableCommitReconciliationRequired,
)
from cclay.prepared_transaction import read_marker

PROJECT_ID = "123e4567-e89b-42d3-a456-426614174000"
BRIDGE_ID = "223e4567-e89b-42d3-a456-426614174000"
REQUEST_ID = "323e4567-e89b-42d3-a456-426614174000"
TRANSACTION_ID = "423e4567-e89b-42d3-a456-426614174000"
BASE_REVISION = "a" * 64
BASE_SCENE = "b" * 64
CANDIDATE_REVISION = "c" * 64
CANDIDATE_SCENE = "d" * 64
BASE_BYTES = b"base blend"
CANDIDATE_BYTES = b"candidate blend"


class FakeWebSocket:
    def __init__(self, responses):
        self.responses = iter(responses)
        self.sent = []
        self.closed = False

    def send_json(self, message):
        self.sent.append(message)

    def recv_json(self):
        response = next(self.responses)
        if callable(response):
            response = response(self.sent)
        if isinstance(response, BaseException):
            raise response
        return response

    def close(self, *_args):
        self.closed = True


class ConnectionTransactionTests(unittest.TestCase):
    def make_connection(self, root: Path, responses) -> tuple[Connection, FakeWebSocket]:
        websocket = FakeWebSocket(responses)
        connection = Connection(
            None,
            websocket,
            project_directory=root,
            capabilities=frozenset((
                "mutation_bridge_v2",
                "scene_manifest_v3",
                "transaction_commit_v2",
            )),
        )
        return connection, websocket

    def commit(self, connection: Connection, root: Path):
        return connection.commit_prepared_transaction(
            bridge_id=BRIDGE_ID,
            request_id=REQUEST_ID,
            transaction_id=TRANSACTION_ID,
            operation="stage_scene",
            project_id=PROJECT_ID,
            base_revision_id=BASE_REVISION,
            base_scene_hash=BASE_SCENE,
            candidate_revision_id=CANDIDATE_REVISION,
            candidate_scene_hash=CANDIDATE_SCENE,
            canonical_blend_path=root / "scene.blend",
            result={
                "expected_revision_id": BASE_REVISION,
                "scene_hash": CANDIDATE_SCENE,
                "manifest": {"revisionId": CANDIDATE_REVISION},
            },
            save_blend=lambda path: path.write_bytes(CANDIDATE_BYTES),
            read_blend_project_id=lambda _path: PROJECT_ID,
        )

    def test_prepared_commit_acknowledges_then_cleans_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "scene.blend").write_bytes(BASE_BYTES)
            connection, websocket = self.make_connection(
                root,
                [{
                    "type": "bridge_transaction_ack",
                    "id": BRIDGE_ID,
                    "transaction_id": TRANSACTION_ID,
                    "status": "committed",
                    "resulting_revision_id": CANDIDATE_REVISION,
                }],
            )

            response = self.commit(connection, root)

            self.assertEqual(response["status"], "committed")
            self.assertEqual(
                [message["type"] for message in websocket.sent],
                [
                    "bridge_transaction_prepared",
                    "bridge_result",
                    "bridge_transaction_acknowledged",
                ],
            )
            prepared = websocket.sent[0]
            self.assertEqual(set(prepared), {
                "type", "id", "transaction_id", "operation", "project_id",
                "base_revision_id", "base_scene_hash", "candidate_revision_id",
                "candidate_scene_hash", "base_backup_sha256", "canonical_blend_sha256",
            })
            self.assertFalse((root / ".cclay" / "prepared-transaction.json").exists())
            self.assertEqual((root / "scene.blend").read_bytes(), CANDIDATE_BYTES)

    def test_connection_loss_retains_candidate_saved_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "scene.blend").write_bytes(BASE_BYTES)
            connection, websocket = self.make_connection(root, [OSError("lost")])

            with self.assertRaises(DurableCommitReconciliationRequired):
                self.commit(connection, root)

            marker = read_marker(root)
            self.assertEqual(marker.phase, "candidate_saved")
            self.assertTrue(Path(marker.base_backup_path).exists())
            self.assertEqual(
                [message["type"] for message in websocket.sent],
                ["bridge_transaction_prepared", "bridge_result"],
            )

    def test_transaction_conflict_retains_evidence_and_surfaces_exact_code(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "scene.blend").write_bytes(BASE_BYTES)
            connection, _websocket = self.make_connection(
                root,
                [{
                    "type": "bridge_transaction_error",
                    "id": BRIDGE_ID,
                    "transaction_id": TRANSACTION_ID,
                    "code": "TRANSACTION_CONFLICT",
                    "message": "transaction id was reused with different content",
                    "retryable": False,
                }],
            )

            with self.assertRaisesRegex(ConnectionError, "TRANSACTION_CONFLICT"):
                self.commit(connection, root)

            self.assertEqual(read_marker(root).phase, "candidate_saved")


    @staticmethod
    def recovery_status(status: str, revision_id: str):
        def response(sent):
            reconcile = sent[-1]
            return {
                "type": "bridge_transaction_status",
                "id": reconcile["id"],
                "transaction_id": TRANSACTION_ID,
                "status": status,
                "revision_id": revision_id,
            }
        return response

    def retained_candidate(self, root: Path) -> None:
        connection, _websocket = self.make_connection(root, [OSError("lost")])
        with self.assertRaises(DurableCommitReconciliationRequired):
            self.commit(connection, root)

    def test_startup_reconcile_restores_authoritative_base_before_exposure(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            canonical = root / "scene.blend"
            canonical.write_bytes(BASE_BYTES)
            self.retained_candidate(root)
            connection, websocket = self.make_connection(
                root,
                [self.recovery_status("base_authoritative", BASE_REVISION)],
            )
            connection.tools_exposed = False
            reloaded = []

            response = connection.reconcile_prepared_transaction(
                canonical_blend_path=canonical,
                read_blend_project_id=lambda _path: PROJECT_ID,
                read_blend_scene_hash=lambda path: (
                    BASE_SCENE if path.read_bytes() == BASE_BYTES else CANDIDATE_SCENE
                ),
                reload_blend=lambda path: reloaded.append(path),
            )

            self.assertEqual(response["status"], "base_authoritative")
            self.assertEqual(canonical.read_bytes(), BASE_BYTES)
            self.assertEqual(reloaded, [canonical])
            self.assertTrue(connection.tools_exposed)
            self.assertFalse((root / ".cclay" / "prepared-transaction.json").exists())
            self.assertEqual(
                [message["type"] for message in websocket.sent],
                ["bridge_transaction_reconcile"],
            )

    def test_startup_reconcile_accepts_authoritative_candidate_and_cleans(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            canonical = root / "scene.blend"
            canonical.write_bytes(BASE_BYTES)
            self.retained_candidate(root)
            connection, websocket = self.make_connection(
                root,
                [self.recovery_status("candidate_authoritative", CANDIDATE_REVISION)],
            )
            connection.tools_exposed = False

            response = connection.reconcile_prepared_transaction(
                canonical_blend_path=canonical,
                read_blend_project_id=lambda _path: PROJECT_ID,
                read_blend_scene_hash=lambda _path: CANDIDATE_SCENE,
                reload_blend=lambda _path: self.fail(
                    "candidate recovery must not restore base"
                ),
            )

            self.assertEqual(response["status"], "candidate_authoritative")
            self.assertEqual(canonical.read_bytes(), CANDIDATE_BYTES)
            self.assertTrue(connection.tools_exposed)
            self.assertFalse((root / ".cclay" / "prepared-transaction.json").exists())
            self.assertEqual(
                [message["type"] for message in websocket.sent],
                [
                    "bridge_transaction_reconcile",
                    "bridge_transaction_acknowledged",
                ],
            )

    def test_unknown_startup_authority_retains_evidence_and_hides_tools(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            canonical = root / "scene.blend"
            canonical.write_bytes(BASE_BYTES)
            self.retained_candidate(root)
            connection, _websocket = self.make_connection(
                root,
                [self.recovery_status("unknown", BASE_REVISION)],
            )

            with self.assertRaisesRegex(
                DurableCommitReconciliationRequired,
                "authority is unknown",
            ):
                connection.reconcile_prepared_transaction(
                    canonical_blend_path=canonical,
                    read_blend_project_id=lambda _path: PROJECT_ID,
                    read_blend_scene_hash=lambda _path: CANDIDATE_SCENE,
                    reload_blend=lambda _path: None,
                )

            self.assertFalse(connection.tools_exposed)
            self.assertTrue((root / ".cclay" / "prepared-transaction.json").exists())

if __name__ == "__main__":
    unittest.main()
