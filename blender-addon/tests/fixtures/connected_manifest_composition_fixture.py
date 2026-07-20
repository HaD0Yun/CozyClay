"""Drive V2 -> stage V3 -> camera V3 -> QA through the real bridge."""

from __future__ import annotations

import copy
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
sys.path.insert(0, str(Path(__file__).resolve().parent))

import oh_my_blender
import oh_my_blender.camera_plan as camera_plan
import oh_my_blender.connection as connection_module
from apply_camera_plan_fixture import PROJECT_ID, bound_plan, setup_scene
from oh_my_blender.connection import Connection, _resolve_daemon_argv
from oh_my_blender.manifest import extract_scene_manifest_v2, extract_scene_manifest_v4


def send_request(
    connection: Connection,
    method: str,
    params: dict,
    expected_revision_id: str,
) -> tuple[str, queue.Queue]:
    request_id = str(uuid.uuid4())
    responses = queue.Queue(maxsize=1)
    connection._response_queues[request_id] = responses
    connection.last_bridge_response = None
    connection._send_json({
        "type": "request",
        "id": request_id,
        "method": method,
        "params": params,
        "expected_revision_id": expected_revision_id,
        "deadline_ms": 30000,
    })
    return request_id, responses


def receive(connection: Connection, responses: queue.Queue, timeout: float = 45) -> dict:
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
        "composition response timed out: "
        f"state={connection.state}, status={connection.task_status}"
    )


def transform(location=(0, 0, 0), scale=(1, 1, 1)) -> dict:
    return {
        "location": list(location),
        "rotation": [0, 0, 0],
        "scale": list(scale),
    }


def main() -> None:
    setup_scene()
    base_manifest = extract_scene_manifest_v2()
    authorized_evidence = camera_plan.load_authorized_fixture(
        bound_plan(), base_manifest["sceneHash"]
    )
    directory = Path(tempfile.mkdtemp(prefix="omb-connected-composition-"))
    connection = None
    original_load = camera_plan.load_authorized_fixture

    def rebound_evidence(plan: dict, scene_hash: str) -> dict:
        evidence = copy.deepcopy(authorized_evidence)
        evidence["revision_id"] = plan["expected_revision_id"]
        evidence["scene_hash"] = scene_hash
        return evidence

    camera_plan.load_authorized_fixture = rebound_evidence
    try:
        omb = directory / ".omb"
        omb.mkdir()
        (omb / "project.json").write_text(json.dumps({
            "schema_version": 1,
            "project_id": PROJECT_ID,
            "current_revision_id": base_manifest["revisionId"],
            "manifest": base_manifest,
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

        assembly_plan = {
            "schema_version": 1,
            "expected_revision_id": base_manifest["revisionId"],
            "operations": [{"op": "create_assembly", "name": "Composition Assembly"}],
        }
        _assembly_id, assembly_responses = send_request(
            connection, "stage_scene", assembly_plan, base_manifest["revisionId"]
        )
        assembly_response = receive(connection, assembly_responses)
        if assembly_response.get("type") != "response":
            raise RuntimeError(f"assembly stage_scene failed: {assembly_response}")
        assembly_project = json.loads((omb / "project.json").read_text(encoding="utf-8"))
        assembly_manifest = assembly_project["manifest"]
        assembly_root_id = assembly_manifest["assemblies"][0]["rootEntityId"]

        stage_plan = {
            "schema_version": 1,
            "expected_revision_id": assembly_project["current_revision_id"],
            "operations": [
                {
                    "op": "add_primitive",
                    "primitive_type": "CUBE",
                    "name": "Composition Cube",
                    **transform(location=(0, 0, 1)),
                    "parent_id": assembly_root_id,
                },
                {
                    "op": "add_primitive",
                    "primitive_type": "CUBE",
                    "name": "Composition Part B",
                    **transform(location=(2, 0, 1)),
                    "parent_id": assembly_root_id,
                },
                {
                    "op": "set_material_color",
                    "object_name": "Composition Cube",
                    "color": [0.2, 0.4, 0.8, 1.0],
                },
                {
                    "op": "upsert_area_light",
                    "name": "Composition Key",
                    **transform(location=(4, -4, 6)),
                    "energy": 800,
                    "color": [1.0, 0.9, 0.8],
                    "size": 3,
                },
            ],
        }
        _stage_id, stage_responses = send_request(
            connection,
            "stage_scene",
            stage_plan,
            assembly_project["current_revision_id"],
        )
        stage_response = receive(connection, stage_responses)
        if stage_response.get("type") != "response":
            raise RuntimeError(f"stage_scene failed: {stage_response}")
        staged_project = json.loads((omb / "project.json").read_text(encoding="utf-8"))
        staged_manifest = staged_project["manifest"]

        camera_request = bound_plan()
        camera_request["expected_revision_id"] = staged_project["current_revision_id"]
        _camera_id, camera_responses = send_request(
            connection,
            "apply_camera_plan",
            camera_request,
            staged_project["current_revision_id"],
        )
        camera_response = receive(connection, camera_responses)
        if camera_response.get("type") != "response":
            raise RuntimeError(f"apply_camera_plan failed: {camera_response}")
        camera_project = json.loads((omb / "project.json").read_text(encoding="utf-8"))
        camera_manifest = camera_project["manifest"]
        live_camera_manifest = extract_scene_manifest_v4()
        qa_request = {
            "schema_version": 1,
            "revision_id": camera_project["current_revision_id"],
            "frames": [80],
        }
        _qa_id, qa_responses = send_request(
            connection,
            "render_qa_frames",
            qa_request,
            camera_project["current_revision_id"],
        )
        qa_response = receive(connection, qa_responses, timeout=90)
        if qa_response.get("type") != "response":
            raise RuntimeError(f"render_qa_frames failed: {qa_response}")
        qa_result = qa_response["result"]

        identities = stage_response["result"]["entity_identities"]
        stage_material = staged_manifest["stageMaterials"][0]
        print("OMB_CONNECTED_COMPOSITION_RESULTS=" + json.dumps({
            "baseSchema": base_manifest["schemaVersion"],
            "stageSchema": staged_manifest["schemaVersion"],
            "cameraSchema": camera_manifest["schemaVersion"],
            "revisionChain": [
                base_manifest["revisionId"],
                assembly_project["current_revision_id"],
                staged_project["current_revision_id"],
                camera_project["current_revision_id"],
            ],
            "stagedFieldsSurvive": {
                "lights": camera_manifest["lights"] == staged_manifest["lights"],
                "stagePrimitives": camera_manifest["stagePrimitives"] == staged_manifest["stagePrimitives"],
                "stageMaterials": camera_manifest["stageMaterials"] == staged_manifest["stageMaterials"],
            },
            "materialFields": {
                "useNodes": stage_material["useNodes"],
                "principledMatches": stage_material["principledBaseColor"] == stage_material["baseColor"],
            },
            "identities": identities,
            "assemblyMembers": len(camera_manifest["assemblies"][0]["memberIds"]),
            "liveHashMatchesCamera": live_camera_manifest["sceneHash"] == camera_manifest["sceneHash"],
            "qaRevision": qa_result["revision_id"],
            "qaFrameCount": len(qa_result["frames"]),
        }, separators=(",", ":")))
    finally:
        camera_plan.load_authorized_fixture = original_load
        if connection is not None:
            try:
                connection.disconnect("composition_complete")
            except BaseException:
                if connection.child is not None:
                    connection.child.kill()
        connection_module._active_connection = None
        oh_my_blender.unregister()
        shutil.rmtree(directory, ignore_errors=True)


main()
