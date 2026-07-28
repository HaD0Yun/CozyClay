"""Initialize a small real Blender project and export its Scene Snapshot v2 manifest."""

from __future__ import annotations

import argparse
import json
import os
import sys
import traceback
from pathlib import Path

import bpy

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPOSITORY_ROOT / "blender-addon"))

from cclay import manifest, register, unregister


def arguments() -> argparse.Namespace:
    blender_arguments = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--project-dir", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args(blender_arguments)


def main() -> None:
    options = arguments()
    options.project_dir.mkdir(parents=True, exist_ok=True)
    blend_path = options.project_dir / "fixture.blend"

    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.name = "Initialized Integration Fixture"
    bpy.ops.mesh.primitive_cube_add(location=(-1.0, 0.0, 0.0))
    bpy.context.active_object.name = "Cube A"
    bpy.ops.mesh.primitive_cube_add(location=(1.0, 0.0, 0.0))
    bpy.context.active_object.name = "Cube B"
    bpy.ops.wm.save_as_mainfile(filepath=str(blend_path))

    register()
    try:
        result = bpy.ops.cclay.initialize_project()
        if result != {"FINISHED"}:
            raise RuntimeError(f"Initialize Project returned {result}")
        bpy.ops.wm.save_as_mainfile(filepath=str(blend_path))
        revision = manifest.write_scene_snapshot(options.output)
        project_id = scene["cclay.project_id"]
        project_index = json.loads(
            (options.project_dir / ".cclay" / "project.json").read_text(encoding="utf-8")
        )
        if project_index.get("project_id") != project_id:
            raise RuntimeError("persisted project_id does not match initialized scene")
        print(f"CCLAY_PROJECT_ID={project_id}")
        print(f"CCLAY_REVISION={revision}")

        # Architecture doc line 92-99/section 14: prove the add-on's OWN
        # registered Connect/Disconnect operators actually own a real daemon
        # child and authenticated WebSocket -- not a separate test-only
        # WebSocket path -- closing the launch-configuration composition gap
        # (CCLAY_DAEMON_ARGS is supplied by the calling test harness).
        from cclay import connection

        connect_result = bpy.ops.cclay.connect()
        if connect_result != {"FINISHED"}:
            raise RuntimeError(f"Connect returned {connect_result}")
        active = connection._active_connection
        if active is None or active.state != "active":
            raise RuntimeError("Connect did not retain an active connection")
        if active.child.process.poll() is not None:
            raise RuntimeError("Connect's owned daemon child is not running")
        print(f"CCLAY_CONNECT_CHILD_PID={active.child.process.pid}")

        disconnect_result = bpy.ops.cclay.disconnect()
        if disconnect_result != {"FINISHED"}:
            raise RuntimeError(f"Disconnect returned {disconnect_result}")
        if connection._active_connection is not None:
            raise RuntimeError("Disconnect did not release the active connection")
        if active.child.process.poll() is None:
            raise RuntimeError("Disconnect did not terminate its owned daemon child")
        print("CCLAY_CONNECT_CYCLE=true")
    finally:
        unregister()

    # architecture doc line 415 ("no Blender ... handler remains registered")
    # -- the operator classes themselves must not survive unregister().
    for class_name in (
        "CCLAY_OT_initialize_project",
        "CCLAY_OT_repair_ids",
        "CCLAY_OT_connect",
        "CCLAY_OT_apply_camera_plan",
        "CCLAY_OT_disconnect",
    ):
        if hasattr(bpy.types, class_name):
            raise RuntimeError(f"{class_name} remained registered after unregister()")
    print("CCLAY_OPERATORS_UNREGISTERED=true")


if __name__ == "__main__":
    try:
        main()
    except BaseException:
        traceback.print_exc()
        sys.stdout.flush()
        sys.stderr.flush()
        os._exit(1)
