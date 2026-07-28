"""Tests for secure T2 bridge attachment through daemon runtime discovery."""


import json
import os
import pathlib
import stat
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).parents[1]))

from cclay.connection import (
    Connection,
    ConnectionError,
    connect_from_handoff,
    connect_pi_extension,
    consume_attach_handoff,
)

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
        runtime = pathlib.Path(root) / "cclay-501" / "11111111-1111-4111-8111-111111111111"
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

    def _handoff(self, runtime, *, project_id="33333333-3333-4333-8333-333333333333", expires_at_ms=9_999_999_999_999):
        path = runtime / "attach-handoff.json"
        path.write_text(json.dumps({
            "schema_version": 1,
            "project_id": project_id,
            "ticket": ATTACH_TICKET,
            "expires_at_ms": expires_at_ms,
        }), encoding="utf-8")
        os.chmod(path, 0o600)
        return path

    def test_discovery_consumes_matching_handoff(self):
        with tempfile.TemporaryDirectory() as root:
            runtime = self._runtime_directory(root)
            handoff = self._handoff(runtime)
            discovered = consume_attach_handoff(
                "33333333-3333-4333-8333-333333333333",
                runtime_user_directory=runtime.parent,
                now_ms=1_000,
            )
            self.assertEqual(discovered, (runtime, ATTACH_TICKET))
            self.assertFalse(handoff.exists())

    def test_discovery_skips_wrong_project(self):
        with tempfile.TemporaryDirectory() as root:
            runtime = self._runtime_directory(root)
            handoff = self._handoff(runtime, project_id="44444444-4444-4444-8444-444444444444")
            self.assertIsNone(consume_attach_handoff(
                "33333333-3333-4333-8333-333333333333",
                runtime_user_directory=runtime.parent,
                now_ms=1_000,
            ))
            self.assertTrue(handoff.exists())

    def test_discovery_deletes_expired_handoff(self):
        with tempfile.TemporaryDirectory() as root:
            runtime = self._runtime_directory(root)
            handoff = self._handoff(runtime, expires_at_ms=999)
            self.assertIsNone(consume_attach_handoff(
                "33333333-3333-4333-8333-333333333333",
                runtime_user_directory=runtime.parent,
                now_ms=1_000,
            ))
            self.assertFalse(handoff.exists())

    def test_discovery_rejects_symlinked_and_world_readable_handoffs(self):
        with tempfile.TemporaryDirectory() as root:
            runtime = self._runtime_directory(root)
            handoff = self._handoff(runtime)
            os.chmod(handoff, 0o644)
            self.assertIsNone(consume_attach_handoff(
                "33333333-3333-4333-8333-333333333333",
                runtime_user_directory=runtime.parent,
                now_ms=1_000,
            ))
            self.assertTrue(handoff.exists())
            handoff.unlink()
            target = pathlib.Path(root) / "handoff-target.json"
            target.write_text("{}", encoding="utf-8")
            handoff.symlink_to(target)
            self.assertIsNone(consume_attach_handoff(
                "33333333-3333-4333-8333-333333333333",
                runtime_user_directory=runtime.parent,
                now_ms=1_000,
            ))
            self.assertTrue(handoff.is_symlink())

    def test_handoff_is_consumed_even_when_attach_fails(self):
        with tempfile.TemporaryDirectory() as root:
            runtime = self._runtime_directory(root)
            handoff = self._handoff(runtime)
            with mock.patch(
                "cclay.connection.connect",
                side_effect=ConnectionError("attach failed"),
            ):
                with self.assertRaisesRegex(ConnectionError, "attach failed"):
                    connect_from_handoff(
                        cwd=root,
                        project_id="33333333-3333-4333-8333-333333333333",
                        addon_version="0.1.0",
                        blender_version="4.3.0",
                        runtime_user_directory=runtime.parent,
                    )
            self.assertFalse(handoff.exists())

    def test_connect_from_handoff_reports_tui_instruction_when_none_found(self):
        with tempfile.TemporaryDirectory() as root:
            user_directory = pathlib.Path(root) / "cclay-501"
            user_directory.mkdir(mode=0o700)
            with self.assertRaisesRegex(ConnectionError, "run the cclay TUI first"):
                connect_from_handoff(
                    cwd=root,
                    project_id="33333333-3333-4333-8333-333333333333",
                    addon_version="0.1.0",
                    blender_version="4.3.0",
                    runtime_user_directory=user_directory,
                )

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

    def test_connect_attach_mode_exposes_tools_without_pending_marker(self):
        """The production attach path must reconcile and expose bridge tools."""
        import cclay.connection as connection_module
        from cclay.connection import connect

        original_attach = Connection.attach.__func__

        def fake_attach(cls, runtime_directory, attach_ticket, **kwargs):
            kwargs["websocket_type"] = FakeWebSocket
            return original_attach(cls, runtime_directory, attach_ticket, **kwargs)

        with tempfile.TemporaryDirectory() as root:
            runtime = self._runtime_directory(root)
            previous_active = connection_module._active_connection
            connection_module._active_connection = None
            try:
                with mock.patch.object(Connection, "attach", classmethod(fake_attach)):
                    connection = connect(
                        cwd=root,
                        project_id="33333333-3333-4333-8333-333333333333",
                        addon_version="0.1.0",
                        blender_version="4.3.0",
                        attach_runtime_directory=runtime,
                        attach_ticket=ATTACH_TICKET,
                    )
                self.assertTrue(
                    connection.tools_exposed,
                    "attach-mode connect must expose tools when no prepared "
                    "transaction marker exists",
                )
                connection.disconnect("addon_unload", timeout=0.01)
            finally:
                connection_module._active_connection = previous_active

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

class PiExtensionConnectionTests(unittest.TestCase):
    def test_reads_private_project_endpoint_and_uses_existing_attach_path(self):
        with tempfile.TemporaryDirectory() as root:
            project = pathlib.Path(root)
            cclay = project / ".cclay"
            cclay.mkdir()
            endpoint = cclay / "pi-bridge.json"
            endpoint.write_text(
                json.dumps({
                    "schema_version": 1,
                    "runtime_directory": str(project / "runtime"),
                    "credential": ATTACH_TICKET,
                }),
                encoding="utf-8",
            )
            os.chmod(endpoint, 0o600)
            sentinel = object()
            with mock.patch(
                "cclay.connection.connect", return_value=sentinel
            ) as connect_mock:
                result = connect_pi_extension(
                    cwd=project,
                    project_id="33333333-3333-4333-8333-333333333333",
                    addon_version="0.1.0",
                    blender_version="5.2.0 LTS",
                )
            self.assertIs(result, sentinel)
            connect_mock.assert_called_once_with(
                cwd=project,
                project_id="33333333-3333-4333-8333-333333333333",
                addon_version="0.1.0",
                blender_version="5.2.0 LTS",
                attach_runtime_directory=str(project / "runtime"),
                attach_ticket=ATTACH_TICKET,
            )

    def test_rejects_world_readable_project_endpoint(self):
        with tempfile.TemporaryDirectory() as root:
            project = pathlib.Path(root)
            cclay = project / ".cclay"
            cclay.mkdir()
            endpoint = cclay / "pi-bridge.json"
            endpoint.write_text(
                json.dumps({
                    "schema_version": 1,
                    "runtime_directory": str(project / "runtime"),
                    "credential": ATTACH_TICKET,
                }),
                encoding="utf-8",
            )
            os.chmod(endpoint, 0o644)
            with self.assertRaisesRegex(
                ConnectionError, "private owned regular file"
            ):
                connect_pi_extension(
                    cwd=project,
                    project_id="33333333-3333-4333-8333-333333333333",
                    addon_version="0.1.0",
                    blender_version="5.2.0 LTS",
                )


if __name__ == "__main__":
    unittest.main()
