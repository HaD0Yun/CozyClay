"""Prepare a Blender project for the live oh-my-blender demo."""

import json
import os
import sys
from pathlib import Path

import bpy
from mathutils import Vector

REPO_ROOT = Path(__file__).resolve().parents[2]
PROJECT_DIR_VALUE = os.environ.get("OMB_DEMO_PROJECT_DIR")
if not PROJECT_DIR_VALUE:
    raise RuntimeError("OMB_DEMO_PROJECT_DIR is required")
PROJECT_DIR = Path(PROJECT_DIR_VALUE).expanduser().resolve()
ATTACH_FILE = Path(os.environ.get("OMB_ATTACH_FILE", "/tmp/omb-live-attach.json"))
SKIP_ATTACH = os.environ.get("OMB_SKIP_ATTACH") == "1"
sys.path.insert(0, str(REPO_ROOT / "blender-addon"))

import oh_my_blender
import oh_my_blender.connection as connection_module
from oh_my_blender.manifest import extract_scene_manifest_v2


def log(*parts: object) -> None:
    print("OMB_DEMO:", *parts, flush=True)


def setup() -> None:
    for scene_object in list(bpy.data.objects):
        bpy.data.objects.remove(scene_object, do_unlink=True)

    camera_data = bpy.data.cameras.new("Observer Camera")
    camera = bpy.data.objects.new("Observer Camera", camera_data)
    camera.location = Vector((7.0, -7.0, 5.0))
    camera.rotation_euler = (-camera.location).to_track_quat("-Z", "Y").to_euler()
    bpy.context.scene.collection.objects.link(camera)
    bpy.context.scene.camera = camera

    PROJECT_DIR.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=str(PROJECT_DIR / "omb-live-demo.blend"))
    oh_my_blender.register()
    bpy.ops.omb.initialize_project()
    if bpy.data.is_dirty:
        bpy.ops.wm.save_mainfile()

    project_id = bpy.context.scene.get("omb.project_id")
    project_file = PROJECT_DIR / ".omb" / "project.json"
    project_document = json.loads(project_file.read_text(encoding="utf-8"))
    if not project_document.get("current_revision_id"):
        base_manifest = extract_scene_manifest_v2()
        project_file.write_text(
            json.dumps(
                {
                    "schema_version": 1,
                    "project_id": project_id,
                    "current_revision_id": base_manifest["revisionId"],
                    "manifest": base_manifest,
                }
            ),
            encoding="utf-8",
        )

    try:
        for area in bpy.context.window.screen.areas:
            if area.type == "VIEW_3D":
                for space in area.spaces:
                    if space.type == "VIEW_3D":
                        space.show_region_ui = True
    except Exception:
        pass

    if SKIP_ATTACH:
        log("project ready:", project_id, "- attach polling skipped")
    else:
        log("project ready:", project_id, "- polling", ATTACH_FILE)


def poll_attach() -> float | None:
    if connection_module._active_connection is not None:
        return None
    if not ATTACH_FILE.exists():
        return 0.3
    try:
        payload = json.loads(ATTACH_FILE.read_text(encoding="utf-8"))
        ATTACH_FILE.unlink(missing_ok=True)
        connection_module.connect(
            cwd=str(PROJECT_DIR),
            project_id=bpy.context.scene.get("omb.project_id"),
            addon_version="0.1.0",
            blender_version=bpy.app.version_string,
            attach_runtime_directory=payload["runtime_directory"],
            attach_ticket=payload["ticket"],
        )
        log("ATTACHED to daemon at", payload["runtime_directory"])
        return None
    except Exception as error:
        log("attach failed:", error)
        return 1.0


setup()
if not SKIP_ATTACH:
    bpy.app.timers.register(poll_attach, first_interval=1.0)
