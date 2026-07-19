"""Tests for secure T2 bridge attachment through daemon runtime discovery."""

import base64

import json
import os
import pathlib
import stat
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).parents[1]))

from oh_my_blender.connection import Connection, ConnectionError
from oh_my_blender.ws_client import ProtocolError, WebSocketClient

ATTACH_TICKET = "A" * 43


class FakeSocketHandle:
    def settimeout(self, _timeout):
        pass


class FakeWebSocket:
    calls = []

    def __init__(self, replies):
        self.replies = iter(replies)
        self.sent = []
        self.closed = False
        self.socket = FakeSocketHandle()

    @classmethod
    def connect(cls, port, token, timeout=10.0, *, role=None):
        cls.calls.append((port, token, timeout, role))
        return cls([{
            "type": "hello_ack",
            "protocol": 2,
            "daemon_version": "0.1.0",
            "launch_id": "11111111-1111-4111-8111-111111111111",
            "session_id": "22222222-2222-4222-8222-222222222222",
            "server_nonce": "AAAAAAAAAAAAAAAAAAAAAA",
            "capabilities": ["mutation_bridge_v2"],
        }])

    def send_json(self, message):
        self.sent.append(message)

    def recv_json(self):
        return next(self.replies)

    def close(self):
        self.closed = True


class AttachConnectionTests(unittest.TestCase):
    def setUp(self):
        FakeWebSocket.calls = []

    def _runtime_directory(self, root):
        runtime = pathlib.Path(root) / "omb-501" / "11111111-1111-4111-8111-111111111111"
        runtime.mkdir(parents=True, mode=0o700)
        os.chmod(runtime.parent, 0o700)
        os.chmod(runtime, 0o700)
        endpoint = runtime / "endpoint.json"
        endpoint.write_text(json.dumps({
            "schema_version": 1,
            "launch_id": "11111111-1111-4111-8111-111111111111",
            "host": "127.0.0.1",
            "port": 43123,
        }), encoding="utf-8")
        os.chmod(endpoint, 0o600)
        return runtime

    def test_attach_discovers_endpoint_and_authenticates_as_bridge(self):
        with tempfile.TemporaryDirectory() as root:
            runtime = self._runtime_directory(root)
            connection = Connection.attach(
                runtime,
                ATTACH_TICKET,
                cwd=root,
                project_id="33333333-3333-4333-8333-333333333333",
                addon_version="0.1.0",
                blender_version="4.3.0",
                websocket_type=FakeWebSocket,
            )

            self.assertEqual(FakeWebSocket.calls, [(43123, ATTACH_TICKET, 3.0, "bridge")])
            self.assertIsNone(connection.child)
            self.assertEqual(connection.identity["launch_id"], runtime.name)
            self.assertEqual(connection.identity["attach_mode"], "ticket")
            self.assertEqual(connection.websocket.sent[0]["type"], "hello")

            connection.disconnect("addon_unload", timeout=0.01)
            self.assertFalse(any(message.get("type") == "shutdown" for message in connection.websocket.sent))
            self.assertTrue(connection.websocket.closed)

    def test_attach_rejects_group_accessible_runtime_directory(self):
        with tempfile.TemporaryDirectory() as root:
            runtime = self._runtime_directory(root)
            os.chmod(runtime, 0o750)
            with self.assertRaisesRegex(ConnectionError, "private"):
                Connection.attach(
                    runtime,
                    ATTACH_TICKET,
                    cwd=root,
                    project_id="33333333-3333-4333-8333-333333333333",
                    addon_version="0.1.0",
                    blender_version="4.3.0",
                    websocket_type=FakeWebSocket,
                )

    def test_attach_rejects_symlinked_endpoint(self):
        with tempfile.TemporaryDirectory() as root:
            runtime = self._runtime_directory(root)
            endpoint = runtime / "endpoint.json"
            target = pathlib.Path(root) / "endpoint-target.json"
            endpoint.replace(target)
            endpoint.symlink_to(target)
            self.assertTrue(stat.S_ISLNK(endpoint.lstat().st_mode))
            with self.assertRaisesRegex(ConnectionError, "symlink"):
                Connection.attach(
                    runtime,
                    ATTACH_TICKET,
                    cwd=root,
                    project_id="33333333-3333-4333-8333-333333333333",
                    addon_version="0.1.0",
                    blender_version="4.3.0",
                    websocket_type=FakeWebSocket,
                )

    def test_attach_discovers_and_connects_to_a_real_daemon(self):
        repository_root = pathlib.Path(__file__).parents[2]
        loader = next(
            parent / "node_modules/tsx/dist/loader.mjs"
            for parent in (repository_root, *repository_root.parents)
            if (parent / "node_modules/tsx/dist/loader.mjs").is_file()
        )
        daemon_main = repository_root / "apps/omb-daemon/src/main.ts"
        with tempfile.TemporaryDirectory() as project:
            process = subprocess.Popen(
                [
                    "node",
                    "--import",
                    str(loader),
                    str(daemon_main),
                    "--port",
                    "0",
                    "--faux",
                ],
                cwd=project,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            controller = None
            bridge = None
            try:
                assert process.stdout is not None
                startup_line = process.stdout.readline()
                if not startup_line:
                    assert process.stderr is not None
                    self.fail(f"daemon startup failed: {process.stderr.read()}")
                startup = json.loads(startup_line)
                controller = WebSocketClient.connect(
                    startup["port"],
                    startup["bearer_token"],
                    timeout=3.0,
                    role="controller",
                )
                controller.send_json({
                    "type": "hello",
                    "protocol": 1,
                    "addon_version": "controller-test",
                    "blender_version": "n/a",
                    "project_id": "33333333-3333-4333-8333-333333333333",
                    "client_nonce": base64.urlsafe_b64encode(
                        os.urandom(16)
                    ).decode("ascii").rstrip("="),
                })
                self.assertEqual(controller.recv_json()["type"], "hello_ack")
                self.assertEqual(controller.recv_json()["type"], "controller_auth")
                controller.send_json({
                    "type": "issue_attach_ticket",
                    "role": "bridge",
                })
                issued = controller.recv_json()
                self.assertEqual(issued["type"], "attach_ticket")

                bridge = Connection.attach(
                    issued["runtime_directory"],
                    issued["ticket"],
                    cwd=project,
                    project_id="33333333-3333-4333-8333-333333333333",
                    addon_version="0.1.0",
                    blender_version="4.3.0",
                )
                bridge.disconnect("test_detach", timeout=0.1)
                bridge = None
                with self.assertRaises(ProtocolError):
                    WebSocketClient.connect(
                        startup["port"],
                        issued["ticket"],
                        timeout=1.0,
                        role="bridge",
                    )

                controller.send_json({
                    "type": "shutdown",
                    "reason": "controller_test",
                })
                self.assertEqual(controller.recv_json()["type"], "shutdown_ack")
                process.wait(timeout=3.0)
                self.assertEqual(process.returncode, 0)
            finally:
                if bridge is not None:
                    bridge.disconnect("test_cleanup", timeout=0.1)
                if controller is not None and not controller.closed:
                    controller.close()
                if process.poll() is None:
                    process.kill()
                    process.wait(timeout=3.0)
                if process.stdout is not None:
                    process.stdout.close()
                if process.stderr is not None:
                    process.stderr.close()


if __name__ == "__main__":
    unittest.main()
