"""Drive a real response-win disconnect, child restart, and reconnect hash gate."""

from __future__ import annotations

import json
import os
import queue
import shutil
import socket
import sys
import tempfile
import time
import uuid
from pathlib import Path

import bpy

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPOSITORY_ROOT / "blender-addon"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import oh_my_blender
import oh_my_blender.connection as connection_module
from apply_camera_plan_fixture import PROJECT_ID, REVISION, bound_plan, setup_scene
from oh_my_blender.canonical import canonical_revision
from oh_my_blender.connection import Connection, ConnectionError, _resolve_daemon_argv, reconnect
from oh_my_blender.daemon_child import DaemonChild
from oh_my_blender.manifest import extract_scene_manifest_v2, extract_scene_snapshot


class RecordingDaemonChild(DaemonChild):
    spawned: list["RecordingDaemonChild"] = []

    @classmethod
    def spawn(cls, argv, *, cwd=None):
        child = super().spawn(argv, cwd=cwd)
        cls.spawned.append(child)
        return child


def sever_socket(connection: Connection) -> None:
    connection.websocket.socket.shutdown(socket.SHUT_RDWR)
    connection.websocket.socket.close()
    deadline = time.monotonic() + 3
    while connection.state == "active" and time.monotonic() < deadline:
        time.sleep(0.01)
    if connection.state == "active":
        raise RuntimeError("real socket severance was not detected")


def send_inspect(connection: Connection, request_id: str) -> dict:
    responses = queue.Queue(maxsize=1)
    connection._response_queues[request_id] = responses
    snapshot = extract_scene_snapshot()
    connection._send_json({
        "type": "request",
        "id": request_id,
        "method": "inspect_project",
        "params": {"snapshot": snapshot},
        "expected_revision_id": canonical_revision(snapshot),
        "deadline_ms": 30000,
    })
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        connection.pump_bridge_messages()
        try:
            return responses.get_nowait()
        except queue.Empty:
            time.sleep(0.01)
    raise RuntimeError("reconnected inspect timed out")


def main() -> None:
    setup_scene()
    base_manifest = extract_scene_manifest_v2()
    if base_manifest["revisionId"] != REVISION:
        raise RuntimeError("reconnect fixture revision drifted")

    directory = Path(tempfile.mkdtemp(prefix="omb-connected-reconnect-"))
    connections: list[Connection] = []
    child_pids: list[int] = []
    result = None
    try:
        omb = directory / ".omb"
        omb.mkdir()
        (omb / "project.json").write_text(json.dumps({
            "schema_version": 1,
            "project_id": PROJECT_ID,
            "current_revision_id": REVISION,
            "manifest": base_manifest,
        }), encoding="utf-8")

        oh_my_blender.register()
        first = Connection.start(
            _resolve_daemon_argv(("--faux",)),
            cwd=directory,
            project_id=PROJECT_ID,
            addon_version="0.1.0",
            blender_version=bpy.app.version_string,
        )
        connections.append(first)
        child_pids.append(first.child.process.pid)
        connection_module._active_connection = first

        apply_request_id = str(uuid.uuid4())
        first._send_json({
            "type": "request",
            "id": apply_request_id,
            "method": "apply_camera_plan",
            "params": bound_plan(),
            "expected_revision_id": REVISION,
            "deadline_ms": 30000,
        })
        deadline = time.monotonic() + 30
        while first.last_bridge_response is None and time.monotonic() < deadline:
            first.pump_bridge_messages()
            time.sleep(0.01)
        if first.last_bridge_response is None:
            raise RuntimeError("real camera mutation did not durably win")
        durable_after_apply = json.loads((omb / "project.json").read_text(encoding="utf-8"))
        live_after_apply = extract_scene_manifest_v2()
        if durable_after_apply["current_revision_id"] != live_after_apply["revisionId"]:
            raise RuntimeError("response-win mutation was not durably committed")

        first_identity = dict(first.identity or {})
        sever_socket(first)
        first.child.kill()
        old_child_exited = first.child.process.poll() is not None

        second = reconnect(
            _resolve_daemon_argv(("--faux",)),
            cwd=directory,
            project_id=PROJECT_ID,
            addon_version="0.1.0",
            blender_version=bpy.app.version_string,
            live_scene_hash_fn=lambda: extract_scene_manifest_v2()["sceneHash"],
            previous_connection=first,
        )
        connections.append(second)
        child_pids.append(second.child.process.pid)
        connection_module._active_connection = second
        second_identity = dict(second.identity or {})
        identity_keys = {
            "launch_id",
            "bearer_token_fingerprint",
            "client_nonce",
            "session_id",
            "server_nonce",
        }
        identities_fresh = all(first_identity[key] != second_identity[key] for key in identity_keys)
        inspect_request_id = str(uuid.uuid4())
        inspect_response = send_inspect(second, inspect_request_id)
        if inspect_response.get("type") != "response":
            raise RuntimeError(f"reconnected inspect failed: {inspect_response}")

        bpy.context.scene.render.resolution_x += 1
        sever_socket(second)
        second.child.kill()
        mismatch_rejected = False
        try:
            reconnect(
                _resolve_daemon_argv(("--faux",)),
                cwd=directory,
                project_id=PROJECT_ID,
                addon_version="0.1.0",
                blender_version=bpy.app.version_string,
                live_scene_hash_fn=lambda: extract_scene_manifest_v2()["sceneHash"],
                previous_connection=second,
                child_type=RecordingDaemonChild,
            )
        except ConnectionError as error:
            mismatch_rejected = "canonical current revision" in str(error)
        if len(RecordingDaemonChild.spawned) != 1:
            raise RuntimeError("mismatch reconnect did not launch exactly one replacement child")
        rejected_child = RecordingDaemonChild.spawned[0]
        child_pids.append(rejected_child.process.pid)
        rejected_child_exited = rejected_child.process.poll() is not None

        result = {
            "oldChildExited": old_child_exited,
            "identitiesFresh": identities_fresh,
            "requestIdsFresh": apply_request_id != inspect_request_id,
            "toolsExposedAfterGate": second.tools_exposed,
            "reconnectedInspect": inspect_response["type"],
            "responseWinPreserved": durable_after_apply["current_revision_id"] == live_after_apply["revisionId"],
            "mismatchRejected": mismatch_rejected,
            "rejectedChildExited": rejected_child_exited,
        }
    finally:
        for connection in connections:
            if connection.child.process.poll() is None:
                try:
                    connection.disconnect("reconnect_fixture_complete")
                except BaseException:
                    connection.child.kill()
        connection_module._active_connection = None
        oh_my_blender.unregister()
        shutil.rmtree(directory, ignore_errors=True)
        if directory.exists():
            raise RuntimeError("temporary reconnect project leaked")
        for pid in child_pids:
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                continue
            raise RuntimeError(f"daemon child {pid} leaked")

    print("OMB_RECONNECT_FAULT_RESULTS=" + json.dumps(result, separators=(",", ":")))


main()
