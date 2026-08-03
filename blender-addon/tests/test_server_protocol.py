"""Pure-Python coverage for the Blender-owned framed transport."""

import os
import io
import json
import pathlib
import socket
import stat
import sys
import tempfile
import time
import unittest
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).parents[1]))

import cclay.connection as connection
from cclay import project_store, scene_manifest
from cclay.blender_server import (
    BACKLOG_LIMIT,
    COMPLETED_RESULT_LIMIT,
    COMPLETED_RESULT_TTL_SECONDS,
    SERVER_CAPABILITIES,
    BlenderServer,
    BlenderServerError,
    MAX_FRAME_BYTES,
    encode_frame,
    read_frame,
)


def hello(token, **changes):
    value = {
        "type": "hello", "token": token, "client": "cclay-extension",
        "protocol_version": 1, "capabilities": list(SERVER_CAPABILITIES),
    }
    value.update(changes)
    return value
def execute_request(request_id: str) -> dict:
    return {
        "type": "execute_blender_python",
        "request_id": request_id,
        "script": "pass",
        "deadline_ms": 1,
        "capture_stdout": False,
        "expected_revision_id": "a" * 64,
    }


def request_id(index: int) -> str:
    return f"123e4567-e89b-42d3-a456-{index:012d}"




class BlenderServerProtocolTests(unittest.TestCase):
    def test_framing_round_trip_and_rejects_oversize_and_truncation(self):
        self.assertEqual(read_frame(io.BytesIO(encode_frame({"text": "✓"}))), {"text": "✓"})
        with self.assertRaises(BlenderServerError):
            encode_frame({"text": "x" * (MAX_FRAME_BYTES + 1)})
        with self.assertRaises(BlenderServerError):
            read_frame(io.BytesIO(b"\x00\x00\x00\x02{"))

    def test_hello_rejects_bad_token_and_version_without_dispatch(self):
        server = BlenderServer(".", "1.0", lambda _message, _send: None)
        self.assertEqual(server._hello_rejection(hello("wrong")), "BAD_TOKEN")
        self.assertEqual(
            server._hello_rejection(hello(server._token, protocol_version=2)),
            "VERSION_MISMATCH",
        )

    def test_discovery_is_private_atomic_shape_and_token_rotation_replaces_it(self):
        with tempfile.TemporaryDirectory() as directory:
            server = BlenderServer(directory, "1.2.3", lambda _message, _send: None)
            first = server.start()
            try:
                path = pathlib.Path(directory, ".cclay", "bridge-endpoint.json")
                self.assertEqual(set(json.loads(path.read_text())), {
                    "schema_version", "host", "port", "pid", "token", "token_generation",
                    "addon_version", "protocol_version",
                })
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
                second = server.rotate_token()
                self.assertEqual(second["token_generation"], first["token_generation"] + 1)
                self.assertNotEqual(second["token"], first["token"])
            finally:
                server.stop()
            self.assertFalse(path.exists())
    def test_project_lock_refuses_a_live_owner_for_the_canonical_project(self):
        with tempfile.TemporaryDirectory() as directory:
            first = BlenderServer(directory, "1.0", lambda _message, _send: None)
            first._acquire_project_lock()
            second = BlenderServer(pathlib.Path(directory, "."), "1.0", lambda _message, _send: None)
            try:
                with self.assertRaisesRegex(BlenderServerError, "PROJECT_ALREADY_ATTACHED"):
                    second._acquire_project_lock()
            finally:
                first._release_project_lock()

    def test_project_lock_reclaims_a_dead_owner(self):
        with tempfile.TemporaryDirectory() as directory:
            server = BlenderServer(directory, "1.0", lambda _message, _send: None)
            server.project_lock_path.parent.mkdir()
            server.project_lock_path.write_text(json.dumps({
                "schema_version": 1,
                "pid": 999_999_999,
                "owner_token": "x" * 43,
            }))
            server._acquire_project_lock()
            try:
                self.assertEqual(
                    json.loads(server.project_lock_path.read_text())["pid"],
                    os.getpid(),
                )
            finally:
                server._release_project_lock()

    def test_project_lock_fails_closed_for_malformed_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            server = BlenderServer(directory, "1.0", lambda _message, _send: None)
            server.project_lock_path.parent.mkdir()
            server.project_lock_path.write_text("not JSON")
            with self.assertRaisesRegex(BlenderServerError, "PROJECT_ALREADY_ATTACHED"):
                server._acquire_project_lock()
            self.assertEqual(server.project_lock_path.read_text(), "not JSON")

    def test_project_lock_release_does_not_delete_a_replacement_lock(self):
        with tempfile.TemporaryDirectory() as directory:
            server = BlenderServer(directory, "1.0", lambda _message, _send: None)
            server._acquire_project_lock()
            replacement = server.project_lock_path.with_suffix(".replacement")
            replacement.write_text(json.dumps({
                "schema_version": 1,
                "pid": os.getpid(),
                "owner_token": "r" * 43,
            }))
            os.replace(replacement, server.project_lock_path)
            server._release_project_lock()
            self.assertTrue(server.project_lock_path.exists())

    def test_live_discovery_and_project_lock_refuse_second_owner(self):
        with tempfile.TemporaryDirectory() as directory:
            first = BlenderServer(directory, "1.0", lambda _message, _send: None)
            first.start()
            second = BlenderServer(pathlib.Path(directory, "."), "1.0", lambda _message, _send: None)
            try:
                with self.assertRaisesRegex(BlenderServerError, "PROJECT_ALREADY_ATTACHED"):
                    second.start()
            finally:
                first.stop()

    def test_stale_discovery_is_replaced_only_after_dead_pid_check(self):
        with tempfile.TemporaryDirectory() as directory:
            endpoint = pathlib.Path(directory, ".cclay", "bridge-endpoint.json")
            endpoint.parent.mkdir()
            endpoint.write_text(json.dumps({
                "schema_version": 1,
                "host": "127.0.0.1",
                "port": 1,
                "pid": 999_999_999,
                "token": "x" * 43,
                "token_generation": 0,
                "addon_version": "1.0",
                "protocol_version": 1,
            }))
            server = BlenderServer(directory, "1.0", lambda _message, _send: None)
            discovery = server.start()
            try:
                self.assertEqual(json.loads(endpoint.read_text())["pid"], discovery["pid"])
            finally:
                server.stop()

    def test_token_rotation_requires_new_token_and_closes_prior_generation_after_grace(self):
        class Client:
            closed = False

            def close(self):
                self.closed = True

        with tempfile.TemporaryDirectory() as directory:
            server = BlenderServer(directory, "1.0", lambda _message, _send: None)
            server.start()
            old_token = server._token
            client = Client()
            server._clients[client] = 0
            rotated = server.rotate_token()
            try:
                self.assertEqual(server._hello_rejection(hello(old_token)), "BAD_TOKEN")
                self.assertIsNone(server._hello_rejection(hello(rotated["token"])))
                self.assertFalse(client.closed)
                server._close_prior_generation(rotated["token_generation"])
                self.assertTrue(client.closed)
            finally:
                server.stop()

    def test_completed_results_have_exact_limit_and_expire_before_query(self):
        now = [0.0]

        def dispatch(message, send):
            send({"type": "execute_result", "request_id": message["request_id"]})

        server = BlenderServer(".", "1.0", dispatch, clock=lambda: now[0])
        for index in range(COMPLETED_RESULT_LIMIT + 1):
            server._work.put_nowait((
                execute_request(request_id(index)),
                lambda _result: None,
            ))
            server.pump()
        self.assertEqual(len(server._completed), COMPLETED_RESULT_LIMIT)
        now[0] += COMPLETED_RESULT_TTL_SECONDS
        sent = []
        server._work.put_nowait((
            {"type": "get_execution_outcome", "request_id": request_id(COMPLETED_RESULT_LIMIT)},
            sent.append,
        ))
        server.pump()
        self.assertEqual(sent, [{
            "type": "execution_outcome_not_found",
            "request_id": request_id(COMPLETED_RESULT_LIMIT),
        }])

    def test_outcome_query_uses_durable_lookup_after_cache_loss(self):
        durable = {
            "type": "execute_result",
            "request_id": request_id(9),
            "outcome": "success",
            "new_revision_id": "b" * 64,
            "stdout": "",
            "stdout_truncated": False,
            "stderr": "",
            "stderr_truncated": False,
        }
        server = BlenderServer(
            ".",
            "1.0",
            lambda _message, _send: self.fail("must not dispatch"),
            outcome_lookup=lambda value: durable if value == request_id(9) else None,
        )
        sent = []
        server._work.put_nowait((
            {"type": "get_execution_outcome", "request_id": request_id(9)},
            sent.append,
        ))
        server.pump()
        self.assertEqual(sent, [durable])

    def test_execute_request_validation_is_closed(self):
        dispatched = []
        server = BlenderServer(".", "1.0", lambda message, _send: dispatched.append(message))
        invalid = execute_request(request_id(7))
        invalid["unexpected"] = True
        server._work.put_nowait((invalid, lambda _result: None))
        server.pump()
        self.assertEqual(dispatched, [])
    def test_disabled_and_stale_execution_are_preconditions_without_journals(self):
        with tempfile.TemporaryDirectory() as directory:
            request = execute_request(request_id(10))
            sent = []
            with (
                mock.patch.object(connection, "bpy", object()),
                # _execute_blender_python imports the extraction module before
                # the precondition checks; on the host there is no bpy, so the
                # real module cannot load. The mock also keeps the later
                # precondition extraction from needing real scene data.
                mock.patch.dict(
                    sys.modules,
                    {"cclay.manifest": mock.Mock(extract_scene_manifest_v4=mock.Mock(return_value={}))},
                ),
                mock.patch(
                    "cclay.project_store.read_project_index",
                    return_value={"current_revision_id": "a" * 64},
                ),
                mock.patch(
                    "cclay.project_store.read_execute_blender_python_permission",
                    return_value=False,
                ),
            ):
                connection._execute_blender_python(request, sent.append, pathlib.Path(directory))
            self.assertEqual(sent[0]["code"], "AUTH_INVALID")
            self.assertFalse(pathlib.Path(directory, ".cclay", "execution-journal").exists())

            sent.clear()
            request["expected_revision_id"] = "b" * 64
            with (
                mock.patch.object(connection, "bpy", object()),
                mock.patch.dict(
                    sys.modules,
                    {"cclay.manifest": mock.Mock(extract_scene_manifest_v4=mock.Mock(return_value={}))},
                ),
                mock.patch(
                    "cclay.project_store.read_project_index",
                    return_value={"current_revision_id": "a" * 64},
                ),
                mock.patch(
                    "cclay.project_store.read_execute_blender_python_permission",
                    return_value=None,
                ),
            ):
                connection._execute_blender_python(request, sent.append, pathlib.Path(directory))
            self.assertEqual(sent[0]["code"], "REVISION_STALE")
            self.assertFalse(pathlib.Path(directory, ".cclay", "execution-journal").exists())
    def test_live_manifest_drift_rejects_execution_before_backup_or_script(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            project_id = "123e4567-e89b-42d3-a456-426614174000"
            sent = []
            with (
                mock.patch.object(connection, "bpy", object()),
                mock.patch(
                    "cclay.project_store.read_project_index",
                    return_value={
                        "project_id": project_id,
                        "current_revision_id": "a" * 64,
                        "manifest": {
                            "revisionId": "a" * 64,
                            "sceneHash": "b" * 64,
                        },
                    },
                ),
                mock.patch(
                    "cclay.project_store.read_execute_blender_python_permission",
                    return_value=None,
                ),
                mock.patch.dict(
                    sys.modules,
                    {
                        "cclay.manifest": mock.Mock(
                            extract_scene_manifest_v4=mock.Mock(
                                return_value={
                                    "projectId": project_id,
                                    "sceneHash": "c" * 64,
                                }
                            )
                        )
                    },
                ),
                mock.patch.object(connection, "ExecutionCoordinator") as coordinator,
            ):
                connection._execute_blender_python(
                    execute_request(request_id(13)), sent.append, root
                )

            self.assertEqual(sent, [{
                "type": "precondition_failed",
                "request_id": request_id(13),
                "code": "REVISION_STALE",
                "message": "Live Blender scene does not match the durable current revision.",
            }])
            coordinator.assert_not_called()
            self.assertFalse((root / ".cclay" / "execution-journal").exists())
    def test_successful_execution_persists_one_child_of_the_durable_base(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            base_revision_id = "a" * 64
            child_revision_id = "b" * 64
            project_id = "123e4567-e89b-42d3-a456-426614174000"
            # The precondition extraction (before the script) must match the
            # durable base; the mint extraction (after the script) must show
            # the scene changed, otherwise the content-derived mint treats the
            # execution as a no-op.
            pre_script_manifest = {
                "projectId": project_id,
                "revisionId": "ignored",
                "sceneHash": "d" * 64,
            }
            post_script_manifest = {
                "projectId": project_id,
                "revisionId": "ignored",
                "sceneHash": "e" * 64,
            }
            child_manifest = {
                "projectId": project_id,
                "revisionId": child_revision_id,
                "sceneHash": "e" * 64,
            }
            project_store.write_project_index(
                directory,
                project_id,
                {
                    "schema_version": 1,
                    "current_revision_id": base_revision_id,
                    "manifest": {
                        "revisionId": base_revision_id,
                        "sceneHash": "d" * 64,
                    },
                },
            )
            blend_path = root / "scene.blend"
            blend_path.write_bytes(b"source")

            class FakeBpy:
                def __init__(self):
                    self.data = type("Data", (), {"filepath": str(blend_path)})()
                    self.ops = type("Ops", (), {
                        "wm": type("WindowManager", (), {
                            "save_as_mainfile": staticmethod(
                                lambda *, filepath, copy: pathlib.Path(filepath).write_bytes(
                                    b"backup"
                                )
                            ),
                        })(),
                    })()

            sent = []
            request = execute_request(request_id(12))
            with (
                mock.patch.object(connection, "bpy", FakeBpy()),
                mock.patch.dict(
                    sys.modules,
                    {
                        "cclay.manifest": mock.Mock(
                            extract_scene_manifest_v4=mock.Mock(
                                side_effect=[pre_script_manifest, post_script_manifest]
                            )
                        )
                    },
                ),
                mock.patch.object(
                    scene_manifest,
                    "finalize_scene_manifest_child",
                    return_value=child_manifest,
                ) as finalize_child,
                mock.patch(
                    "cclay.project_store.write_project_index",
                    wraps=project_store.write_project_index,
                ) as write_index,
            ):
                connection._execute_blender_python(request, sent.append, root)

            self.assertEqual(sent[0]["new_revision_id"], child_revision_id)
            self.assertEqual(write_index.call_count, 1)
            self.assertEqual(
                finalize_child.call_args.args[1],
                base_revision_id,
            )
            self.assertEqual(
                finalize_child.call_args.args[2],
                {
                    "type": "execute_blender_python",
                    "request_id": request["request_id"],
                },
            )
            persisted = project_store.read_project_index(directory)
            self.assertEqual(persisted["current_revision_id"], child_revision_id)
            self.assertEqual(persisted["manifest"], child_manifest)

    def test_noop_execution_returns_the_durable_base_without_minting(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            base_revision_id = "a" * 64
            project_id = "123e4567-e89b-42d3-a456-426614174000"
            live_manifest = {
                "projectId": project_id,
                "revisionId": "ignored",
                "sceneHash": "c" * 64,
            }
            child_manifest = {
                "projectId": project_id,
                "revisionId": "b" * 64,
                "sceneHash": "c" * 64,
            }
            project_store.write_project_index(
                directory,
                project_id,
                {
                    "schema_version": 1,
                    "current_revision_id": base_revision_id,
                    "manifest": {
                        "revisionId": base_revision_id,
                        "sceneHash": "c" * 64,
                    },
                },
            )
            blend_path = root / "scene.blend"
            blend_path.write_bytes(b"source")

            class FakeBpy:
                def __init__(self):
                    self.data = type("Data", (), {"filepath": str(blend_path)})()
                    self.ops = type("Ops", (), {
                        "wm": type("WindowManager", (), {
                            "save_as_mainfile": staticmethod(
                                lambda *, filepath, copy: pathlib.Path(filepath).write_bytes(
                                    b"backup"
                                )
                            ),
                        })(),
                    })()

            sent = []
            request = execute_request(request_id(14))
            with (
                mock.patch.object(connection, "bpy", FakeBpy()),
                mock.patch.dict(
                    sys.modules,
                    {
                        "cclay.manifest": mock.Mock(
                            extract_scene_manifest_v4=mock.Mock(
                                return_value=live_manifest
                            )
                        )
                    },
                ),
                mock.patch.object(
                    scene_manifest,
                    "finalize_scene_manifest_child",
                    return_value=child_manifest,
                ) as finalize_child,
                mock.patch(
                    "cclay.project_store.write_project_index",
                    wraps=project_store.write_project_index,
                ) as write_index,
            ):
                connection._execute_blender_python(request, sent.append, root)

            # A script whose canonical manifest is byte-identical to the
            # durable base must not mint a child revision: the revision the
            # caller already holds stays valid.
            self.assertEqual(sent[0]["new_revision_id"], base_revision_id)
            self.assertEqual(write_index.call_count, 0)
            finalize_child.assert_not_called()
            persisted = project_store.read_project_index(directory)
            self.assertEqual(persisted["current_revision_id"], base_revision_id)

    def test_exception_dispatch_closes_without_response(self):
        closed = []
        server = BlenderServer(
            ".",
            "1.0",
            lambda _message, send: send.close_client(),
        )
        sender = mock.Mock()
        sender.close_client = lambda: closed.append(True)
        server._work.put_nowait((execute_request(request_id(11)), sender))
        server.pump()
        self.assertEqual(closed, [True])
        sender.assert_not_called()

    def test_hello_requires_extension_transport_capability(self):
        server = BlenderServer(".", "1.0", lambda _message, _send: None)
        self.assertEqual(
            server._hello_rejection(hello(server._token, capabilities=[])),
            "BAD_TOKEN",
        )
    def test_dispatch_waits_for_active_request_completion(self):
        callbacks = []
        dispatched = []

        def dispatch(message, send):
            dispatched.append(message["request_id"])
            callbacks.append(send)

        server = BlenderServer(".", "1.0", dispatch)
        ids = (request_id(1), request_id(2))
        for request_id_value in ids:
            server._work.put_nowait((
                execute_request(request_id_value),
                lambda _result: None,
            ))
        server.pump()
        self.assertEqual(dispatched, [ids[0]])
        callbacks.pop()({"type": "execute_result", "request_id": ids[0]})
        server.pump()
        self.assertEqual(dispatched, [ids[0], ids[1]])
    def test_queue_is_bounded_and_completed_results_are_addressable(self):
        dispatched = []
        def dispatch(message, send):
            dispatched.append(message)
            send({
                "type": "execute_result",
                "request_id": message["request_id"],
                "outcome": "outcome_unknown",
                "reason": "lost",
            })

        server = BlenderServer(".", "1.0", dispatch)
        sender = []
        for index in range(BACKLOG_LIMIT):
            server._work.put_nowait((
                execute_request(request_id(index)),
                sender.append,
            ))
        with self.assertRaises(Exception):
            server._work.put_nowait(({"type": "x"}, sender.append))
        server.pump()
        server.pump()
        self.assertEqual(len(dispatched), BACKLOG_LIMIT)
        server._work.put_nowait((
            {"type": "get_execution_outcome", "request_id": request_id(0)}, sender.append,
        ))
        server.pump()
        self.assertEqual(sender[-1]["request_id"], request_id(0))

    def test_inflight_disconnect_does_not_dispatch_from_listener_thread(self):
        dispatched = []
        with tempfile.TemporaryDirectory() as directory:
            server = BlenderServer(directory, "1.0", lambda message, _send: dispatched.append(message))
            discovery = server.start()
            client = socket.create_connection((discovery["host"], discovery["port"]))
            stream = client.makefile("rwb")
            try:
                stream.write(encode_frame(hello(discovery["token"])))
                stream.flush()
                self.assertEqual(read_frame(stream)["type"], "hello_ack")
                stream.write(encode_frame({"type": "bridge_request", "id": "a"}))
                stream.flush()
                client.close()
                time.sleep(0.02)
                self.assertEqual(dispatched, [])
                server.pump()
                self.assertEqual(dispatched, [{"type": "bridge_request", "id": "a"}])
            finally:
                server.stop()


if __name__ == "__main__":
    unittest.main()
