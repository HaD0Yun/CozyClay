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


def _task_progress_evidence(active: object) -> tuple[str, str, str]:
    checkpoint = getattr(active, "active_checkpoint", None)
    reconciliation = getattr(active, "durable_commit_reconciliation", None)
    response = getattr(active, "last_bridge_response", None)
    if checkpoint is not None:
        task = "Camera plan mutation"
        progress = "Mutation checkpoint retained"
    elif reconciliation is not None:
        task = "Durable commit reconciliation"
        progress = "Awaiting verified durable outcome"
    else:
        task = "Idle"
        progress = "Awaiting Pi-issued task"

    if isinstance(reconciliation, dict):
        outcome = reconciliation.get("outcome")
        rendered = str(outcome).replace("_", " ") if outcome else "pending"
        evidence = f"Durable commit {rendered}"
    elif response is not None:
        evidence = "Durable bridge response received"
    else:
        evidence = "No retained evidence"
    return task, progress, evidence


def draw_status(layout: object, active: object | None) -> None:
    """Render status labels only; never expose mutation controls or secret-bearing data."""
    layout.label(text="Pi-driven controls")
    layout.label(text="Prompt: Controlled by Pi")
    if active is None:
        layout.label(text="Lifecycle: Not connected")
        layout.label(text="Provider: Unavailable")
        layout.label(text="Model: Unavailable")
        layout.label(text="Task: Idle")
        layout.label(text="Progress: Awaiting Pi connection")
        layout.label(text="Evidence: No retained evidence")
        layout.label(text="Tools: Hidden while disconnected")
        return

    state = getattr(active, "state", LifecycleState.STOPPED)
    layout.label(text=f"Lifecycle: {_LIFECYCLE_LABELS.get(state, 'Unknown')}")
    provider, model = _provider_and_model(active)
    layout.label(text=f"Provider: {provider}")
    layout.label(text=f"Model: {model}")
    task, progress, evidence = _task_progress_evidence(active)
    layout.label(text=f"Task: {task}")
    layout.label(text=f"Progress: {progress}")
    layout.label(text=f"Evidence: {evidence}")
    if getattr(active, "tools_exposed", False):
        layout.label(text="Tools: Available to Pi")
    elif state is LifecycleState.RECOVERY_REQUIRED:
        layout.label(text="Tools: Hidden until verified recovery")
    else:
        layout.label(text="Tools: Hidden while degraded")
