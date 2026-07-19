"""Tests for add-on connection lifecycle orchestration."""

import json
import pathlib
import subprocess
import tempfile
import threading
import sys
import time
from unittest import mock
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).parents[1]))
TEST_EXECUTABLE = str(pathlib.Path(sys.executable).resolve(strict=True))

from oh_my_blender.checkpoint import create_checkpoint
from oh_my_blender.connection import (
    Connection,
    ConnectionError,
    DurableCommitReconciliationRequired,
    _test_only_inject_disconnect_fault,
    _resolve_daemon_argv,
    connect,
    disconnect_active,
    verify_reconnect_hash,
    reconnect,
)
from oh_my_blender import connection as connection_module


class FakeProcess:
    def __init__(self, times_out=False, exited=False):
        self.times_out = times_out
        self.exited = exited
        self.wait_calls = []

    def wait(self, timeout=None):
        self.wait_calls.append(timeout)
        if self.times_out:
            raise subprocess.TimeoutExpired("daemon", timeout)
        return 0

    def poll(self):
        return 0 if self.exited else None


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



BASE_REVISION = "a" * 64
CANDIDATE_REVISION = "c" * 64


def mutation_result():
    return {
        "expected_revision_id": BASE_REVISION,
        "scene_hash": "b" * 64,
        "manifest": {"revisionId": CANDIDATE_REVISION},
    }

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

    def test_reconnecting_connection_hides_mutating_tool_capabilities(self):
        """Architecture §4: reconnect exposes zero tools until full V2 equality."""
        socket = FakeSocket()
        connection = Connection(FakeChild(FakeProcess()), socket)
        connection.tools_exposed = False
        blender = mock.Mock()
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

        blender.ops.omb.apply_camera_plan.assert_not_called()
        self.assertEqual(socket.sent[0]["type"], "bridge_error")
        self.assertEqual(socket.sent[0]["code"], "RECOVERY_REQUIRED")

    def test_render_qa_frames_uses_the_existing_main_thread_bridge_dispatcher(self):
        """Task clause: use `start_bridge_dispatcher`/main-thread dispatch, not a parallel path."""
        socket = FakeSocket()
        connection = Connection(FakeChild(FakeProcess()), socket)
        blender = mock.Mock()
        message = {
            "type": "bridge_request",
            "id": "qa-bridge",
            "request_id": "qa-request",
            "method": "render_qa_frames",
            "params": {
                "schema_version": 1,
                "revision_id": "a" * 64,
                "frames": [80, 161, 199],
            },
            "expected_revision_id": "a" * 64,
            "current_scene_hash": "b" * 64,
            "deadline_ms": 30000,
        }

        with mock.patch.object(connection_module, "bpy", blender):
            connection.dispatch_bridge_message(message)

        blender.ops.omb.render_qa_frames.assert_called_once_with(
            request_json=json.dumps(message["params"], separators=(",", ":")),
            current_scene_hash="b" * 64,
            bridge_id="qa-bridge",
            request_id="qa-request",
            deadline_ms=30000,
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

    def test_reader_failure_does_not_overwrite_recovery_required(self):
        """A late socket error must not replace the transaction's terminal state."""
        entered_receive = threading.Event()
        fail_receive = threading.Event()

        class DelayedFailureSocket(FakeSocket):
            def recv_json(self):
                entered_receive.set()
                fail_receive.wait(timeout=1)
                raise OSError("socket closed")

        connection = Connection(
            FakeChild(FakeProcess()),
            DelayedFailureSocket(),
        )
        blender = mock.Mock()
        blender.app.timers.register.return_value = None

        with mock.patch.object(connection_module, "bpy", blender):
            connection.start_bridge_dispatcher()
            self.assertTrue(entered_receive.wait(timeout=1))
            connection.require_recovery()
            fail_receive.set()
            connection._reader_thread.join(timeout=1)

        self.assertFalse(connection._reader_thread.is_alive())
        self.assertEqual(connection.state, "recovery_required")
        self.assertFalse(connection.tools_exposed)

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
            {
                "type": "response",
                "id": "request",
                "result": {},
                "resulting_revision_id": CANDIDATE_REVISION,
            },
        ])
        connection = Connection(FakeChild(FakeProcess()), socket)
        checkpoint = create_checkpoint({"object:cube": {"visible": True}})
        connection.hold_checkpoint(checkpoint)

        response = connection.await_durable_bridge_commit(
            "bridge",
            "request",
            mutation_result(),
        )

        self.assertEqual(response["type"], "response")
        self.assertIsNone(connection.active_checkpoint)
        self.assertEqual(connection.durable_commit_reconciliation["outcome"], "committed")
        self.assertEqual(socket.sent, [{
            "type": "bridge_result",
            "id": "bridge",
            "request_id": "request",
            "result": mutation_result(),
        }])

    def test_bridge_commit_error_is_a_transaction_failure(self):
        socket = FakeSocket([
            {"type": "error", "id": "request", "code": "STALE_BASE"},
        ])
        connection = Connection(FakeChild(FakeProcess()), socket)

        with self.assertRaisesRegex(ConnectionError, "STALE_BASE"):
            connection.await_durable_bridge_commit(
                "bridge", "request", mutation_result()
            )
        self.assertEqual(
            connection.durable_commit_reconciliation["outcome"],
            "not_committed",
        )

    def test_timeout_reconciles_committed_candidate_and_releases_once(self):
        with tempfile.TemporaryDirectory() as directory:
            omb = pathlib.Path(directory, ".omb")
            omb.mkdir()
            (omb / "project.json").write_text(json.dumps({
                "current_revision_id": CANDIDATE_REVISION,
            }))
            connection = Connection(
                FakeChild(FakeProcess()),
                FakeSocket(),
                project_directory=directory,
            )
            checkpoint = create_checkpoint({"object:cube": {"visible": True}})
            connection.hold_checkpoint(checkpoint)

            response = connection.await_durable_bridge_commit(
                "bridge",
                "request",
                mutation_result(),
                deadline=time.monotonic() - 1,
            )

        self.assertTrue(response["reconciled"])
        self.assertIsNone(connection.active_checkpoint)
        self.assertEqual(connection.reconcile_durable_bridge_commit(), "committed")
        self.assertIsNone(connection.release_checkpoint())

    def test_timeout_with_definitive_base_preserves_checkpoint_for_rollback_once(self):
        with tempfile.TemporaryDirectory() as directory:
            omb = pathlib.Path(directory, ".omb")
            omb.mkdir()
            (omb / "project.json").write_text(json.dumps({
                "current_revision_id": BASE_REVISION,
            }))
            socket = FakeSocket()
            socket.closed = True
            connection = Connection(
                FakeChild(FakeProcess(exited=True)),
                socket,
                project_directory=directory,
            )
            checkpoint = create_checkpoint({"object:cube": {"visible": True}})
            connection.hold_checkpoint(checkpoint)

            with self.assertRaisesRegex(ConnectionError, "did not complete"):
                connection.await_durable_bridge_commit(
                    "bridge",
                    "request",
                    mutation_result(),
                    deadline=time.monotonic() - 1,
                )

        self.assertIs(connection.active_checkpoint, checkpoint)
        self.assertEqual(
            connection.reconcile_durable_bridge_commit(),
            "not_committed",
        )
        self.assertIs(connection.release_checkpoint(), checkpoint)
        self.assertIsNone(connection.release_checkpoint())

    def test_timeout_with_unreadable_project_requires_recovery_without_rollback(self):
        connection = Connection(
            FakeChild(FakeProcess()),
            FakeSocket(),
            project_directory="/missing/project",
        )
        checkpoint = create_checkpoint({"object:cube": {"visible": True}})
        connection.hold_checkpoint(checkpoint)

        with self.assertRaisesRegex(
            DurableCommitReconciliationRequired,
            "reconciliation required",
        ):
            connection.await_durable_bridge_commit(
                "bridge",
                "request",
                mutation_result(),
                deadline=time.monotonic() - 1,
            )

        self.assertIs(connection.active_checkpoint, checkpoint)
        self.assertEqual(
            connection.durable_commit_reconciliation["outcome"],
            "reconciliation_required",
        )

    def test_checkpoint_hold_and_release_enforce_single_in_flight(self):
        connection = Connection(FakeChild(FakeProcess()), FakeSocket())
        first = create_checkpoint({"object:cube": {"visible": True}})
        second = create_checkpoint({"object:sphere": {"visible": False}})

        connection.hold_checkpoint(first)
        with self.assertRaises(ConnectionError):
            connection.hold_checkpoint(second)
        self.assertIs(connection.release_checkpoint(), first)
        self.assertIsNone(connection.release_checkpoint())
    def test_blender_timer_handles_real_eof_once_on_main_thread(self):
        """Architecture §4/§15.3: EOF callback records only; Blender timer restores/verifies once."""
        socket = FakeSocket()
        connection = Connection(FakeChild(FakeProcess()), socket)
        checkpoint = create_checkpoint({"camera_plan_scope": {"visible": True}})
        connection.hold_checkpoint(checkpoint)
        blender = mock.Mock()
        callbacks = []
        blender.app.timers.register.side_effect = (
            lambda callback, **_kwargs: callbacks.append(callback)
        )
        scene = {"camera_plan_scope": {"visible": False}}
        main_thread_calls = []

        def restore_scope(key, values):
            main_thread_calls.append(("restore", threading.get_ident(), key))
            scene[key] = values

        def read_scope(key):
            main_thread_calls.append(("verify", threading.get_ident(), key))
            return scene[key]

        main_thread_id = threading.get_ident()
        with (
            mock.patch.object(connection_module, "bpy", blender),
            mock.patch("oh_my_blender.camera_plan._restore_scope", restore_scope),
            mock.patch("oh_my_blender.camera_plan._read_scope", read_scope),
        ):
            connection.start_bridge_dispatcher()
            connection._reader_thread.join(timeout=1)
            self.assertEqual(connection.state, "lost")
            self.assertIsNone(callbacks[0]())
            self.assertIsNone(callbacks[0]())

        self.assertEqual(
            main_thread_calls,
            [
                ("restore", main_thread_id, "camera_plan_scope"),
                ("verify", main_thread_id, "camera_plan_scope"),
            ],
        )
        self.assertIsNone(connection.active_checkpoint)
        self.assertEqual(connection.state, "disconnected")
        self.assertTrue(socket.closed)
        self.assertFalse(connection._reader_thread.is_alive())

    def test_failed_timer_restore_enters_recovery_required_and_hides_mutations(self):
        """Architecture §4/§15.3: failed verification leaves recovery-required with tools hidden."""
        connection = Connection(FakeChild(FakeProcess()), FakeSocket())
        connection.hold_checkpoint(
            create_checkpoint({"camera_plan_scope": {"visible": True}})
        )
        connection.state = "lost"

        with (
            mock.patch("oh_my_blender.camera_plan._restore_scope"),
            mock.patch(
                "oh_my_blender.camera_plan._read_scope",
                return_value={"visible": False},
            ),
        ):
            self.assertIsNone(connection.pump_bridge_messages())

        self.assertEqual(connection.state, "recovery_required")
        self.assertFalse(connection.tools_exposed)
        self.assertIsNone(connection.active_checkpoint)

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

    def test_reconnect_reads_durable_hash_and_exposes_tools_only_after_live_v2_equality(self):
        """Architecture §4: fresh reconnect re-inspects full V2 before capabilities."""
        connection = mock.Mock()
        connection.tools_exposed = False
        connection.child.process.poll.return_value = None
        previous = mock.Mock()
        previous.state = "lost"
        previous.child.process.poll.return_value = 0
        with tempfile.TemporaryDirectory() as directory:
            omb = pathlib.Path(directory, ".omb")
            omb.mkdir()
            (omb / "project.json").write_text(json.dumps({
                "current_revision_id": BASE_REVISION,
                "manifest": {
                    "revisionId": BASE_REVISION,
                    "sceneHash": "b" * 64,
                },
            }))
            with mock.patch.object(Connection, "start", return_value=connection) as start:
                result = reconnect(
                    ("daemon",),
                    cwd=directory,
                    project_id="project",
                    addon_version="1",
                    blender_version="4",
                    live_scene_hash_fn=lambda: "b" * 64,
                    previous_connection=previous,
                )

        self.assertIs(result, connection)
        start.assert_called_once_with(
            ("daemon",),
            cwd=directory,
            project_id="project",
            addon_version="1",
            blender_version="4",
            child_type=mock.ANY,
            websocket_type=mock.ANY,
            expose_tools=False,
        )
        connection.expose_tools.assert_called_once_with()
        connection.disconnect.assert_not_called()

    def test_reconnect_confirms_old_child_exit_before_spawning_replacement(self):
        """Architecture §4: full restart confirms the old child exited first."""
        events = []
        previous = mock.Mock()
        previous.state = "lost"
        previous.child.process.poll.side_effect = [None, 0]

        def disconnect(_reason):
            events.append("old-exited")

        previous.disconnect.side_effect = disconnect
        replacement = mock.Mock()
        replacement.tools_exposed = False
        with tempfile.TemporaryDirectory() as directory:
            omb = pathlib.Path(directory, ".omb")
            omb.mkdir()
            (omb / "project.json").write_text(json.dumps({
                "current_revision_id": BASE_REVISION,
                "manifest": {
                    "revisionId": BASE_REVISION,
                    "sceneHash": "b" * 64,
                },
            }))
            with mock.patch.object(
                Connection,
                "start",
                side_effect=lambda *_args, **_kwargs: events.append("replacement-started") or replacement,
            ):
                reconnect(
                    ("daemon",),
                    cwd=directory,
                    project_id="project",
                    addon_version="1",
                    blender_version="4",
                    live_scene_hash_fn=lambda: "b" * 64,
                    previous_connection=previous,
                )

        self.assertEqual(events, ["old-exited", "replacement-started"])

    def test_reconnect_mismatch_terminates_replacement_with_zero_tool_exposure(self):
        """Architecture §4: hash mismatch terminates replacement and exposes zero tools."""
        connection = mock.Mock()
        connection.tools_exposed = False
        previous = mock.Mock()
        previous.state = "stopped"
        previous.child.process.poll.return_value = 0
        with tempfile.TemporaryDirectory() as directory:
            omb = pathlib.Path(directory, ".omb")
            omb.mkdir()
            (omb / "project.json").write_text(json.dumps({
                "current_revision_id": BASE_REVISION,
                "manifest": {
                    "revisionId": BASE_REVISION,
                    "sceneHash": "c" * 64,
                },
            }))
            with mock.patch.object(Connection, "start", return_value=connection):
                with self.assertRaisesRegex(ConnectionError, "canonical current revision"):
                    reconnect(
                        ("daemon",),
                        cwd=directory,
                        project_id="project",
                        addon_version="1",
                        blender_version="4",
                        live_scene_hash_fn=lambda: "b" * 64,
                        previous_connection=previous,
                    )

        connection.expose_tools.assert_not_called()
        connection.disconnect.assert_called_once_with("reconnect_hash_mismatch")

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
            with mock.patch.dict(
                "os.environ",
                {
                    "OMB_DAEMON_ARGS": "--should-not-be-used",
                    "OMB_NODE_EXECUTABLE": TEST_EXECUTABLE,
                },
                clear=True,
            ):
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

    def test_connect_restarts_post_detector_states_through_durable_hash_gate(self):
        """Production Connect routes every timer-produced terminal state through restart."""
        for state in ("disconnected", "recovery_required"):
            with self.subTest(state=state):
                previous = mock.Mock()
                previous.state = state
                replacement = mock.Mock()
                replacement.state = "active"
                connection_module._active_connection = previous
                with mock.patch.dict(
                    "os.environ", {"OMB_NODE_EXECUTABLE": TEST_EXECUTABLE}, clear=True
                ), mock.patch.object(
                    connection_module,
                    "reconnect",
                    return_value=replacement,
                ) as restart:
                    result = connect(
                        cwd="/tmp",
                        project_id="project",
                        addon_version="1",
                        blender_version="4",
                        daemon_args=("--faux",),
                    )

                self.assertIs(result, replacement)
                self.assertIs(
                    restart.call_args.kwargs["previous_connection"],
                    previous,
                )
                self.assertTrue(
                    callable(restart.call_args.kwargs["live_scene_hash_fn"])
                )
                connection_module._active_connection = None

    def test_connect_falls_back_to_the_environment_variable_when_unspecified(self):
        connection_module._active_connection = None
        fake = mock.Mock()
        fake.state = "active"
        with mock.patch.object(Connection, "start", return_value=fake) as start:
            with mock.patch.dict(
                "os.environ",
                {
                    "OMB_DAEMON_ARGS": "--faux",
                    "OMB_NODE_EXECUTABLE": TEST_EXECUTABLE,
                },
                clear=True,
            ):
                connect(cwd="/tmp", project_id="project", addon_version="1", blender_version="4")
        argv = start.call_args.args[0]
        self.assertEqual(argv[-1], "--faux")
        disconnect_active("test_cleanup")

    def test_daemon_argv_requires_absolute_verified_node_without_path_search(self):
        with mock.patch.dict(
            "os.environ",
            {"OMB_NODE_EXECUTABLE": TEST_EXECUTABLE, "PATH": "/attacker-controlled"},
            clear=True,
        ):
            argv = _resolve_daemon_argv(("--faux",))
        self.assertEqual(argv[0], TEST_EXECUTABLE)
        self.assertTrue(pathlib.Path(argv[0]).is_absolute())
        with mock.patch.dict(
            "os.environ",
            {"OMB_NODE_EXECUTABLE": "node", "PATH": "/attacker-controlled"},
            clear=True,
        ):
            with self.assertRaisesRegex(ConnectionError, "must be absolute"):
                _resolve_daemon_argv(("--faux",))

        with mock.patch.dict(
            "os.environ", {"OMB_NODE_EXECUTABLE": TEST_EXECUTABLE}, clear=True
        ):
            with self.assertRaisesRegex(ConnectionError, "unsupported daemon arguments"):
                _resolve_daemon_argv((
                    "--provider", "anthropic", "--model", "claude-haiku-4-5",
                    "--api-key", "must-not-reach-child-argv",
                ))

    def test_daemon_argv_supports_verified_installed_executable(self):
        with mock.patch.dict(
            "os.environ",
            {"OMB_DAEMON_EXECUTABLE": TEST_EXECUTABLE},
            clear=True,
        ):
            argv = _resolve_daemon_argv(("--faux",))
        self.assertEqual(argv, (TEST_EXECUTABLE, "--port", "0", "--faux"))

    def test_daemon_argv_rejects_ambiguous_executable_configuration(self):
        with mock.patch.dict(
            "os.environ",
            {
                "OMB_DAEMON_EXECUTABLE": TEST_EXECUTABLE,
                "OMB_NODE_EXECUTABLE": TEST_EXECUTABLE,
            },
            clear=True,
        ):
            with self.assertRaisesRegex(ConnectionError, "INVALID_ARGUMENT.*both"):
                _resolve_daemon_argv(("--faux",))

    def test_installed_daemon_uses_shared_executable_safety_checks(self):
        with tempfile.TemporaryDirectory() as directory:
            executable = pathlib.Path(directory).resolve() / "daemon"
            executable.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
            executable.chmod(0o700)
            symlink = pathlib.Path(directory).resolve() / "daemon-link"
            symlink.symlink_to(executable)

            for configured, expected in (
                ("daemon", "must be absolute"),
                (str(symlink), "regular nonsymlink"),
            ):
                with self.subTest(configured=configured), mock.patch.dict(
                    "os.environ",
                    {"OMB_DAEMON_EXECUTABLE": configured},
                    clear=True,
                ):
                    with self.assertRaisesRegex(ConnectionError, expected):
                        _resolve_daemon_argv(("--faux",))

            with mock.patch.dict(
                "os.environ",
                {"OMB_DAEMON_EXECUTABLE": str(executable)},
                clear=True,
            ), mock.patch(
                "oh_my_blender.daemon_child.os.getuid",
                return_value=executable.stat().st_uid + 1,
            ):
                with self.assertRaisesRegex(ConnectionError, "owned executable"):
                    _resolve_daemon_argv(("--faux",))


if __name__ == "__main__":
    unittest.main()
