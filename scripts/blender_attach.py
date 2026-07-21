"""Open (or initialize) an oh-my-blender project in Blender and attach.

Generic counterpart to scripts/demo/blender_bootstrap.py: works for any
project directory, both fresh and existing.

Environment:
  OMB_PROJECT_DIR  required - project directory (holds .omb/ and the .blend)
  OMB_REPO         optional - repository root (defaults relative to this file)

Behavior:
  - existing .blend -> open the newest one; scene identity must already exist
  - fresh directory -> save <dirname>.blend, run omb.initialize_project
    (which seeds .omb/project.json), and save again
  - bare .omb/project.json without a bound scene is a broken state the addon
    refuses to adopt silently; this script reports it and exits non-zero
  - then polls the connect operator until the TUI daemon's one-use attach
    handoff is discovered
"""

import os
import sys
from pathlib import Path

import bpy

REPO_ROOT = Path(os.environ.get("OMB_REPO") or Path(__file__).resolve().parents[1])
PROJECT_DIR_VALUE = os.environ.get("OMB_PROJECT_DIR")
if not PROJECT_DIR_VALUE:
    raise RuntimeError("OMB_PROJECT_DIR is required")
PROJECT_DIR = Path(PROJECT_DIR_VALUE).expanduser().resolve()
# Interactive sessions get watch-mode pacing (scene builds visibly while a
# plan applies); tests and headless runs stay unpaced unless they opt in.
os.environ.setdefault("OMB_WATCH_MS", "150")
sys.path.insert(0, str(REPO_ROOT / "blender-addon"))

import oh_my_blender
import oh_my_blender.connection as connection_module


def log(*parts: object) -> None:
    print("OMB_ATTACH:", *parts, flush=True)


def newest_blend() -> Path | None:
    blends = sorted(PROJECT_DIR.glob("*.blend"), key=lambda p: p.stat().st_mtime)
    return blends[-1] if blends else None


def setup() -> None:
    PROJECT_DIR.mkdir(parents=True, exist_ok=True)
    # Exact per-project liveness marker for the omb launcher's reuse check
    # (Blender holds no file handle on its .blend, so lsof/pgrep are unusable).
    (PROJECT_DIR / ".omb-blender.pid").write_text(str(os.getpid()), encoding="utf-8")
    project_file = PROJECT_DIR / ".omb" / "project.json"
    blend = newest_blend()
    if blend is not None:
        bpy.ops.wm.open_mainfile(filepath=str(blend))
        log("opened", blend.name)
    elif project_file.exists():
        raise RuntimeError(
            f"{project_file} exists but the project has no .blend; the scene "
            "binding is unrecoverable here - remove the bare .omb skeleton or "
            "restore the blend, then retry"
        )
    oh_my_blender.register()
    scene = bpy.context.scene
    if not scene.get("omb.project_id"):
        if project_file.exists():
            raise RuntimeError(
                "scene has no project identity but .omb/project.json exists; "
                "initialize_project refuses this state by design"
            )
        target = PROJECT_DIR / f"{PROJECT_DIR.name}.blend" if blend is None else blend
        bpy.ops.wm.save_as_mainfile(filepath=str(target))
        bpy.ops.omb.initialize_project()
        # Scene id-property writes do not reliably dirty the file; an unsaved
        # project id bricks every later relaunch.
        bpy.ops.wm.save_mainfile()
        log("initialized project", scene.get("omb.project_id"))
    try:
        for area in bpy.context.window.screen.areas:
            if area.type == "VIEW_3D":
                for space in area.spaces:
                    if space.type == "VIEW_3D":
                        space.show_region_ui = True
    except Exception:
        pass
    log("ready - attaching via runtime handoff discovery")


_was_attached = False


def poll_attach() -> float | None:
    """Persistent attach watchdog: (re)connects whenever the bridge is down.

    A daemon restart drops the bridge and a fresh one-use handoff appears once
    a controller reissues one, so poll for the lifetime of the Blender session
    (cheap no-op while attached) instead of stopping after the first attach.
    """
    global _was_attached
    if connection_module._active_connection is not None:
        if not _was_attached:
            _was_attached = True
            log("ATTACHED via handoff discovery")
        return 5.0
    if _was_attached:
        _was_attached = False
        log("bridge lost - polling for a new attach handoff")
    # The connect operator refuses a dirty file; this scene is attach-managed
    # (save-at-commit persists every turn), so saving here is always safe.
    if bpy.data.is_dirty and bpy.data.filepath:
        try:
            bpy.ops.wm.save_mainfile()
        except Exception:
            pass
    try:
        bpy.ops.omb.connect()
    except Exception:
        pass  # no handoff yet (TUI not started); keep polling
    if connection_module._active_connection is not None:
        _was_attached = True
        log("ATTACHED via handoff discovery")
        return 5.0
    return 1.0


setup()
bpy.app.timers.register(poll_attach, first_interval=1.0)
