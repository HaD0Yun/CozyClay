"""Exercise the production add-on keepalive pump against a real daemon."""

from __future__ import annotations

import json
import os
import sys
import tempfile
import time
from pathlib import Path

import bpy

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPOSITORY_ROOT / "blender-addon"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import oh_my_blender.connection as connection_module
from apply_camera_plan_fixture import PROJECT_ID, REVISION, setup_scene
from oh_my_blender.connection import LifecycleState, connect
from oh_my_blender.manifest import extract_scene_manifest_v2


def main() -> None:
    setup_scene()
    directory = Path(tempfile.mkdtemp(prefix="omb-connected-keepalive-"))
    omb = directory / ".omb"
    omb.mkdir()
    (omb / "project.json").write_text(json.dumps({
        "schema_version": 1,
        "project_id": PROJECT_ID,
        "current_revision_id": REVISION,
        "manifest": extract_scene_manifest_v2(),
    }), encoding="utf-8")

    connection = None
    try:
        connection = connect(
            cwd=directory,
            project_id=PROJECT_ID,
            addon_version="0.1.0",
            blender_version=bpy.app.version_string,
            daemon_args=("--faux",),
        )
        pong_nonces: set[str] = set()
        deadline = time.monotonic() + 65.0
        while time.monotonic() < deadline:
            connection.pump_bridge_messages()
            if connection.last_pong_nonce is not None:
                pong_nonces.add(connection.last_pong_nonce)
            time.sleep(0.01)
        survived = connection.state == LifecycleState.ACTIVE

        idle_deadline = time.monotonic() + 27.0
        while connection.state == LifecycleState.ACTIVE and time.monotonic() < idle_deadline:
            time.sleep(0.05)
        print("OMB_CONNECTED_KEEPALIVE_RESULTS=" + json.dumps({
            "survived": survived,
            "pongCount": len(pong_nonces),
            "closedAfterSilence": connection.state != LifecycleState.ACTIVE,
        }, sort_keys=True))
    finally:
        if connection is not None:
            connection.disconnect("keepalive_fixture_complete", timeout=0.2)
        connection_module._active_connection = None


if __name__ == "__main__":
    main()
