"""Open (or initialize) a CozyClay project in Blender and attach.

Generic counterpart to scripts/demo/blender_bootstrap.py: works for any
project directory, both fresh and existing.

Environment:
  CCLAY_PROJECT_DIR  required - project directory (holds .cclay/ and the .blend)
  CCLAY_REPO         optional - repository root (defaults relative to this file)

Behavior:
  - existing .blend -> open the newest one; scene identity must already exist
  - fresh directory -> save <dirname>.blend, run cclay.initialize_project
    (which seeds .cclay/project.json), and save again
  - bare .cclay/project.json without a bound scene is a broken state the addon
    refuses to adopt silently; this script reports it and exits non-zero
  - then polls the connect operator until the TUI daemon's one-use attach
    handoff is discovered
"""

import os
import sys
import threading
import traceback
from pathlib import Path

import bpy

REPO_ROOT = Path(os.environ.get("CCLAY_REPO") or Path(__file__).resolve().parents[1])


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


_repo_override = _argv_option("--cclay-repo")
if _repo_override:
    REPO_ROOT = Path(_repo_override)
PROJECT_DIR_VALUE = (
    _argv_option("--cclay-project-dir")
    or os.environ.get("CCLAY_PROJECT_DIR")
)
if not PROJECT_DIR_VALUE:
    raise RuntimeError(
        "CCLAY_PROJECT_DIR (env) or --cclay-project-dir (script arg) is required"
    )
PROJECT_DIR = Path(PROJECT_DIR_VALUE).expanduser().resolve()
# Interactive sessions get watch-mode pacing (scene builds visibly while a
# plan applies); tests and headless runs stay unpaced unless they opt in.
os.environ.setdefault("CCLAY_WATCH_MS", "150")
sys.path.insert(0, str(REPO_ROOT / "blender-addon"))

import cclay
import cclay.connection as connection_module


def _repo_addon_version() -> str:
    """Repo-truth add-on version from blender_manifest.toml (single source)."""
    manifest = REPO_ROOT / "blender-addon" / "cclay" / "blender_manifest.toml"
    for line in manifest.read_text(encoding="utf-8").splitlines():
        if line.startswith("version = "):
            return line.split('"')[1]
    raise RuntimeError(f"no version field in {manifest}")


def _loaded_addon_version(module) -> str:
    """Version of the in-memory add-on module.

    A module predating ADDON_VERSION reports "unknown", which never equals the
    repo manifest version, so the caller reloads it -- the correct outcome for
    an add-on old enough to lack the attribute. The legacy bl_info tuple is no
    longer a version source.
    """
    version = getattr(module, "ADDON_VERSION", None)
    if isinstance(version, str) and version:
        return version
    return "unknown"


def _ensure_current_addon():
    """Idempotent (re)load of the repo add-on inside a possibly reused Blender.

    A re-run of this script in a live Blender whose in-memory cclay
    predates the repo (stale METHOD_NOT_SUPPORTED / unsupported-op surface)
    unregisters the old add-on, purges its modules, and re-imports from the
    repo path so the current code serves the bridge. Fresh launches and
    re-runs at the current version are no-ops beyond the import.
    """
    global cclay, connection_module
    repo_version = _repo_addon_version()
    loaded = sys.modules.get("cclay")
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
                if name == "cclay" or name.startswith("cclay.")
            ):
                sys.modules.pop(name, None)
    import cclay as addon_module
    import cclay.connection as reloaded_connection_module

    cclay = addon_module
    connection_module = reloaded_connection_module
    effective = _loaded_addon_version(addon_module)
    if effective != repo_version:
        raise RuntimeError(
            f"add-on reload failed: loaded v{effective}, repo expects v{repo_version}"
        )
    return addon_module


def log(*parts: object) -> None:
    print("CCLAY_ATTACH:", *parts, flush=True)
    # LaunchServices-launched Blender has no useful stdout; mirror to a file.
    try:
        with open(PROJECT_DIR / ".cclay-blender-attach.log", "a", encoding="utf-8") as handle:
            handle.write(" ".join(str(part) for part in ("CCLAY_ATTACH:", *parts)) + "\n")
    except OSError:
        pass


def _log_unhandled(exc_type, exc_value, exc_traceback) -> None:
    log("UNHANDLED", "".join(traceback.format_exception(exc_type, exc_value, exc_traceback)))


def _install_exception_logging() -> None:
    # Blender launched through LaunchServices has stdout/stderr routed to
    # /dev/null, so an unhandled addon exception otherwise vanishes exactly
    # when it explains a bridge loss.
    sys.excepthook = _log_unhandled
    threading.excepthook = lambda args: _log_unhandled(
        args.exc_type, args.exc_value, args.exc_traceback
    )


_install_exception_logging()


def newest_blend() -> Path | None:
    blends = sorted(PROJECT_DIR.glob("*.blend"), key=lambda p: p.stat().st_mtime)
    return blends[-1] if blends else None


def write_pidfile() -> None:
    """Liveness + staleness marker for the cclay launcher's reuse check.

    Line 1: this Blender's pid. Line 2: the loaded add-on version, so the
    launcher can refuse to reuse a Blender running an outdated add-on.
    (Blender holds no file handle on its .blend, so lsof/pgrep are unusable.)
    """
    (PROJECT_DIR / ".cclay-blender.pid").write_text(
        f"{os.getpid()}\n{_loaded_addon_version(cclay)}\n", encoding="utf-8"
    )


def setup() -> None:
    _ensure_current_addon()
    PROJECT_DIR.mkdir(parents=True, exist_ok=True)
    write_pidfile()
    project_file = PROJECT_DIR / ".cclay" / "project.json"
    blend = newest_blend()
    if blend is not None:
        bpy.ops.wm.open_mainfile(filepath=str(blend))
        log("opened", blend.name)
    elif project_file.exists():
        raise RuntimeError(
            f"{project_file} exists but the project has no .blend; the scene "
            "binding is unrecoverable here - remove the bare .cclay skeleton or "
            "restore the blend, then retry"
        )
    cclay.register()
    scene = bpy.context.scene
    if not scene.get("cclay.project_id"):
        if project_file.exists():
            raise RuntimeError(
                "scene has no project identity but .cclay/project.json exists; "
                "initialize_project refuses this state by design"
            )
        target = PROJECT_DIR / f"{PROJECT_DIR.name}.blend" if blend is None else blend
        bpy.ops.wm.save_as_mainfile(filepath=str(target))
        bpy.ops.cclay.initialize_project()
        # Scene id-property writes do not reliably dirty the file; an unsaved
        # project id bricks every later relaunch.
        bpy.ops.wm.save_mainfile()
        log("initialized project", scene.get("cclay.project_id"))
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
        bpy.ops.cclay.connect()
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
