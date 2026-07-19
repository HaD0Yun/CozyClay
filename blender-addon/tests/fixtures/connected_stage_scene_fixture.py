"""Drive stage_scene creation, rollback, and deferred deletion through the real bridge."""

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
from oh_my_blender.connection import Connection, _resolve_daemon_argv
from oh_my_blender.manifest import extract_scene_manifest_v2, extract_scene_manifest_v3

PROJECT_ID = "00000000-0000-4000-8000-00000000000a"


def send_request(connection: Connection, params: dict, expected_revision_id: str) -> queue.Queue:
    request_id = str(uuid.uuid4())
    responses = queue.Queue(maxsize=1)
    connection._response_queues[request_id] = responses
    connection.last_bridge_response = None
    connection._send_json({
        "type": "request",
        "id": request_id,
        "method": "stage_scene",
        "params": params,
        "expected_revision_id": expected_revision_id,
        "deadline_ms": 30000,
    })
    return responses


def receive(connection: Connection, responses: queue.Queue, timeout: float = 30) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        connection.pump_bridge_messages()
        if connection.last_bridge_response is not None:
            return connection.last_bridge_response
        try:
            return responses.get_nowait()
        except queue.Empty:
            time.sleep(0.01)
    raise RuntimeError(
        "stage_scene response timed out: "
        f"state={connection.state}, status={connection.task_status}, "
        f"reader_alive={connection._reader_thread.is_alive() if connection._reader_thread else None}, "
        f"child_exit={connection.child.process.poll()}, sent={connection.websocket.closed}"
    )


def request(revision: str, operations: list[dict]) -> dict:
    return {
        "schema_version": 1,
        "expected_revision_id": revision,
        "operations": operations,
    }


def transform(location=(0, 0, 0), scale=(1, 1, 1)) -> dict:
    return {
        "location": list(location),
        "rotation": [0, 0, 0],
        "scale": list(scale),
    }


def main() -> None:
    for scene_object in list(bpy.data.objects):
        bpy.data.objects.remove(scene_object, do_unlink=True)
    bpy.context.scene["omb.project_id"] = PROJECT_ID
    base = extract_scene_manifest_v2()
    directory = Path(tempfile.mkdtemp(prefix="omb-connected-stage-"))
    connection = None
    original_apply = stage_scene.apply_stage_scene_transaction
    try:
        omb = directory / ".omb"
        omb.mkdir()
        (omb / "project.json").write_text(json.dumps({
            "schema_version": 1,
            "project_id": PROJECT_ID,
            "current_revision_id": base["revisionId"],
            "manifest": base,
        }), encoding="utf-8")
        oh_my_blender.register()
        connection = Connection.start(
            _resolve_daemon_argv(("--faux",)),
            cwd=directory,
            project_id=PROJECT_ID,
            addon_version="0.1.0",
            blender_version=bpy.app.version_string,
        )
        connection_module._active_connection = connection

        create_request = request(base["revisionId"], [
            {"op": "add_primitive", "primitive_type": "PLANE", "name": "Floor", **transform(scale=(5, 5, 1))},
            {"op": "set_material_color", "object_name": "Floor", "color": [0.12, 0.18, 0.3, 1]},
            {"op": "add_primitive", "primitive_type": "CUBE", "name": "Hero Cube", **transform(location=(0, 0, 1))},
            {"op": "set_material_color", "object_name": "Hero Cube", "color": [0.8, 0.2, 0.1, 1]},
            {"op": "add_primitive", "primitive_type": "UV_SPHERE", "name": "Hero Sphere", **transform(location=(2, 0, 1))},
            {"op": "set_material_color", "object_name": "Hero Sphere", "color": [0.1, 0.35, 0.8, 1]},
            {
                "op": "upsert_area_light",
                "name": "Key Light",
                **transform(location=(4, -4, 6)),
                "energy": 800,
                "color": [1, 0.9, 0.8],
                "size": 3,
            },
        ])
        created_response = receive(connection, send_request(connection, create_request, base["revisionId"]))
        if created_response.get("type") != "response":
            raise RuntimeError(f"connected create failed: {created_response}")
        durable = json.loads((omb / "project.json").read_text(encoding="utf-8"))
        live = extract_scene_manifest_v3()
        durable_manifest = durable["manifest"]
        cube_id = next(item["entityId"] for item in durable_manifest["objects"] if item["name"] == "Hero Cube")
        sphere_id = next(item["entityId"] for item in durable_manifest["objects"] if item["name"] == "Hero Sphere")

        time.sleep(1.01)
        before_rollback = extract_scene_manifest_v3()

        def fail_apply(plan_value, current_scene_hash, active, _commit_fn, **kwargs):
            return original_apply(
                plan_value,
                current_scene_hash,
                active,
                lambda _candidate: (_ for _ in ()).throw(RuntimeError("injected commit failure")),
                **kwargs,
            )

        stage_scene.apply_stage_scene_transaction = fail_apply
        rollback_request = request(durable["current_revision_id"], [
            {"op": "add_primitive", "primitive_type": "CUBE", "name": "Rollback Cube", **transform(location=(0, 3, 1))},
        ])
        rollback_response = receive(
            connection,
            send_request(connection, rollback_request, durable["current_revision_id"]),
        )
        stage_scene.apply_stage_scene_transaction = original_apply
        rollback_exact = extract_scene_manifest_v3() == before_rollback

        time.sleep(1.01)
        delete_request = request(durable["current_revision_id"], [
            {"op": "delete_entity", "entity_id": sphere_id},
        ])
        delete_response = receive(
            connection,
            send_request(connection, delete_request, durable["current_revision_id"]),
        )
        after_delete = json.loads((omb / "project.json").read_text(encoding="utf-8"))
        print("OMB_CONNECTED_STAGE_RESULTS=" + json.dumps({
            "createResponse": created_response.get("type"),
            "rollbackCode": rollback_response.get("code"),
            "rollbackExact": rollback_exact,
            "deleteResponse": delete_response.get("type"),
            "daemonIdsMatch": {
                item["entityId"] for item in durable_manifest["objects"]
            } == {
                scene_object.get("omb.entity_id") for scene_object in bpy.context.scene.objects
            } | {sphere_id},
            "manifestAdvanced": durable_manifest["sceneHash"] != base["sceneHash"],
            "stageCounts": [len(durable_manifest["stagePrimitives"]), len(durable_manifest["stageMaterials"])],
            "cubeStillPresent": any(obj.get("omb.entity_id") == cube_id for obj in bpy.context.scene.objects),
            "sphereDestroyed": all(obj.get("omb.entity_id") != sphere_id for obj in bpy.data.objects),
            "deleteRevisionAdvanced": after_delete["current_revision_id"] != durable["current_revision_id"],
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
