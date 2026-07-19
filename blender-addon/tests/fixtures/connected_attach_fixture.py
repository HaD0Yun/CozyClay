"""Drive the T2 controller-issued attach path through a real Blender bridge."""

from __future__ import annotations

import base64
import json
import os
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
from oh_my_blender.connection import Connection, _resolve_daemon_argv
from oh_my_blender.daemon_child import DaemonChild
from oh_my_blender.manifest import extract_scene_manifest_v2
from oh_my_blender.ws_client import WebSocketClient


def controller_hello() -> dict:
    return {
        "type": "hello",
        "protocol": 1,
        "addon_version": "controller-fixture",
        "blender_version": "n/a",
        "project_id": PROJECT_ID,
        "client_nonce": base64.urlsafe_b64encode(os.urandom(16)).decode("ascii").rstrip("="),
    }


def receive_controller_message(
    controller: WebSocketClient,
    bridge: Connection | None,
    expected_type: str,
    request_id: str | None = None,
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
        if (
            isinstance(message, dict)
            and message.get("type") == "error"
            and (request_id is None or message.get("id") == request_id)
        ):
            raise RuntimeError(f"controller received daemon error: {message}")
        if (
            isinstance(message, dict)
            and message.get("type") == expected_type
            and (request_id is None or message.get("id") == request_id)
        ):
            return message
    detail = ""
    if bridge is not None:
        detail = (
            f", bridge_state={bridge.state}, task={bridge.task_status}, "
            f"last_response={bridge.last_bridge_response}, "
            f"queued={bridge._main_thread_messages.qsize()}"
        )
    raise RuntimeError(f"controller timed out waiting for {expected_type}{detail}")


def main() -> None:
    setup_scene()
    manifest = extract_scene_manifest_v2()
    if manifest["revisionId"] != REVISION:
        raise RuntimeError("attach fixture revision drifted")
    directory = Path(tempfile.mkdtemp(prefix="omb-connected-attach-"))
    omb = directory / ".omb"
    omb.mkdir()
    (omb / "project.json").write_text(json.dumps({
        "schema_version": 1,
        "project_id": PROJECT_ID,
        "current_revision_id": REVISION,
        "manifest": manifest,
    }), encoding="utf-8")

    child = None
    controller = None
    bridge = None
    result = None
    try:
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
        hello_ack = receive_controller_message(controller, None, "hello_ack")
        if hello_ack["launch_id"] != startup["launch_id"]:
            raise RuntimeError("controller launch identity mismatch")
        receive_controller_message(controller, None, "controller_auth")
        controller.send_json({"type": "issue_attach_ticket", "role": "bridge"})
        ticket = receive_controller_message(controller, None, "attach_ticket")

        bridge = Connection.attach(
            ticket["runtime_directory"],
            ticket["ticket"],
            cwd=directory,
            project_id=PROJECT_ID,
            addon_version="0.1.0",
            blender_version=bpy.app.version_string,
        )
        connection_module._active_connection = bridge
        request_id = str(uuid.uuid4())
        controller.send_json({
            "type": "request",
            "id": request_id,
            "method": "apply_camera_plan",
            "params": bound_plan(),
            "expected_revision_id": REVISION,
            "deadline_ms": 30000,
        })
        response = receive_controller_message(controller, bridge, "response", request_id)
        durable = json.loads((omb / "project.json").read_text(encoding="utf-8"))
        result = {
            "responseType": response["type"],
            "attachedWithoutChild": bridge.child is None,
            "attachMode": bridge.identity.get("attach_mode"),
            "revisionAdvanced": durable["current_revision_id"] != REVISION,
            "runtimeOutsideProject": not str(ticket["runtime_directory"]).startswith(str(omb)),
        }
    finally:
        if bridge is not None:
            bridge.disconnect("attach_fixture_complete", timeout=0.2)
        connection_module._active_connection = None
        if controller is not None and not controller.closed:
            try:
                controller.send_json({"type": "shutdown", "reason": "attach_fixture_complete"})
                receive_controller_message(controller, None, "shutdown_ack", timeout=5.0)
            finally:
                controller.close()
        if child is not None:
            if child.process.poll() is None:
                child.process.wait(timeout=5.0)
            child.close_streams()
        oh_my_blender.unregister()
    if result is None:
        raise RuntimeError("attach fixture did not produce a result")
    print("OMB_CONNECTED_ATTACH_RESULTS=" + json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
