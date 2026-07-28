"""Tests for independent owner/peer controller connection lifecycle."""

import json
import os
import pathlib
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).parents[1]))

from cclay import connection as connection_module
from cclay.connection import (
    Connection,
    LifecycleState,
    configure_bridge_auto_reconnect,
    consume_discovery_slot,
    poll_active_bridge_reconnect,
)
from cclay.controller_connection import (
    ControllerConnection,
    ControllerConnectionError,
    ControllerState,
)


PROJECT_ID = "123e4567-e89b-42d3-a456-426614174000"
LAUNCH_ID = "223e4567-e89b-42d3-a456-426614174000"
LINEAGE_ID = "323e4567-e89b-42d3-a456-426614174000"
SESSION_ID = "423e4567-e89b-42d3-a456-426614174000"
TICKET = "A" * 43
RESUME_1 = "B" * 43
RESUME_2 = "C" * 43


class FakeSocketHandle:
    def settimeout(self, _timeout):
        pass

    def shutdown(self, _how):
        pass


class FakeWebSocket:
    calls = []
    replies_by_call = []

    def __init__(self, replies):
        self.replies = iter(replies)
        self.sent = []
        self.closed = False
        self.socket = FakeSocketHandle()

    @classmethod
    def connect(cls, port, token, timeout=10.0, *, role=None):
        cls.calls.append((port, token, timeout, role))
        return cls(cls.replies_by_call.pop(0))

    def send_json(self, message):
        self.sent.append(message)

    def recv_json(self):
        return next(self.replies)

    def close(self, code=1000):
        self.closed = True
        self.close_code = code


def hello_ack():
    return {
        "type": "hello_ack",
        "protocol": 1,
        "daemon_version": "0.1.0",
        "launch_id": LAUNCH_ID,
        "session_id": SESSION_ID,
        "server_nonce": "A" * 22,
        "capabilities": ["inspect_project", "controller_peers_v1"],
        "protocol_features": ["snapshot_cursor_v2"],
    }


def peer_auth(token=RESUME_1, generation=1):
    return {
        "type": "controller_peer_auth",
        "resume_token": token,
        "launch_id": LAUNCH_ID,
        "lineage_id": LINEAGE_ID,
        "generation": generation,
        "expires_in_ms": 300000,
    }


def owner_auth():
    return {
        "type": "controller_auth",
        "resume_token": RESUME_1,
        "launch_id": LAUNCH_ID,
    }


class ControllerConnectionTests(unittest.TestCase):
    def setUp(self):
        FakeWebSocket.calls = []
        FakeWebSocket.replies_by_call = []

    def runtime_directory(self, root):
        runtime = pathlib.Path(root) / "cclay-501" / LAUNCH_ID
        runtime.mkdir(parents=True, mode=0o700)
        os.chmod(runtime.parent, 0o700)
        os.chmod(runtime, 0o700)
        endpoint = runtime / "endpoint.json"
        endpoint.write_text(json.dumps({
            "schema_version": 1,
            "launch_id": LAUNCH_ID,
            "host": "127.0.0.1",
            "port": 43123,
        }), encoding="utf-8")
        os.chmod(endpoint, 0o600)
        return runtime

    def write_slot(self, runtime, slot, generation=1, lineage_id=LINEAGE_ID):
        name = "bridge-slot.json" if slot == "bridge" else "controller-peer-slot.json"
        payload = {
            "schema_version": 1,
            "project_id": PROJECT_ID,
            "ticket": TICKET,
            "expires_at_ms": 9_999_999_999_999,
            "generation": generation,
        }
        if slot == "controller_peer":
            payload["lineage_id"] = lineage_id
        path = runtime / name
        path.write_text(json.dumps(payload), encoding="utf-8")
        os.chmod(path, 0o600)
        return path

    def test_discovery_slots_are_consumed_independently(self):
        with tempfile.TemporaryDirectory() as root:
            runtime = self.runtime_directory(root)
            bridge_path = self.write_slot(runtime, "bridge")
            peer_path = self.write_slot(runtime, "controller_peer")

            peer = consume_discovery_slot(
                PROJECT_ID,
                "controller_peer",
                runtime_user_directory=runtime.parent,
                now_ms=1_000,
            )

            self.assertEqual(peer.runtime_directory, runtime)
            self.assertEqual(peer.ticket, TICKET)
            self.assertEqual(peer.generation, 1)
            self.assertEqual(peer.lineage_id, LINEAGE_ID)
            self.assertFalse(peer_path.exists())
            self.assertTrue(bridge_path.exists())

    def test_discovery_rejects_unknown_fields_and_wrong_lineage_without_consuming(self):
        with tempfile.TemporaryDirectory() as root:
            runtime = self.runtime_directory(root)
            path = self.write_slot(runtime, "controller_peer")
            payload = json.loads(path.read_text(encoding="utf-8"))
            payload["unknown"] = True
            path.write_text(json.dumps(payload), encoding="utf-8")
            os.chmod(path, 0o600)
            self.assertIsNone(consume_discovery_slot(
                PROJECT_ID,
                "controller_peer",
                runtime_user_directory=runtime.parent,
                lineage_id=LINEAGE_ID,
                now_ms=1_000,
            ))
            self.assertTrue(path.exists())

            payload.pop("unknown")
            path.write_text(json.dumps(payload), encoding="utf-8")
            os.chmod(path, 0o600)
            self.assertIsNone(consume_discovery_slot(
                PROJECT_ID,
                "controller_peer",
                runtime_user_directory=runtime.parent,
                lineage_id="523e4567-e89b-42d3-a456-426614174000",
                now_ms=1_000,
            ))
            self.assertTrue(path.exists())

    def test_peer_ticket_attach_accepts_only_targeted_peer_auth(self):
        with tempfile.TemporaryDirectory() as root:
            runtime = self.runtime_directory(root)
            slot_path = self.write_slot(runtime, "controller_peer")
            slot = consume_discovery_slot(
                PROJECT_ID,
                "controller_peer",
                runtime_user_directory=runtime.parent,
                now_ms=1_000,
            )
            self.assertFalse(slot_path.exists())
            FakeWebSocket.replies_by_call = [[hello_ack(), peer_auth()]]

            controller = ControllerConnection.attach_peer(
                slot,
                project_id=PROJECT_ID,
                addon_version="0.1.0",
                blender_version="4.3.0",
                websocket_type=FakeWebSocket,
                start_reader=False,
                jitter=lambda _delay: 0.0,
            )

            self.assertEqual(FakeWebSocket.calls, [(43123, TICKET, 3.0, "controller")])
            self.assertEqual(controller.authority, "peer")
            self.assertEqual(controller.lineage_id, LINEAGE_ID)
            self.assertEqual(controller.generation, 1)
            self.assertEqual(controller.resume_token, RESUME_1)
            self.assertEqual(controller.state, ControllerState.ACTIVE)
            self.assertEqual(controller.websocket.sent[0]["type"], "hello")
            self.assertNotIn("capabilities", controller.websocket.sent[0])

    def test_peer_attach_rejects_owner_auth_without_authority_escalation(self):
        with tempfile.TemporaryDirectory() as root:
            runtime = self.runtime_directory(root)
            self.write_slot(runtime, "controller_peer")
            slot = consume_discovery_slot(
                PROJECT_ID,
                "controller_peer",
                runtime_user_directory=runtime.parent,
                now_ms=1_000,
            )
            FakeWebSocket.replies_by_call = [[hello_ack(), owner_auth()]]

            with self.assertRaisesRegex(ControllerConnectionError, "peer auth"):
                ControllerConnection.attach_peer(
                    slot,
                    project_id=PROJECT_ID,
                    addon_version="0.1.0",
                    blender_version="4.3.0",
                    websocket_type=FakeWebSocket,
                    start_reader=False,
                )

            self.assertTrue(FakeWebSocket.calls)

    def test_peer_resume_uses_exact_launch_lineage_generation_headers_and_ratchets(self):
        with tempfile.TemporaryDirectory() as root:
            runtime = self.runtime_directory(root)
            self.write_slot(runtime, "controller_peer")
            slot = consume_discovery_slot(
                PROJECT_ID,
                "controller_peer",
                runtime_user_directory=runtime.parent,
                now_ms=1_000,
            )
            FakeWebSocket.replies_by_call = [[hello_ack(), peer_auth()]]
            resumed = FakeWebSocket([hello_ack(), peer_auth(RESUME_2, 2)])
            resume_calls = []

            def resume_connect(port, token, headers, timeout):
                resume_calls.append((port, token, headers, timeout))
                return resumed

            controller = ControllerConnection.attach_peer(
                slot,
                project_id=PROJECT_ID,
                addon_version="0.1.0",
                blender_version="4.3.0",
                websocket_type=FakeWebSocket,
                resume_connect=resume_connect,
                start_reader=False,
                jitter=lambda _delay: 0.0,
            )
            controller.mark_lost()

            self.assertTrue(controller.poll_reconnect(force=True))

            self.assertEqual(resume_calls, [(
                43123,
                RESUME_1,
                {
                    "X-CCLAY-Launch-ID": LAUNCH_ID,
                    "X-CCLAY-Peer-Lineage-ID": LINEAGE_ID,
                    "X-CCLAY-Peer-Generation": "1",
                },
                3.0,
            )])
            self.assertEqual(controller.resume_token, RESUME_2)
            self.assertEqual(controller.generation, 2)
            self.assertEqual(controller.state, ControllerState.ACTIVE)

    def test_owner_resume_uses_only_launch_binding_header(self):
        FakeWebSocket.replies_by_call = [[hello_ack(), owner_auth()]]
        resumed = FakeWebSocket([hello_ack(), owner_auth()])
        resume_calls = []
        controller = ControllerConnection.connect_owner(
            port=43123,
            boot_token=TICKET,
            launch_id=LAUNCH_ID,
            project_id=PROJECT_ID,
            addon_version="0.1.0",
            blender_version="4.3.0",
            runtime_directory=None,
            websocket_type=FakeWebSocket,
            resume_connect=lambda port, token, headers, timeout: (
                resume_calls.append((port, token, headers, timeout)) or resumed
            ),
            start_reader=False,
            jitter=lambda _delay: 0.0,
        )
        controller.mark_lost()

        self.assertTrue(controller.poll_reconnect(force=True))
        self.assertEqual(resume_calls[0][2], {"X-CCLAY-Launch-ID": LAUNCH_ID})
        self.assertEqual(controller.authority, "owner")

    def test_unknown_server_frame_closes_and_enters_reconnect_without_queueing(self):
        FakeWebSocket.replies_by_call = [[hello_ack(), owner_auth()]]
        controller = ControllerConnection.connect_owner(
            port=43123,
            boot_token=TICKET,
            launch_id=LAUNCH_ID,
            project_id=PROJECT_ID,
            addon_version="0.1.0",
            blender_version="4.3.0",
            runtime_directory=None,
            websocket_type=FakeWebSocket,
            start_reader=False,
        )

        with self.assertRaisesRegex(ControllerConnectionError, "unknown server frame"):
            controller.handle_server_message({"type": "future_unknown"})

        self.assertEqual(controller.state, ControllerState.LOST)
        self.assertTrue(controller.websocket.closed)
        self.assertEqual(controller.drain_updates(), [])

    def test_drain_surface_is_bounded_by_count_and_budget(self):
        FakeWebSocket.replies_by_call = [[hello_ack(), owner_auth()]]
        controller = ControllerConnection.connect_owner(
            port=43123,
            boot_token=TICKET,
            launch_id=LAUNCH_ID,
            project_id=PROJECT_ID,
            addon_version="0.1.0",
            blender_version="4.3.0",
            runtime_directory=None,
            websocket_type=FakeWebSocket,
            start_reader=False,
        )
        for sequence in range(40):
            controller.handle_server_message({
                "type": "director_turn_started",
                "id": f"{sequence:08d}-0000-4000-8000-000000000000",
                "sequence": 0,
                "at": "2026-07-20T00:00:00.000Z",
            })

        clock = mock.Mock(side_effect=[0.0, 0.0, 0.001, 0.005])
        drained = controller.drain_updates(max_updates=32, budget_ms=4.0, clock=clock)

        self.assertEqual(len(drained), 2)
        self.assertEqual(controller.pending_update_count, 38)

    def test_bridge_reconnect_consumes_only_reissued_bridge_generation(self):
        with tempfile.TemporaryDirectory() as root:
            project = pathlib.Path(root) / "project"
            project.mkdir()
            cclay = project / ".cclay"
            cclay.mkdir()
            (cclay / "project.json").write_text(json.dumps({
                "project_id": PROJECT_ID,
                "schema_version": 1,
                "current_revision_id": "a" * 64,
                "manifest": {
                    "revisionId": "a" * 64,
                    "sceneHash": "b" * 64,
                },
            }), encoding="utf-8")
            runtime = self.runtime_directory(root)
            peer_path = self.write_slot(runtime, "controller_peer")
            bridge_path = self.write_slot(runtime, "bridge", generation=2)

            old = Connection(None, FakeWebSocket(()), project_directory=project)
            old.identity = {"launch_id": LAUNCH_ID}
            old.state = LifecycleState.DISCONNECTED
            replacement = Connection(
                None,
                FakeWebSocket(()),
                project_directory=project,
                tools_exposed=False,
            )
            configure_bridge_auto_reconnect(
                old,
                cwd=project,
                project_id=PROJECT_ID,
                addon_version="0.1.0",
                blender_version="4.3.0",
                runtime_user_directory=runtime.parent,
                live_scene_hash_fn=lambda expected: expected,
                jitter=lambda _delay: 0.0,
                websocket_type=FakeWebSocket,
            )
            connection_module._active_connection = old
            connection_module._begin_bridge_auto_reconnect(old)

            with mock.patch.object(
                Connection, "attach", return_value=replacement
            ) as attach:
                self.assertTrue(poll_active_bridge_reconnect(force=True))

            self.assertFalse(bridge_path.exists())
            self.assertTrue(peer_path.exists())
            self.assertIs(connection_module._active_connection, replacement)
            self.assertTrue(replacement.tools_exposed)
            self.assertEqual(old.state, LifecycleState.STOPPED)
            self.assertEqual(attach.call_args.args[:2], (runtime, TICKET))
            connection_module._active_connection = None
            connection_module.reset_lifecycle_state()

if __name__ == "__main__":
    unittest.main()
