"""Cancel a director turn during an actual staged Blender mutation."""

from __future__ import annotations

import base64
import json
import os
import shutil
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
import oh_my_blender.stage_scene as stage_scene
from apply_camera_plan_fixture import PROJECT_ID, setup_scene
from oh_my_blender.connection import Connection, _resolve_daemon_argv
from oh_my_blender.daemon_child import DaemonChild
from oh_my_blender.manifest import extract_scene_manifest_v2
from oh_my_blender.ws_client import WebSocketClient


def controller_hello() -> dict:
    return {
        "type": "hello",
        "protocol": 1,
        "addon_version": "director-cancellation-fixture",
        "blender_version": "n/a",
        "project_id": PROJECT_ID,
        "client_nonce": base64.urlsafe_b64encode(os.urandom(16)).decode("ascii").rstrip("="),
    }


def receive(
    controller: WebSocketClient,
    bridge: Connection | None,
    expected_type: str,
    timeout: float = 30.0,
) -> dict:
    deadline = time.monotonic() + timeout
    controller.socket.settimeout(0.05)
    while time.monotonic() < deadline:
        if bridge is not None:
            bridge.pump_bridge_messages()
        try:
            message = controller.recv_json()
        except TimeoutError:
            continue
        if isinstance(message, dict) and message.get("type") == expected_type:
            return message
    raise RuntimeError(f"timed out waiting for {expected_type}")


def canonical_bytes(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")


def main() -> None:
    setup_scene()
    base_manifest = extract_scene_manifest_v2()
    directory = Path(tempfile.mkdtemp(prefix="omb-connected-director-cancel-"))
    child = None
    controller = None
    bridge = None
    result = None
    original_create = stage_scene._create_primitive
    mutation_applied = threading.Event()

    try:
        omb = directory / ".omb"
        omb.mkdir()
        project_path = omb / "project.json"
        project_path.write_text(json.dumps({
            "schema_version": 1,
            "project_id": PROJECT_ID,
            "current_revision_id": base_manifest["revisionId"],
            "manifest": base_manifest,
        }), encoding="utf-8")
        before_project_bytes = project_path.read_bytes()
        before_scene_bytes = canonical_bytes(base_manifest)

        oh_my_blender.register()
        child = DaemonChild.spawn(_resolve_daemon_argv(("--faux",)), cwd=directory)
        startup = child.read_startup_record()
        controller = WebSocketClient.connect(
            startup["port"],
            startup["bearer_token"],
            timeout=3.0,
            role="controller",
        )
        controller.send_json(controller_hello())
        receive(controller, None, "hello_ack")
        receive(controller, None, "controller_auth")
        controller.send_json({"type": "issue_attach_ticket", "role": "bridge"})
        ticket = receive(controller, None, "attach_ticket")
        bridge = Connection.attach(
            ticket["runtime_directory"],
            ticket["ticket"],
            cwd=directory,
            project_id=PROJECT_ID,
            addon_version="0.1.0",
            blender_version=bpy.app.version_string,
        )
        connection_module._active_connection = bridge

        def create_then_wait_for_cancel(operation, transaction, project_id):
            created = original_create(operation, transaction, project_id)
            mutation_applied.set()
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                if any(event.is_set() for event in bridge._bridge_cancellations.values()):
                    return created
                time.sleep(0.005)
            raise RuntimeError("director cancellation did not reach the staged mutation")

        stage_scene._create_primitive = create_then_wait_for_cancel
        turn_id = str(uuid.uuid4())

        def cancel_during_mutation() -> None:
            if mutation_applied.wait(timeout=20):
                controller.send_json({"type": "cancel", "id": turn_id})

        threading.Thread(target=cancel_during_mutation, daemon=True).start()
        controller.send_json({
            "type": "director_turn",
            "id": turn_id,
            "prompt": "Start a staged mutation and then cancel it.",
            "expected_revision_id": "0" * 64,
            "deadline_ms": 30000,
        })

        terminal_events = []
        cancel_ack = None
        deadline = time.monotonic() + 60
        controller.socket.settimeout(0.05)
        terminal_seen_at = None
        while time.monotonic() < deadline:
            bridge.pump_bridge_messages()
            try:
                message = controller.recv_json()
            except TimeoutError:
                if terminal_seen_at is not None and time.monotonic() - terminal_seen_at > 0.25:
                    break
                continue
            if not isinstance(message, dict) or message.get("id") != turn_id:
                continue
            if message.get("type") == "cancel_ack":
                cancel_ack = message
            if message.get("type") in {
                "director_turn_completed",
                "director_turn_failed",
                "director_turn_cancelled",
            }:
                terminal_events.append(message)
                terminal_seen_at = time.monotonic()
        after_project_bytes = project_path.read_bytes()
        after_project = json.loads(after_project_bytes.decode("utf-8"))
        after_scene_bytes = canonical_bytes(extract_scene_manifest_v2())
        result = {
            "mutationAppliedBeforeCancel": mutation_applied.is_set(),
            "cancelAckStatus": None if cancel_ack is None else cancel_ack.get("status"),
            "terminalTypes": [event["type"] for event in terminal_events],
            "terminalCount": len(terminal_events),
            "bitPerfectSceneRestore": after_scene_bytes == before_scene_bytes,
            "bitPerfectDurableRestore": after_project_bytes == before_project_bytes,
            "durableRevisionUnchanged": after_project["current_revision_id"] == base_manifest["revisionId"],
        }
    finally:
        stage_scene._create_primitive = original_create
        if bridge is not None:
            bridge.disconnect("director_cancel_fixture_complete", timeout=0.2)
        connection_module._active_connection = None
        if controller is not None and not controller.closed:
            try:
                controller.send_json({"type": "shutdown", "reason": "director_cancel_fixture_complete"})
                receive(controller, None, "shutdown_ack", timeout=5.0)
            finally:
                controller.close()
        if child is not None:
            if child.process.poll() is None:
                child.process.wait(timeout=5.0)
            child.close_streams()
        oh_my_blender.unregister()
        shutil.rmtree(directory, ignore_errors=True)
    if result is None:
        raise RuntimeError("director cancellation fixture did not produce a result")
    print("OMB_CONNECTED_DIRECTOR_CANCEL_RESULTS=" + json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
