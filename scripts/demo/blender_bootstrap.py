"""Prepare a Blender project for the live CozyClay demo."""

import json
import os
import sys
from pathlib import Path

import bpy
from mathutils import Vector

REPO_ROOT = Path(__file__).resolve().parents[2]
PROJECT_DIR_VALUE = os.environ.get("CCLAY_DEMO_PROJECT_DIR")
if not PROJECT_DIR_VALUE:
    raise RuntimeError("CCLAY_DEMO_PROJECT_DIR is required")
PROJECT_DIR = Path(PROJECT_DIR_VALUE).expanduser().resolve()
SKIP_ATTACH = os.environ.get("CCLAY_SKIP_ATTACH") == "1"
sys.path.insert(0, str(REPO_ROOT / "blender-addon"))

import cclay
import cclay.connection as connection_module


def log(*parts: object) -> None:
    print("CCLAY_DEMO:", *parts, flush=True)


def setup() -> None:
    # Eligibility gate BEFORE any destructive work: this bootstrap builds a
    # brand-new demo project. An existing durable project (or blend) must be
    # reused or removed explicitly; the scene wipe/save below must not run.
    blend_file = PROJECT_DIR / "cclay-live-demo.blend"
    project_file = PROJECT_DIR / ".cclay" / "project.json"
    if project_file.exists() or blend_file.exists():
        raise RuntimeError(
            f"CCLAY_DEMO_PROJECT_DIR already contains a project ({PROJECT_DIR}); "
            "reuse it with the normal launch path or point at a fresh directory"
        )

    for scene_object in list(bpy.data.objects):
        bpy.data.objects.remove(scene_object, do_unlink=True)

    camera_data = bpy.data.cameras.new("Observer Camera")
    camera = bpy.data.objects.new("Observer Camera", camera_data)
    camera.location = Vector((7.0, -7.0, 5.0))
    camera.rotation_euler = (-camera.location).to_track_quat("-Z", "Y").to_euler()
    bpy.context.scene.collection.objects.link(camera)
    bpy.context.scene.camera = camera

    PROJECT_DIR.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=str(blend_file))
    cclay.register()
    bpy.ops.cclay.initialize_project()
    # Unconditional save: scene id-property writes (project id, entity ids) do
    # not reliably mark the file dirty, and losing them bricks every later
    # relaunch ("Initialize and save the project before connecting").
    bpy.ops.wm.save_mainfile()

    project_id = bpy.context.scene.get("cclay.project_id")
    if not project_id:
        raise RuntimeError("initialize_project did not assign a scene project id")
    # initialize_project owns durable-document seeding; verify instead of writing.
    project_document = json.loads(project_file.read_text(encoding="utf-8"))
    if project_document.get("project_id") != project_id:
        raise RuntimeError("durable project identity does not match the scene")
    if "current_revision_id" not in project_document:
        raise RuntimeError(
            "initialize_project did not produce a durable revision document; "
            "update the cclay add-on instead of reseeding here"
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
        log("project ready:", project_id, "- attaching via runtime handoff discovery")


def poll_attach() -> float | None:
    # Product path: the connect operator discovers the TUI daemon's one-use
    # attach handoff in the private runtime directory (no ticket scraping).
    if connection_module._active_connection is not None:
        log("ATTACHED via handoff discovery")
        return None
    try:
        bpy.ops.cclay.connect()
    except Exception:
        pass  # no handoff yet (TUI not started); keep polling
    if connection_module._active_connection is not None:
        log("ATTACHED via handoff discovery")
        return None
    return 1.0


setup()
if not SKIP_ATTACH:
    bpy.app.timers.register(poll_attach, first_interval=1.0)
