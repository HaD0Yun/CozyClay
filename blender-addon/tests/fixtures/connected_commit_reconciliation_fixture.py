"""Exercise post-bridge-result acknowledgement loss through Blender and the real daemon."""

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
import oh_my_blender.connection as connection_module
from apply_camera_plan_fixture import PROJECT_ID, REVISION, bound_plan, setup_scene
from oh_my_blender.connection import Connection, _resolve_daemon_argv
from oh_my_blender.manifest import extract_scene_manifest_v2


def main() -> None:
    fail_commit = "--fail-commit" in sys.argv
    setup_scene()
    base_manifest = extract_scene_manifest_v2()
    directory = Path(tempfile.mkdtemp(prefix="omb-commit-reconciliation-"))
    connection = None
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
        daemon_script = REPOSITORY_ROOT / "blender-addon/tests/fixtures/delayed_commit_daemon.ts"
        argv = (*regular_argv[:3], str(daemon_script))
        if fail_commit:
            argv = (*argv, "--fail-commit")
        connection = Connection.start(
            argv,
            cwd=directory,
            project_id=PROJECT_ID,
            addon_version="0.1.0",
            blender_version=bpy.app.version_string,
        )
        connection_module._active_connection = connection

        connection._send_json({
            "type": "request",
            "id": str(uuid.uuid4()),
            "method": "apply_camera_plan",
            "params": bound_plan(),
            "expected_revision_id": REVISION,
            "deadline_ms": 200,
        })
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            connection.pump_bridge_messages()
            project = json.loads((omb / "project.json").read_text(encoding="utf-8"))
            reconciliation = getattr(connection, "durable_commit_reconciliation", None)
            terminal = reconciliation is not None and reconciliation.get("outcome") in {
                "committed", "not_committed", "reconciliation_required",
            }
            if fail_commit:
                if terminal:
                    break
            elif project["current_revision_id"] != REVISION and terminal:
                break
            time.sleep(0.01)
        time.sleep(0.1)

        project = json.loads((omb / "project.json").read_text(encoding="utf-8"))
        live_manifest = extract_scene_manifest_v2()
        print("OMB_COMMIT_RECONCILIATION_RESULTS=" + json.dumps({
            "branch": "not_committed" if fail_commit else "committed",
            "durableRevision": project["current_revision_id"],
            "durableSceneHash": project["manifest"]["sceneHash"],
            "liveRevision": live_manifest["revisionId"],
            "liveSceneHash": live_manifest["sceneHash"],
            "reconciliation": getattr(connection, "durable_commit_reconciliation", None),
        }, separators=(",", ":")))
    finally:
        if connection is not None:
            try:
                connection.disconnect("fixture_complete")
            except BaseException:
                connection.child.kill()
        connection_module._active_connection = None
        oh_my_blender.unregister()
        shutil.rmtree(directory, ignore_errors=True)


main()
