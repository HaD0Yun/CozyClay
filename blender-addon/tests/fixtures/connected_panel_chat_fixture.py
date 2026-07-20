"""Exercise the connected chat panel through a real Blender/controller lifecycle."""

from __future__ import annotations

import base64
import hashlib
import json
import os
import sys
import time
import threading
from pathlib import Path

import bpy

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPOSITORY_ROOT / "blender-addon"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import oh_my_blender
from apply_camera_plan_fixture import PROJECT_ID
from controller_lifecycle_support import cleanup, prepare_project
import oh_my_blender.connection as connection
import oh_my_blender.controller_connection as controller_connection
from oh_my_blender import ui_panel

TURN = "11111111-1111-4111-8111-111111111111"
SESSION = "22222222-2222-4222-8222-222222222222"
SEGMENT = "33333333-3333-4333-8333-333333333333"
AT = "2026-07-20T00:00:00.000Z"
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
)


def event(kind: str, sequence: int, **values: object) -> dict[str, object]:
    return {"type": kind, "id": TURN, "sequence": sequence, "at": AT, **values}


def pump(directory: Path, count: int = 1) -> None:
    for _ in range(count):
        ui_panel.pump_controller_panel(bpy_module=bpy, project_directory=directory)


def main() -> None:
    directory = prepare_project()
    bridge = None
    result = None
    redraw_calls = 0
    original_redraw = ui_panel._tag_redraw
    try:
        oh_my_blender.register()
        bridge = connection.connect_addon_spawned(
            cwd=directory,
            project_id=PROJECT_ID,
            addon_version="0.1.0",
            blender_version=bpy.app.version_string,
            daemon_args=("--faux",),
        )
        controller = controller_connection._active_controller
        if controller is None:
            raise RuntimeError("connected fixture has no active controller")

        ui_panel.reset_panel_state()
        pump(directory)
        replay_started = ui_panel.panel_snapshot().replaying
        for _ in range(40):
            time.sleep(0.005)
            pump(directory)
            if controller.pending_update_count == 0:
                break

        controller.handle_server_message({
            "type": "director_transcript", "schema_version": 2, "id": SESSION,
            "session_id": SESSION, "events": [], "next_cursor": None, "snapshot_cursor": 0,
        })
        pump(directory)
        replay_finished = not ui_panel.panel_snapshot().replaying

        def tagged(host=None):
            nonlocal redraw_calls
            redraw_calls += 1
            return original_redraw(host)

        ui_panel._tag_redraw = tagged
        ui_panel._panel_state.begin_submission(TURN, "Build the connected panel shot")
        started = event("director_turn_started", 0, prompt="Build the connected panel shot")
        controller.handle_server_message(started)
        for _ in range(39):
            controller.handle_server_message(started)
        pump(directory)
        pending_after_bound = controller.pending_update_count
        updates_drained = 40 - pending_after_bound
        pump(directory, 2)

        controller.handle_server_message({
            "type": "director_turn_delta", "id": TURN, "segment_id": SEGMENT,
            "content_index": 0, "delta_sequence": 0, "delta": "temporary-stream-bytes",
        })
        pump(directory)
        delta_seen = ui_panel.panel_snapshot().active_text == "temporary-stream-bytes"
        controller.handle_server_message(event(
            "director_assistant_utterance", 1, segment_id=SEGMENT, content_index=0,
            through_delta_sequence=0, content="Durable assistant answer",
        ))
        controller.handle_server_message(event(
            "director_tool_call_started", 2, tool_call_id="qa-call",
            tool_name="render_qa_frames", params_summary="Frame 1",
        ))

        digest = hashlib.sha256(PNG).hexdigest()
        payload = directory / ".omb" / "artifacts" / digest / "payload"
        payload.parent.mkdir(parents=True)
        payload.write_bytes(PNG)
        os.chmod(payload, 0o600)
        image_areas = [
            area for screen in bpy.data.screens for area in screen.areas
            if area.type == "IMAGE_EDITOR"
        ]
        if not image_areas and bpy.data.screens and bpy.data.screens[0].areas:
            bpy.data.screens[0].areas[0].type = "IMAGE_EDITOR"
            image_areas = [bpy.data.screens[0].areas[0]]
        controller.handle_server_message(event(
            "director_tool_call_finished", 3, tool_call_id="qa-call",
            tool_name="render_qa_frames",
            result_digest=digest, is_error=False,
        ))
        pump(directory)
        before_busy = ui_panel.panel_snapshot()
        controller.handle_server_message({
            "type": "error",
            "id": "55555555-5555-4555-8555-555555555555",
            "code": "BUSY",
            "message": "one director turn is already active",
            "retryable": True,
        })
        pump(directory)
        busy = ui_panel.panel_snapshot()
        controller.handle_server_message(event("director_turn_cancelled", 4))
        pump(directory)
        final = ui_panel.panel_snapshot()
        p95, maximum = ui_panel.panel_timer_metrics()
        rendered = "\n".join(entry.text for entry in final.entries) + final.status + (final.error or "")
        result = {
            "durableContentsExactlyOnce": sum(e.text == "Build the connected panel shot" for e in final.entries) == 1,
            "deltaReplacedByUtterance": delta_seen and not final.active_text and sum(e.text == "Durable assistant answer" for e in final.entries) == 1,
            "busyPreservedCancelState": before_busy.can_cancel and busy.can_cancel and busy.active_turn_id == TURN,
            "terminalClearedCancelState": not final.can_cancel and final.active_turn_id is None,
            "replayStarted": replay_started,
            "replayConverged": replay_finished,
            "updateBound32": 0 < updates_drained <= 32,
            "updatesDrainedFirstPump": updates_drained,
            "redrawTagged": redraw_calls > 0,
            "timerP95Ms": p95,
            "timerMaxMs": maximum,
            "durableEventsDropped": max(0, 5 - len(final.entries)),
            "qaImageDisplayed": final.displayed_qa_digest == digest and any(area.spaces.active.image is not None for area in image_areas),
            "transcriptByteMatch": int(PNG in rendered.encode("utf-8") or base64.b64encode(PNG) in rendered.encode("utf-8")),
            "payloadMode": payload.stat().st_mode & 0o777,
            "cleanupTimerCount": 0,
            "cleanupControllerCount": 0,
            "cleanupThreadCount": 0,
        }
    finally:
        ui_panel._tag_redraw = original_redraw
        connection.disconnect_active("client_exit")
        cleanup(directory, None, None)
        oh_my_blender.unregister()
        oh_my_blender.register()
        oh_my_blender.unregister()
    if result is None:
        raise RuntimeError("panel fixture produced no result")
    result["cleanupTimerCount"] = int(
        oh_my_blender._lifecycle_timer_registered
        or bpy.app.timers.is_registered(oh_my_blender._pump_lifecycle)
    )
    result["cleanupControllerCount"] = int(controller_connection._active_controller is not None)
    result["cleanupThreadCount"] = sum(
        thread.name.startswith("omb-controller") and thread.is_alive()
        for thread in threading.enumerate()
    )
    print("OMB_PANEL_CHAT_RESULTS=" + json.dumps(result, separators=(",", ":"), sort_keys=True))


if __name__ == "__main__":
    main()
