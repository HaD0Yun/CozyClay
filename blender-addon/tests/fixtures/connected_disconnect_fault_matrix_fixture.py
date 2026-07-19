"""Exercise camera transaction socket-loss phases through Blender's real timer loop."""

from __future__ import annotations

import json
import queue
import shutil
import sys
import tempfile
import time
import traceback
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
from oh_my_blender.connection import Connection, LifecycleState, _resolve_daemon_argv
from oh_my_blender.manifest import extract_scene_manifest_v2, extract_scene_snapshot
from oh_my_blender.canonical import canonical_revision


def argument(name: str) -> str:
    index = sys.argv.index(name)
    return sys.argv[index + 1]


def main() -> None:
    phase = argument("--fault-phase")
    setup_scene()
    base_manifest = extract_scene_manifest_v2()
    directory = Path(tempfile.mkdtemp(prefix=f"omb-disconnect-{phase}-"))
    connections: list[Connection] = []
    restore_count = 0
    verify_count = 0
    success_responses: list[dict] = []
    result: dict | None = None
    deadline = time.monotonic() + 45
    original_restore = camera_plan.restore
    original_verify = camera_plan.verify

    def tracked_restore(*args, **kwargs):
        nonlocal restore_count
        restore_count += 1
        restored = original_restore(*args, **kwargs)
        if phase == "before_verify":
            bpy.context.scene.render.resolution_x += 1
        return restored

    def tracked_verify(*args, **kwargs):
        nonlocal verify_count
        verify_count += 1
        return original_verify(*args, **kwargs)

    camera_plan.restore = tracked_restore
    camera_plan.verify = tracked_verify

    def finish(exit_code: int = 0) -> None:
        camera_plan.restore = original_restore
        camera_plan.verify = original_verify
        connection_module._active_connection = None
        for active in connections:
            if active.child.process.poll() is None:
                try:
                    active.disconnect("fixture_complete")
                except BaseException:
                    active.child.kill()
        try:
            oh_my_blender.unregister()
        finally:
            shutil.rmtree(directory, ignore_errors=True)
        if result is not None:
            print("OMB_DISCONNECT_FAULT_RESULTS=" + json.dumps(result, separators=(",", ":")))
        if exit_code:
            print("OMB_DISCONNECT_FAULT_FAILURE", file=sys.stderr)
        bpy.ops.wm.quit_blender()

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
        connections.append(connection)
        connection_module._active_connection = connection
        production_timer = connection.pump_bridge_messages

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

        original_record = connection._record_durable_response

        def recording_response(message: dict) -> dict:
            nonlocal faulted
            recorded = original_record(message)
            success_responses.append(dict(message))
            if phase == "after_response" and not faulted:
                faulted = True
                connection.child.kill()
            return recorded

        connection._record_durable_response = recording_response

        request_id = str(uuid.uuid4())
        connection._send_json({
            "type": "request",
            "id": request_id,
            "method": "apply_camera_plan",
            "params": bound_plan(),
            "expected_revision_id": REVISION,
            "deadline_ms": 10_000,
        })

        stage = "wait_for_detector"
        replacement: Connection | None = None
        inspect_responses: queue.Queue | None = None
        old_id_responses: queue.Queue | None = None
        restarted_inspect: dict | None = None
        old_request_cancel_ack: dict | None = None
        old_request_unexpected: list[dict] = []
        inspect_request_id: str | None = None
        observed: dict = {}

        def observe() -> float | None:
            nonlocal stage, replacement, inspect_responses, old_id_responses
            nonlocal inspect_request_id, restarted_inspect, old_request_cancel_ack, result
            try:
                if time.monotonic() >= deadline:
                    raise RuntimeError(f"fault fixture timed out in {stage}")

                if stage == "wait_for_detector":
                    if bpy.app.timers.is_registered(production_timer):
                        return 0.01
                    if connection.state in (LifecycleState.ACTIVE, LifecycleState.LOST):
                        return 0.01
                    reader_alive = (
                        connection._reader_thread is not None
                        and connection._reader_thread.is_alive()
                    )
                    project = json.loads((omb / "project.json").read_text(encoding="utf-8"))
                    live_manifest = extract_scene_manifest_v2()
                    durable_advanced = project["current_revision_id"] != REVISION
                    if connection.state == LifecycleState.RECOVERY_REQUIRED:
                        outcome = "recovery_required"
                    elif len(success_responses) == 1 and durable_advanced:
                        outcome = "response_win"
                    elif durable_advanced:
                        outcome = "commit_cas"
                    else:
                        outcome = "disconnect_win"
                    observed.update({
                        "phase": phase,
                        "outcome": outcome,
                        "baseRevision": REVISION,
                        "liveRevision": live_manifest["revisionId"],
                        "durableRevision": project["current_revision_id"],
                        "liveSceneHash": live_manifest["sceneHash"],
                        "durableSceneHash": project["manifest"]["sceneHash"],
                        "durableAdvanced": durable_advanced,
                        "successResponses": len(success_responses),
                        "restoreCount": restore_count,
                        "verifyCount": verify_count,
                        "childExited": connection.child.process.poll() is not None,
                        "timerSelfUnregistered": not bpy.app.timers.is_registered(production_timer),
                        "socketClosed": connection.websocket.closed,
                        "readerStopped": not reader_alive,
                        "connectionState": connection.state.value,
                        "reconciliation": connection.durable_commit_reconciliation,
                    })
                    if phase == "before_verify":
                        sent: list[dict] = []
                        connection._send_json = lambda message: sent.append(message)
                        for method in (
                            "inspect_project",
                            "apply_camera_plan",
                            "render_qa_frames",
                        ):
                            connection.dispatch_bridge_message({
                                "type": "bridge_request",
                                "id": f"hidden-{method}",
                                "request_id": f"hidden-{method}",
                                "method": method,
                            })
                        observed["hiddenToolErrors"] = {
                            message["id"].removeprefix("hidden-"): message["code"]
                            for message in sent
                        }
                        observed["toolsExposed"] = connection.tools_exposed
                        result = observed
                        finish()
                        return None

                    replacement = connection_module.connect(
                        cwd=directory,
                        project_id=PROJECT_ID,
                        addon_version="0.1.0",
                        blender_version=bpy.app.version_string,
                        daemon_args=("--faux",),
                    )
                    connections.append(replacement)
                    old_id_responses = queue.Queue()
                    replacement._cancel_ack_queues[request_id] = old_id_responses
                    replacement._send_json({
                        "type": "cancel",
                        "id": request_id,
                    })
                    inspect_request_id = str(uuid.uuid4())
                    inspect_responses = queue.Queue(maxsize=1)
                    replacement._response_queues[inspect_request_id] = inspect_responses
                    snapshot = extract_scene_snapshot()
                    replacement._send_json({
                        "type": "request",
                        "id": inspect_request_id,
                        "method": "inspect_project",
                        "params": {"snapshot": snapshot},
                        "expected_revision_id": canonical_revision(snapshot),
                        "deadline_ms": 30_000,
                    })
                    stage = "wait_for_restarted_inspect"
                    return 0.01

                if stage == "wait_for_restarted_inspect":
                    assert replacement is not None
                    assert inspect_responses is not None
                    assert old_id_responses is not None
                    assert inspect_request_id is not None
                    while True:
                        try:
                            old_id_message = old_id_responses.get_nowait()
                        except queue.Empty:
                            break
                        if (
                            old_request_cancel_ack is None
                            and old_id_message.get("type") == "cancel_ack"
                        ):
                            old_request_cancel_ack = old_id_message
                        else:
                            old_request_unexpected.append(old_id_message)
                    if restarted_inspect is None:
                        try:
                            restarted_inspect = inspect_responses.get_nowait()
                        except queue.Empty:
                            pass
                    if restarted_inspect is None or old_request_cancel_ack is None:
                        return 0.01
                    replacement._response_queues.pop(inspect_request_id, None)
                    replacement._cancel_ack_queues.pop(request_id, None)
                    observed["restartedInspect"] = restarted_inspect.get("type")
                    observed["oldRequestCancelAck"] = {
                        "type": old_request_cancel_ack.get("type"),
                        "correlated": old_request_cancel_ack.get("id") == request_id,
                        "status": old_request_cancel_ack.get("status"),
                    }
                    observed["oldRequestUnexpectedTraffic"] = old_request_unexpected
                    observed["replacementToolsExposed"] = replacement.tools_exposed
                    replacement_timer = replacement.pump_bridge_messages
                    observed["replacementTimer"] = replacement_timer
                    replacement.disconnect("fault_fixture_complete")
                    stage = "wait_for_replacement_timer"
                    return 0.01

                assert replacement is not None
                replacement_timer = observed.pop("replacementTimer")
                if bpy.app.timers.is_registered(replacement_timer):
                    return 0.01
                reader_alive = (
                    replacement._reader_thread is not None
                    and replacement._reader_thread.is_alive()
                )
                observed["replacementTimerSelfUnregistered"] = True
                observed["replacementSocketClosed"] = replacement.websocket.closed
                observed["replacementReaderStopped"] = not reader_alive
                observed["replacementResponseQueuesEmpty"] = not replacement._response_queues
                observed["replacementCancelAckQueuesEmpty"] = not replacement._cancel_ack_queues
                observed["replacementBridgeCancellationsEmpty"] = not replacement._bridge_cancellations
                result = observed
                finish()
                return None
            except BaseException:
                traceback.print_exc()
                finish(exit_code=1)
                return None

        bpy.app.timers.register(observe, first_interval=0.01)
    except BaseException:
        traceback.print_exc()
        finish(exit_code=1)


bpy.app.timers.register(main, first_interval=0.1)
