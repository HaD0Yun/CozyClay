"""Shared project context for daemon startup tests."""

from __future__ import annotations

import json
import uuid
from os import PathLike
from pathlib import Path


def provision_daemon_project(
    directory: str | PathLike[str], project_id: str | None = None
) -> str:
    """Write the minimum durable project accepted before daemon listen."""
    resolved_project_id = project_id or str(uuid.uuid4())
    cclay = Path(directory) / ".cclay"
    cclay.mkdir(parents=True, exist_ok=True)
    (cclay / "project.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "project_id": resolved_project_id,
                "current_revision_id": "0" * 64,
            },
            separators=(",", ":"),
        )
        + "\n",
        encoding="utf-8",
    )
    return resolved_project_id
