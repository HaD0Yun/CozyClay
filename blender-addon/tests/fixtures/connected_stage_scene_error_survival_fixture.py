"""Exercise fixed stage_scene failures and bridge survival through real Blender."""

from __future__ import annotations

import json
import queue
import shutil
import sys
import tempfile
import time
import uuid
from pathlib import Path

import bpy

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPOSITORY_ROOT / "blender-addon"))

import oh_my_blender
import oh_my_blender.connection as connection_module
import oh_my_blender.stage_scene as stage_scene
from oh_my_blender.canonical import canonical_revision
from oh_my_blender.connection import Connection, LifecycleState, _resolve_daemon_argv
from oh_my_blender.manifest import extract_scene_manifest_v2, extract_scene_snapshot

PROJECT_ID = "00000000-0000-4000-8000-00000000000f"
SENTINEL = "private-stage-runtime-sentinel"


def send_request(
    connection: Connection,
    method: str,
    params: dict,
    expected_revision_id: str,
) -> queue.Queue:
    request_id = str(uuid.uuid4())
    responses = queue.Queue(maxsize=1)
    connection._response_queues[request_id] = responses
    connection._send_json({
        "type": "request",
        "id": request_id,
        "method": method,
        "params": params,
        "expected_revision_id": expected_revision_id,
        "deadline_ms": 30_000,
    })
    return responses


def receive(connection: Connection, responses: queue.Queue, timeout: float = 30) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        connection.pump_bridge_messages()
        try:
            return responses.get_nowait()
        except queue.Empty:
            time.sleep(0.01)
    raise RuntimeError("daemon response timed out")


def main() -> None:
    for scene_object in list(bpy.data.objects):
        bpy.data.objects.remove(scene_object, do_unlink=True)
    bpy.context.scene["omb.project_id"] = PROJECT_ID
    manifest = extract_scene_manifest_v2()
    directory = Path(tempfile.mkdtemp(prefix="omb-connected-stage-error-"))
    connection = None
    original_apply = stage_scene.apply_stage_scene_transaction
    try:
        omb = directory / ".omb"
        omb.mkdir()
        project_path = omb / "project.json"
        project_path.write_text(json.dumps({
            "schema_version": 1,
            "project_id": PROJECT_ID,
            "current_revision_id": manifest["revisionId"],
            "manifest": manifest,
        }), encoding="utf-8")
        before_project = project_path.read_text(encoding="utf-8")

        oh_my_blender.register()
        connection = Connection.start(
            _resolve_daemon_argv(("--faux",)),
            cwd=directory,
            project_id=PROJECT_ID,
            addon_version="0.1.0",
            blender_version=bpy.app.version_string,
        )
        connection_module._active_connection = connection

        def fail_stage(*_args, **_kwargs):
            raise RuntimeError(SENTINEL)

        stage_scene.apply_stage_scene_transaction = fail_stage
        failed = receive(
            connection,
            send_request(
                connection,
                "stage_scene",
                {
                    "schema_version": 1,
                    "expected_revision_id": manifest["revisionId"],
                    "operations": [{
                        "op": "add_primitive",
                        "primitive_type": "CUBE",
                        "name": "Must Not Persist",
                        "location": [0, 0, 0],
                        "rotation": [0, 0, 0],
                        "scale": [1, 1, 1],
                    }],
                },
                manifest["revisionId"],
            ),
        )
        stage_scene.apply_stage_scene_transaction = original_apply

        snapshot = extract_scene_snapshot()
        inspected = receive(
            connection,
            send_request(
                connection,
                "inspect_project",
                {"snapshot": snapshot},
                canonical_revision(snapshot),
            ),
        )
        serialized_failure = json.dumps(failed, separators=(",", ":"))
        print("OMB_CONNECTED_STAGE_ERROR_SURVIVAL_RESULTS=" + json.dumps({
            "failure": failed,
            "sentinelAbsent": SENTINEL not in serialized_failure and "RuntimeError" not in serialized_failure,
            "inspectType": inspected.get("type"),
            "bridgeAlive": connection.state == LifecycleState.ACTIVE,
            "durableUnchanged": project_path.read_text(encoding="utf-8") == before_project,
        }, separators=(",", ":")))
    finally:
        stage_scene.apply_stage_scene_transaction = original_apply
        if connection is not None:
            try:
                connection.disconnect("fixture_complete")
            except BaseException:
                connection.child.kill()
        connection_module._active_connection = None
        oh_my_blender.unregister()
        shutil.rmtree(directory, ignore_errors=True)


main()
