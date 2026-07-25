"""Nonsecret bridge status and connected conversation controls for Blender."""

from __future__ import annotations

import os
import time
import uuid
from collections import deque
from collections.abc import Sequence
from os import PathLike

from . import controller_connection, project_store, qa_image_display
from .connection import LifecycleState
from .controller_connection import ControllerConnectionError, ControllerState
from .panel_state import PanelSnapshot, PanelState, PanelStateError
from .ws_client import WebSocketError

try:  # Blender is intentionally absent from host-side tests.
    import bpy  # type: ignore
except ImportError:  # pragma: no cover - exercised by host-side imports
    bpy = None

_LIFECYCLE_LABELS = {
    LifecycleState.ACTIVE: "Active",
    LifecycleState.LOST: "Connection lost",
    LifecycleState.DISCONNECTED: "Disconnected",
    LifecycleState.RECOVERY_REQUIRED: "Recovery required",
    LifecycleState.DRAINING: "Draining",
    LifecycleState.STOPPED: "Stopped",
}
_SECRET_ENVIRONMENT_MARKERS = ("API_KEY", "TOKEN", "SECRET", "CREDENTIAL", "PASSWORD")


def _argument_value(argv: Sequence[object], flag: str) -> str | None:
    values = [str(value) for value in argv]
    indexes = [index for index, value in enumerate(values) if value == flag]
    if len(indexes) != 1 or indexes[0] + 1 >= len(values):
        return None
    value = values[indexes[0] + 1]
    if not value or value.startswith("--"):
        return None
    return value


def _safe_identifier(value: str | None) -> str:
    if value is None:
        return "Unavailable"
    secret_values = {
        environment_value
        for name, environment_value in os.environ.items()
        if environment_value
        and any(marker in name.upper() for marker in _SECRET_ENVIRONMENT_MARKERS)
    }
    if any(secret in value for secret in secret_values):
        return "Unavailable"
    return value


def _provider_and_model(active: object) -> tuple[str, str]:
    process = getattr(getattr(active, "child", None), "process", None)
    argv = getattr(process, "args", ())
    if not isinstance(argv, (list, tuple)):
        return "Unavailable", "Unavailable"
    if "--faux" in argv:
        return "Faux", "Faux"
    return (
        _safe_identifier(_argument_value(argv, "--provider")),
        _safe_identifier(_argument_value(argv, "--model")),
    )


def _task_snapshot(active: object) -> tuple[str, str, str, str, str]:
    status = getattr(active, "task_status", None)
    kind = getattr(status, "task_kind", None)
    task = {
        "camera_plan": "Camera plan",
        "qa_render": "QA render",
    }.get(kind, "Idle")
    descriptor = getattr(status, "descriptor", "Awaiting Pi-issued task")
    phase = getattr(status, "phase", "idle")
    completed = getattr(status, "completed", 0)
    total = getattr(status, "total", 0)
    rendered_phase = str(phase).replace("_", " ").capitalize()
    progress = (
        f"{rendered_phase} ({completed}/{total})"
        if isinstance(total, int) and total > 0
        else rendered_phase
    )
    outcome = getattr(status, "outcome", None)
    rendered_outcome = (
        str(outcome).replace("_", " ").capitalize()
        if outcome is not None
        else "Pending"
    )
    evidence = getattr(status, "evidence", "No retained evidence")
    return task, descriptor, progress, rendered_outcome, evidence


def draw_status(layout: object, active: object | None) -> tuple[str, ...]:
    """Render status labels only; never expose mutation controls or secret-bearing data."""
    labels = ["Pi-driven controls"]
    if active is None:
        labels.extend([
            "Lifecycle: Not connected",
            "Provider: Unavailable",
            "Model: Unavailable",
            "Task: Idle",
            "Descriptor: Awaiting Pi-issued task",
            "Progress: Awaiting Pi connection",
            "Outcome: Pending",
            "Evidence: No retained evidence",
            "Tools: Hidden while disconnected",
        ])
    else:
        state = getattr(active, "state", LifecycleState.STOPPED)
        provider, model = _provider_and_model(active)
        task, descriptor, progress, outcome, evidence = _task_snapshot(active)
        labels.extend([
            f"Lifecycle: {_LIFECYCLE_LABELS.get(state, 'Unknown')}",
            f"Provider: {provider}",
            f"Model: {model}",
            f"Task: {task}",
            f"Descriptor: {descriptor}",
            f"Progress: {progress}",
            f"Outcome: {outcome}",
            f"Evidence: {evidence}",
        ])
        if getattr(active, "tools_exposed", False):
            labels.append("Tools: Available to Pi")
        elif state is LifecycleState.RECOVERY_REQUIRED:
            labels.append("Tools: Hidden until verified recovery")
        else:
            labels.append("Tools: Hidden while degraded")
    for text in labels:
        layout.label(text=text)
    return tuple(labels)


_DIRECTOR_TURN_CAPABILITY = "director_turn_v1"
_DIRECTOR_TRANSCRIPT_CAPABILITY = "director_transcript_v1"
_PANEL_ACTIVE_INTERVAL = 0.016
_PANEL_IDLE_INTERVAL = 0.1
_PANEL_BUDGET_SECONDS = 0.004
_PANEL_MAX_UPDATES = 32
_panel_state = PanelState()
_controller_marker: tuple[int, object, object] | None = None
_controller_was_active = False
_pump_durations_ms: deque[float] = deque(maxlen=512)


class PanelActionError(RuntimeError):
    """A user-facing panel action cannot be completed safely."""


def panel_snapshot() -> PanelSnapshot:
    return _panel_state.snapshot()


def reset_panel_state() -> None:
    global _panel_state, _controller_marker, _controller_was_active
    _panel_state = PanelState()
    _controller_marker = None
    _controller_was_active = False
    _pump_durations_ms.clear()


def submit_prompt(
    prompt: str,
    project_directory: str | PathLike[str],
    *,
    controller=None,
) -> str:
    active = controller or controller_connection._active_controller
    if active is None or getattr(active, "state", None) != ControllerState.ACTIVE:
        raise PanelActionError("Controller is not connected")
    if _DIRECTOR_TURN_CAPABILITY not in getattr(active, "capabilities", ()):
        raise PanelActionError("Director turns are unavailable")
    normalized = prompt.strip()
    project = project_store.read_project_index(project_directory)
    revision = None if project is None else project.get("current_revision_id")
    if (
        not isinstance(revision, str)
        or len(revision) != 64
        or any(character not in "0123456789abcdef" for character in revision)
    ):
        raise PanelActionError("Current project revision is unavailable")
    turn_id = str(uuid.uuid4())
    try:
        _panel_state.begin_submission(turn_id, normalized)
        active._send_json({
            "type": "director_turn",
            "id": turn_id,
            "prompt": normalized,
            "expected_revision_id": revision,
            "deadline_ms": 300_000,
        })
    except (ControllerConnectionError, OSError, PanelStateError, WebSocketError) as error:
        _panel_state.submission_failed(turn_id, str(error))
        raise PanelActionError(str(error)) from error
    _tag_redraw()
    return turn_id


def cancel_active_turn(*, controller=None) -> str:
    active = controller or controller_connection._active_controller
    turn_id = _panel_state.active_request_id
    if (
        active is None
        or getattr(active, "state", None) != ControllerState.ACTIVE
        or turn_id is None
    ):
        raise PanelActionError("No active panel turn can be cancelled")
    try:
        active._send_json({"type": "cancel", "id": turn_id})
    except (ControllerConnectionError, OSError, WebSocketError) as error:
        raise PanelActionError("Cancel request could not be sent") from error
    return turn_id


def reconnect_controller() -> bool:
    controller_connection.poll_controller_lifecycle(force=True)
    active = controller_connection._active_controller
    reconnected = (
        active is not None
        and getattr(active, "state", None) == ControllerState.ACTIVE
    )
    _tag_redraw()
    return reconnected


def pump_controller_panel(
    *,
    clock=time.perf_counter,
    bpy_module=None,
    project_directory: str | PathLike[str] | None = None,
) -> float:
    """Drain controller updates within the frozen 32-event/4-ms timer budget."""
    global _controller_marker, _controller_was_active
    started = clock()
    drain_finished = started
    deadline = started + _PANEL_BUDGET_SECONDS
    active = controller_connection._active_controller
    changed = False
    if active is None:
        if _controller_marker is not None or _controller_was_active:
            _panel_state.set_disconnected()
            changed = True
        _controller_marker = None
        _controller_was_active = False
    else:
        is_active = getattr(active, "state", None) == ControllerState.ACTIVE
        marker = (
            id(active),
            getattr(active, "session_id", None),
            getattr(active, "generation", None),
        )
        if is_active and (marker != _controller_marker or not _controller_was_active):
            _controller_marker = marker
            if _DIRECTOR_TRANSCRIPT_CAPABILITY in getattr(active, "capabilities", ()):
                try:
                    request_id = _request_transcript(active, 0, None)
                    _panel_state.begin_replay(
                        request_id,
                        str(getattr(active, "session_id", "")),
                    )
                except (ControllerConnectionError, OSError, WebSocketError) as error:
                    _panel_state.set_connected()
                    _panel_state.record_error(
                        f"Transcript replay unavailable: {type(error).__name__}"
                    )
            else:
                _panel_state.set_connected()
            changed = True
        elif not is_active and _controller_was_active:
            _panel_state.set_disconnected(
                str(getattr(active, "state", ControllerState.LOST).value)
            )
            changed = True
        _controller_was_active = is_active

        drained = 0
        while is_active and drained < _PANEL_MAX_UPDATES:
            now = clock()
            if now >= deadline:
                break
            replayed = _panel_state.drain_replay_events(1)
            if replayed:
                drained += replayed
                changed = True
                continue
            remaining_ms = min(4.0, max(0.001, (deadline - now) * 1000))
            updates = active.drain_updates(
                max_updates=1,
                budget_ms=remaining_ms,
                clock=clock,
            )
            if not updates:
                break
            continuation = _panel_state.apply_update(updates[0])
            drained += 1
            changed = True
            if continuation is not None:
                cursor, snapshot_cursor = continuation
                try:
                    request_id = _request_transcript(
                        active,
                        cursor,
                        snapshot_cursor,
                    )
                    _panel_state.expect_replay_page(
                        request_id,
                        cursor,
                        snapshot_cursor,
                    )
                except (ControllerConnectionError, OSError, WebSocketError) as error:
                    _panel_state.abort_replay(
                        f"Transcript replay unavailable: {type(error).__name__}"
                    )

        drain_finished = clock()
        digests = _panel_state.take_qa_digests()
        if digests:
            root = project_directory
            host = bpy_module
            if root is None:
                resolved_host = _bpy_module() if host is None else host
                path_api = getattr(resolved_host, "path", None)
                root = (
                    path_api.abspath("//")
                    if path_api is not None and callable(getattr(path_api, "abspath", None))
                    else None
                )
            if root is None:
                _panel_state.record_qa_error("QA project directory is unavailable")
            else:
                try:
                    displayed = qa_image_display.display_latest_qa_artifact(
                        root,
                        digests[-1],
                        bpy_module=host,
                    )
                except qa_image_display.QaImageDisplayError as error:
                    _panel_state.record_qa_error(str(error))
                else:
                    _panel_state.record_qa_display(displayed)
            changed = True

    elapsed_ms = max(0.0, (drain_finished - started) * 1000)
    _pump_durations_ms.append(elapsed_ms)
    if changed:
        _tag_redraw(bpy_module)
    snapshot = _panel_state.snapshot()
    pending = 0 if active is None else getattr(active, "pending_update_count", 0)
    return (
        _PANEL_ACTIVE_INTERVAL
        if active is not None
        and getattr(active, "state", None) == ControllerState.ACTIVE
        and (pending > 0 or snapshot.can_cancel or snapshot.replaying)
        else _PANEL_IDLE_INTERVAL
    )


def panel_timer_metrics() -> tuple[float, float]:
    if not _pump_durations_ms:
        return 0.0, 0.0
    ordered = sorted(_pump_durations_ms)
    index = min(len(ordered) - 1, max(0, (95 * len(ordered) + 99) // 100 - 1))
    return ordered[index], ordered[-1]


def draw_panel(
    layout: object,
    context: object,
    active_bridge: object | None,
    active_controller: object | None,
) -> tuple[str, ...]:
    labels = list(draw_status(layout, active_bridge))
    snapshot = _panel_state.snapshot()
    authority = getattr(active_controller, "authority", None)
    controller_state = getattr(active_controller, "state", ControllerState.STOPPED)
    controller_label = (
        f"Controller: {str(authority).capitalize()} / "
        f"{getattr(controller_state, 'value', str(controller_state)).replace('_', ' ').capitalize()}"
        if active_controller is not None
        else "Controller: Not connected"
    )
    status_label = f"Chat: {snapshot.status}"
    layout.label(text=controller_label)
    layout.label(text=status_label)
    labels.extend((controller_label, status_label))
    if snapshot.error:
        error_label = f"Chat error: {snapshot.error}"
        layout.label(text=error_label, icon="ERROR")
        labels.append(error_label)

    for entry in snapshot.entries:
        prefix = {
            "user": "You",
            "assistant": "Pi",
            "tool": "Tool",
            "tool_error": "Tool error",
            "completed": "Done",
            "failed": "Failed",
            "cancelled": "Cancelled",
        }.get(entry.kind, "Event")
        for line in _wrapped_lines(entry.text):
            text = f"{prefix}: {line}"
            layout.label(text=text)
            labels.append(text)
    if snapshot.active_text:
        for line in _wrapped_lines(snapshot.active_text):
            text = f"Pi: {line}"
            layout.label(text=text)
            labels.append(text)

    properties = getattr(getattr(context, "scene", None), "cclay_panel_chat", None)
    if properties is not None and callable(getattr(layout, "prop", None)):
        layout.prop(properties, "prompt", text="Prompt")
    if snapshot.can_submit:
        row = layout.row(align=True) if callable(getattr(layout, "row", None)) else layout
        row.operator("cclay.send_prompt", text="Send")
    if snapshot.can_cancel:
        row = layout.row(align=True) if callable(getattr(layout, "row", None)) else layout
        row.operator("cclay.cancel_turn", text="Cancel")
    if active_controller is None or controller_state != ControllerState.ACTIVE:
        layout.operator("cclay.reconnect_controller", text="Reconnect")
    return tuple(labels)


def _request_transcript(
    active: object,
    cursor: int,
    snapshot_cursor: int | None,
) -> str:
    if _DIRECTOR_TRANSCRIPT_CAPABILITY not in getattr(active, "capabilities", ()):
        raise ControllerConnectionError("Director transcript capability is unavailable")
    request_id = str(uuid.uuid4())
    active._send_json({
        "type": "director_transcript_request",
        "id": request_id,
        "cursor": cursor,
        "page_size": 64,
        "snapshot_cursor": snapshot_cursor,
    })
    return request_id


def _wrapped_lines(text: str, width: int = 96) -> tuple[str, ...]:
    lines: list[str] = []
    for source in text.splitlines() or [""]:
        remaining = source
        while len(remaining) > width:
            split = remaining.rfind(" ", 0, width + 1)
            if split <= 0:
                split = width
            lines.append(remaining[:split])
            remaining = remaining[split:].lstrip()
        lines.append(remaining)
    return tuple(lines)


def _bpy_module():
    return bpy


def _tag_redraw(bpy_module=None) -> None:
    host = _bpy_module() if bpy_module is None else bpy_module
    context = getattr(host, "context", None)
    window_manager = getattr(context, "window_manager", None)
    for window in getattr(window_manager, "windows", ()):
        screen = getattr(window, "screen", None)
        for area in getattr(screen, "areas", ()):
            redraw = getattr(area, "tag_redraw", None)
            if callable(redraw):
                redraw()
