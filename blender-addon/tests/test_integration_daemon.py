"""Section 14 Blender/add-on -> daemon -> Pi inspect integration scenario."""

from __future__ import annotations

import json
import os
import shutil
import tempfile
import socket
import subprocess
import sys
import time
import unittest
import uuid
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPOSITORY_ROOT / "blender-addon"))

from oh_my_blender.canonical import canonical_revision  # noqa: E402
from oh_my_blender.daemon_child import DaemonChild  # noqa: E402
from oh_my_blender.handshake import build_hello, validate_hello_ack  # noqa: E402
from oh_my_blender.ws_client import ProtocolError, WebSocketClient, WebSocketError  # noqa: E402

BLENDER = Path("/opt/homebrew/bin/blender")
BLENDER_FIXTURE_SCRIPT = (
    REPOSITORY_ROOT / "blender-addon/tests/fixtures/init_and_export_fixture.py"
)
DAEMON_COMMAND = ["node", "--import", "tsx", "apps/omb-daemon/src/main.ts", "--port", "0", "--faux"]
DELAYED_DAEMON_COMMAND = [
    "node",
    "--import",
    "tsx",
    "blender-addon/tests/fixtures/delayed_faux_daemon.ts",
]

if shutil.which("node") is None:
    raise unittest.SkipTest("node is unavailable")
try:
    subprocess.run(
        ["node", "--import", "tsx", "-e", ""],
        cwd=REPOSITORY_ROOT,
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=10,
    )
except (OSError, subprocess.SubprocessError):
    raise unittest.SkipTest("tsx is unavailable")
if not BLENDER.is_file():
    raise unittest.SkipTest(f"Blender is unavailable at {BLENDER}")


class DaemonIntegrationTest(unittest.TestCase):
    def setUp(self) -> None:
        self.children: list[DaemonChild] = []
        self.tokens: list[bytes] = []
        self.clients: list[WebSocketClient] = []
        self.temporary_directory = tempfile.TemporaryDirectory()
        # architecture doc line 425: "git status --porcelain is unchanged" --
        # capture the tree state before the test drives any subprocess so
        # tearDown can prove the real Blender/daemon runs left no stray
        # repo-tracked-tree mutation (all fixture artifacts live under
        # self.temporary_directory, outside REPOSITORY_ROOT).
        self.initial_git_status = subprocess.run(
            ["git", "status", "--porcelain"],
            cwd=REPOSITORY_ROOT,
            check=True,
            capture_output=True,
            text=True,
        ).stdout

    def tearDown(self) -> None:
        temporary_directory_path = Path(self.temporary_directory.name)
        pids = [child.process.pid for child in self.children]
        for client in self.clients:
            client.socket.close()
            client.closed = True
        for child in self.children:
            if child.process.poll() is None:
                child.kill()
            else:
                child.close_streams()
        for pid in pids:
            with self.assertRaises(ProcessLookupError, msg=f"daemon pid {pid} was not reaped"):
                os.kill(pid, 0)
        excluded = {".git", "node_modules"}
        for root, directories, files in os.walk(REPOSITORY_ROOT):
            directories[:] = [name for name in directories if name not in excluded]
            for name in files:
                path = Path(root, name)
                try:
                    contents = path.read_bytes()
                except OSError:
                    continue
                for token in self.tokens:
                    self.assertNotIn(token, contents, f"bearer token persisted in {path}")
        self.temporary_directory.cleanup()
        # architecture doc line 422: "temporary project/session/artifact
        # directories are absent" -- the test's own scratch directory (which
        # held the real-Blender project, .omb store, and exported snapshot)
        # must not survive teardown.
        self.assertFalse(
            temporary_directory_path.exists(),
            f"temporary project directory survived teardown: {temporary_directory_path}",
        )
        # architecture doc line 425: no repo-tracked-tree mutation leaked out
        # of the real Blender/daemon subprocess runs this test drove.
        final_git_status = subprocess.run(
            ["git", "status", "--porcelain"],
            cwd=REPOSITORY_ROOT,
            check=True,
            capture_output=True,
            text=True,
        ).stdout
        self.assertEqual(
            final_git_status,
            self.initial_git_status,
            "git status --porcelain changed during the integration test",
        )

    def spawn(self, command: list[str] = DAEMON_COMMAND) -> tuple[DaemonChild, dict]:
        child = DaemonChild.spawn(command, cwd=REPOSITORY_ROOT)
        self.children.append(child)
        record = child.read_startup_record(timeout=15)
        self.tokens.append(record["bearer_token"].encode("ascii"))
        return child, record
    def initialize_fixture(self) -> tuple[dict, str, str, subprocess.CompletedProcess[str]]:
        project_directory = Path(self.temporary_directory.name) / "project"
        snapshot_path = Path(self.temporary_directory.name) / "snapshot.json"
        completed = subprocess.run(
            [
                str(BLENDER),
                "--background",
                "--factory-startup",
                "--python",
                str(BLENDER_FIXTURE_SCRIPT),
                "--",
                "--project-dir",
                str(project_directory),
                "--output",
                str(snapshot_path),
            ],
            cwd=REPOSITORY_ROOT,
            check=False,
            capture_output=True,
            text=True,
            timeout=60,
        )
        self.assertEqual(
            completed.returncode,
            0,
            f"headless Blender failed\nstdout:\n{completed.stdout}\nstderr:\n{completed.stderr}",
        )
        snapshot = json.loads(snapshot_path.read_text(encoding="utf-8"))
        revision = canonical_revision(snapshot)
        self.assertIn(f"OMB_REVISION={revision}", completed.stdout)

        project_index = json.loads(
            (project_directory / ".omb" / "project.json").read_text(encoding="utf-8")
        )
        project_id = project_index["project_id"]
        parsed_project_id = uuid.UUID(project_id)
        self.assertEqual(parsed_project_id.version, 4)
        self.assertEqual(str(parsed_project_id), project_id)
        self.assertIn(f"OMB_PROJECT_ID={project_id}", completed.stdout)
        self.assertTrue((project_directory / ".omb" / "journal.jsonl").is_file())
        self.assertTrue((project_directory / "fixture.blend").is_file())
        return snapshot, revision, project_id, completed

    def request(self, client: WebSocketClient, snapshot: dict, revision: str, deadline_ms: int) -> str:
        request_id = str(uuid.uuid4())
        client.send_json({
            "type": "request",
            "id": request_id,
            "method": "inspect_project",
            "params": {"snapshot": snapshot},
            "expected_revision_id": revision,
            "deadline_ms": deadline_ms,
        })
        return request_id

    def exercise_request_lifecycle(
        self, client: WebSocketClient, snapshot: dict, revision: str
    ) -> None:
        timeout_id = self.request(client, snapshot, revision, 100)
        timeout_message = client.recv_json()
        self.assertEqual(timeout_message["type"], "error")
        self.assertEqual(timeout_message["id"], timeout_id)
        self.assertEqual(timeout_message["code"], "TIMEOUT")

        cancelled_id = self.request(client, snapshot, revision, 10000)
        client.send_json({"type": "cancel", "id": cancelled_id})
        cancelled_messages = [client.recv_json(), client.recv_json()]
        self.assertEqual(
            sum(
                message == {
                    "type": "cancel_ack",
                    "id": cancelled_id,
                    "status": "accepted",
                }
                for message in cancelled_messages
            ),
            1,
        )
        cancelled_terminals = [
            message
            for message in cancelled_messages
            if message.get("id") == cancelled_id
            and message.get("type") in {"error", "response"}
        ]
        self.assertEqual(len(cancelled_terminals), 1)
        self.assertEqual(cancelled_terminals[0]["type"], "error")
        self.assertEqual(cancelled_terminals[0]["code"], "CANCELLED")

        active_id = self.request(client, snapshot, revision, 10000)
        busy_id = self.request(client, snapshot, revision, 10000)
        busy_message = client.recv_json()
        self.assertEqual(busy_message["type"], "error")
        self.assertEqual(busy_message["id"], busy_id)
        self.assertEqual(busy_message["code"], "BUSY")
        self.assertIs(busy_message["retryable"], True)
        client.send_json({"type": "cancel", "id": active_id})
        active_messages = [client.recv_json(), client.recv_json()]
        self.assertEqual(
            sum(
                message.get("type") == "cancel_ack"
                and message.get("id") == active_id
                and message.get("status") == "accepted"
                for message in active_messages
            ),
            1,
        )
        self.assertEqual(
            sum(
                message.get("type") == "error"
                and message.get("id") == active_id
                and message.get("code") == "CANCELLED"
                for message in active_messages
            ),
            1,
        )


    def inspect(self, record: dict, snapshot: dict, revision: str) -> tuple[WebSocketClient, dict]:
        client = WebSocketClient.connect(record["port"], record["bearer_token"])
        self.clients.append(client)
        client.send_json(build_hello(str(uuid.uuid4()), "0.1.0", "4.3.0"))
        ack = validate_hello_ack(client.recv_json())
        self.assertEqual(ack["launch_id"], record["launch_id"])
        # Protocol v1 has no server request message: Blender extracts the snapshot,
        # then this request drives daemon -> one Pi turn -> inspect_project -> response.
        request_id = str(uuid.uuid4())
        client.send_json({
            "type": "request",
            "id": request_id,
            "method": "inspect_project",
            "params": {"snapshot": snapshot},
            "expected_revision_id": revision,
            "deadline_ms": 30000,
        })
        response = client.recv_json()
        self.assertEqual(response["type"], "response")
        self.assertEqual(response["id"], request_id)
        self.assertEqual(response["resulting_revision_id"], revision)
        self.assertEqual(response["result"]["revision"], revision)
        return client, ack

    def shutdown(self, child: DaemonChild, client: WebSocketClient, port: int) -> float:
        started = time.monotonic()
        client.send_json({"type": "shutdown", "reason": "addon_unload"})
        self.assertEqual(client.recv_json(), {"type": "shutdown_ack"})
        with self.assertRaises((WebSocketError, OSError)):
            client.recv_text()
        child.process.wait(timeout=8)
        elapsed = time.monotonic() - started
        self.assertLess(elapsed, 8.0)
        with self.assertRaises(OSError):
            socket.create_connection(("127.0.0.1", port), timeout=0.25)
        return elapsed
    def connect(self, record: dict) -> tuple[WebSocketClient, dict]:
        client = WebSocketClient.connect(record["port"], record["bearer_token"])
        self.clients.append(client)
        client.send_json(build_hello(str(uuid.uuid4()), "0.1.0", "5.1.2"))
        ack = validate_hello_ack(client.recv_json())
        self.assertEqual(ack["launch_id"], record["launch_id"])
        return client, ack


    def test_real_daemon_inspect_shutdown_and_restart(self) -> None:
        snapshot, revision, project_id, blender_run = self.initialize_fixture()
        # Recompute the revision from the freshly exported snapshot rather than
        # trusting either a copied hash constant or Blender's printed value.

        first_child, first_record = self.spawn(DELAYED_DAEMON_COMMAND)
        first_client, first_ack = self.connect(first_record)
        self.exercise_request_lifecycle(first_client, snapshot, revision)
        with self.assertRaises(ProtocolError):
            WebSocketClient.connect(first_record["port"], first_record["bearer_token"])
        first_shutdown = self.shutdown(first_child, first_client, first_record["port"])

        second_child, second_record = self.spawn()
        second_client, second_ack = self.inspect(second_record, snapshot, revision)
        for field in ("launch_id", "bearer_token"):
            self.assertNotEqual(first_record[field], second_record[field])
        for field in ("session_id", "server_nonce"):
            self.assertNotEqual(first_ack[field], second_ack[field])
        second_shutdown = self.shutdown(second_child, second_client, second_record["port"])

        print(
            f"section14 launch_ids={first_record['launch_id']},{second_record['launch_id']} "
            f"project_id={project_id} revision={revision} blender_exit={blender_run.returncode} "
            f"blender_stderr={blender_run.stderr.strip()!r} "
            f"shutdown_s={first_shutdown:.3f},{second_shutdown:.3f}"
        )


if __name__ == "__main__":
    unittest.main()
