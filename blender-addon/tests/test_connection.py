"""Tests for add-on connection lifecycle orchestration."""

import contextlib
import json
import pathlib
import subprocess
import tempfile
import threading
import sys
import time
import types
from unittest import mock
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).parents[1]))
TEST_EXECUTABLE = str(pathlib.Path(sys.executable).resolve(strict=True))

from cclay.checkpoint import create_checkpoint
from cclay.connection import (
    Connection,
    ConnectionError,
    DurableCommitReconciliationRequired,
    _test_only_inject_disconnect_fault,
    connect,
    disconnect_active,
    verify_reconnect_hash,
    reconnect,
)
from cclay import connection as connection_module


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
            "params": {"schema_version": 1, "keyframes": [{}], "secret": "credential"},
            "expected_revision_id": "a" * 64,
            "current_scene_hash": "b" * 64,
            "deadline_ms": 5000,
        }

        with mock.patch.object(connection_module, "bpy", blender):
            connection.dispatch_bridge_message(message)

        blender.app.timers.register.assert_not_called()
        blender.ops.cclay.apply_camera_plan.assert_called_once_with(
            plan_json=json.dumps(message["params"], separators=(",", ":")),
            current_scene_hash="b" * 64,
            bridge_id="bridge",
            request_id="request",
            deadline_ms=5000,
        )
        self.assertEqual(connection.task_status.task_kind, "camera_plan")
        self.assertEqual(connection.task_status.phase, "dispatching")
        self.assertIn("1 camera-plan keyframe", connection.task_status.descriptor)
        self.assertNotIn("secret", connection.task_status.descriptor)

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

        blender.ops.cclay.apply_camera_plan.assert_not_called()
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

        blender.ops.cclay.render_qa_frames.assert_called_once_with(
            request_json=json.dumps(message["params"], separators=(",", ":")),
            current_scene_hash="b" * 64,
            bridge_id="qa-bridge",
            request_id="qa-request",
            deadline_ms=30000,
        )
        self.assertEqual(connection.task_status.task_kind, "qa_render")
        self.assertEqual(connection.task_status.phase, "dispatching")
        self.assertEqual(connection.task_status.completed, 0)
        self.assertEqual(connection.task_status.total, 3)
        self.assertIn("frames 80, 161, 199", connection.task_status.descriptor)

    def test_stage_scene_uses_existing_main_thread_bridge_and_safe_status(self):
        socket = FakeSocket()
        connection = Connection(FakeChild(FakeProcess()), socket)
        blender = mock.Mock()
        message = {
            "type": "bridge_request",
            "id": "stage-bridge",
            "request_id": "stage-request",
            "method": "stage_scene",
            "params": {
                "schema_version": 1,
                "expected_revision_id": "a" * 64,
                "operations": [{"op": "add_primitive"}],
                "secret": "credential",
            },
            "expected_revision_id": "a" * 64,
            "current_scene_hash": "b" * 64,
            "deadline_ms": 30000,
        }

        with mock.patch.object(connection_module, "bpy", blender):
            connection.dispatch_bridge_message(message)

        blender.ops.cclay.stage_scene.assert_called_once_with(
            plan_json=json.dumps(message["params"], separators=(",", ":")),
            current_scene_hash="b" * 64,
            bridge_id="stage-bridge",
            request_id="stage-request",
            deadline_ms=30000,
        )
        self.assertEqual(connection.task_status.task_kind, "stage_scene")
        self.assertIn("1 operation", connection.task_status.descriptor)
        self.assertNotIn("secret", connection.task_status.descriptor)

    def test_inspect_project_uses_substrate_aware_main_thread_snapshot_path(self):
        socket = FakeSocket()
        with tempfile.TemporaryDirectory() as directory:
            cclay = pathlib.Path(directory, ".cclay")
            cclay.mkdir()
            (cclay / "project.json").write_text(json.dumps({
                "project_id": "project",
                "current_revision_id": BASE_REVISION,
                "manifest": {"sceneHash": "b" * 64},
            }))
            connection = Connection(
                FakeChild(FakeProcess()),
                socket,
                project_directory=directory,
            )
            blender = mock.Mock()
            snapshot = {"schemaVersion": 2, "scene": {"name": "Scene"}}
            message = {
                "type": "bridge_request",
                "id": "inspect-bridge",
                "request_id": "inspect-request",
                "method": "inspect_project",
                "params": {},
                "expected_revision_id": "0" * 64,
                "deadline_ms": 5000,
            }

            resolved_manifest = {"schemaVersion": 2, "sceneHash": "0" * 64}
            manifest_module = types.SimpleNamespace(
                resolve_manifest_for_expected_hash=mock.Mock(
                    return_value=resolved_manifest
                ),
                extract_scene_snapshot=mock.Mock(return_value=snapshot),
                extract_scene_manifest_v2=mock.Mock(return_value=resolved_manifest),
            )
            with (
                mock.patch.object(connection_module, "bpy", blender),
                mock.patch.dict(
                    sys.modules,
                    {"cclay.manifest": manifest_module},
                ),
            ):
                connection.dispatch_bridge_message(message)

        manifest_module.resolve_manifest_for_expected_hash.assert_called_once_with("b" * 64)
        manifest_module.extract_scene_snapshot.assert_called_once_with()
        self.assertEqual(socket.sent, [{
            "type": "bridge_result",
            "id": "inspect-bridge",
            "request_id": "inspect-request",
            "result": {
                "revision": BASE_REVISION,
                "snapshot": snapshot,
            },
        }])
        self.assertFalse(connection._bridge_cancellations)
        blender.ops.cclay.apply_camera_plan.assert_not_called()
        blender.ops.cclay.stage_scene.assert_not_called()
        blender.ops.cclay.render_qa_frames.assert_not_called()

    def test_inspect_project_with_stale_expected_revision_serves_durable_truth(self):
        """Inspect never fails STALE_BASE: it rebinds to the durable revision."""
        socket = FakeSocket()
        with tempfile.TemporaryDirectory() as directory:
            cclay = pathlib.Path(directory, ".cclay")
            cclay.mkdir()
            (cclay / "project.json").write_text(json.dumps({
                "project_id": "project",
                "current_revision_id": BASE_REVISION,
                "manifest": {"sceneHash": "b" * 64},
            }))
            connection = Connection(
                FakeChild(FakeProcess()),
                socket,
                project_directory=directory,
            )
            blender = mock.Mock()
            snapshot = {"schemaVersion": 2, "scene": {"name": "Scene"}}
            message = {
                "type": "bridge_request",
                "id": "inspect-bridge",
                "request_id": "inspect-request",
                "method": "inspect_project",
                "params": {},
                "expected_revision_id": "e" * 64,
                "deadline_ms": 5000,
            }

            resolved_manifest = {"schemaVersion": 2, "sceneHash": "b" * 64}
            manifest_module = types.SimpleNamespace(
                resolve_manifest_for_expected_hash=mock.Mock(
                    return_value=resolved_manifest
                ),
                extract_scene_snapshot=mock.Mock(return_value=snapshot),
                extract_scene_manifest_v2=mock.Mock(return_value=resolved_manifest),
            )
            with (
                mock.patch.object(connection_module, "bpy", blender),
                mock.patch.dict(
                    sys.modules,
                    {"cclay.manifest": manifest_module},
                ),
            ):
                connection.dispatch_bridge_message(message)
            journal_entries = [
                json.loads(line)
                for line in (cclay / "journal.jsonl").read_text().splitlines()
            ]

        self.assertEqual(socket.sent, [{
            "type": "bridge_result",
            "id": "inspect-bridge",
            "request_id": "inspect-request",
            "result": {
                "revision": BASE_REVISION,
                "snapshot": snapshot,
            },
        }])
        self.assertEqual(journal_entries, [{
            "type": "inspect_rebind",
            "source": "durable_serve",
            "project_id": "project",
            "scene_hash": "b" * 64,
            "old_revision_id": "e" * 64,
            "new_revision_id": BASE_REVISION,
        }])
        self.assertFalse(connection._bridge_cancellations)

    def test_inspect_project_rebinds_wedged_durable_substrate_to_live_truth(self):
        """A durable revision left behind live (aborted stage_scene) recovers on inspect."""
        project_id = "356ae9c2-9cc1-4541-8e8e-a6d759b4df64"
        socket = FakeSocket()
        blender = mock.Mock()
        blender.app.timers.register.side_effect = lambda callback, **_kwargs: callback()
        with tempfile.TemporaryDirectory() as directory:
            cclay = pathlib.Path(directory, ".cclay")
            cclay.mkdir()
            (cclay / "project.json").write_text(json.dumps({
                "project_id": project_id,
                "current_revision_id": BASE_REVISION,
                "manifest": {"sceneHash": "b" * 64},
            }))
            connection = Connection(
                FakeChild(FakeProcess()),
                socket,
                project_directory=directory,
            )
            snapshot = {"schemaVersion": 2, "scene": {"name": "Scene"}}
            live_manifest = {
                "schemaVersion": 2,
                "projectId": project_id,
                "revisionId": CANDIDATE_REVISION,
                "sceneHash": "d" * 64,
            }
            manifest_module = types.SimpleNamespace(
                resolve_manifest_for_expected_hash=mock.Mock(return_value=None),
                extract_scene_snapshot=mock.Mock(return_value=snapshot),
                extract_scene_manifest_v2=mock.Mock(return_value=live_manifest),
            )
            with (
                mock.patch.object(connection_module, "bpy", blender),
                mock.patch.dict(
                    sys.modules,
                    {"cclay.manifest": manifest_module},
                ),
            ):
                connection.dispatch_bridge_message({
                    "type": "bridge_request",
                    "id": "inspect-bridge",
                    "request_id": "inspect-request",
                    "method": "inspect_project",
                    "params": {},
                    "expected_revision_id": BASE_REVISION,
                    "deadline_ms": 5000,
                })
                # The next mutation based on the NEW revision succeeds.
                connection.dispatch_bridge_message({
                    "type": "bridge_request",
                    "id": "stage-bridge",
                    "request_id": "stage-request",
                    "method": "stage_scene",
                    "params": {
                        "schema_version": 1,
                        "expected_revision_id": CANDIDATE_REVISION,
                        "operations": [{"op": "add_primitive"}],
                    },
                    "expected_revision_id": CANDIDATE_REVISION,
                    "deadline_ms": 30000,
                })
            durable = json.loads((cclay / "project.json").read_text())
            journal_entries = [
                json.loads(line)
                for line in (cclay / "journal.jsonl").read_text().splitlines()
            ]

        self.assertEqual(socket.sent[0], {
            "type": "bridge_result",
            "id": "inspect-bridge",
            "request_id": "inspect-request",
            "result": {
                "revision": CANDIDATE_REVISION,
                "snapshot": snapshot,
            },
        })
        self.assertEqual(durable["current_revision_id"], CANDIDATE_REVISION)
        self.assertEqual(journal_entries, [{
            "type": "inspect_rebind",
            "source": "live_rewrite",
            "project_id": project_id,
            "scene_hash": "d" * 64,
            "old_revision_id": BASE_REVISION,
            "new_revision_id": CANDIDATE_REVISION,
        }])
        blender.ops.cclay.stage_scene.assert_called_once()
        self.assertEqual(
            blender.ops.cclay.stage_scene.call_args.kwargs["current_scene_hash"],
            "d" * 64,
        )

    def _dispatch_preflight_motion(self, params, collect=None, begin_task=None):
        """Dispatch one preflight_motion bridge request against a durable base."""
        socket = FakeSocket()
        with tempfile.TemporaryDirectory() as directory:
            cclay = pathlib.Path(directory, ".cclay")
            cclay.mkdir()
            (cclay / "project.json").write_text(json.dumps({
                "project_id": "project",
                "current_revision_id": BASE_REVISION,
                "manifest": {"sceneHash": "b" * 64},
            }))
            connection = Connection(
                FakeChild(FakeProcess()),
                socket,
                project_directory=directory,
            )
            blender = mock.Mock()
            message = {
                "type": "bridge_request",
                "id": "preflight-bridge",
                "request_id": "preflight-request",
                "method": "preflight_motion",
                "params": params,
                "expected_revision_id": BASE_REVISION,
                "deadline_ms": 5000,
            }
            from cclay import motion_preflight

            with contextlib.ExitStack() as stack:
                stack.enter_context(
                    mock.patch.object(connection_module, "bpy", blender)
                )
                if collect is not None:
                    stack.enter_context(mock.patch.object(
                        motion_preflight, "collect_preflight", collect
                    ))
                if begin_task is not None:
                    stack.enter_context(
                        mock.patch.object(connection, "begin_task", begin_task)
                    )
                connection.dispatch_bridge_message(message)
        # finish_bridge always ran: no live cancellation, bridge is terminal.
        self.assertFalse(connection._bridge_cancellations)
        self.assertIn("preflight-bridge", connection._terminal_bridge_ids)
        return socket, connection, blender

    def test_preflight_motion_success_sends_bridge_result_read_only(self):
        payload = {"revision": BASE_REVISION, "motion_id": "walk-01"}
        collect = mock.Mock(return_value=payload)
        begin_task = mock.Mock()
        socket, _connection, blender = self._dispatch_preflight_motion(
            {"motion_id": "walk-01"}, collect=collect, begin_task=begin_task
        )
        collect.assert_called_once()
        self.assertEqual(collect.call_args.args[0], BASE_REVISION)
        self.assertEqual(collect.call_args.args[1], {"motion_id": "walk-01"})
        self.assertEqual(socket.sent, [{
            "type": "bridge_result",
            "id": "preflight-bridge",
            "request_id": "preflight-request",
            "result": payload,
        }])
        # Read-only classification: never a mutation task, never an operator.
        begin_task.assert_not_called()
        blender.ops.cclay.stage_scene.assert_not_called()
        blender.ops.cclay.apply_camera_plan.assert_not_called()

    def test_preflight_motion_error_surfaces_contract_code(self):
        from cclay.motion_preflight import PreflightMotionError

        collect = mock.Mock(side_effect=PreflightMotionError(
            "ENTITY_NOT_FOUND", "entity does not exist"
        ))
        socket, _connection, _blender = self._dispatch_preflight_motion(
            {"motion_id": "walk-01"}, collect=collect
        )
        self.assertEqual(socket.sent, [{
            "type": "bridge_error",
            "id": "preflight-bridge",
            "request_id": "preflight-request",
            "code": "ENTITY_NOT_FOUND",
            "message": "ENTITY_NOT_FOUND: entity does not exist",
            "retryable": False,
        }])

    def test_preflight_motion_maps_stage_scene_error_to_apply_motion_code(self):
        """Real collect_preflight: the loader's StageSceneError surfaces its code."""
        begin_task = mock.Mock()
        socket, _connection, _blender = self._dispatch_preflight_motion(
            {"motion_id": "missing-motion"}, begin_task=begin_task
        )
        self.assertEqual(len(socket.sent), 1)
        error = socket.sent[0]
        self.assertEqual(error["type"], "bridge_error")
        self.assertEqual(error["code"], "APPLY_MOTION_NOT_FOUND")
        self.assertIn(".cclay/motions/missing-motion.npz", error["message"])
        begin_task.assert_not_called()

    def test_live_rewrite_journal_failure_fails_closed_without_substrate_rewrite(self):
        """Audit-before-rewrite: a failed journal append must not persist a rebind."""
        from cclay import project_store

        project_id = "356ae9c2-9cc1-4541-8e8e-a6d759b4df64"
        socket = FakeSocket()
        blender = mock.Mock()
        with tempfile.TemporaryDirectory() as directory:
            cclay = pathlib.Path(directory, ".cclay")
            cclay.mkdir()
            (cclay / "project.json").write_text(json.dumps({
                "project_id": project_id,
                "current_revision_id": BASE_REVISION,
                "manifest": {"sceneHash": "b" * 64},
            }))
            durable_before = (cclay / "project.json").read_text()
            connection = Connection(
                FakeChild(FakeProcess()),
                socket,
                project_directory=directory,
            )
            live_manifest = {
                "schemaVersion": 2,
                "projectId": project_id,
                "revisionId": CANDIDATE_REVISION,
                "sceneHash": "d" * 64,
            }
            manifest_module = types.SimpleNamespace(
                resolve_manifest_for_expected_hash=mock.Mock(return_value=None),
                extract_scene_snapshot=mock.Mock(),
                extract_scene_manifest_v2=mock.Mock(return_value=live_manifest),
            )
            with (
                mock.patch.object(connection_module, "bpy", blender),
                mock.patch.dict(
                    sys.modules,
                    {"cclay.manifest": manifest_module},
                ),
                mock.patch.object(
                    project_store,
                    "append_journal",
                    side_effect=project_store.ProjectStoreError(
                        "injected journal failure"
                    ),
                ) as append_journal,
                mock.patch.object(
                    project_store, "write_project_index"
                ) as write_project_index,
            ):
                connection.dispatch_bridge_message({
                    "type": "bridge_request",
                    "id": "inspect-bridge",
                    "request_id": "inspect-request",
                    "method": "inspect_project",
                    "params": {},
                    "expected_revision_id": BASE_REVISION,
                    "deadline_ms": 5000,
                })
            durable_after = (cclay / "project.json").read_text()
            journal_exists = (cclay / "journal.jsonl").exists()

        append_journal.assert_called_once()
        write_project_index.assert_not_called()
        self.assertEqual(durable_after, durable_before)
        self.assertFalse(journal_exists)
        self.assertEqual(socket.sent[-1]["type"], "bridge_error")
        self.assertEqual(socket.sent[-1]["code"], "DURABLE_STORE_FAILED")
        self.assertIn("journal append failed", socket.sent[-1]["message"])
        manifest_module.extract_scene_snapshot.assert_not_called()

    def test_mutation_with_stale_expected_revision_still_fails_closed(self):
        """Recovery leniency is inspect-only; mutations keep STALE_BASE."""
        socket = FakeSocket()
        blender = mock.Mock()
        with tempfile.TemporaryDirectory() as directory:
            cclay = pathlib.Path(directory, ".cclay")
            cclay.mkdir()
            (cclay / "project.json").write_text(json.dumps({
                "project_id": "project",
                "current_revision_id": BASE_REVISION,
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
                    "id": "stage-bridge",
                    "request_id": "stage-request",
                    "method": "stage_scene",
                    "params": {
                        "schema_version": 1,
                        "expected_revision_id": "e" * 64,
                        "operations": [{"op": "add_primitive"}],
                    },
                    "expected_revision_id": "e" * 64,
                    "deadline_ms": 30000,
                })
            journal_exists = (cclay / "journal.jsonl").exists()

        blender.ops.cclay.stage_scene.assert_not_called()
        self.assertEqual(socket.sent[-1]["type"], "bridge_error")
        self.assertEqual(socket.sent[-1]["code"], "STALE_BASE")
        self.assertEqual(
            socket.sent[-1]["message"],
            "durable project revision does not match the bridge request",
        )
        self.assertFalse(journal_exists)

    def test_stale_base_death_spiral_recovers_via_inspect_project(self):
        """Regression: failed stage_scene -> inspect recovers -> stage_scene succeeds."""
        socket = FakeSocket()
        blender = mock.Mock()
        stale_revision = "e" * 64
        with tempfile.TemporaryDirectory() as directory:
            cclay = pathlib.Path(directory, ".cclay")
            cclay.mkdir()
            (cclay / "project.json").write_text(json.dumps({
                "project_id": "project",
                "current_revision_id": BASE_REVISION,
                "manifest": {"sceneHash": "b" * 64},
            }))
            connection = Connection(
                FakeChild(FakeProcess()),
                socket,
                project_directory=directory,
            )
            snapshot = {"schemaVersion": 2, "scene": {"name": "Scene"}}
            resolved_manifest = {"schemaVersion": 2, "sceneHash": "b" * 64}
            manifest_module = types.SimpleNamespace(
                resolve_manifest_for_expected_hash=mock.Mock(
                    return_value=resolved_manifest
                ),
                extract_scene_snapshot=mock.Mock(return_value=snapshot),
                extract_scene_manifest_v2=mock.Mock(return_value=resolved_manifest),
            )
            stage_message = {
                "type": "bridge_request",
                "id": "stage-bridge",
                "request_id": "stage-request",
                "method": "stage_scene",
                "params": {
                    "schema_version": 1,
                    "expected_revision_id": stale_revision,
                    "operations": [{"op": "add_primitive"}],
                },
                "expected_revision_id": stale_revision,
                "deadline_ms": 30000,
            }
            with (
                mock.patch.object(connection_module, "bpy", blender),
                mock.patch.dict(
                    sys.modules,
                    {"cclay.manifest": manifest_module},
                ),
            ):
                # 1) The stale mutation fails closed.
                connection.dispatch_bridge_message(stage_message)
                self.assertEqual(socket.sent[-1]["type"], "bridge_error")
                self.assertEqual(socket.sent[-1]["code"], "STALE_BASE")
                # 2) inspect_project with the same stale expectation recovers.
                connection.dispatch_bridge_message({
                    "type": "bridge_request",
                    "id": "inspect-bridge",
                    "request_id": "inspect-request",
                    "method": "inspect_project",
                    "params": {},
                    "expected_revision_id": stale_revision,
                    "deadline_ms": 5000,
                })
                self.assertEqual(socket.sent[-1]["type"], "bridge_result")
                rebound_revision = socket.sent[-1]["result"]["revision"]
                self.assertEqual(rebound_revision, BASE_REVISION)
                # 3) The retried mutation on the rebound revision dispatches.
                connection.dispatch_bridge_message({
                    **stage_message,
                    "id": "stage-bridge-retry",
                    "request_id": "stage-request-retry",
                    "params": {
                        "schema_version": 1,
                        "expected_revision_id": rebound_revision,
                        "operations": [{"op": "add_primitive"}],
                    },
                    "expected_revision_id": rebound_revision,
                })

        blender.ops.cclay.stage_scene.assert_called_once()
        self.assertEqual(
            blender.ops.cclay.stage_scene.call_args.kwargs["bridge_id"],
            "stage-bridge-retry",
        )
        self.assertEqual(
            blender.ops.cclay.stage_scene.call_args.kwargs["current_scene_hash"],
            "b" * 64,
        )

    def test_bridge_request_reads_durable_base_hash_from_project_store(self):
        socket = FakeSocket()
        blender = mock.Mock()
        blender.app.timers.register.side_effect = lambda callback, **_kwargs: callback()
        with tempfile.TemporaryDirectory() as directory:
            cclay = pathlib.Path(directory, ".cclay")
            cclay.mkdir()
            (cclay / "project.json").write_text(json.dumps({
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

        blender.ops.cclay.apply_camera_plan.assert_called_once()
        self.assertEqual(
            blender.ops.cclay.apply_camera_plan.call_args.kwargs["current_scene_hash"],
            "b" * 64,
        )

    def test_bridge_timer_sends_ping_on_twenty_second_cadence(self):
        socket = FakeSocket()
        with mock.patch.object(connection_module.time, "monotonic", return_value=100.0):
            connection = Connection(FakeChild(FakeProcess()), socket)

        with mock.patch.object(connection_module.time, "monotonic", return_value=119.99):
            self.assertEqual(connection.pump_bridge_messages(), 0.01)
        self.assertEqual(socket.sent, [])

        with mock.patch.object(connection_module.time, "monotonic", return_value=120.0):
            self.assertEqual(connection.pump_bridge_messages(), 0.01)
        self.assertEqual(socket.sent[0]["type"], "ping")
        self.assertRegex(socket.sent[0]["nonce"], r"^[A-Za-z0-9_-]+$")

    def test_bridge_dispatcher_ignores_pong(self):
        received_pong = threading.Event()

        class PongSocket(FakeSocket):
            def recv_json(self):
                if not received_pong.is_set():
                    received_pong.set()
                    return {"type": "pong", "nonce": "keepalive"}
                raise TimeoutError()

        connection = Connection(FakeChild(FakeProcess()), PongSocket())
        connection.start_bridge_dispatcher()
        self.assertTrue(received_pong.wait(timeout=1))
        time.sleep(0.02)
        self.assertTrue(connection._main_thread_messages.empty())
        self.assertEqual(connection.state, "active")
        connection.state = "disconnected"
        connection._reader_thread.join(timeout=1)
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
        blender.ops.cclay.apply_camera_plan.assert_called_once()

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
        self.assertEqual(connection.task_status.outcome, "recovery_required")
        self.assertEqual(connection.task_status.evidence, "Recovery required")

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
        self.assertEqual(connection.task_status.outcome, "cancelled")
        self.assertEqual(connection.task_status.evidence, "Cancellation accepted")

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
            cclay = pathlib.Path(directory, ".cclay")
            cclay.mkdir()
            (cclay / "project.json").write_text(json.dumps({
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
            cclay = pathlib.Path(directory, ".cclay")
            cclay.mkdir()
            (cclay / "project.json").write_text(json.dumps({
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
            mock.patch("cclay.camera_plan._restore_scope", restore_scope),
            mock.patch("cclay.camera_plan._read_scope", read_scope),
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
            mock.patch("cclay.camera_plan._restore_scope"),
            mock.patch(
                "cclay.camera_plan._read_scope",
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
            cclay = pathlib.Path(directory, ".cclay")
            cclay.mkdir()
            (cclay / "project.json").write_text(json.dumps({
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
                    live_scene_hash_fn=lambda _expected: "b" * 64,
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
            cclay = pathlib.Path(directory, ".cclay")
            cclay.mkdir()
            (cclay / "project.json").write_text(json.dumps({
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
                    live_scene_hash_fn=lambda _expected: "b" * 64,
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
            cclay = pathlib.Path(directory, ".cclay")
            cclay.mkdir()
            (cclay / "project.json").write_text(json.dumps({
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
                        live_scene_hash_fn=lambda _expected: "b" * 64,
                        previous_connection=previous,
                    )

        connection.expose_tools.assert_not_called()
        connection.disconnect.assert_called_once_with("reconnect_hash_mismatch")



if __name__ == "__main__":
    unittest.main()
