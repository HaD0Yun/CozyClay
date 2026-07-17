"""Section 14 Blender/add-on -> daemon -> Pi inspect integration scenario."""

from __future__ import annotations

import json
import os
import shutil
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

SNAPSHOT_PATH = REPOSITORY_ROOT / "packages/blender-protocol/test/fixtures/blender-exported-snapshot.json"
DAEMON_COMMAND = ["node", "--import", "tsx", "apps/omb-daemon/src/main.ts", "--port", "0", "--faux"]

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


class DaemonIntegrationTest(unittest.TestCase):
    def setUp(self) -> None:
        self.children: list[DaemonChild] = []
        self.tokens: list[bytes] = []
        self.clients: list[WebSocketClient] = []

    def tearDown(self) -> None:
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

    def spawn(self) -> tuple[DaemonChild, dict]:
        child = DaemonChild.spawn(DAEMON_COMMAND, cwd=REPOSITORY_ROOT)
        self.children.append(child)
        record = child.read_startup_record(timeout=15)
        self.tokens.append(record["bearer_token"].encode("ascii"))
        return child, record

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

    def test_real_daemon_inspect_shutdown_and_restart(self) -> None:
        snapshot = json.loads(SNAPSHOT_PATH.read_text(encoding="utf-8"))
        # Recomputing the fixture-adjacent parity value here proves Python/TS parity
        # in the actual request flow rather than trusting a copied hash constant.
        revision = canonical_revision(snapshot)

        first_child, first_record = self.spawn()
        first_client, first_ack = self.inspect(first_record, snapshot, revision)
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
            f"revision={revision} shutdown_s={first_shutdown:.3f},{second_shutdown:.3f}"
        )


if __name__ == "__main__":
    unittest.main()
