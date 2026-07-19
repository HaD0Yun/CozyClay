"""Read-only, nonsecret status rendering for the Pi-controlled Blender bridge."""

from __future__ import annotations

import os
from collections.abc import Sequence

from .connection import LifecycleState

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
