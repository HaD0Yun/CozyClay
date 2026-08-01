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

    def test_recovery_required_refuses_bridge_requests_with_structured_error(self):
        socket = FakeSocket()
        connection = Connection(FakeChild(FakeProcess()), socket)
        connection.require_recovery()
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
        self.assertEqual(socket.sent, [{
            "type": "bridge_error",
            "id": "bridge",
            "request_id": "request",
            "code": "RECOVERY_REQUIRED",
            "message": (
                "tool remains callable, but bridge requests are refused until "
                "reconnect verification succeeds"
            ),
            "retryable": False,
        }])

    def test_render_qa_frames_uses_the_existing_main_thread_bridge_dispatcher(self):
        """Dispatches the render request through the retained main-thread dispatcher."""
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
                "operations": [{"op": "set_render_settings", "resolution_x": 1280}],
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
                extract_scene_manifest_v4=mock.Mock(return_value=resolved_manifest),
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
                extract_scene_manifest_v4=mock.Mock(return_value=resolved_manifest),
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
                extract_scene_manifest_v4=mock.Mock(return_value=live_manifest),
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
                        "operations": [{"op": "set_render_settings", "resolution_x": 1280}],
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
                extract_scene_manifest_v4=mock.Mock(return_value=live_manifest),
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
                        "operations": [{"op": "set_render_settings", "resolution_x": 1280}],
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
                extract_scene_manifest_v4=mock.Mock(return_value=resolved_manifest),
            )
            stage_message = {
                "type": "bridge_request",
                "id": "stage-bridge",
                "request_id": "stage-request",
                "method": "stage_scene",
                "params": {
                    "schema_version": 1,
                    "expected_revision_id": stale_revision,
                    "operations": [{"op": "set_render_settings", "resolution_x": 1280}],
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
                        "operations": [{"op": "set_render_settings", "resolution_x": 1280}],
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



if __name__ == "__main__":
    unittest.main()
