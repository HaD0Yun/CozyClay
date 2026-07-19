"""Exercise all camera transaction socket-loss phases through Blender and a real daemon."""

from __future__ import annotations

import json
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
from apply_camera_plan_fixture import PROJECT_ID, REVISION, bound_plan, setup_scene
from oh_my_blender.connection import Connection, _resolve_daemon_argv
from oh_my_blender.manifest import extract_scene_manifest_v2


def argument(name: str) -> str:
    index = sys.argv.index(name)
    return sys.argv[index + 1]


def main() -> None:
    phase = argument("--fault-phase")
    setup_scene()
    base_manifest = extract_scene_manifest_v2()
    directory = Path(tempfile.mkdtemp(prefix=f"omb-disconnect-{phase}-"))
    connection = None
    restore_count = 0
    verify_count = 0
    original_restore = camera_plan.restore
    original_verify = camera_plan.verify

    def tracked_restore(*args, **kwargs):
        nonlocal restore_count
        restore_count += 1
        return original_restore(*args, **kwargs)

    def tracked_verify(*args, **kwargs):
        nonlocal verify_count
        verify_count += 1
        return original_verify(*args, **kwargs)

    camera_plan.restore = tracked_restore
    camera_plan.verify = tracked_verify
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
        regular_argv = _resolve_daemon_argv(("--faux",))
        if phase == "commit_eligibility":
            daemon_script = REPOSITORY_ROOT / "blender-addon/tests/fixtures/delayed_commit_daemon.ts"
            argv = (*regular_argv[:3], str(daemon_script))
        else:
            argv = regular_argv
        connection = Connection.start(
            argv,
            cwd=directory,
            project_id=PROJECT_ID,
            addon_version="0.1.0",
            blender_version=bpy.app.version_string,
        )
        connection_module._active_connection = connection

        faulted = False
        target_guard_phase = {
            "after_checkpoint": "after_checkpoint",
            "mid_mutation": "keyframe_write",
            "before_verify": "before_verify",
        }.get(phase)
        original_guard = connection.ensure_mutation_connection

        def faulting_guard(guard_phase: str) -> None:
            nonlocal faulted
            if not faulted and guard_phase == target_guard_phase:
                faulted = True
                connection.child.kill()
            original_guard(guard_phase)

        connection.ensure_mutation_connection = faulting_guard

        if phase == "commit_eligibility":
            original_send = connection._send_json

            def faulting_send(message: dict) -> None:
                nonlocal faulted
                original_send(message)
                if not faulted and message.get("type") == "bridge_result":
                    faulted = True
                    connection.child.kill()

            connection._send_json = faulting_send
        elif phase == "after_response":
            original_record = connection._record_durable_response

            def faulting_record(message: dict) -> dict:
                nonlocal faulted
                result = original_record(message)
                if not faulted:
                    faulted = True
                    connection.child.kill()
                return result

            connection._record_durable_response = faulting_record

        request_id = str(uuid.uuid4())
        connection._send_json({
            "type": "request",
            "id": request_id,
            "method": "apply_camera_plan",
            "params": bound_plan(),
            "expected_revision_id": REVISION,
            "deadline_ms": 10_000,
        })
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            connection.pump_bridge_messages()
            if connection._terminal_bridge_ids and connection.active_checkpoint is None:
                if connection.child.process.poll() is not None:
                    break
            time.sleep(0.01)

        for _index in range(100):
            if connection.state != "active":
                break
            time.sleep(0.01)
        connection.pump_bridge_messages()

        project = json.loads((omb / "project.json").read_text(encoding="utf-8"))
        live_manifest = extract_scene_manifest_v2()
        expected_restore_count = 0 if phase == "after_response" else 1
        if phase == "after_response":
            outcome = "response_win"
        elif phase == "commit_eligibility":
            outcome = "commit_cas"
        else:
            outcome = "disconnect_win"

        timer = connection.pump_bridge_messages
        if bpy.app.timers.is_registered(timer):
            bpy.app.timers.unregister(timer)
        connection.websocket.socket.close()
        connection.websocket.closed = True
        print("OMB_DISCONNECT_FAULT_RESULTS=" + json.dumps({
            "phase": phase,
            "outcome": outcome,
            "liveSceneHash": live_manifest["sceneHash"],
            "durableSceneHash": project["manifest"]["sceneHash"],
            "restoreCount": restore_count,
            "verifyCount": verify_count,
            "expectedRestoreCount": expected_restore_count,
            "requestTerminal": len(connection._terminal_bridge_ids) == 1,
            "childExited": connection.child.process.poll() is not None,
            "timerRegistered": bpy.app.timers.is_registered(timer),
            "socketClosed": connection.websocket.closed,
            "connectionState": connection.state,
            "reconciliation": connection.durable_commit_reconciliation,
        }, separators=(",", ":")))
    finally:
        camera_plan.restore = original_restore
        camera_plan.verify = original_verify
        if connection is not None:
            try:
                connection.disconnect("fixture_complete")
            except BaseException:
                connection.child.kill()
        connection_module._active_connection = None
        oh_my_blender.unregister()
        shutil.rmtree(directory, ignore_errors=True)


main()
