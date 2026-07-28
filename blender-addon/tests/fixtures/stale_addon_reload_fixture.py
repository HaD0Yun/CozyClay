"""Prove blender_attach reloads a stale in-memory add-on inside real Blender.

Simulates the live-session incident: Blender is reused with an in-memory
cclay older than the repo (METHOD_NOT_SUPPORTED / unsupported-op
surface). The attach script's _ensure_current_addon must unregister the stale
add-on, purge its modules, re-import the repo code, and allow re-registration
without double-registration errors. The pidfile must record pid + loaded
version for the launcher's reuse guard.
"""

from __future__ import annotations

import importlib.util
import json
import os
import sys
import tempfile
import traceback
import uuid
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPOSITORY_ROOT / "blender-addon"))

results: dict[str, object] = {}
project_dir = Path(tempfile.mkdtemp(prefix="cclay-stale-reload-"))
os.environ["CCLAY_PROJECT_DIR"] = str(project_dir)
os.environ["CCLAY_REPO"] = str(REPOSITORY_ROOT)

try:
    import cclay

    # A live Blender session has the add-on registered before cclay re-attaches.
    cclay.register()
    results["initialRegistered"] = True

    # Simulate staleness: downgrade the version markers the detector inspects.
    stale_module = cclay
    stale_module.ADDON_VERSION = "0.1.0"
    stale_module.bl_info = dict(stale_module.bl_info, version=(0, 1, 0))

    spec = importlib.util.spec_from_file_location(
        "cclay_blender_attach", REPOSITORY_ROOT / "scripts" / "blender_attach.py"
    )
    assert spec is not None and spec.loader is not None
    attach = importlib.util.module_from_spec(spec)
    # __name__ != "__main__": module-level setup()/timer registration is skipped.
    spec.loader.exec_module(attach)

    repo_version = attach._repo_addon_version()
    results["repoVersion"] = repo_version
    results["staleDetectedVersion"] = attach._loaded_addon_version(stale_module)

    reloaded = attach._ensure_current_addon()
    results["moduleReplaced"] = reloaded is not stale_module
    results["reloadedVersion"] = reloaded.ADDON_VERSION
    results["reloadedMatchesRepo"] = reloaded.ADDON_VERSION == repo_version

    # Re-registration after the reload must not raise double-registration.
    reloaded.register()
    results["reRegistered"] = True

    # The reloaded add-on's hello reports the repo version surface.
    from cclay.handshake import build_hello

    hello = build_hello(str(uuid.uuid4()), reloaded.ADDON_VERSION, "5.1.2")
    results["helloReportsRepoVersion"] = (
        f"cclay.addon_version={repo_version}" in hello["capabilities"]
    )

    # A second ensure at the current version is a no-op (idempotent re-run).
    results["idempotent"] = attach._ensure_current_addon() is reloaded

    # Launcher reuse guard input: pid on line 1, loaded version on line 2.
    attach.write_pidfile()
    lines = (project_dir / ".cclay-blender.pid").read_text(encoding="utf-8").splitlines()
    results["pidfilePidMatches"] = bool(lines) and lines[0] == str(os.getpid())
    results["pidfileVersionLine"] = lines[1] if len(lines) > 1 else None
except Exception:
    traceback.print_exc()
    results["error"] = traceback.format_exc()

print("CCLAY_STALE_RELOAD_RESULTS=" + json.dumps(results), flush=True)
