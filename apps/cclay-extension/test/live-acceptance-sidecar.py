"""Test-only live-acceptance sidecar: run driver-authored Python in live Blender.

Loaded as a second `--python` script after scripts/blender_attach.py by
test/live-acceptance.test.ts. Polls `<project>/.cclay-e2e/cmd-N.py` command files
(armed by a `cmd-N.go` marker), executes each once on the Blender main thread,
and writes a JSON outcome to `cmd-N.json`. This is how the driver seeds
raw-bpy scene state (S2) and mutates the scene outside stage_scene (S5)
without any production-code change.
"""

from __future__ import annotations

import json
import os
import sys
import traceback
from pathlib import Path

import bpy


def _argv_option(name: str) -> str | None:
    argv = sys.argv
    if "--" not in argv:
        return None
    tail = argv[argv.index("--") + 1 :]
    for index, token in enumerate(tail):
        if token == name and index + 1 < len(tail):
            return tail[index + 1]
    return None


_PROJECT_DIR_VALUE = _argv_option("--cclay-project-dir") or os.environ.get("CCLAY_PROJECT_DIR")
if not _PROJECT_DIR_VALUE:
    raise RuntimeError("live-acceptance sidecar requires --cclay-project-dir")
PROJECT_DIR = Path(_PROJECT_DIR_VALUE).expanduser().resolve()
COMMAND_DIR = PROJECT_DIR / ".cclay-e2e"
COMMAND_DIR.mkdir(parents=True, exist_ok=True)
_done: set[str] = set()


def _run_command(stem: str) -> None:
    source = COMMAND_DIR / f"{stem}.py"
    try:
        namespace: dict = {"bpy": bpy, "PROJECT_DIR": PROJECT_DIR, "result": None}
        exec(compile(source.read_text(encoding="utf-8"), str(source), "exec"), namespace)
        payload = {"ok": True, "result": namespace.get("result")}
    except BaseException:
        payload = {"ok": False, "error": traceback.format_exc()}
    try:
        text = json.dumps(payload, default=str)
    except (TypeError, ValueError):
        text = json.dumps({"ok": payload.get("ok", False), "result": str(payload.get("result"))})
    temporary = COMMAND_DIR / f".{stem}.tmp"
    temporary.write_text(text, encoding="utf-8")
    temporary.replace(COMMAND_DIR / f"{stem}.json")


def _poll() -> float:
    for marker in sorted(COMMAND_DIR.glob("cmd-*.go")):
        stem = marker.stem
        if stem in _done:
            continue
        _done.add(stem)
        _run_command(stem)
    return 0.2


bpy.app.timers.register(_poll, first_interval=0.5)
print("CCLAY_E2E_SIDECAR: ready", flush=True)
