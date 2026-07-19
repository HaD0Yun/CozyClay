"""Drive one faux director turn through the real daemon and Blender bridge."""

from __future__ import annotations

import base64
import copy
import json
import os
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
import oh_my_blender.qa_render as qa_render
from apply_camera_plan_fixture import PROJECT_ID, bound_plan, setup_scene
from oh_my_blender.connection import Connection, _resolve_daemon_argv
from oh_my_blender.daemon_child import DaemonChild
from oh_my_blender.manifest import extract_scene_manifest_v2, extract_scene_manifest_v3
from oh_my_blender.ws_client import WebSocketClient


def controller_hello() -> dict:
    return {
        "type": "hello",
        "protocol": 1,
        "addon_version": "director-loop-fixture",
        "blender_version": "n/a",
        "project_id": PROJECT_ID,
        "client_nonce": base64.urlsafe_b64encode(os.urandom(16)).decode("ascii").rstrip("="),
    }


def receive(
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
            and message.get("type") == expected_type
            and (request_id is None or message.get("id") == request_id)
        ):
            return message
        if (
            isinstance(message, dict)
            and message.get("id") == request_id
            and message.get("type") in {"error", "director_turn_failed"}
        ):
            raise RuntimeError(f"director loop failed: {message}")
    raise RuntimeError(f"timed out waiting for {expected_type}")


def main() -> None:
    setup_scene()
    base_manifest = extract_scene_manifest_v2()
    authorized_evidence = camera_plan.load_authorized_fixture(
        bound_plan(), base_manifest["sceneHash"]
    )
    directory = Path(tempfile.mkdtemp(prefix="omb-connected-director-loop-"))
    child = None
    controller = None
    bridge = None
    result = None
    original_load = camera_plan.load_authorized_fixture
    original_render_transaction = qa_render.render_qa_frames_transaction

    def rebound_evidence(plan: dict, scene_hash: str) -> dict:
        evidence = copy.deepcopy(authorized_evidence)
        evidence["revision_id"] = plan["expected_revision_id"]
        evidence["scene_hash"] = scene_hash
        return evidence

    def render_faux_batch(
        frames: list[int],
        *,
        deadline: float,
        cancelled,
    ) -> list[tuple[int, bytes]]:
        png = base64.b64decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII="
        )
        rendered = []
        for frame in frames:
            qa_render._check_abort(deadline, cancelled)
            bpy.context.scene.frame_set(frame)
            bpy.context.view_layer.update()
            rendered.append((frame, png))
        return rendered

    def render_faux_transaction(request_value, current_scene_hash, **kwargs):
        return original_render_transaction(
            request_value,
            current_scene_hash,
            render_batch=render_faux_batch,
            **kwargs,
        )

    camera_plan.load_authorized_fixture = rebound_evidence
    qa_render.render_qa_frames_transaction = render_faux_transaction
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
        child = DaemonChild.spawn(_resolve_daemon_argv(("--faux",)), cwd=directory)
        startup = child.read_startup_record()
        controller = WebSocketClient.connect(
            startup["port"],
            startup["bearer_token"],
            timeout=3.0,
            role="controller",
        )
        controller.send_json(controller_hello())
        hello_ack = receive(controller, None, "hello_ack")
        if "director_turn_v1" not in hello_ack["capabilities"]:
            raise RuntimeError("daemon did not advertise director turns")
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

        candidate_revisions = []
        send_json = bridge._send_json

        def observe_bridge_result(message: dict) -> None:
            payload = message.get("result")
            if message.get("type") == "bridge_result" and isinstance(payload, dict):
                manifest = payload.get("manifest")
                if isinstance(manifest, dict) and isinstance(manifest.get("revisionId"), str):
                    candidate_revisions.append(manifest["revisionId"])
            send_json(message)

        bridge._send_json = observe_bridge_result
        turn_id = str(uuid.uuid4())
        controller.send_json({
            "type": "director_turn",
            "id": turn_id,
            "prompt": "Build a deterministic hero product shot.",
            "expected_revision_id": "0" * 64,
            "deadline_ms": 30000,
        })
        tool_order = []
        terminal = None
        deadline = time.monotonic() + 150
        controller.socket.settimeout(0.05)
        while time.monotonic() < deadline and terminal is None:
            bridge.pump_bridge_messages()
            try:
                message = controller.recv_json()
            except TimeoutError:
                continue
            if not isinstance(message, dict) or message.get("id") != turn_id:
                continue
            if message.get("type") == "director_tool_call_started":
                tool_order.append(message["tool_name"])
            elif message.get("type") in {
                "director_turn_completed",
                "director_turn_failed",
                "director_turn_cancelled",
            }:
                terminal = message
        if terminal is None:
            raise RuntimeError("director turn timed out")
        if terminal.get("type") != "director_turn_completed":
            raise RuntimeError(f"director turn did not complete: {terminal}")

        durable = json.loads((omb / "project.json").read_text(encoding="utf-8"))
        live = extract_scene_manifest_v3()
        revision_chain = [base_manifest["revisionId"], *candidate_revisions]
        result = {
            "toolOrder": tool_order,
            "terminalType": terminal["type"],
            "revisionChain": revision_chain,
            "revisionChainDistinct": len(revision_chain) == 3 and len(set(revision_chain)) == 3,
            "terminalMatchesDurable": terminal["resulting_revision_id"] == durable["current_revision_id"],
            "candidateMatchesDurable": revision_chain[-1] == durable["current_revision_id"],
            "liveMatchesDurable": live["sceneHash"] == durable["manifest"]["sceneHash"],
        }
    finally:
        camera_plan.load_authorized_fixture = original_load
        qa_render.render_qa_frames_transaction = original_render_transaction
        if bridge is not None:
            bridge.disconnect("director_loop_fixture_complete", timeout=0.2)
        connection_module._active_connection = None
        if controller is not None and not controller.closed:
            try:
                controller.send_json({"type": "shutdown", "reason": "director_loop_fixture_complete"})
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
        raise RuntimeError("director loop fixture did not produce a result")
    print("OMB_CONNECTED_DIRECTOR_LOOP_RESULTS=" + json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
