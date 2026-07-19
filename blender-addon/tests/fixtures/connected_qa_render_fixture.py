"""Drive inspect -> apply_camera_plan -> render_qa_frames through the real v2 bridge."""

from __future__ import annotations

import base64
import hashlib
import json
import queue
import sys
import tempfile
import threading
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
from oh_my_blender.connection import Connection, _resolve_daemon_argv
from oh_my_blender.manifest import extract_scene_manifest_v2, extract_scene_snapshot


def send_request(
    connection: Connection,
    method: str,
    params: dict,
    expected_revision_id: str,
) -> tuple[str, queue.Queue]:
    request_id = str(uuid.uuid4())
    responses = queue.Queue(maxsize=1)
    connection._response_queues[request_id] = responses
    connection._send_json({
        "type": "request",
        "id": request_id,
        "method": method,
        "params": params,
        "expected_revision_id": expected_revision_id,
        "deadline_ms": 30000,
    })
    return request_id, responses


def receive(connection: Connection, responses: queue.Queue, timeout: float = 35) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        connection.pump_bridge_messages()
        try:
            return responses.get_nowait()
        except queue.Empty:
            time.sleep(0.01)
    raise RuntimeError("daemon response timed out")


def contains_byte_field(value: object) -> bool:
    if isinstance(value, dict):
        return any(
            key in {"data_base64", "png_base64"} or contains_byte_field(item)
            for key, item in value.items()
        )
    if isinstance(value, list):
        return any(contains_byte_field(item) for item in value)
    return False


def main() -> None:
    setup_scene()
    base_manifest = extract_scene_manifest_v2()
    if base_manifest["revisionId"] != REVISION:
        raise RuntimeError("connected QA fixture revision drifted")
    directory = Path(tempfile.mkdtemp(prefix="omb-connected-qa-"))
    connection = None
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
        connection = Connection.start(
            _resolve_daemon_argv(("--faux",)),
            cwd=directory,
            project_id=PROJECT_ID,
            addon_version="0.1.0",
            blender_version=bpy.app.version_string,
        )
        connection_module._active_connection = connection

        snapshot = extract_scene_snapshot()
        _inspect_id, inspect_responses = send_request(
            connection,
            "inspect_project",
            {"snapshot": snapshot},
            canonical_revision(snapshot),
        )
        inspect = receive(connection, inspect_responses)
        if inspect.get("type") != "response":
            raise RuntimeError(f"inspect failed: {inspect}")

        connection.last_bridge_response = None
        apply_id = str(uuid.uuid4())
        connection._send_json({
            "type": "request",
            "id": apply_id,
            "method": "apply_camera_plan",
            "params": bound_plan(),
            "expected_revision_id": REVISION,
            "deadline_ms": 30000,
        })
        deadline = time.monotonic() + 30
        while connection.last_bridge_response is None and time.monotonic() < deadline:
            connection.pump_bridge_messages()
            time.sleep(0.01)
        if connection.last_bridge_response is None:
            raise RuntimeError("apply_camera_plan timed out")

        manifest = extract_scene_manifest_v2()
        revision = manifest["revisionId"]
        render_request = {
            "schema_version": 1,
            "revision_id": revision,
            "frames": [79, 80, 81],
        }
        _render_id, render_responses = send_request(
            connection, "render_qa_frames", render_request, revision
        )
        render = receive(connection, render_responses)
        if render.get("type") != "response":
            raise RuntimeError(f"render_qa_frames failed: {render}")
        result = render.get("result", render)
        artifacts = []
        for frame in result["frames"]:
            digest = frame["sha256"]
            payload_path = omb / "artifacts" / digest / "payload"
            payload = payload_path.read_bytes()
            if hashlib.sha256(payload).hexdigest() != digest:
                raise RuntimeError("published artifact digest mismatch")
            if frame["uri"] != f"omb-artifact://sha256/{digest}":
                raise RuntimeError("artifact URI is not canonical")
            model_image = frame["image"]
            model_payload = base64.b64decode(
                model_image["data_base64"],
                validate=True,
            )
            image = bpy.data.images.load(str(payload_path), check_existing=False)
            dimensions = list(image.size)
            bpy.data.images.remove(image)
            artifacts.append({
                "frame": frame["frame"],
                "dimensions": dimensions,
                "byteLength": len(payload),
                "declaredLength": frame["byte_length"],
                "digest": digest,
                "rereadDigest": hashlib.sha256(payload_path.read_bytes()).hexdigest(),
                "imageMimeType": model_image["mime_type"],
                "modelContentMatchesArtifact": model_payload == payload,
            })
        time.sleep(1.01)

        _stale_id, stale_responses = send_request(
            connection,
            "render_qa_frames",
            {"schema_version": 1, "revision_id": REVISION, "frames": [80]},
            REVISION,
        )
        stale = receive(connection, stale_responses)
        time.sleep(1.01)

        _limit_id, limit_responses = send_request(
            connection,
            "render_qa_frames",
            {"schema_version": 1, "revision_id": revision, "frames": list(range(1, 14))},
            revision,
        )
        limit = receive(connection, limit_responses)
        time.sleep(1.01)

        artifact_root = omb / "artifacts"
        before_cancel = sorted(
            path.name for path in artifact_root.iterdir()
            if path.is_dir() and path.name != ".tmp"
        )
        cancel_id, cancel_responses = send_request(
            connection,
            "render_qa_frames",
            {"schema_version": 1, "revision_id": revision, "frames": list(range(90, 102))},
            revision,
        )
        first_chunk_sent = threading.Event()
        send_json = connection._send_json

        def observe_stream(message: dict) -> None:
            send_json(message)
            if message.get("type") == "bridge_artifact_chunk":
                first_chunk_sent.set()

        connection._send_json = observe_stream

        def cancel_after_first_chunk() -> None:
            if first_chunk_sent.wait(timeout=30):
                connection._send_json({"type": "cancel", "id": cancel_id})

        threading.Thread(target=cancel_after_first_chunk, daemon=True).start()
        cancelled = receive(connection, cancel_responses)
        after_cancel = sorted(
            path.name for path in artifact_root.iterdir()
            if path.is_dir() and path.name != ".tmp"
        )
        temp_entries = list((artifact_root / ".tmp").iterdir())
        print("OMB_CONNECTED_QA_RESULTS=" + json.dumps({
            "inspect": inspect["type"],
            "artifacts": artifacts,
            "revision": result["revision_id"],
            "staleCode": stale.get("code"),
            "limitCode": limit.get("code"),
            "resultHasByteFields": contains_byte_field(result),
            "cancelAfterChunk": first_chunk_sent.is_set(),
            "cancelCode": cancelled.get("code"),
            "cancelArtifactsUnchanged": before_cancel == after_cancel,
            "tempEntryCount": len(temp_entries),
        }, separators=(",", ":")))
    finally:
        if connection is not None:
            connection.disconnect("connected_qa_complete")
        connection_module._active_connection = None
        oh_my_blender.unregister()


if __name__ == "__main__":
    main()
