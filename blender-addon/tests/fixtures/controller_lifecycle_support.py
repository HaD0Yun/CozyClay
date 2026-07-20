"""Shared real-Blender setup and cleanup for controller lifecycle fixtures."""

from __future__ import annotations

import json
import shutil
import tempfile
from pathlib import Path

import bpy

from apply_camera_plan_fixture import PROJECT_ID, REVISION, setup_scene
from oh_my_blender.connection import _resolve_daemon_argv, _runtime_user_directory
from oh_my_blender.controller_connection import ControllerConnection
from oh_my_blender.daemon_child import DaemonChild
from oh_my_blender.manifest import extract_scene_manifest_v2


def prepare_project() -> Path:
    setup_scene()
    manifest = extract_scene_manifest_v2()
    if manifest["revisionId"] != REVISION:
        raise RuntimeError("controller lifecycle fixture revision drifted")
    directory = Path(tempfile.mkdtemp(prefix="omb-controller-lifecycle-"))
    omb = directory / ".omb"
    omb.mkdir()
    (omb / "project.json").write_text(json.dumps({
        "schema_version": 1,
        "project_id": PROJECT_ID,
        "current_revision_id": REVISION,
        "manifest": manifest,
    }), encoding="utf-8")
    return directory


def spawn_owner(directory: Path) -> tuple[DaemonChild, ControllerConnection, Path]:
    child = DaemonChild.spawn(_resolve_daemon_argv(("--faux",)), cwd=directory)
    startup = child.read_startup_record()
    runtime_directory = _runtime_user_directory() / startup["launch_id"]
    owner = ControllerConnection.connect_owner(
        port=startup["port"],
        boot_token=startup["bearer_token"],
        launch_id=startup["launch_id"],
        project_id=PROJECT_ID,
        addon_version="0.1.0",
        blender_version=bpy.app.version_string,
        runtime_directory=runtime_directory,
        start_reader=False,
        jitter=lambda _delay: 0.0,
    )
    startup["bearer_token"] = ""
    return child, owner, runtime_directory


def cleanup(
    directory: Path,
    child: DaemonChild | None,
    owner: ControllerConnection | None,
    *connections,
) -> None:
    for connection in connections:
        if connection is None:
            continue
        try:
            connection.close() if isinstance(connection, ControllerConnection) else connection.disconnect(
                "lifecycle_fixture_complete", timeout=0.2
            )
        except Exception:
            pass
    if owner is not None:
        try:
            owner.shutdown("client_exit", timeout=3.0)
        except Exception:
            owner.close()
    if child is not None:
        if child.process.poll() is None:
            child.kill()
        else:
            child.close_streams()
    shutil.rmtree(directory, ignore_errors=True)
