"""Tests for add-on connection lifecycle orchestration."""

import json
import pathlib
import subprocess
import tempfile
import sys
from unittest import mock
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).parents[1]))

from oh_my_blender.checkpoint import create_checkpoint
from oh_my_blender.connection import (
    Connection,
    ConnectionError,
    _test_only_inject_disconnect_fault,
    connect,
    disconnect_active,
    verify_reconnect_hash,
    reconnect,
)
from oh_my_blender import connection as connection_module


class FakeProcess:
    def __init__(self, times_out=False):
        self.times_out = times_out
        self.wait_calls = []

    def wait(self, timeout=None):
        self.wait_calls.append(timeout)
        if self.times_out:
            raise subprocess.TimeoutExpired("daemon", timeout)
        return 0


class FakeChild:
    def __init__(self, process):
        self.process = process
        self.killed = False
        self.streams_closed = False

    def kill(self):
        self.killed = True

    def close_streams(self):
        self.streams_closed = True


class FakeSocket:
    def __init__(self, replies=()):
        self.closed = False
        self.replies = iter(replies)
        self.sent = []

    def send_json(self, message):
        self.sent.append(message)

    def recv_json(self):
        return next(self.replies)

    def close(self):
        self.closed = True


class ConnectionTests(unittest.TestCase):
    def test_reconnect_gate_accepts_equal_hashes(self):
        """§4 line 119: reconnect requires the canonical live scene hash."""
        verify_reconnect_hash("ab12", "ab12")

    def test_reconnect_gate_rejects_mismatched_hashes(self):
        """§4 line 119: reconnect refuses a non-canonical live scene."""
        with self.assertRaises(ConnectionError):
            verify_reconnect_hash("ab12", "cd34")

    def test_only_disconnect_fault_injector_mutates_target_value(self):
        """§12 line 411: the test fault changes one harmless property."""
        entities = {"object:cube": {"visible": True, "name": "Cube"}}

        _test_only_inject_disconnect_fault(entities, "object:cube", "visible", False)

        self.assertFalse(entities["object:cube"]["visible"])
        self.assertEqual(entities["object:cube"]["name"], "Cube")

    def test_disconnect_sends_shutdown_and_waits_for_ack_and_child(self):
        """§4 lines 103/118: normal unload drains before child exit."""
        process = FakeProcess()
        child = FakeChild(process)
        socket = FakeSocket([{"type": "shutdown_ack"}])
        connection = Connection(child, socket)

        connection.disconnect("addon_unload", timeout=0.1)

        self.assertEqual(socket.sent, [{"type": "shutdown", "reason": "addon_unload"}])
        self.assertTrue(socket.closed)
        self.assertFalse(child.killed)
        self.assertTrue(child.streams_closed)
        self.assertEqual(len(process.wait_calls), 1)

    def test_disconnect_force_kills_only_after_child_wait_timeout(self):
        """§4 line 118: force-kill follows, never precedes, the drain bound."""
        process = FakeProcess(times_out=True)
        child = FakeChild(process)
        socket = FakeSocket([{"type": "shutdown_ack"}])

        Connection(child, socket).disconnect("addon_unload", timeout=0.1)

        self.assertTrue(child.killed)
        self.assertEqual(len(process.wait_calls), 1)

    def test_bridge_request_dispatches_operator_on_blender_main_thread(self):
        socket = FakeSocket()
        connection = Connection(FakeChild(FakeProcess()), socket)
        blender = mock.Mock()
        blender.app.timers.register.return_value = None
        message = {
            "type": "bridge_request",
            "id": "bridge",
            "request_id": "request",
            "method": "apply_camera_plan",
            "params": {"schema_version": 1},
            "expected_revision_id": "a" * 64,
            "current_scene_hash": "b" * 64,
            "deadline_ms": 5000,
        }

        with mock.patch.object(connection_module, "bpy", blender):
            connection.dispatch_bridge_message(message)

        blender.app.timers.register.assert_not_called()
        blender.ops.omb.apply_camera_plan.assert_called_once_with(
            plan_json=json.dumps(message["params"], separators=(",", ":")),
            current_scene_hash="b" * 64,
            bridge_id="bridge",
            request_id="request",
            deadline_ms=5000,
        )

    def test_bridge_request_reads_durable_base_hash_from_project_store(self):
        socket = FakeSocket()
        blender = mock.Mock()
        blender.app.timers.register.side_effect = lambda callback, **_kwargs: callback()
        with tempfile.TemporaryDirectory() as directory:
            omb = pathlib.Path(directory, ".omb")
            omb.mkdir()
            (omb / "project.json").write_text(json.dumps({
                "project_id": "project",
                "current_revision_id": "a" * 64,
                "manifest": {"sceneHash": "b" * 64},
            }))
            connection = Connection(
                FakeChild(FakeProcess()),
                socket,
                project_directory=directory,
            )
            with mock.patch.object(connection_module, "bpy", blender):
                connection.dispatch_bridge_message({
                    "type": "bridge_request",
                    "id": "bridge",
                    "request_id": "request",
                    "method": "apply_camera_plan",
                    "params": {},
                    "expected_revision_id": "a" * 64,
                    "deadline_ms": 5000,
                })

        blender.ops.omb.apply_camera_plan.assert_called_once()
        self.assertEqual(
            blender.ops.omb.apply_camera_plan.call_args.kwargs["current_scene_hash"],
            "b" * 64,
        )

    def test_bridge_dispatcher_receive_loop_routes_requests(self):
        request = {
            "type": "bridge_request",
            "id": "bridge",
            "request_id": "request",
            "method": "apply_camera_plan",
            "params": {},
            "expected_revision_id": "a" * 64,
            "current_scene_hash": "b" * 64,
            "deadline_ms": 5000,
        }
        connection = Connection(
            FakeChild(FakeProcess()),
            FakeSocket([request]),
        )
        blender = mock.Mock()
        blender.app.timers.register.return_value = None

        with mock.patch.object(connection_module, "bpy", blender):
            connection.start_bridge_dispatcher()
            connection._reader_thread.join(timeout=1)
            connection.pump_bridge_messages()

        blender.app.timers.register.assert_called_once()
        blender.ops.omb.apply_camera_plan.assert_called_once()
    def test_bridge_cancel_marks_active_transaction_and_acknowledges(self):
        socket = FakeSocket()
        connection = Connection(FakeChild(FakeProcess()), socket)
        blender = mock.Mock()
        blender.app.timers.register.return_value = None
        request = {
            "type": "bridge_request",
            "id": "bridge",
            "request_id": "request",
            "method": "apply_camera_plan",
            "params": {},
            "expected_revision_id": "a" * 64,
            "current_scene_hash": "b" * 64,
            "deadline_ms": 5000,
        }
        with mock.patch.object(connection_module, "bpy", blender):
            connection.dispatch_bridge_message(request)
            connection.dispatch_bridge_message({
                "type": "bridge_cancel",
                "id": "bridge",
                "request_id": "request",
            })

        self.assertTrue(connection.is_bridge_cancelled("bridge"))
        self.assertEqual(socket.sent[-1], {
            "type": "bridge_cancel_ack",
            "id": "bridge",
            "request_id": "request",
            "status": "accepted",
        })

    def test_unsupported_bridge_method_returns_correlated_bridge_error(self):
        socket = FakeSocket()
        connection = Connection(FakeChild(FakeProcess()), socket)

        connection.dispatch_bridge_message({
            "type": "bridge_request",
            "id": "bridge",
            "request_id": "request",
            "method": "arbitrary_python",
            "params": {},
            "expected_revision_id": "a" * 64,
            "current_scene_hash": "b" * 64,
            "deadline_ms": 5000,
        })

        self.assertEqual(socket.sent[-1], {
            "type": "bridge_error",
            "id": "bridge",
            "request_id": "request",
            "code": "METHOD_NOT_SUPPORTED",
            "message": "unsupported bridge method: arbitrary_python",
            "retryable": False,
        })
    def test_bridge_checkpoint_releases_only_after_durable_response(self):
        socket = FakeSocket([
            {"type": "progress", "id": "other"},
            {"type": "response", "id": "request", "result": {}},
        ])
        connection = Connection(FakeChild(FakeProcess()), socket)

        response = connection.await_durable_bridge_commit(
            "bridge",
            "request",
            {"scene_hash": "a" * 64},
        )

        self.assertEqual(response["type"], "response")
        self.assertEqual(socket.sent, [{
            "type": "bridge_result",
            "id": "bridge",
            "request_id": "request",
            "result": {"scene_hash": "a" * 64},
        }])

    def test_bridge_commit_error_is_a_transaction_failure(self):
        socket = FakeSocket([
            {"type": "error", "id": "request", "code": "STALE_BASE"},
        ])
        connection = Connection(FakeChild(FakeProcess()), socket)

        with self.assertRaisesRegex(ConnectionError, "STALE_BASE"):
            connection.await_durable_bridge_commit("bridge", "request", {})

    def test_checkpoint_hold_and_release_enforce_single_in_flight(self):
        connection = Connection(FakeChild(FakeProcess()), FakeSocket())
        first = create_checkpoint({"object:cube": {"visible": True}})
        second = create_checkpoint({"object:sphere": {"visible": False}})

        connection.hold_checkpoint(first)
        with self.assertRaises(ConnectionError):
            connection.hold_checkpoint(second)
        self.assertIs(connection.release_checkpoint(), first)
        self.assertIsNone(connection.release_checkpoint())

    def test_unexpected_loss_restores_then_verifies_and_clears_checkpoint(self):
        connection = Connection(FakeChild(FakeProcess()), FakeSocket())
        checkpoint = create_checkpoint({"object:cube": {"visible": True}})
        connection.hold_checkpoint(checkpoint)
        scene = {"object:cube": {"visible": False}}
        calls = []

        def apply(key, values):
            calls.append(("restore", key))
            scene[key] = values

        def read(key):
            calls.append(("verify", key))
            return scene[key]

        self.assertTrue(connection.restore_on_unexpected_loss(apply, read))
        self.assertEqual(calls, [("restore", "object:cube"), ("verify", "object:cube")])
        self.assertIsNone(connection.active_checkpoint)

    def test_unexpected_loss_failed_verification_still_clears_checkpoint(self):
        connection = Connection(FakeChild(FakeProcess()), FakeSocket())
        connection.hold_checkpoint(
            create_checkpoint({"object:cube": {"visible": True}})
        )

        self.assertFalse(
            connection.restore_on_unexpected_loss(
                lambda key, values: None,
                lambda key: {"visible": False},
            )
        )
        self.assertIsNone(connection.active_checkpoint)

    def test_unexpected_loss_without_checkpoint_is_no_op(self):
        connection = Connection(FakeChild(FakeProcess()), FakeSocket())
        apply = mock.Mock()
        read = mock.Mock()

        self.assertTrue(connection.restore_on_unexpected_loss(apply, read))
        apply.assert_not_called()
        read.assert_not_called()

    def test_reconnect_accepts_matching_live_hash(self):
        connection = mock.Mock()
        with mock.patch.object(Connection, "start", return_value=connection) as start:
            result = reconnect(
                ("daemon",),
                cwd="/tmp",
                project_id="project",
                addon_version="1",
                blender_version="4",
                expected_scene_hash="ab12",
                live_scene_hash_fn=lambda: "ab12",
            )

        self.assertIs(result, connection)
        start.assert_called_once()
        connection.disconnect.assert_not_called()

    def test_reconnect_mismatch_disconnects_and_reraises_original_error(self):
        connection = mock.Mock()
        connection.disconnect.side_effect = RuntimeError("disconnect failed")
        with mock.patch.object(Connection, "start", return_value=connection):
            with self.assertRaisesRegex(ConnectionError, "canonical current revision"):
                reconnect(
                    ("daemon",),
                    cwd="/tmp",
                    project_id="project",
                    addon_version="1",
                    blender_version="4",
                    expected_scene_hash="cd34",
                    live_scene_hash_fn=lambda: "ab12",
                )

        connection.disconnect.assert_called_once()

    def test_connect_refuses_when_no_daemon_launch_mode_is_configured(self):
        """architecture doc line 92-99: never silently fall back to a fake provider."""
        connection_module._active_connection = None
        with mock.patch.dict("os.environ", {}, clear=True):
            with self.assertRaisesRegex(ConnectionError, "NOT_CONFIGURED"):
                connect(cwd="/tmp", project_id="project", addon_version="1", blender_version="4")

    def test_connect_uses_explicit_daemon_args_over_the_environment(self):
        connection_module._active_connection = None
        fake = mock.Mock()
        fake.state = "active"
        with mock.patch.object(Connection, "start", return_value=fake) as start:
            with mock.patch.dict("os.environ", {"OMB_DAEMON_ARGS": "--should-not-be-used"}, clear=True):
                result = connect(
                    cwd="/tmp",
                    project_id="project",
                    addon_version="1",
                    blender_version="4",
                    daemon_args=("--faux",),
                )
        self.assertIs(result, fake)
        argv = start.call_args.args[0]
        self.assertEqual(argv[-1], "--faux")
        self.assertNotIn("--should-not-be-used", argv)
        disconnect_active("test_cleanup")

    def test_connect_falls_back_to_the_environment_variable_when_unspecified(self):
        connection_module._active_connection = None
        fake = mock.Mock()
        fake.state = "active"
        with mock.patch.object(Connection, "start", return_value=fake) as start:
            with mock.patch.dict("os.environ", {"OMB_DAEMON_ARGS": "--faux"}, clear=True):
                connect(cwd="/tmp", project_id="project", addon_version="1", blender_version="4")
        argv = start.call_args.args[0]
        self.assertEqual(argv[-1], "--faux")
        disconnect_active("test_cleanup")

if __name__ == "__main__":
    unittest.main()
