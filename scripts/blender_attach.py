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


def _argv_option(name: str) -> str | None:
    """Read --name value from Blender's script args (after the `--` separator).

    LaunchServices (`open -a Blender`) does not forward environment variables,
    so launchers pass the project location as script arguments instead.
    """
    argv = sys.argv
    if "--" not in argv:
        return None
    tail = argv[argv.index("--") + 1 :]
    for index, token in enumerate(tail):
        if token == name and index + 1 < len(tail):
            return tail[index + 1]
    return None


_repo_override = _argv_option("--omb-repo")
if _repo_override:
    REPO_ROOT = Path(_repo_override)
PROJECT_DIR_VALUE = _argv_option("--omb-project-dir") or os.environ.get("OMB_PROJECT_DIR")
if not PROJECT_DIR_VALUE:
    raise RuntimeError("OMB_PROJECT_DIR (env) or --omb-project-dir (script arg) is required")
PROJECT_DIR = Path(PROJECT_DIR_VALUE).expanduser().resolve()
# Interactive sessions get watch-mode pacing (scene builds visibly while a
# plan applies); tests and headless runs stay unpaced unless they opt in.
os.environ.setdefault("OMB_WATCH_MS", "150")
sys.path.insert(0, str(REPO_ROOT / "blender-addon"))

import oh_my_blender
import oh_my_blender.connection as connection_module


def _repo_addon_version() -> str:
    """Repo-truth add-on version from blender_manifest.toml (single source)."""
    manifest = REPO_ROOT / "blender-addon" / "oh_my_blender" / "blender_manifest.toml"
    for line in manifest.read_text(encoding="utf-8").splitlines():
        if line.startswith("version = "):
            return line.split('"')[1]
    raise RuntimeError(f"no version field in {manifest}")


def _loaded_addon_version(module) -> str:
    """Version of the in-memory add-on module (legacy modules lack ADDON_VERSION)."""
    version = getattr(module, "ADDON_VERSION", None)
    if isinstance(version, str) and version:
        return version
    return ".".join(str(part) for part in module.bl_info["version"])


def _ensure_current_addon():
    """Idempotent (re)load of the repo add-on inside a possibly reused Blender.

    A re-run of this script in a live Blender whose in-memory oh_my_blender
    predates the repo (stale METHOD_NOT_SUPPORTED / unsupported-op surface)
    unregisters the old add-on, purges its modules, and re-imports from the
    repo path so the current code serves the bridge. Fresh launches and
    re-runs at the current version are no-ops beyond the import.
    """
    global oh_my_blender, connection_module
    repo_version = _repo_addon_version()
    loaded = sys.modules.get("oh_my_blender")
    if loaded is not None:
        loaded_version = _loaded_addon_version(loaded)
        if loaded_version != repo_version:
            log(f"stale add-on v{loaded_version} loaded; reloading repo v{repo_version}")
            try:
                loaded.unregister()
            except Exception as exc:  # Blender may hold partial state; purge anyway.
                log("unregister of stale add-on failed (continuing):", exc)
            for name in sorted(
                name
                for name in sys.modules
                if name == "oh_my_blender" or name.startswith("oh_my_blender.")
            ):
                sys.modules.pop(name, None)
    import oh_my_blender as addon_module
    import oh_my_blender.connection as reloaded_connection_module

    oh_my_blender = addon_module
    connection_module = reloaded_connection_module
    effective = _loaded_addon_version(addon_module)
    if effective != repo_version:
        raise RuntimeError(
            f"add-on reload failed: loaded v{effective}, repo expects v{repo_version}"
        )
    return addon_module


def log(*parts: object) -> None:
    print("OMB_ATTACH:", *parts, flush=True)
    # LaunchServices-launched Blender has no useful stdout; mirror to a file.
    try:
        with open(PROJECT_DIR / ".omb-blender-attach.log", "a", encoding="utf-8") as handle:
            handle.write(" ".join(str(part) for part in ("OMB_ATTACH:", *parts)) + "\n")
    except OSError:
        pass


def newest_blend() -> Path | None:
    blends = sorted(PROJECT_DIR.glob("*.blend"), key=lambda p: p.stat().st_mtime)
    return blends[-1] if blends else None


def write_pidfile() -> None:
    """Liveness + staleness marker for the omb launcher's reuse check.

    Line 1: this Blender's pid. Line 2: the loaded add-on version, so the
    launcher can refuse to reuse a Blender running an outdated add-on.
    (Blender holds no file handle on its .blend, so lsof/pgrep are unusable.)
    """
    (PROJECT_DIR / ".omb-blender.pid").write_text(
        f"{os.getpid()}\n{_loaded_addon_version(oh_my_blender)}\n", encoding="utf-8"
    )


def setup() -> None:
    _ensure_current_addon()
    PROJECT_DIR.mkdir(parents=True, exist_ok=True)
    write_pidfile()
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

def bridge_is_attached() -> bool:
    active = connection_module._active_connection
    return (
        active is not None
        and active.state not in connection_module.RECONNECTABLE_STATES
        and active.state != connection_module.LifecycleState.STOPPED
    )



def poll_attach() -> float | None:
    """Persistent attach watchdog: (re)connects whenever the bridge is down.

    A daemon restart drops the bridge and a fresh one-use handoff appears once
    a controller reissues one, so poll for the lifetime of the Blender session
    (cheap no-op while attached) instead of stopping after the first attach.
    """
    global _was_attached
    if bridge_is_attached():
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
    if bridge_is_attached():
        _was_attached = True
        log("ATTACHED via handoff discovery")
        return 5.0
    return 1.0


if __name__ == "__main__":
    setup()
    bpy.app.timers.register(poll_attach, first_interval=1.0)
